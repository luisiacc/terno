/// <reference lib="webworker" />
/**
 * The web's backend: the same BackendCore as desktop's utility process, in a
 * dedicated worker (terno-backend-worker), on SQLite-WASM over OPFS. The tab
 * that holds the Web Lock starts it; RPC runs over a MessagePort with the
 * same envelope as desktop.
 */
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { BackendCore } from "@terno/backend/portable";
import { captureError, installDiag, log, type DiagEntry, type DiagOptions, type ErrorRecord } from "@terno/core/diag";
import { isRpcMessage, type HostInfo, type RpcMessage, type Transport } from "@terno/core/rpc";
import { adaptPageCache, cacheBytesFor, databaseBytes, setCacheBytes, sqlDb, SqlMailStore } from "@terno/db/wasm";
import { L } from "@terno/i18n";
import type { MailStore, Platform } from "@terno/store";
import type { PageToWorker, WorkerInit, WorkerToPage } from "../protocol";
import { webCipher } from "./cipher";
import { migrateLegacyFiles, migrateLegacyIdb, migrateLegacyPool } from "./legacy-storage";
import { opfsFiles, webPlatform } from "./platform";
import { webRegistry } from "./providers";
import { webStores } from "./stores";

declare const self: DedicatedWorkerGlobalScope;

const WEB_HOST: HostInfo = { kind: "web", capabilities: { imap: false, agents: false, backgroundSync: false, network: "browser" } };
const BUILD = import.meta.env.VITE_BUILD_ID;
/** re-measure the page cache's hot set when the file grew this much (imports) */
const RETUNE_GROWTH = 1.1;

const post = (m: WorkerToPage) => self.postMessage(m);

// ───────────────────────────── diagnostics: posted to the page (every 500 ms, records at once) ─────────────────────────────

let diagEntries: DiagEntry[] = [];
let diagTimer: ReturnType<typeof setTimeout> | null = null;
const flushDiag = (records: ErrorRecord[] = []) => {
  if (diagTimer) clearTimeout(diagTimer);
  diagTimer = null;
  if (diagEntries.length || records.length) post({ type: "diag", entries: diagEntries, records });
  diagEntries = [];
};
const diagOptions = (session?: string): DiagOptions => ({
  proc: "worker",
  version: String(BUILD).replace(/-[a-z0-9]+$/, ""),
  build: `${String(BUILD).replace(/-[a-z0-9]+$/, "")}+${import.meta.env.VITE_BUILD_SHA ?? "dev"}`,
  channel: import.meta.env.VITE_WEB_DEMO === "1" ? "demo" : import.meta.env.DEV ? "dev" : "production",
  session,
  context: () => ({ os: "web", engine: "wasm-opfs", locale: navigator.language }),
  sink: {
    write: (e) => {
      if (diagEntries.length < 1000) diagEntries.push(e);
      diagTimer ??= setTimeout(() => flushDiag(), 500);
    },
    capture: (r) => flushDiag([r]),
    flush: () => flushDiag(),
  },
});
installDiag(diagOptions());
// the page's error listener can't see a rejection in here: the worker catches its own
self.addEventListener("error", (e) => void captureError(e.error ?? new Error(e.message), { code: "process.uncaught", fields: { source: "worker" } }));
self.addEventListener("unhandledrejection", (e) => void captureError(e.reason, { code: "process.unhandled_rejection", fields: { source: "worker" } }));

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
    close: () => {
      port.close();
      for (const l of closeListeners) l();
    },
  };
}

let backend: BackendCore | null = null;
let release: (() => Promise<void>) | null = null;
let cache = { hotBytes: 0, cacheBytes: 0, fileBytes: 0 };
let retuneTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Sizes the page cache to the hot set. Measuring walks the hot b-trees (one
 * synchronous dbstat each, ~20 ms for the largest at 50k messages), so the
 * result is kept in a file beside the database and only re-measured when
 * the file has grown by 10 % (imports).
 */
