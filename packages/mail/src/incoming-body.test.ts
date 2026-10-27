import { getEventListeners } from "node:events";
import { expect, it, vi } from "vitest";
import { IncomingPipeline } from "./incoming";
import { readIncomingBody, type IncomingBody } from "./incoming-body";

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const chunkBytes = 65536;
function stream(chunks: Uint8Array[], pulled = () => {}) {
  let next = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) { pulled(); if (next < chunks.length) controller.enqueue(chunks[next++]!); else controller.close(); },
  }, { highWaterMark: 0 }));
}

it("does not allocate a64KiB transfer buffer for each ordinary tiny resource", async () => {
  const response = stream([new Uint8Array(190)]);
  const nativePrototype = Uint8Array.prototype;
  const constructors = vi.spyOn(globalThis, "Uint8Array");
  Object.defineProperty(constructors, "prototype", { value: nativePrototype });
  let body: IncomingBody | undefined;
  try {
    body = await readIncomingBody(response, { signal: new AbortController().signal, limit: 1024, promote: async () => () => {} });
    expect(constructors.mock.calls.every((args) => { const size: unknown = args.at(0); return typeof size !== "number" || size <= 1024; }), "tiny resources must not churn a64KiB allocation before final transfer").toBe(true);
    expect(body.chunks.map((chunk) => chunk.byteLength)).toEqual([190]);
  } finally { constructors.mockRestore(); body?.release(); }
});

it("coalesces fragmented input into exact transferable buffers and ignores a lying length", async () => {
  const bytes = Uint8Array.from({ length: chunkBytes + 123 }, (_, index) => index % 256);
  const response = stream(Array.from({ length: Math.ceil(bytes.length / 97) }, (_, index) => bytes.subarray(index * 97, Math.min(bytes.length, (index + 1) * 97))));
  response.headers.set("content-length", "1");
  const signal = new AbortController().signal;
  const promote = vi.fn(async () => () => {});
  const body = await readIncomingBody(response, { signal, limit: bytes.length, promote });
  expect(body.bytes).toBe(bytes.length);
  expect(body.chunks.map((chunk) => chunk.byteLength)).toEqual([chunkBytes, 123]);
  expect(body.chunks.every((chunk) => chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength)).toBe(true);
  expect(Buffer.concat(body.chunks)).toEqual(Buffer.from(bytes));
  expect(promote).not.toHaveBeenCalled();
  expect(response.body!.locked).toBe(false);
  expect(getEventListeners(signal, "abort")).toHaveLength(0);
  body.release();
  expect(body.chunks).toEqual([]);
});

it("stops six unknown sources at their prefixes until the shared owner releases after its consumer", async () => {
  const pipeline = new IncomingPipeline();
  const pulled = Array<number>(6).fill(0);
  const responses = Array.from({ length: 6 }, (_, index) => stream(Array.from({ length: 8 }, () => new Uint8Array(chunkBytes)), () => { pulled[index] = pulled[index]! + 1; }));
  const work = responses.map((response, index) => readIncomingBody(response, { signal: new AbortController().signal, limit: 1024 * 1024, promote: (signal) => pipeline.promote(index + 1, signal) }));
  try {
    for (let index = 0; index < work.length; index++) {
      const body = await work[index]!;
      expect(body.promoted).toBe(true);
      await turn();
      for (let waiting = index + 1; waiting < work.length; waiting++) expect(pulled[waiting]).toBe(5);
      body.release();
    }
  } finally { pipeline.close(); await Promise.allSettled(work); }
});

it("rejects over-budget delivery before interpreting a partial response", async () => {
  const canceled = vi.fn();
  const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(2048)); }, cancel: canceled }));
  response.headers.set("content-length", "0");
  await expect(readIncomingBody(response, { signal: new AbortController().signal, limit: 1024, promote: async () => () => {} })).rejects.toMatchObject({ name: "ResponseBodyLimitError" });
  expect(canceled).toHaveBeenCalledOnce();
  expect(response.body!.locked).toBe(false);
});

it.each([false, true])("refuses a source backing allocation over1MiB before promotion (subarray=%s)", async (subarray) => {
  const backing = new Uint8Array(1024 * 1024 + 1);
  const response = stream([subarray ? backing.subarray(0, 1) : backing]);
  const promote = vi.fn(async () => () => {});
  await expect(readIncomingBody(response, { signal: new AbortController().signal, limit: 2 * 1024 * 1024, promote })).rejects.toMatchObject({ name: "ResponseBodyLimitError" });
  expect(promote).not.toHaveBeenCalled();
  expect(response.body!.locked).toBe(false);
});

