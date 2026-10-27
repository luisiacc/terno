import { createIncomingProcessor, type IncomingProcessorOptions, type IncomingProcessor } from "@terno/mail/incoming-processing";

export function createBrowserIncomingProcessor(options: IncomingProcessorOptions = {}): IncomingProcessor {
  return createIncomingProcessor((events) => {
    const worker = new Worker(new URL("./incoming.worker.ts", import.meta.url), { type: "module", name: "terno-incoming" });
    worker.onmessage = (event) => events.message(event.data);
    worker.onmessageerror = () => events.fault();
    worker.onerror = (event) => { event.preventDefault(); events.fault(); };
    return {
      postMessage: (request, transfer) => worker.postMessage(request, transfer),
      terminate: () => {
        worker.terminate();
        worker.onmessage = null;
        worker.onmessageerror = null;
        worker.onerror = null;
      },
    };
  }, options);
}
