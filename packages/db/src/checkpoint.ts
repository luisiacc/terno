import { Worker } from "node:worker_threads";
import type { Db } from "./sqlite";

/**
 * Moves WAL checkpoints off the writer's thread. With autocheckpoint on, the
 * commit that crosses the threshold copies pages back and F_FULLFSYNCs on the
 * writer's event loop (measured: 30–80 ms stalls during imports). A worker with
 * its own connection runs PASSIVE checkpoints instead; the writer keeps going.
 * The worker source is inlined (eval) so it survives bundling.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(workerData.path);
db.exec("PRAGMA busy_timeout = 1000");
db.exec("PRAGMA checkpoint_fullfsync = ON");
const stmt = db.prepare("PRAGMA wal_checkpoint(PASSIVE)");
const timer = setInterval(() => {
  try { stmt.get(); } catch (e) { parentPort.postMessage({ error: String(e && e.message || e) }); }
}, workerData.intervalMs);
parentPort.on("message", (m) => {
  if (m === "stop") {
    clearInterval(timer);
    try { db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get(); } catch {}
    db.close();
    parentPort.postMessage("stopped");
  }
});
`;

export interface CheckpointWorker {
  stop(): Promise<void>;
}

export function startCheckpointWorker(db: Db, intervalMs = 1000): CheckpointWorker | null {
  if (db.path === ":memory:") return null;
  db.exec("PRAGMA wal_autocheckpoint = 0");
  const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { path: db.path, intervalMs } });
  worker.unref();
  let stopped = false;
  // If the worker ever dies, fall back to in-thread autocheckpoints so the WAL can't grow unbounded.
  worker.on("exit", () => {
    if (!stopped) {
      try {
        db.exec("PRAGMA wal_autocheckpoint = 1000");
      } catch {
        /* db already closed */
      }
    }
  });
  return {
    stop: () =>
      new Promise<void>((resolve) => {
        stopped = true;
        const done = () => resolve();
        worker.once("message", (m) => (m === "stopped" ? void worker.terminate().then(done) : undefined));
        worker.once("exit", done);
        worker.postMessage("stop");
        setTimeout(() => void worker.terminate().then(done), 2000).unref();
      }),
  };
}
