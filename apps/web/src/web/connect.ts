import { snack } from "~/lib/snack";
import { adoptSettings } from "~/lib/appearance";
import { flushAllDrafts } from "~/lib/drafts";
import { setApp } from "~/state/app";
import { isRpcMessage, type RpcClient, type RpcMessage, type Transport } from "@terno/core/rpc";
import { diagSession, log } from "@terno/core/diag";
import { captureUi } from "~/lib/diag";
import { ingestWorker } from "~/lib/diag-local";
import { setWeb, type WebLifecycle } from "./lifecycle";
import type { PageToWorker, WorkerToPage } from "./protocol";

const LOCK = "terno-backend";
const TABS = "terno-tabs";
const TAKEOVER = "terno:takeover";
/**
 * The lock and channel of builds from when the app was called Única. For one
 * release the leader holds that lock too, so an older tab still open and
 * this one never have the mailbox open together, and talks on that channel
 * so they can hand it over (and the older one learns it should reload).
 */
const LEGACY_LOCK = "unica-backend";
const LEGACY_TABS = "unica-tabs";
const BUILD = import.meta.env.VITE_BUILD_ID;
const DEMO_BUILD = import.meta.env.VITE_WEB_DEMO === "1";
/** a closing worker that hasn't released its handles by then is terminated (the browser drops them with it) */
const CLOSE_TIMEOUT_MS = 10_000;
/** a waiting tab looks for a free lock this often (an owner that crashed sends nothing) */
const POLL_MS = 1500;
/** while a handoff to another tab is in flight, waiting tabs don't grab the lock */
const HANDOFF_MS = 8000;

/**
 * Tabs talk on one BroadcastChannel. Waiting tabs never queue on the lock
 * (the browser would grant it first come, first served); they take it only
 * when it is free and nobody else was named for it.
 */
type TabMessage =
  | { type: "takeover"; from: string }
  | { type: "handoff"; to: string }
  | { type: "released" }
  | { type: "leader"; build: string };

const pinKey = (name: string) => `terno:storage:${name}`;
/** what a storage switch carries to the other engine (sessionStorage: this tab, this reload) */
const CARRY = "terno:carry";

/** The mailbox this page opens (demo builds: ?mailbox=). */
function mailboxName(): string {
  return (DEMO_BUILD && new URLSearchParams(location.search).get("mailbox")) || "terno";
}

/**
 * Opens this mailbox in another storage engine from the next load on. What
 * can't be re-synced (settings, categories, filters, drafts) is exported now
 * and imported there once it opens; the mailbox in the current engine stays
 * where it is (switching back finds it).
 */
export async function switchStorage(client: RpcClient, target: string): Promise<void> {
  await flushAllDrafts();
  const dump = await client.call("app.export", {});
  try {
    sessionStorage.setItem(CARRY, JSON.stringify({ to: target, dump }));
  } catch {
    throw new Error("No cabe lo que hay que llevar al otro almacenamiento: exporta tus datos, cambia y luego impórtalos.");
  }
  localStorage.setItem(pinKey(mailboxName()), target);
  const url = new URL(location.href);
  url.searchParams.delete("storage");
  location.replace(url.toString());
}

/** After a switch: what the previous engine held comes in, once. */
async function carryOver(client: RpcClient, storage: string): Promise<void> {
  const raw = sessionStorage.getItem(CARRY);
  if (!raw) return;
  sessionStorage.removeItem(CARRY);
  const { to, dump } = JSON.parse(raw) as { to: string; dump: Parameters<RpcClient["call"]>[1] };
  if (to !== storage) return;
  try {
    const r = await client.call("app.import", { data: dump as never });
    const boot = await client.call("app.bootstrap", {});
    adoptSettings(boot.settings);
    setApp({ categories: boot.categories });
    const waiting = r.pending.drafts + r.pending.filters;
    snack.success(`Traído de tu otro almacenamiento: ${r.categories.added + r.categories.merged} categorías, ${r.filters.added + r.filters.existing} filtros${r.drafts ? `, ${r.drafts} borradores` : ""} y tus ajustes.`, {
      description: waiting ? `${r.pending.drafts} borradores y ${r.pending.filters} filtros de tus cuentas vuelven en cuanto las conectes.` : undefined,
      duration: waiting ? 12_000 : undefined,
      background: true,
    });
  } catch (error) {
    snack.error(`No se pudieron traer tus ajustes: ${error instanceof Error ? error.message : String(error)}. Siguen en el otro almacenamiento.`, { background: true });
  }
}

