import { RpcError } from "@terno/core/rpc";
import { L } from "@terno/i18n";
import { open } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import { BODY_UPGRADE_APPLICATION_ID, SCHEMA_VERSION } from "@terno/db";
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
    if (bytesRead !== header.length || header.subarray(0, 16).toString("ascii") !== "SQLite format 3\0") throw new Error("Mailbox header is unreadable");
    const version = header.readUInt32BE(60), applicationId = header.readUInt32BE(68);
    return version < SCHEMA_VERSION || applicationId === BODY_UPGRADE_APPLICATION_ID;
  } finally { await file.close(); }
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
      const fail = () => { if (terminal) return; terminal = true; clearTimeout(timer); reject(new RpcError("UNAVAILABLE", L("errors.mail.processingBusy"))); };
      const arm = () => { clearTimeout(timer); timer = setTimeout(fail, 30000); };
      const abort = () => { if (terminal) return; terminal = true; clearTimeout(timer); reject(signal.reason); };
      signal.addEventListener("abort", abort, { once: true });
      detachAbort = () => signal.removeEventListener("abort", abort);
      worker.on("error", fail); worker.on("messageerror", fail); worker.on("exit", () => { if (!terminal) fail(); });
      worker.on("message", (value: { type?: string; progress?: BodyUpgradeProgress }) => {
        if (terminal) return;
        if (value?.type === "legacy-progress" && value.progress) {
          arm();
          void Promise.resolve(progress?.(value.progress)).then(() => { if (!terminal && !signal.aborted) worker.postMessage({ type: "legacy-continue" }); }, fail);
        } else if (value?.type === "legacy-complete") { terminal = true; clearTimeout(timer); signal.removeEventListener("abort", abort); resolve(); }
        else fail();
      });
      arm();
      worker.postMessage({ type: "legacy-upgrade", path });
    });
  } finally { terminal = true; detachAbort(); await terminate(); }
}