it("cancels a blocked native reader without waiting for its source cancellation", async () => {
  const abort = new AbortController();
  const canceled = vi.fn(() => new Promise<void>(() => {}));
  const response = new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => {}), cancel: canceled }));
  const work = readIncomingBody(response, { signal: abort.signal, limit: 1024, promote: async () => () => {} });
  const settled = work.then(() => "resolved", (error: Error) => error.name);
  await turn();
  abort.abort();
  expect(await settled).toBe("AbortError");
  expect(canceled).toHaveBeenCalledOnce();
  expect(response.body!.locked).toBe(false);
  expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
});

it("releases a late promotion grant after terminal consumer release and never promotes again", async () => {
  let granted!: (release: () => void) => void;
  const released = vi.fn();
  const promote = vi.fn(() => new Promise<() => void>((resolve) => { granted = resolve; }));
  const body = await readIncomingBody(stream([new Uint8Array(12)]), { signal: new AbortController().signal, limit: 1024, promote });
  const first = body.promote();
  expect(body.promote()).toBe(first);
  const settled = first.then(() => "resolved", (error: Error) => error.name);
  body.release();
  granted(released);
  expect(await settled).toBe("AbortError");
  expect(released).toHaveBeenCalledOnce();
  await expect(body.promote()).rejects.toMatchObject({ name: "AbortError" });
  expect(promote).toHaveBeenCalledOnce();
});

it("returns an immediately granted promotion if cancellation wins its continuation", async () => {
  const abort = new AbortController();
  const released = vi.fn();
  const body = await readIncomingBody(stream([new Uint8Array(12)]), { signal: abort.signal, limit: 1024, promote: async () => released });
  const work = body.promote();
  const settled = work.then(() => "resolved", (error: Error) => error.name);
  abort.abort();
  expect(await settled).toBe("AbortError");
  expect(released).toHaveBeenCalledOnce();
  body.release();
  expect(released).toHaveBeenCalledOnce();
});

it("terminal release cancels a queued promotion without waiting for the active consumer", async () => {
  const pipeline = new IncomingPipeline();
  const active = await pipeline.promote(1, new AbortController().signal);
  const body = await readIncomingBody(stream([new Uint8Array(12)]), { signal: new AbortController().signal, limit: 1024, promote: (signal) => pipeline.promote(2, signal) });
  const pending = body.promote();
  const settled = pending.then(() => "resolved", (error: Error) => error.name);
  body.release();
  try { expect(await settled).toBe("AbortError"); }
  finally { active(); pipeline.close(); }
});

it("cleans cancellation listeners when promotion throws synchronously", async () => {
  const signal = new AbortController().signal;
  const failure = new Error("synthetic promotion failure");
  const body = await readIncomingBody(stream([new Uint8Array(12)]), { signal, limit: 1024, promote() { throw failure; } });
  await expect(body.promote()).rejects.toBe(failure);
  expect(getEventListeners(signal, "abort")).toHaveLength(0);
  body.release();
});

it("keeps the completed promoted lease until an admitted consumer releases it", async () => {
  const abort = new AbortController();
  const released = vi.fn();
  const body = await readIncomingBody(stream(Array.from({ length: 5 }, () => new Uint8Array(chunkBytes))), { signal: abort.signal, limit: 1024 * 1024, promote: async () => released });
  abort.abort();
  expect(released).not.toHaveBeenCalled();
  body.release(); body.release();
  expect(released).toHaveBeenCalledOnce();
});

it("yields for fragmented or empty sources so cancellation can run", async () => {
  const abort = new AbortController();
  let count = 0;
  const response = new Response(new ReadableStream<Uint8Array>({ pull(controller) { count++; controller.enqueue(new Uint8Array()); } }, { highWaterMark: 0 }));
  const work = readIncomingBody(response, { signal: abort.signal, limit: 1024, promote: async () => () => {} });
  const settled = work.then(() => "resolved", (error: Error) => error.name);
  await turn();
  abort.abort();
  expect(await settled).toBe("AbortError");
  expect(count).toBeLessThanOrEqual(256);
  expect(response.body!.locked).toBe(false);
});

it("shares completed credits without waiting and closes both admission queues", async () => {
  const pipeline = new IncomingPipeline();
  const first = pipeline.retainCompleted(3 * 1024 * 1024)!;
  expect(pipeline.retainCompleted(2 * 1024 * 1024)).toBeUndefined();
  first(); first();
  const second = pipeline.retainCompleted(4 * 1024 * 1024)!;
  expect(second).toBeTypeOf("function");
  const active = await pipeline.promote(1, new AbortController().signal);
  const queued = pipeline.promote(2, new AbortController().signal).then(() => "resolved", (error: Error) => error.name);
  pipeline.close();
  expect(await queued).toBe("AbortError");
  await expect(pipeline.acquire(1, new AbortController().signal)).rejects.toMatchObject({ name: "AbortError" });
  await expect(pipeline.promote(1, new AbortController().signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(() => pipeline.retainCompleted(1)).toThrow();
  active(); second();
});
