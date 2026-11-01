import { nodeSqliteDriver, nodePlatform, openDatabaseWith, upgradeLegacyBodies, classifyOpenError, type BodyUpgradeProgress } from "@terno/db";
import { parentPort } from "node:worker_threads";
import type { IncomingWorkerReply, IncomingWorkerRequest } from "@terno/mail/incoming-processing";
import { incomingResultTransfers, runIncomingWorkerRequest } from "@terno/mail/incoming-processing-worker";

if (!parentPort) throw new Error("Incoming worker needs a parent port");
const port = parentPort;
let active: IncomingWorkerRequest | undefined;
let legacy = false, continueLegacy: (() => void) | undefined;
const failure = () => {
  const reply: IncomingWorkerReply = active
    ? { type: "error", incarnation: active.incarnation, job: active.job, code: "worker-fault" }
    : { type: "fault", code: "worker-fault" };
  try { port.postMessage(reply); } catch { /* The parent may already have terminated this job. */ }
};
const fatal = () => { failure(); process.exit(1); };
process.on("uncaughtException", fatal);
process.on("unhandledRejection", fatal);
port.on("messageerror", fatal);
port.on("message", (request: IncomingWorkerRequest | { type: "legacy-upgrade"; path: string } | { type: "legacy-continue" }) => {
  if (request.type === "legacy-continue") { const next = continueLegacy; continueLegacy = undefined; next?.(); return; }
  if (request.type === "legacy-upgrade") {
    if (legacy || active) { port.postMessage({ type: "legacy-failed" }); return; }
    legacy = true;
    void (async () => {
      const db = openDatabaseWith(nodeSqliteDriver, request.path, { uuid: nodePlatform.uuid, exclusive: true });
      let result: BodyUpgradeProgress;
      try {
        result = await upgradeLegacyBodies(db, nodePlatform.yield, (progress) => new Promise<void>((resolve) => { continueLegacy = resolve; port.postMessage({ type: "legacy-progress", progress }); }), () => {});
      } finally { db.close(); }
      port.postMessage({ type: "legacy-complete", progress: result });
    })().catch((error: unknown) => { const failure = classifyOpenError(error); port.postMessage(failure ? { type: "legacy-open-failed", failure } : { type: "legacy-failed" }); });
    return;
  }
  if (legacy) { port.postMessage({ type: "legacy-failed" }); return; }
  if (active) {
    port.postMessage({ type: "error", incarnation: request.incarnation, job: request.job, code: "worker-busy" } satisfies IncomingWorkerReply);
    return;
  }
  active = request;
  void runIncomingWorkerRequest(request).then((reply) => {
    try { port.postMessage(reply, reply.type === "result" ? incomingResultTransfers(reply.result) : []); }
    catch { failure(); }
    finally { active = undefined; }
  }, () => { failure(); active = undefined; });
});
