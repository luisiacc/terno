import { isRpcMessage, type RpcClient, type RpcMessage, type Transport } from "@unica/core/rpc";
import { setWeb, useWeb } from "./lifecycle";
import type { PageToWorker, WorkerToPage } from "./protocol";

const LOCK = "unica-backend";
const TABS = "unica-tabs";
const TAKEOVER = "unica:takeover";
const BUILD = import.meta.env.VITE_BUILD_ID;
const DEMO_BUILD = import.meta.env.VITE_WEB_DEMO === "1";
/** a closing worker that hasn't released its handles by then is terminated (the browser drops them with it) */
const CLOSE_TIMEOUT_MS = 10_000;

type TabMessage = { type: "takeover" } | { type: "leader"; build: string };

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

/**
 * Holds the Web Lock that makes this tab the mailbox's only writer. If
 * another tab has it, waits: it is granted when that tab closes or hands it
 * over (takeover, after its worker closed every handle). Resolves with the
 * function that gives leadership up.
 */
async function lead(tabs: BroadcastChannel): Promise<() => void> {
  const wantsTakeover = sessionStorage.getItem(TAKEOVER) === "1";
  sessionStorage.removeItem(TAKEOVER);
  let giveUp!: () => void;
  const held = new Promise<void>((r) => (giveUp = r));
  const now = await new Promise<boolean>((resolve) => {
    void navigator.locks.request(LOCK, { ifAvailable: true }, async (lock) => {
      resolve(lock !== null);
      if (lock) await held;
    });
  });
  if (!now) {
    if (wantsTakeover) requestTakeover(tabs);
    else setWeb({ phase: "elsewhere" });
    await new Promise<void>((resolve) => {
      void navigator.locks.request(LOCK, async () => {
        resolve();
        await held;
      });
    });
  }
  tabs.postMessage({ type: "leader", build: BUILD } satisfies TabMessage);
  return giveUp;
}

/** "Usar aquí": ask the leader to close its mailbox and hand the lock over. */
export function requestTakeover(tabs = new BroadcastChannel(TABS)): void {
  setWeb({ phase: "taking-over" });
  tabs.postMessage({ type: "takeover" } satisfies TabMessage);
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
  const tabs = new BroadcastChannel(TABS);
  const giveUp = await lead(tabs);
  setWeb({ phase: "starting" });

  const started = performance.now();
  const worker = new Worker(new URL("./worker/backend.worker.ts", import.meta.url), { type: "module", name: "unica-backend-worker" });
  worker.addEventListener("error", (e) => setWeb({ phase: "fatal", code: "CRASHED", message: e.message || "El motor de correo se detuvo" }));
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
  const first = (await next(worker, ["ready", "fatal"]))!;
  if (first.type === "fatal") {
    worker.terminate();
    setWeb({ phase: "fatal", code: first.code, message: first.message });
    throw new Error(first.message);
  }
  if (first.type !== "ready") throw new Error("unexpected worker message");
  // the mailbox now lives in this adapter: later opens must find it there or fail, never start empty elsewhere
  localStorage.setItem(pinKey(name), first.storage);
  setWeb({ phase: "ready", storage: first.storage, progress: null });

  tabs.onmessage = (e: MessageEvent<TabMessage>) => {
    if (e.data.type === "leader" && e.data.build !== BUILD) setWeb({ update: { apply: () => location.reload() } });
    if (e.data.type !== "takeover" || useWeb.getState().phase !== "ready") return;
    setWeb({ phase: "taken" });
    void (async () => {
      worker.postMessage({ type: "close" } satisfies PageToWorker);
      await next(worker, ["closed"], CLOSE_TIMEOUT_MS);
      worker.terminate();
      giveUp();
    })();
  };

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
