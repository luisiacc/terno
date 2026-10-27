import { afterEach, describe, expect, it, vi } from "vitest";
import { createIncomingProcessor, type IncomingProcessingResult, type IncomingWorkerEvents, type IncomingWorkerHost, type IncomingWorkerRequest } from "./incoming-processing";

const input = () => ({ kind: "mime" as const, chunks: [new TextEncoder().encode("Subject: ordinary\r\n\r\nbody")] });
const result = { kind: "mime", message: { subject: "ordinary", attachments: [] } } as unknown as IncomingProcessingResult;
const turn = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
function harness() {
  const hosts: { events: IncomingWorkerEvents; sent: IncomingWorkerRequest[]; terminated: number; active: boolean[] }[] = [];
  const factory = vi.fn((events: IncomingWorkerEvents): IncomingWorkerHost => {
    const state = { events, sent: [] as IncomingWorkerRequest[], terminated: 0, active: [] as boolean[] };
    hosts.push(state);
    return {
      postMessage: (request, transfer) => state.sent.push(structuredClone(request, { transfer })),
      terminate: () => { state.terminated++; },
      setActive: (active) => { state.active.push(active); },
    };
  });
  const processor = createIncomingProcessor(factory);
  const answer = (host = hosts.at(-1)!, value = result) => {
    const request = host.sent.at(-1)!;
    host.events.message({ type: "result", incarnation: request.incarnation, job: request.job, result: value });
  };
  return { hosts, factory, processor, answer };
}

