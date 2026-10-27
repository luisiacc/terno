import { parentPort } from "node:worker_threads";
import type { IncomingWorkerReply, IncomingWorkerRequest } from "@terno/mail/incoming-processing";
import { incomingResultTransfers, runIncomingWorkerRequest } from "@terno/mail/incoming-processing-worker";

if (!parentPort) throw new Error("Incoming worker needs a parent port");
const port = parentPort;
let active: IncomingWorkerRequest | undefined;
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
port.on("message", (request: IncomingWorkerRequest) => {
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