async function tune(store: MailStore, platform: Platform, name: string): Promise<void> {
  if (!(store instanceof SqlMailStore) || store.db.driver.id !== "wasm-opfs") return;
  const db = sqlDb(store);
  const fileBytes = databaseBytes(db);
  const path = `/${name}.pagecache`;
  if (!cache.fileBytes) {
    const saved = await platform.files?.read(path).catch(() => null);
    const known = saved ? (JSON.parse(new TextDecoder().decode(saved)) as typeof cache) : null;
    if (known && fileBytes < known.fileBytes * RETUNE_GROWTH) {
      cache = { ...known, cacheBytes: cacheBytesFor(known.hotBytes) };
      setCacheBytes(db, cache.cacheBytes);
      return;
    }
  } else if (fileBytes < cache.fileBytes * RETUNE_GROWTH) return;
  cache = { ...(await adaptPageCache(db, () => platform.yield())), fileBytes };
  await platform.files?.replace(path, new TextEncoder().encode(JSON.stringify(cache))).catch(() => {});
}

async function start(init: WorkerInit): Promise<void> {
  if (init.diagSession) installDiag(diagOptions(init.diagSession));
  const timings: Record<string, number> = {};
  const t0 = performance.now();
  const mark = (name: string) => (timings[name] = Math.round((performance.now() - t0) * 10) / 10);
  if (init.build !== BUILD) {
    post({ type: "fatal", code: "BUILD_MISMATCH", message: `This tab (${init.build}) and its worker (${BUILD}) come from different builds` });
    return;
  }
  // Única's storage takes its Terno names first (this tab holds both Web Locks); a failure deletes nothing and opens nothing
  const migrationFailed = (error: unknown) =>
    post({ type: "fatal", code: "OPEN_FAILED", message: L("web.worker.migrationFailed", { error: error instanceof Error ? error.message : String(error) }) });
  const moved: string[] = [];
  const note = (message: string) => console.warn(`[storage] ${message}`);
  try {
    // demo builds (tests): ?legacyPause=1 holds a mailbox's copy after its first batch until the tab goes away
    const pause = import.meta.env.VITE_WEB_DEMO === "1" && init.pauseLegacyCopy;
    const afterBatch = pause ? (to: string) => (to.endsWith("-keys") ? Promise.resolve() : new Promise<void>(() => {})) : undefined;
    moved.push(...(await migrateLegacyIdb(indexedDB, init.name, note, { afterBatch })));
  } catch (error) {
    return migrationFailed(error);
  }
  // the key store next: it must not queue behind the mailbox's own reads
  const cipherReady = webCipher();
  const sqlite3 = await sqlite3InitModule();
  mark("wasm");
  const stores = webStores(sqlite3);
  release = stores.release;
  try {
    const root = await navigator.storage?.getDirectory?.().catch(() => null);
    if (root) moved.push(...(await migrateLegacyPool(root, sqlite3, stores.pool, note)), ...(await migrateLegacyFiles(root, note)));
  } catch (error) {
    return migrationFailed(error);
  }
  if (moved.length) {
    console.info(`[storage] moved from Única's names:\n${moved.join("\n")}`);
    mark("legacyMoved");
  }
  const choice = await stores.registry.pick({ name: init.name, requested: init.requestedStorage, pinned: init.pinnedStorage }).catch((error: unknown) => ({
    adapter: null,
    reason: "unavailable" as const,
    message: error instanceof Error ? error.message : String(error),
  }));
  if (!choice.adapter) {
    post({ type: "fatal", code: "UNAVAILABLE", message: choice.message });
    return;
  }
  const platform = webPlatform(await opfsFiles().catch(() => undefined));
  const logLine = (level: "info" | "warn" | "error", message: string, extra?: unknown) => {
    (level === "error" ? console.error : level === "warn" ? console.warn : console.info)(`[backend] ${message}`, extra ?? "");
    // the log keeps that one happened, never its text (it can quote a provider's answer)
    log[level]("log.message", { source: "worker" });
  };
  let store: MailStore;
  try {
    store = await choice.adapter.open({ name: init.name, platform, log: logLine, instantSearch: init.instantSearch });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // the mailbox stays exactly as it was: no fallback to another (empty) adapter, no repair attempt
    post({ type: "fatal", code: /newer than this app/.test(message) ? "SCHEMA_NEWER" : "OPEN_FAILED", message });
    return;
  }
  mark("open");
  for (const [k, v] of Object.entries((store as { openTimings?: Record<string, number> }).openTimings ?? {})) timings[`open.${k}`] = Math.round(v * 10) / 10;
  const cipher = await cipherReady;
  mark("cipher");
  backend = new BackendCore({
    store,
    platform,
    version: BUILD,
    cipher,
    providers: webRegistry(),
    host: WEB_HOST,
    // a web commit costs 3–7 ms (OPFS, IndexedDB): 20 ms slices keep imports moving, interactions still interleave
    sliceBudgetMs: 20,
    demoAi: init.demo !== null,
    log: logLine,
  });
  let seeded = false;
  if (init.demo) {
    post({ type: "progress", message: L("web.worker.seedingDemo") });
    // the mock generator is its own chunk: release builds never load it
    const { seedDemo } = await import("@terno/backend/demo");
    if (await seedDemo(store, init.demo)) {
      seeded = true;
      await store.settings.set("app", { ai: { provider: "fake" } });
      await backend.categorizer.rebuildNow();
      mark("seed");
    }
  }
  await backend.ready;
  mark("backendReady");
  await backend.start();
  backend.connect(portTransport(init.port), { clientId: "tab", origin: "renderer" });
  mark("ready");
  post({ type: "ready", storage: choice.adapter.id, reason: choice.reason, build: BUILD, seeded, timings });
  // after the first answer: size the page cache to what searches read, and again as imports grow the file
  void tune(store, platform, init.name);
  retuneTimer = setInterval(() => void tune(store, platform, init.name), 5 * 60_000);
}