export interface WebDebug {
  build: string;
  storage: string | null;
  timings: Record<string, number>;
  cacheStatus(): Promise<Extract<WorkerToPage, { type: "cache-status" }>["status"]>;
  /** the RPC client the app uses, for measuring round trips */
  client: RpcClient;
  /** ingests that many generated threads as a sync would (resolves when done) */
  importMail(threads: number, seed: number): Promise<{ messages: number; ms: number }>;
}

declare global {
  interface Window {
    /** demo and perf builds: what the web perf gate reads */
    __ternoWeb?: WebDebug;
  }
}

/** This tab's side of the leadership protocol (one per page). */
class Leadership {
  readonly id = crypto.randomUUID();
  readonly tabs = new BroadcastChannel(TABS);
  readonly legacyTabs = new BroadcastChannel(LEGACY_TABS);
  private giveUp: (() => void) | null = null;
  private granted: (() => void) | null = null;
  private quietUntil = 0;
  private poller: ReturnType<typeof setInterval> | null = null;
  /** a takeover this owner was asked for while it was still starting */
  private pending: string | null = null;
  /** what the owner does when another tab asks: close its mailbox, then hand over */
  onTakeover: ((to: string) => Promise<void>) | null = null;

  constructor() {
    // registered before anything starts, so no request is lost while this tab starts its worker
    this.tabs.onmessage = (e: MessageEvent<TabMessage>) => void this.receive(e.data);
    this.legacyTabs.onmessage = (e: MessageEvent<TabMessage>) => void this.receiveLegacy(e.data);
    addEventListener("pagehide", () => {
      if (this.giveUp) this.post({ type: "released" });
    });
  }

  /** To this build's tabs and to older ones (still called Única) alike. */
  private post(m: TabMessage): void {
    this.tabs.postMessage(m);
    this.legacyTabs.postMessage(m);
  }

  /**
   * An older tab: its handoffs and releases count like ours; asked for the
   * mailbox, the leader doesn't hand it back (that build would open the old,
   * now empty storage names) but says which build leads, so it offers a reload.
   */
  private async receiveLegacy(m: TabMessage): Promise<void> {
    if (m.type === "takeover") {
      if (this.leading) this.legacyTabs.postMessage({ type: "leader", build: BUILD } satisfies TabMessage);
      return;
    }
    if (m.type === "leader") return;
    await this.receive(m);
  }

  get leading(): boolean {
    return this.giveUp !== null;
  }

  private async receive(m: TabMessage): Promise<void> {
    if (m.type === "leader" && m.build !== BUILD) setWeb({ update: { apply: () => void flushAllDrafts().then(() => location.reload()) } });
    if (m.type === "takeover") {
      if (this.leading) {
        if (this.onTakeover) await this.onTakeover(m.from);
        else this.pending = m.from;
      } else this.quietUntil = Date.now() + HANDOFF_MS;
    }
    if (m.type === "handoff") {
      if (m.to === this.id) void this.tryLead(10);
      else this.quietUntil = Date.now() + 1000;
    }
    if (m.type === "released" && !this.leading) void this.tryLead();
  }

  /** the takeover asked for while starting, if any (the owner serves it once its worker is up or failed) */
  takePending(): string | null {
    const p = this.pending;
    this.pending = null;
    return p;
  }

