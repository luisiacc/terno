import { isRpcMessage, type RpcClient, type RpcMessage, type Transport } from "@unica/core/rpc";
import { setWeb, type WebLifecycle } from "./lifecycle";
import type { PageToWorker, WorkerToPage } from "./protocol";

const LOCK = "unica-backend";
const TABS = "unica-tabs";
const TAKEOVER = "unica:takeover";
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

const pinKey = (name: string) => `unica:storage:${name}`;

export interface WebDebug {
  build: string;
  storage: string | null;
  timings: Record<string, number>;
  cacheStatus(): Promise<Extract<WorkerToPage, { type: "cache-status" }>["status"]>;
  /** the RPC client the app uses, for measuring round trips */
  client: RpcClient;
}

declare global {
  interface Window {
    /** demo and perf builds: what the web perf gate reads */
    __unicaWeb?: WebDebug;
  }
}

/** This tab's side of the leadership protocol (one per page). */
class Leadership {
  readonly id = crypto.randomUUID();
  readonly tabs = new BroadcastChannel(TABS);
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
    addEventListener("pagehide", () => {
      if (this.giveUp) this.tabs.postMessage({ type: "released" } satisfies TabMessage);
    });
  }

  get leading(): boolean {
    return this.giveUp !== null;
  }

  private async receive(m: TabMessage): Promise<void> {
    if (m.type === "leader" && m.build !== BUILD) setWeb({ update: { apply: () => location.reload() } });
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
          const held = new Promise<void>((r) => (this.giveUp = r));
          resolve(true);
          await held;
        });
      });
      if (got) {
        if (this.poller) clearInterval(this.poller);
        this.poller = null;
        this.tabs.postMessage({ type: "leader", build: BUILD } satisfies TabMessage);
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
    this.tabs.postMessage({ type: "takeover", from: this.id } satisfies TabMessage);
  }

  /** Gives the lock up; `to` names the tab it goes to (others keep waiting). */
  release(to: string | null): void {
    const giveUp = this.giveUp;
    if (!giveUp) return;
    this.giveUp = null;
    giveUp();
    this.tabs.postMessage((to ? { type: "handoff", to } : { type: "released" }) satisfies TabMessage);
  }

  close(): void {
    if (this.poller) clearInterval(this.poller);
    this.tabs.close();
  }
}

let leadership: Leadership | null = null;

export function requestTakeover(): void {
  leadership?.requestTakeover();
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
  const name = (DEMO_BUILD && params.get("mailbox")) || "unica";
  const tabs = (leadership = new Leadership());
  await tabs.lead();
  setWeb({ phase: "starting" });

  const started = performance.now();
  const worker = new Worker(new URL("./worker/backend.worker.ts", import.meta.url), { type: "module", name: "unica-backend-worker" });
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
  worker.addEventListener("error", (e) => fail("CRASHED", e.message || "El motor de correo se detuvo"));
  /** another tab asked: close every handle, then hand the lock to that tab by name */
  const handOver = async (to: string) => {
    if (stopped) return tabs.release(to);
    stopped = true;
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
  };
  worker.postMessage(init, [channel.port2]);
  const first = await Promise.race([next(worker, ["ready", "fatal"]), new Promise<null>((r) => worker.addEventListener("error", () => r(null)))]);
  if (!first || first.type === "fatal") {
    const message = first?.type === "fatal" ? first.message : "El motor de correo se detuvo";
    fail(first?.type === "fatal" ? first.code : "CRASHED", message);
    throw new Error(message);
  }
  if (first.type !== "ready") throw new Error("unexpected worker message");
  // the mailbox now lives in this adapter: later opens must find it there or fail, never start empty elsewhere
  localStorage.setItem(pinKey(name), first.storage);
  setWeb({ phase: "ready", storage: first.storage, progress: null });
  tabs.onTakeover = handOver;
  const asked = tabs.takePending();
  if (asked) {
    void handOver(asked);
    return;
  }

  client.attach(portTransport(channel.port1));
  if (DEMO_BUILD) {
    window.__unicaWeb = {
      build: BUILD,
      storage: first.storage,
      timings: { ...first.timings, workerReady: Math.round(performance.now() - started) },
      client,
      async cacheStatus() {
        worker.postMessage({ type: "cache-status" } satisfies PageToWorker);
        const m = await next(worker, ["cache-status"], 5000);
        return m?.type === "cache-status" ? m.status : null;
      },
    };
  }
}
