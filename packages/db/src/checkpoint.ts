import type { CheckpointWorker } from "./connection";
import type { Db } from "./sqlite";

export type { CheckpointWorker } from "./connection";

/**
 * Hands WAL checkpoints to the driver's worker (desktop), with in-thread
 * autocheckpoints switched off meanwhile. If the worker ever dies, in-thread
 * autocheckpoints come back so the WAL can't grow unbounded. Drivers without
 * a worker keep SQLite's defaults.
 */
export function startCheckpointWorker(db: Db, intervalMs = 1000): CheckpointWorker | null {
  const start = db.driver.startCheckpointWorker;
  if (db.path === ":memory:" || !db.driver.features.checkpointWorker || !start) return null;
  db.exec("PRAGMA wal_autocheckpoint = 0");
  return start(
    db.path,
    () => {
      try {
        db.exec("PRAGMA wal_autocheckpoint = 1000");
      } catch {
        /* db already closed */
      }
    },
    intervalMs,
  );
}
