import type { BodyPreparationFactory } from "@terno/store";

export const webBodyPreparation: BodyPreparationFactory = (message, failure) => {
  const worker = new Worker(new URL("./body-preparation.worker.ts", import.meta.url), { type: "module", name: "terno-body-preparation" });
  worker.onmessage = (event) => message(event.data);
  worker.onmessageerror = failure;
  worker.onerror = (event) => { event.preventDefault(); failure(); };
  return { post: (value, transfer) => worker.postMessage(value, transfer), async terminate() { worker.terminate(); worker.onmessage = null; worker.onmessageerror = null; worker.onerror = null; } };
};