/** Demo builds: new mail for the existing accounts, ingested through the same sliced path as a sync. */
async function devImport(b: BackendCore, threads: number, seed: number): Promise<void> {
  const { generateDataset } = await import("@terno/mock-data");
  const accounts = await b.store.accounts.list();
  const data = generateDataset({ threads, accounts: accounts.length, seed, now: Date.now(), bodyScale: 2 });
  const tag = (id: string | null) => (id ? `import-${seed}-${id}` : null);
  const messages = data.messages.map((m) => ({
    ...m,
    accountId: accounts[m.accountIndex]!.id,
    providerMsgId: tag(m.providerMsgId),
    providerThreadId: tag(m.providerThreadId),
    rfcMessageId: tag(m.rfcMessageId),
    inReplyTo: tag(m.inReplyTo),
    references: m.references.map((r) => tag(r)!),
  }));
  const started = performance.now();
  await b.ingestSliced(messages);
  post({ type: "dev-imported", messages: messages.length, ms: performance.now() - started });
}

/** Closes every storage handle, then says so: only then may another tab take over. */
async function close(): Promise<void> {
  if (retuneTimer) clearInterval(retuneTimer);
  await backend?.stop().catch((error) => console.error("[backend] stop failed", error));
  backend = null;
  await release?.();
  post({ type: "closed" });
}

self.onmessage = (event: MessageEvent<PageToWorker>) => {
  const m = event.data;
  if (m.type === "init") {
    void start(m).catch((error) => {
      captureError(error, { code: "worker.open_failed", fields: { fatalCode: "OPEN_FAILED", engine: "wasm-opfs" } });
      post({ type: "fatal", code: "OPEN_FAILED", message: error instanceof Error ? error.message : String(error) });
    });
  } else if (m.type === "close") {
    void close();
  } else if (m.type === "dev-import") {
    if (import.meta.env.VITE_WEB_DEMO === "1" && backend) void devImport(backend, m.threads, m.seed);
  } else if (m.type === "cache-status") {
    const db = backend && backend.store instanceof SqlMailStore ? sqlDb(backend.store) : null;
    const status = db?.cacheStatus();
    post({ type: "cache-status", status: status ? { ...status, cacheBytes: cache.cacheBytes, hotBytes: cache.hotBytes } : null });
  }
};