  /** Takes the lock if it is free right now; retries a few times for a handoff naming this tab. */
  private async tryLead(attempts = 1): Promise<boolean> {
    for (let i = 0; i < attempts && !this.leading; i++) {
      const got = await new Promise<boolean>((resolve) => {
        void navigator.locks.request(LOCK, { ifAvailable: true }, async (lock) => {
          if (!lock) return resolve(false);
          // an older tab leading under the legacy lock keeps the mailbox: neither lock is held then
          await navigator.locks.request(LEGACY_LOCK, { ifAvailable: true }, async (legacy) => {
            if (!legacy) return resolve(false);
            const held = new Promise<void>((r) => (this.giveUp = r));
            resolve(true);
            await held;
          });
        });
      });
      if (got) {
        if (this.poller) clearInterval(this.poller);
        this.poller = null;
        this.post({ type: "leader", build: BUILD });
        this.granted?.();
        return true;
      }
      if (attempts > 1) await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }

  /** Resolves once this tab holds the lock: now, after a handoff to it, or when the owner goes away. */
  async lead(): Promise<void> {
    const wantsTakeover = sessionStorage.getItem(TAKEOVER) === "1";
    sessionStorage.removeItem(TAKEOVER);
    const granted = new Promise<void>((r) => (this.granted = r));
    if (await this.tryLead()) return;
    if (wantsTakeover) this.requestTakeover();
    else setWeb({ phase: "elsewhere" });
    this.poller = setInterval(() => {
      if (Date.now() >= this.quietUntil) void this.tryLead();
    }, POLL_MS);
    await granted;
  }

  /** "Usar aquí": ask the owner to close its mailbox and hand the lock to this tab. */
  requestTakeover(): void {
    setWeb({ phase: "taking-over" });
    this.post({ type: "takeover", from: this.id });
  }

  /** Gives the lock up; `to` names the tab it goes to (others keep waiting). */
  release(to: string | null): void {
    const giveUp = this.giveUp;
    if (!giveUp) return;
    this.giveUp = null;
    giveUp();
    this.post(to ? { type: "handoff", to } : { type: "released" });
  }

  close(): void {
    if (this.poller) clearInterval(this.poller);
    this.tabs.close();
    this.legacyTabs.close();
  }
}

let leadership: Leadership | null = null;

export function requestTakeover(): void {
  leadership?.requestTakeover();
}

/**
 * Asks the browser not to evict this site's storage under pressure (Safari's
 * 7-day rule, low disk): the mailbox has local-only state (categories,
 * filters, unsent work). persist() exists on the page, not in workers.
 */
async function requestPersistence(): Promise<void> {
  const storage = navigator.storage;
  if (!storage?.persist) return void setWeb({ persistence: { state: "unsupported", usage: null, quota: null } });
  const granted = (await storage.persisted()) || (await storage.persist().catch(() => false));
  const estimate = await storage.estimate().catch(() => ({}) as StorageEstimate);
  setWeb({ persistence: { state: granted ? "granted" : "denied", usage: estimate.usage ?? null, quota: estimate.quota ?? null } });
}

/** From a tab whose mailbox was taken: start over and take it back. */
export function takeBack(): void {
  sessionStorage.setItem(TAKEOVER, "1");
  location.reload();
}

function next(worker: Worker, types: WorkerToPage["type"][], timeoutMs = Infinity): Promise<WorkerToPage | null> {
  return new Promise((resolve) => {
    const timer = Number.isFinite(timeoutMs) ? setTimeout(() => done(null), timeoutMs) : null;
    const onMessage = (e: MessageEvent<WorkerToPage>) => {
      if (e.data.type === "progress") setWeb({ progress: e.data.message });
      if (types.includes(e.data.type)) done(e.data);
    };
    const done = (m: WorkerToPage | null) => {
      if (timer) clearTimeout(timer);
      worker.removeEventListener("message", onMessage);
      resolve(m);
    };
    worker.addEventListener("message", onMessage);
  });
}

async function registerServiceWorker(): Promise<void> {
  if (!("serviceWorker" in navigator) || import.meta.env.DEV) return;
  const hadController = navigator.serviceWorker.controller !== null;
  const reg = await navigator.serviceWorker.register("./sw.js");
  const offer = () => setWeb({ update: { apply: () => reg.waiting?.postMessage("skip-waiting") } });
  if (reg.waiting && hadController) offer();
  reg.addEventListener("updatefound", () => {
    const installing = reg.installing;
    installing?.addEventListener("statechange", () => {
      if (installing.state === "installed" && navigator.serviceWorker.controller) offer();
    });
  });
  // the new build took control (after "Recargar"): this page, its worker and the WASM must all come from it
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (hadController) location.reload();
  });
}

function portTransport(port: MessagePort): Transport {
  const listeners = new Set<(m: RpcMessage) => void>();
  const closeListeners = new Set<() => void>();
  port.onmessage = (e) => {
    if (isRpcMessage(e.data)) for (const l of listeners) l(e.data);
  };
  port.start();
  return {
    send: (m) => port.postMessage(m),
    onMessage: (l) => (listeners.add(l), () => listeners.delete(l)),
    onClose: (l) => (closeListeners.add(l), () => closeListeners.delete(l)),
    close: () => port.close(),
  };
}

/**
 * Web: become the leader tab, start the backend worker on this mailbox and
 * attach the RPC client to it. Throws (after setting the lifecycle) when
 * the mailbox can't be opened; never falls back to another storage.
 */
