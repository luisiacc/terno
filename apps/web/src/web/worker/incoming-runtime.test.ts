/// <reference lib="webworker" />
import { afterEach, expect, it, vi } from "vitest";
import { createBrowserIncomingProcessor } from "./incoming-runtime";
import type { IncomingWorkerRequest } from "@terno/mail/incoming-processing";

const instances: BrowserWorker[] = [];
class BrowserWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  sent: IncomingWorkerRequest[] = [];
  terminate = vi.fn();
  constructor(readonly url: URL, readonly options: WorkerOptions) { instances.push(this); }
  postMessage(request: IncomingWorkerRequest, transfer: ArrayBuffer[]) { this.sent.push(structuredClone(request, { transfer })); }
}
afterEach(() => { instances.length = 0; vi.unstubAllGlobals(); });
const input = () => ({ kind: "mime" as const, chunks: [new TextEncoder().encode("Subject: browser\r\n\r\nbody")] });

it("lazily constructs a literal nested module worker and transfers exact input", async () => {
  vi.stubGlobal("Worker", BrowserWorker);
  const processor = createBrowserIncomingProcessor();
  expect(instances).toHaveLength(0);
  const source = input();
  const pending = processor.run(source, new AbortController().signal);
  const worker = instances[0]!;
  expect(worker.url.pathname).toMatch(/\/incoming\.worker\.ts$/);
  expect(worker.options).toMatchObject({ type: "module" });
  expect(source.chunks[0]!.byteLength).toBe(0);
  const request = worker.sent[0]!;
  worker.onmessage!({ data: { type: "result", incarnation: request.incarnation, job: request.job, result: { kind: "mime", message: { subject: "browser", attachments: [] } } } } as MessageEvent);
  expect((await pending).message.subject).toBe("browser");
  await processor.close();
  expect(worker.terminate).toHaveBeenCalledTimes(1);
});

it("suppresses default private browser error propagation and settles once", async () => {
  vi.stubGlobal("Worker", BrowserWorker);
  const processor = createBrowserIncomingProcessor();
  const pending = processor.run(input(), new AbortController().signal);
  const failure = expect(pending).rejects.toMatchObject({ code: "worker-fault", message: "Incoming processing failed (worker-fault)" });
  const event = Object.assign(new Event("error", { cancelable: true }), { message: "private-token-marker", error: new Error("https://private.test") });
  instances[0]!.onerror!(event as ErrorEvent);
  await failure;
  expect(event.defaultPrevented).toBe(true);
  await processor.whenIdle();
  await processor.close();
  expect(instances[0]!.terminate).toHaveBeenCalledTimes(1);
});

it("contains global worker errors and rejected promises, including idle failures", async () => {
  const listeners = new Map<string, (event: Event) => void>();
  const postMessage = vi.fn();
  const close = vi.fn();
  vi.stubGlobal("self", { addEventListener: (name: string, listener: (event: Event) => void) => listeners.set(name, listener), postMessage, close });
  await import("./incoming.worker");
  for (const type of ["error", "unhandledrejection"]) {
    const event = Object.assign(new Event(type, { cancelable: true }), { reason: new Error("private-token-marker"), message: "https://private.test" });
    listeners.get(type)!(event);
    expect(event.defaultPrevented).toBe(true);
    expect(postMessage).toHaveBeenLastCalledWith({ type: "fault", code: "worker-fault" });
  }
  expect(close).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(postMessage.mock.calls)).not.toContain("private-token-marker");
});
