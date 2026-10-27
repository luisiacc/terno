/// <reference lib="webworker" />
import type { IncomingWorkerReply, IncomingWorkerRequest } from "@terno/mail/incoming-processing";
import { incomingResultTransfers, runIncomingWorkerRequest } from "@terno/mail/incoming-processing-worker";

declare const self: DedicatedWorkerGlobalScope;
let active: IncomingWorkerRequest | undefined;
const failure = () => {
  const reply: IncomingWorkerReply = active
    ? { type: "error", incarnation: active.incarnation, job: active.job, code: "worker-fault" }
    : { type: "fault", code: "worker-fault" };
  try { self.postMessage(reply); } catch { /* The parent may already have terminated this job. */ }
};
self.addEventListener("error", (event) => { event.preventDefault(); failure(); self.close(); });
self.addEventListener("unhandledrejection", (event) => { event.preventDefault(); failure(); self.close(); });
self.addEventListener("messageerror", () => { failure(); self.close(); });
self.onmessage = (event: MessageEvent<IncomingWorkerRequest>) => {
  const request = event.data;
  if (active) {
    self.postMessage({ type: "error", incarnation: request.incarnation, job: request.job, code: "worker-busy" } satisfies IncomingWorkerReply);
    return;
  }
  active = request;
  void runIncomingWorkerRequest(request).then((reply) => {
    try { self.postMessage(reply, reply.type === "result" ? incomingResultTransfers(reply.result) : []); }
    catch { failure(); }
    finally { active = undefined; }
  }, () => { failure(); active = undefined; });
};