export async function connectWorker(client: RpcClient): Promise<void> {
  void registerServiceWorker().catch((error) => console.warn("[web] service worker unavailable", error));
  const params = new URLSearchParams(location.search);
  const name = mailboxName();
  const tabs = (leadership = new Leadership());
  await tabs.lead();
  setWeb({ phase: "starting" });

  const started = performance.now();
  const worker = new Worker(new URL("./worker/backend.worker.ts", import.meta.url), { type: "module", name: "terno-backend-worker" });
  let stopped = false;
  /** the mailbox can't be used here: stop the worker and let another tab have it (nothing is handed over by name) */
  const fail = (code: NonNullable<WebLifecycle["code"]>, message: string) => {
    if (stopped) return;
    stopped = true;
    worker.terminate();
    setWeb({ phase: "fatal", code, message });
    tabs.release(null);
    tabs.close();
  };
  worker.addEventListener("message", (e: MessageEvent<WorkerToPage>) => e.data?.type === "diag" && ingestWorker(e.data));
  worker.addEventListener("error", (e) => {
    captureUi(new Error(e.message || "worker error"), { code: "worker.failed", fields: { fatalCode: "CRASHED" } });
    fail("CRASHED", e.message || "El motor de correo se detuvo");
  });
  /** another tab asked: close every handle, then hand the lock to that tab by name */
  const handOver = async (to: string) => {
    if (stopped) return tabs.release(to);
    stopped = true;
    // what is being written reaches the worker before it closes (≤ 1 s)
    await flushAllDrafts();
    setWeb({ phase: "taken" });
    worker.postMessage({ type: "close" } satisfies PageToWorker);
    await next(worker, ["closed"], CLOSE_TIMEOUT_MS);
    worker.terminate();
    tabs.release(to);
  };

  const channel = new MessageChannel();
  const demoThreads = Number(params.get("demo") ?? 3000);
  const init: PageToWorker = {
    type: "init",
    port: channel.port2,
    name,
    requestedStorage: params.get("storage"),
    pinnedStorage: localStorage.getItem(pinKey(name)),
    demo: DEMO_BUILD && demoThreads > 0 ? { threads: demoThreads, accounts: Number(params.get("accounts") ?? 4) } : null,
    build: BUILD,
    instantSearch: !(DEMO_BUILD && params.get("instant") === "0"),
    pauseLegacyCopy: DEMO_BUILD && params.get("legacyPause") === "1",
    diagSession: diagSession(),
  };
  worker.postMessage(init, [channel.port2]);
  const first = await Promise.race([next(worker, ["ready", "fatal"]), new Promise<null>((r) => worker.addEventListener("error", () => r(null)))]);
  if (!first || first.type === "fatal") {
    if (first?.type === "fatal") log.warn("worker.open_failed", { fatalCode: first.code, engine: "wasm-opfs" });
    const message = first?.type === "fatal" ? first.message : "El motor de correo se detuvo";
    fail(first?.type === "fatal" ? first.code : "CRASHED", message);
    throw new Error(message);
  }
  if (first.type !== "ready") throw new Error("unexpected worker message");
  // the mailbox now lives in this adapter: later opens must find it there or fail, never start empty elsewhere
  localStorage.setItem(pinKey(name), first.storage);
  setWeb({ phase: "ready", storage: first.storage, progress: null });
  void requestPersistence().catch((error) => console.warn("[web] storage persistence unavailable", error));
  tabs.onTakeover = handOver;
  const asked = tabs.takePending();
  if (asked) {
    void handOver(asked);
    return;
  }

  client.attach(portTransport(channel.port1));
  void carryOver(client, first.storage);
  if (DEMO_BUILD) {
    window.__ternoWeb = {
      build: BUILD,
      storage: first.storage,
      timings: { ...first.timings, workerReady: Math.round(performance.now() - started) },
      client,
      async importMail(threads, seed) {
        worker.postMessage({ type: "dev-import", threads, seed } satisfies PageToWorker);
        const m = await next(worker, ["dev-imported"]);
        return m?.type === "dev-imported" ? { messages: m.messages, ms: m.ms } : { messages: 0, ms: 0 };
      },
      async cacheStatus() {
        worker.postMessage({ type: "cache-status" } satisfies PageToWorker);
        const m = await next(worker, ["cache-status"], 5000);
        return m?.type === "cache-status" ? m.status : null;
      },
    };
  }
}