afterEach(() => vi.restoreAllMocks());
describe("incoming processor client", () => {
  it("starts lazily, transfers exact owned bytes and reuses idle worker without timers", async () => {
    const timers = vi.spyOn(globalThis, "setTimeout");
    const h = harness();
    expect(h.factory).not.toHaveBeenCalled();
    const first = input();
    const pending = h.processor.run(first, new AbortController().signal);
    await turn();
    expect(first.chunks[0]!.byteLength).toBe(0);
    expect(new TextDecoder().decode(h.hosts[0]!.sent[0]!.input.chunks[0])).toContain("ordinary");
    h.answer();
    expect(await pending).toEqual(result);
    const next = h.processor.run(input(), new AbortController().signal);
    await turn();
    h.answer();
    await next;
    expect(h.factory).toHaveBeenCalledTimes(1);
    expect(h.hosts[0]!.active).toEqual([true, false, true, false]);
    expect(timers).not.toHaveBeenCalled();
    await h.processor.close();
    expect(h.hosts[0]!.terminated).toBe(1);
  });

  it("deduplicates whole backing buffers and refuses neighboring/pooled views before transfer", async () => {
    const h = harness();
    const bytes = new Uint8Array([65, 66, 67]);
    await expect(h.processor.run({ kind: "mime", chunks: [bytes.subarray(1)] }, new AbortController().signal)).rejects.toMatchObject({ code: "input-limit" });
    expect(bytes.byteLength).toBe(3);
    expect(h.factory).not.toHaveBeenCalled();
    const pending = h.processor.run({ kind: "mime", chunks: [bytes, bytes] }, new AbortController().signal);
    await turn();
    expect(bytes.byteLength).toBe(0);
    expect(h.hosts[0]!.sent[0]!.input.chunks[0]!.buffer).toBe(h.hosts[0]!.sent[0]!.input.chunks[1]!.buffer);
    h.answer();
    await pending;
    await h.processor.close();
  });

  it("bounds descriptors and rejects shared backing stores before starting a worker", async () => {
    const h = harness();
    for (const chunks of [Array.from({ length: 4097 }, () => new Uint8Array(0)), [new Uint8Array(new SharedArrayBuffer(8))]]) {
      await expect(h.processor.run({ kind: "mime", chunks }, new AbortController().signal)).rejects.toMatchObject({ code: "input-limit" });
    }
    expect(h.factory).not.toHaveBeenCalled();
    await h.processor.close();
  });

  it("projects the protocol payload so host-only configuration cannot cross the boundary", async () => {
    const h = harness();
    const supplied = { ...input(), config: "private-token-marker", url: "https://private.test" };
    const pending = h.processor.run(supplied, new AbortController().signal);
    await turn();
    expect(Object.keys(h.hosts[0]!.sent[0]!.input).sort()).toEqual(["chunks", "kind"]);
    h.answer();
    await pending;
    await h.processor.close();
  });

  it("has no hidden queue and a canceled account cannot terminate the active sibling", async () => {
    const h = harness();
    const b = h.processor.run(input(), new AbortController().signal);
    await turn();
    const a = new AbortController();
    a.abort(new Error("private-token-marker"));
    await expect(h.processor.run(input(), a.signal)).rejects.toMatchObject({ name: "AbortError", message: "Incoming processing canceled" });
    await expect(h.processor.run(input(), new AbortController().signal)).rejects.toMatchObject({ code: "worker-busy" });
    expect(h.hosts[0]!.terminated).toBe(0);
    h.answer();
    await b;
    await h.processor.close();
  });

  it("terminates the canceled incarnation once and ignores its late replies during a later job", async () => {
    const h = harness();
    const cancel = new AbortController();
    const first = h.processor.run(input(), cancel.signal);
    const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
    await turn();
    cancel.abort();
    await rejected;
    expect(h.hosts[0]!.terminated).toBe(1);
    const next = h.processor.run(input(), new AbortController().signal);
    await turn();
    let finished = false;
    void next.then(() => { finished = true; });
    h.answer(h.hosts[0]);
    h.hosts[0]!.events.fault();
    await turn();
    expect(finished).toBe(false);
    h.answer(h.hosts[1]);
    await next;
    await h.processor.close();
    expect(h.hosts.map((host) => host.terminated)).toEqual([1, 1]);
  });

  it("keeps a canceled startup and retiring host bounded until termination completes", async () => {
    let started!: (host: IncomingWorkerHost) => void;
    let retired!: () => void;
    const factory = vi.fn(() => new Promise<IncomingWorkerHost>((resolve) => { started = resolve; }));
    const processor = createIncomingProcessor(factory);
    const cancel = new AbortController();
    const pending = processor.run(input(), cancel.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    cancel.abort();
    await rejected;
    await expect(processor.run(input(), new AbortController().signal)).rejects.toMatchObject({ code: "worker-busy" });
    started({ postMessage: () => {}, terminate: () => new Promise<void>((resolve) => { retired = resolve; }) });
    await turn();
    await expect(processor.run(input(), new AbortController().signal)).rejects.toMatchObject({ code: "worker-busy" });
    expect(factory).toHaveBeenCalledTimes(1);
    retired();
    await turn();
    await processor.close();
  });

  it.each([{ type: "unexpected" }, { type: "result", result: { kind: "gmail", message: {} } }, { type: "result", result: null }])("settles malformed current-job protocol replies: %j", async (reply) => {
    const h = harness();
    const pending = h.processor.run(input(), new AbortController().signal);
    const failure = expect(pending).rejects.toMatchObject({ code: "worker-fault" });
    await turn();
    const request = h.hosts[0]!.sent[0]!;
    h.hosts[0]!.events.message({ incarnation: request.incarnation, job: request.job, ...reply });
    await failure;
    await h.processor.close();
  });

  it("revalidates input ownership after asynchronous factory startup", async () => {
    let ready!: (host: IncomingWorkerHost) => void;
    const processor = createIncomingProcessor(() => new Promise<IncomingWorkerHost>((resolve) => { ready = resolve; }));
    const source = input();
    const pending = processor.run(source, new AbortController().signal);
    const failure = expect(pending).rejects.toMatchObject({ code: "input-limit" });
    structuredClone(source.chunks[0], { transfer: [source.chunks[0]!.buffer] });
    const postMessage = vi.fn();
    ready({ postMessage, terminate: () => {} });
    await failure;
    expect(postMessage).not.toHaveBeenCalled();
    await processor.close();
  });

  it("settles crashes and permits only a fresh explicit demand, with fixed private errors", async () => {
    const h = harness();
    const first = h.processor.run(input(), new AbortController().signal);
    const failure = expect(first).rejects.toMatchObject({ code: "worker-fault", message: "Incoming processing failed (worker-fault)" });
    await turn();
    h.hosts[0]!.events.fault();
    await failure;
    expect(h.factory).toHaveBeenCalledTimes(1);
    const next = h.processor.run(input(), new AbortController().signal);
    await turn();
    h.answer();
    await next;
    await h.processor.close();
  });

  it("never serializes arbitrary error codes/messages from a worker", async () => {
    const h = harness();
    const pending = h.processor.run(input(), new AbortController().signal);
    const failure = expect(pending).rejects.toMatchObject({ code: "worker-fault" });
    await turn();
    const request = h.hosts[0]!.sent[0]!;
    h.hosts[0]!.events.message({ type: "error", incarnation: request.incarnation, job: request.job, code: "private-token-marker", message: "https://private.test/token" });
    await failure;
    await h.processor.close();
  });

  it("cancels async startup without hanging close and terminates a late-created worker", async () => {
    let resolve!: (host: IncomingWorkerHost) => void;
    const terminate = vi.fn();
    const processor = createIncomingProcessor(() => new Promise((done) => { resolve = done; }));
    const pending = processor.run(input(), new AbortController().signal);
    const failed = expect(pending).rejects.toMatchObject({ code: "worker-closed" });
    await processor.close();
    await failed;
    resolve({ terminate, postMessage: () => { throw new Error("must not post after close"); } });
    await turn();
    expect(terminate).toHaveBeenCalledTimes(1);
    await expect(processor.run(input(), new AbortController().signal)).rejects.toMatchObject({ code: "worker-closed" });
  });

  it("settles startup rejection and postMessage exceptions without leaking private details", async () => {
    const processor = createIncomingProcessor(() => { throw new Error("private-token-marker"); });
    await expect(processor.run(input(), new AbortController().signal)).rejects.toMatchObject({ code: "worker-unavailable", message: "Incoming processing failed (worker-unavailable)" });
    await processor.close();
    const terminate = vi.fn();
    const broken = createIncomingProcessor(() => ({ terminate, postMessage: () => { throw new Error("private-token-marker"); } }));
    await expect(broken.run(input(), new AbortController().signal)).rejects.toMatchObject({ code: "worker-fault" });
    await broken.close();
    expect(terminate).toHaveBeenCalledTimes(1);
  });
});
