import { expect, it } from "vitest";
import { createNodeIncomingProcessor } from "./incoming-worker";

/** Produces actual JSON wire chunks without retaining a second whole fixture envelope. */
function wire(parts: Iterable<string>): Uint8Array[] {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let fill = new Uint8Array(65536);
  let offset = 0;
  const append = (text: string) => {
    while (text.length) {
      const count = Math.min(text.length, fill.length - offset);
      encoder.encodeInto(text.slice(0, count), fill.subarray(offset));
      offset += count;
      text = text.slice(count);
      if (offset === fill.length) { chunks.push(fill); fill = new Uint8Array(65536); offset = 0; }
    }
  };
  append('{"id":"expected","threadId":"thread","raw":"');
  let carry = "";
  for (const part of parts) {
    const source = carry + part;
    const complete = source.length - source.length % 3;
    append(Buffer.from(source.slice(0, complete)).toString("base64url"));
    carry = source.slice(complete);
  }
  if (carry) append(Buffer.from(carry).toString("base64url"));
  append('"}');
  if (offset) chunks.push(fill.slice(0, offset));
  return chunks;
}
function* repeated(header: string, block: string, count: number) {
  yield header;
  while (count) { const n = Math.min(count, 1024); yield block.repeat(n); count -= n; }
}

it("processes valid36/70MiB Gmail wire through the actual emitted worker with exact attachment bytes", async () => {
  const processor = createNodeIncomingProcessor();
  try {
    for (const mib of [36, 70]) {
      const header = 'From: Sender <sender@test.com>\r\nSubject: large worker\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="large.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\n';
      const line = "paWl".repeat(19) + "\r\n";
      const lines = Math.floor((mib * 1024 * 1024 - header.length) / line.length);
      const chunks = wire(repeated(header, line, lines));
      const inputBuffers = [...chunks];
      const parsed = await processor.run({ kind: "gmail", expectedId: "expected", chunks }, new AbortController().signal);
      expect(inputBuffers.every((chunk) => chunk.byteLength === 0)).toBe(true);
      expect(parsed).toMatchObject({ kind: "gmail", metadata: { id: "expected", threadId: "thread" }, message: { subject: "large worker" } });
      const bytes = parsed.message.attachments[0]!.bytes!;
      expect(bytes.length).toBe(lines * 57);
      expect(bytes.every((byte) => byte === 165)).toBe(true);
      expect(parsed.message.captureUnavailable).toBeUndefined();
      await processor.whenIdle();
    }
  } finally { await processor.close(); }
}, 60000);

it("validates the complete oversized encoding before returning genuine bounded headers", async () => {
  const processor = createNodeIncomingProcessor();
  const header = 'From: sender@test.com\r\nSubject: over policy\r\n\r\n';
  const rawBytes = 75 * 1024 * 1024 + 1;
  function chunks() { return wire(repeated(header, "x", rawBytes - header.length)); }
  try {
    const parsed = await processor.run({ kind: "gmail", expectedId: "expected", chunks: chunks() }, new AbortController().signal);
    expect(parsed.message).toMatchObject({ subject: "over policy", from: { email: "sender@test.com" }, text: null, html: null, attachments: [], captureUnavailable: "size" });
    const invalid = chunks();
    const tail = invalid.at(-1)!;
    tail[tail.length - 3] = 33;
    await expect(processor.run({ kind: "gmail", expectedId: "expected", chunks: invalid }, new AbortController().signal)).rejects.toMatchObject({ code: "malformed-base64" });
  } finally { await processor.close(); }
}, 60000);

it("distinguishes complete headers at64KiB from a terminator crossing or beyond the bound", async () => {
  const processor = createNodeIncomingProcessor();
  const rawBytes = 75 * 1024 * 1024 + 1;
  try {
    for (const [end, separator] of [[65536, "\r\n\r\n"], [65536, "\n\r\n"], [65537, "\r\n\r\n"], [65540, "\r\n\r\n"]] as const) {
      const header = 'Subject: ' + 'a'.repeat(end - 'Subject: '.length - separator.length) + separator;
      const chunks = wire(repeated(header, "x", rawBytes - header.length));
      const pending = processor.run({ kind: "gmail", expectedId: "expected", chunks }, new AbortController().signal);
      if (end === 65536) expect((await pending).message.captureUnavailable).toBe("size");
      else await expect(pending).rejects.toMatchObject({ code: "envelope-unavailable" });
    }
  } finally { await processor.close(); }
}, 60000);
