import { Worker } from "node:worker_threads";
import { createIncomingProcessor, type IncomingProcessorOptions, type IncomingProcessor } from "@terno/mail/incoming-processing";

/** Source launchers emit dist first; packaged backend and worker are siblings. */
const defaultWorkerUrl = new URL(import.meta.url.endsWith(".ts") ? "../dist/incoming.worker.cjs" : "./incoming.worker.cjs", import.meta.url);

export function createNodeIncomingProcessor(workerUrl: URL = defaultWorkerUrl, options: IncomingProcessorOptions = {}): IncomingProcessor {
  return createIncomingProcessor((events) => {
    const worker = new Worker(workerUrl, {
      execArgv: [],
      env: {},
      // V8 old heap only: ArrayBuffers and process RSS are separate budgets.
      resourceLimits: { maxOldGenerationSizeMb: 512 },
      name: "terno-incoming",
    });
    worker.on("message", events.message);
    worker.on("messageerror", events.fault);
    worker.on("error", events.fault);
    worker.on("exit", events.fault);
    worker.unref();
    let ending: Promise<void> | undefined;
    return {
      postMessage: (request, transfer) => worker.postMessage(request, transfer),
      setActive: (active) => { if (active) worker.ref(); else worker.unref(); },
      terminate: () => ending ??= worker.terminate().then(() => {}),
    };
  }, options);
}
