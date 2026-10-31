import { Worker } from "node:worker_threads";
import { expect, it } from "vitest";
import { prepareBodyTokens, type BodyPreparationFactory } from "@terno/store";

it("reports local worker failure with the existing bilingual typed error after native retirement", async () => {
  let exited = false, retired = false;
  const factory: BodyPreparationFactory = (message, failure) => {
    const worker = new Worker("require('node:worker_threads').parentPort.on('message',()=>process.exit(1))", { eval: true, env: {}, execArgv: [] });
    worker.on("message", message); worker.on("error", failure); worker.on("exit", () => { exited = true; failure(); });
    return { post: (value, transfer) => worker.postMessage(value, transfer), async terminate() { await worker.terminate(); retired = true; } };
  };
  const parts = prepareBodyTokens("synthetic ".repeat(5000), async () => {}, factory);
  await expect(parts.next()).rejects.toMatchObject({ code: "UNAVAILABLE", i18n: { key: "errors.mail.processingBusy" } });
  expect(exited && retired).toBe(true);
});
