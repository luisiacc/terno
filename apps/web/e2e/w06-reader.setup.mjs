import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildIncomingWorker } from "../../../packages/backend/scripts/build-incoming-worker.mjs";

export default async function setup() {
  const worker = fileURLToPath(new URL("../../../packages/backend/dist/incoming.worker.cjs", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "terno-w06-reader-worker-"));
  const existed = existsSync(worker);
  const saved = join(dir, "incoming.worker.cjs");
  if (existed) copyFileSync(worker, saved);
  const restore = () => {
    try { if (existed) copyFileSync(saved, worker); else rmSync(worker, { force: true }); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  };
  try { await buildIncomingWorker(); }
  catch (error) { restore(); throw error; }
  return restore;
}
