import { onTestFinished } from "vitest";
import { startCheckpointWorker } from "../checkpoint";
import type { Db } from "../sqlite";

export function checkpointFixture(db: Db): void {
  const worker = startCheckpointWorker(db)!;
  onTestFinished(async () => {
    await worker.stop();
    db.exec("PRAGMA wal_autocheckpoint = 1000");
  });
}
