import { expect, it } from "vitest";
import { MAX_INCOMING_MIME_BYTES } from "@terno/core";
import { IncomingPipeline } from "./incoming";
import { readIncomingBody } from "./incoming-body";
import { incomingInputTransfers, INCOMING_GMAIL_WIRE_BYTES } from "./incoming-processing";
import { incomingResultTransfers, processIncoming } from "./incoming-processing-worker";
import { retainedIncomingBytes } from "./incoming-size";

it.each([0, 1])("enforces actual Gmail wire cap including JSON overhead, excess=%s", async (excess) => {
  expect(INCOMING_GMAIL_WIRE_BYTES).toBe(4 * Math.ceil(MAX_INCOMING_MIME_BYTES / 3) + 256 * 1024);
  expect(INCOMING_GMAIL_WIRE_BYTES).toBe(105119744);
  let remaining = INCOMING_GMAIL_WIRE_BYTES + excess;
  let delivered = 0, releases = 0, cancellations = 0;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!remaining) { controller.close(); return; }
      const count = Math.min(65536, remaining);
      remaining -= count; delivered += count;
      controller.enqueue(new Uint8Array(count).fill(32));
    },
    cancel() { cancellations++; },
  }, { highWaterMark: 0 }), { headers: { "content-length": "1" } });
  const work = readIncomingBody(response, { signal: new AbortController().signal, limit: INCOMING_GMAIL_WIRE_BYTES, promote: async () => () => { releases++; } });
  if (excess) await expect(work).rejects.toMatchObject({ name: "ResponseBodyLimitError", limit: INCOMING_GMAIL_WIRE_BYTES });
  else {
    const body = await work;
    expect(body.bytes).toBe(INCOMING_GMAIL_WIRE_BYTES);
    expect(body.chunks.reduce((sum, chunk) => sum + chunk.buffer.byteLength, 0)).toBe(INCOMING_GMAIL_WIRE_BYTES);
    body.release(); body.release();
    expect(body.chunks).toEqual([]);
  }
  expect(delivered).toBe(INCOMING_GMAIL_WIRE_BYTES + excess);
  expect(releases).toBe(1);
  expect(cancellations).toBe(excess);
  expect(response.body!.locked).toBe(false);
});

it("compacts a distinct attachment backing before transfer and charges whole retained buffers", async () => {
  const result = await processIncoming({ kind: "mime", chunks: [new TextEncoder().encode("Subject: synthetic\r\n\r\nbody")] });
  const backing = new Uint8Array(1024 * 1024).fill(231);
  backing.set([17, 0, 255], 501);
  const view = backing.subarray(501, 504);
  result.message.attachments = [{ filename: "witness.bin", mime: "application/octet-stream", size: 3, bytes: view }];
  const pipeline = new IncomingPipeline();
  try {
    expect(retainedIncomingBytes(view)).toBe(backing.byteLength + 64);
    const held = pipeline.retainCompleted(4 * 1024 * 1024 - 100)!;
    expect(pipeline.retainCompleted(retainedIncomingBytes(view))).toBeUndefined();
    held(); held();
    const credit = pipeline.retainCompleted(4 * 1024 * 1024)!;
    expect(credit).toBeTypeOf("function");
    credit(); credit();
    expect(() => incomingInputTransfers({ kind: "mime", chunks: [view] })).toThrow();
    const unsafe = structuredClone(view);
    expect(unsafe.byteLength).toBe(3);
    expect(unsafe.buffer.byteLength).toBe(1024 * 1024);
    expect(() => expect(unsafe.buffer.byteLength).toBe(3)).toThrow();
    const transfers = incomingResultTransfers(result);
    expect(transfers).toHaveLength(1);
    expect(transfers[0]!.byteLength).toBe(3);
    const received = structuredClone(result, { transfer: transfers });
    expect(result.message.attachments[0]!.bytes!.buffer.byteLength).toBe(0);
    const bytes = received.message.attachments[0]!.bytes!;
    expect(bytes.byteOffset).toBe(0);
    expect(bytes.buffer.byteLength).toBe(3);
    expect([...bytes]).toEqual([17, 0, 255]);
    expect(backing.byteLength).toBe(1024 * 1024);
  } finally { pipeline.close(); }
});
