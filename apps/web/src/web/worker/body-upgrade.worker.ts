/// <reference lib="webworker" />
import { upgradeLegacyIdbBodies } from "@terno/idb";
import { openDatabaseWith, upgradeLegacyBodies, wasmSqliteDriver, type BodyUpgradeProgress } from "@terno/db/wasm";

declare const self: DedicatedWorkerGlobalScope;
let active = false, cancelled = false, resume: (() => void) | undefined;
const check = () => { if (cancelled) throw new DOMException("Mailbox opening cancelled", "AbortError"); };
const progress = (value: BodyUpgradeProgress) => new Promise<void>((resolve) => { resume = resolve; self.postMessage({ type: "progress", progress: value }); });

self.onmessage = (event: MessageEvent<{ type: string; kind?: "idb" | "opfs"; name?: string }>) => {
  const request = event.data;
  if (request.type === "continue" || request.type === "cancel") { if (request.type === "cancel") cancelled = true; const next = resume; resume = undefined; next?.(); return; }
  if (request.type !== "upgrade" || active || !request.name) return;
  active = true;
  void (async () => {
    let error = false;
    const channel = new MessageChannel();
    const yieldTo = () => new Promise<void>((resolve) => { channel.port1.onmessage = () => resolve(); channel.port2.postMessage(0); });
    try {
      check();
      if (request.kind === "idb") await upgradeLegacyIdbBodies(indexedDB, request.name!, yieldTo, progress, check);
      else {
        const { default: init } = await import("@sqlite.org/sqlite-wasm");
        const sqlite3 = await init(); check();
        const pool = await sqlite3.installOpfsSAHPoolVfs({ name: "terno-sahpool", directory: ".terno-sahpool", initialCapacity: 8, preserveOnInitFailure: true });
        try {
          const db = openDatabaseWith(wasmSqliteDriver(sqlite3, { pool }), `/${request.name}.db`, { exclusive: true });
          try { await upgradeLegacyBodies(db, yieldTo, progress, check); }
          finally { db.close(); }
        } finally { pool.pauseVfs(); }
      }
      check();
    } catch { error = true; }
    finally { channel.port1.close(); channel.port2.close(); }
    // All native transactions and OPFS handles have retired before this acknowledgement.
    self.postMessage({ type: "retired", ok: !error && !cancelled, cancelled });
  })();
};
