import { RpcError } from "@terno/core/rpc";
import { L } from "@terno/i18n";
import { open } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import { BODY_UPGRADE_APPLICATION_ID, SCHEMA_VERSION, MigrationError, SchemaNewerError, type OpenFailure } from "@terno/db";
import type { BodyUpgradeProgress } from "@terno/db";

const defaultWorkerUrl = new URL(import.meta.url.endsWith(".ts") ? "../dist/incoming.worker.cjs" : "./incoming.worker.cjs", import.meta.url);

/** Bounded asynchronous header read; a copied/interrupted pending upgrade still routes to its dedicated owner. */
export async function needsLegacyBodyUpgrade(path: string): Promise<boolean> {
  if (path === ":memory:") return false;
  let file;
  try { file = await open(path, "r"); } catch (error) { if ((error as { code?: string }).code === "ENOENT") return false; throw error; }
  try {
    const header = Buffer.alloc(72), { bytesRead } = await file.read(header, 0, header.length, 0);
    if (!bytesRead) return false;
    // The normal opener classifies invalid/truncated files using SQLite's real error code.
    if (bytesRead !== header.length || header.subarray(0, 16).toString("ascii") !== "SQLite format 3\0") return false;
    const version = header.readUInt32BE(60), applicationId = header.readUInt32BE(68);
    return version < SCHEMA_VERSION || applicationId === BODY_UPGRADE_APPLICATION_ID;
  } finally { await file.close(); }
}

function legacyOpenError(failure: OpenFailure): Error {
  if (failure.kind === "newer") return new SchemaNewerError(failure.schema, failure.supported);
  if (failure.kind === "failed" && failure.reason === "migration" && failure.step !== null) return new MigrationError(failure.step, "legacy body preparation", new Error("Mailbox migration failed"));
  // Recreate only qualified primary codes; the host still supplies its actual disk estimates.
  if (failure.kind === "no-room") return Object.assign(new Error("Mailbox migration needs disk space"), { errcode: 13 });
  if (failure.kind === "failed" && (failure.reason === "corrupt" || failure.reason === "unwritable")) return Object.assign(new Error("Mailbox could not open"), { errcode: failure.reason === "corrupt" ? 11 : 8 });
  return new RpcError("UNAVAILABLE", L("errors.mail.processingBusy"));
}

/** Uses the existing emitted artifact in a separate, exclusive migration incarnation. No message data reaches the host. */
export async function upgradeNodeLegacyBodies(path: string, signal: AbortSignal, progress?: (value: BodyUpgradeProgress) => void | Promise<void>, workerUrl = defaultWorkerUrl): Promise<void> {
  signal.throwIfAborted();
  const worker = new Worker(workerUrl, { env: {}, execArgv: [], name: "terno-body-upgrade", resourceLimits: { maxOldGenerationSizeMb: 512 } });
  let detachAbort = () => {};
  let terminal = false, ending: Promise<number | undefined> | undefined;
  const terminate = () => ending ??= worker.terminate();
  try {
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const rejectFailure = (error: unknown) => { if (terminal) return; terminal = true; clearTimeout(timer); reject(error); };
      const fail = () => rejectFailure(new RpcError("UNAVAILABLE", L("errors.mail.processingBusy")));
      const arm = () => { clearTimeout(timer); timer = setTimeout(fail, 30000); };
      const abort = () => { if (terminal) return; terminal = true; clearTimeout(timer); reject(signal.reason); };
      signal.addEventListener("abort", abort, { once: true });
      detachAbort = () => signal.removeEventListener("abort", abort);
      worker.on("error", fail); worker.on("messageerror", fail); worker.on("exit", () => { if (!terminal) fail(); });
      worker.on("message", (value: { type?: string; progress?: BodyUpgradeProgress; failure?: OpenFailure }) => {
        if (terminal) return;
        if (value?.type === "legacy-progress" && value.progress) {
          arm();
          void Promise.resolve(progress?.(value.progress)).then(() => { if (!terminal && !signal.aborted) worker.postMessage({ type: "legacy-continue" }); }, fail);
        } else if (value?.type === "legacy-complete") { terminal = true; clearTimeout(timer); signal.removeEventListener("abort", abort); resolve(); }
        else if (value?.type === "legacy-open-failed" && value.failure) rejectFailure(legacyOpenError(value.failure));
        else fail();
      });
      arm();
      worker.postMessage({ type: "legacy-upgrade", path });
    });
  } finally { terminal = true; detachAbort(); await terminate(); }
}
