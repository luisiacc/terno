import { describe, expect, it, vi } from "vitest";
import { parseRaw } from "./mime";
import * as mime from "./mime";
import { incomingResultTransfers, processIncoming, runIncomingWorkerRequest } from "./incoming-processing-worker";

const plain = 'From: Sender <SENDER@test.com>\r\nTo: Me <me@test.com>\r\nReply-To: "Help, Team" <help@test.com>, list@test.com\r\nSubject: ordinary\r\nMessage-ID: <message@test>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nhello café\r\n';
const bytes = (text: string) => new TextEncoder().encode(text);
const b64 = (text: string) => Buffer.from(text).toString("base64url");
const resource = (extra: Record<string, unknown> = {}) => ({ id: "expected", threadId: "thread", labelIds: ["INBOX", "UNREAD"], internalDate: "0001700000000000", sizeEstimate: 200, raw: b64(plain), ...extra });
const gmail = (value: unknown) => ({ kind: "gmail" as const, expectedId: "expected", chunks: [bytes(JSON.stringify(value))] });

it("validates consumed Gmail metadata and maps ordinary UTF8 MIME identically", async () => {
  const input = gmail(resource());
  const wire = input.chunks[0]!;
  input.chunks = [wire.slice(0, 7), wire.slice(7, 53), wire.slice(53)];
  expect(await processIncoming(input)).toEqual({ kind: "gmail", metadata: { id: "expected", threadId: "thread", labelIds: ["INBOX", "UNREAD"], internalDate: "0001700000000000", sizeEstimate: 200 }, message: await parseRaw(plain) });
  expect(await processIncoming(gmail(resource({ labelIds: undefined, internalDate: undefined, sizeEstimate: undefined })))).toMatchObject({ metadata: { id: "expected", threadId: "thread" } });
});

it("strictly rejects malformed UTF8/JSON without leaking source detail", async () => {
  for (const chunks of [[new Uint8Array([0xff])], [bytes('{"private-token-marker":')]]) {
    await expect(processIncoming({ kind: "gmail", expectedId: "expected", chunks })).rejects.toMatchObject({ code: "malformed-json", message: "Incoming processing failed (malformed-json)" });
  }
});

it.each([
  { id: "different" }, { threadId: "" }, { labelIds: ["INBOX", 3] }, { labelIds: [""] },
  { internalDate: "8640000000000001" }, { internalDate: "-8640000000000001" }, { internalDate: "1e3" }, { internalDate: 42 },
  { sizeEstimate: -1 }, { sizeEstimate: 0.5 }, { sizeEstimate: Number.MAX_SAFE_INTEGER + 1 }, { raw: "" }, { raw: null },
])("rejects malformed consumed resource fields %j", async (extra) => {
  await expect(processIncoming(gmail(resource(extra)))).rejects.toMatchObject({ code: "malformed-resource" });
});

it.each(["a", "a===", "ab=", "ab===", "abc==", "ab=c", "abcd=", "abcde===", "a+b/", "abcd\n", "!!!!"])("validates the entire base64url grammar: %s", async (raw) => {
  await expect(processIncoming(gmail(resource({ raw })))).rejects.toMatchObject({ code: "malformed-base64" });
});

it("accepts legal padded and unpadded tails, preserving exact binary attachments", async () => {
  for (const suffix of ["", "x", "xx"]) {
    const source = plain + suffix;
    for (const raw of [Buffer.from(source).toString("base64url"), Buffer.from(source).toString("base64").replaceAll("+", "-").replaceAll("/", "_")]) {
      expect((await processIncoming(gmail(resource({ raw })))).message).toEqual(await parseRaw(source));
    }
  }
  const source = ['From: sender@test.com', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="p"', '', '--p', 'Content-Type: multipart/alternative; boundary="a"', '', '--a', 'Content-Type: text/plain', '', 'plain alternative', '--a', 'Content-Type: text/html', '', '<b>html alternative</b>', '--a--', ...["AP+A", "", "AQID"].flatMap((data, i) => ['--p', 'Content-Type: image/png', `Content-Disposition: ${i === 2 ? "inline" : "attachment"}; filename="same.png"`, ...(i === 2 ? ['Content-ID: <CID@Test>'] : []), 'Content-Transfer-Encoding: base64', '', data]), '--p--', ''].join('\r\n');
  const parsed = (await processIncoming({ kind: "mime", chunks: [bytes(source)] })).message;
  expect(parsed).toEqual(await parseRaw(source));
  expect(parsed.attachments.map((part) => [...part.bytes!])).toEqual([[0, 255, 128], [], [1, 2, 3]]);
  expect(parsed.attachments[2]!.contentId).toBe("CID@Test");
});

const multipart = (count: number) => ['From: sender@test.com', 'Content-Type: multipart/mixed; boundary="p"', '', ...Array.from({ length: count }, (_, i) => ['--p', 'Content-Type: application/octet-stream', `Content-Disposition: attachment; filename="${i}.bin"`, '', 'x'].join('\r\n')), '--p--', ''].join('\r\n');

describe("explicit public PostalMime resource limits", () => {
  it("accepts ordinary100 attachments without confusing capture and part-count policies", async () => {
    const parsed = await processIncoming({ kind: "mime", chunks: [bytes(multipart(100))] });
    expect(parsed.message.attachments).toHaveLength(100);
    expect(parsed.message.attachments.every((part) => part.bytes?.[0] === 120)).toBe(true);
  });
  it("rejects >1000 aggregate parts even in a small wire resource", async () => {
    await expect(processIncoming({ kind: "mime", chunks: [bytes(multipart(1000))] })).rejects.toMatchObject({ code: "mime-limit-parts" });
  });
  it("rejects charged aggregate headers above512KiB", async () => {
    await expect(processIncoming({ kind: "mime", chunks: [bytes('X: x\r\n'.repeat(8193) + '\r\nbody')] })).rejects.toMatchObject({ code: "mime-limit-headers" });
  });
  it("rejects MIME nesting above64", async () => {
    let source = 'Content-Type: text/plain\r\n\r\nbody';
    for (let i = 0; i < 66; i++) source = `Content-Type: multipart/mixed; boundary="p${i}"\r\n\r\n--p${i}\r\n${source}\r\n--p${i}--\r\n`;
    await expect(processIncoming({ kind: "mime", chunks: [bytes(source)] })).rejects.toMatchObject({ code: "mime-limit-depth" });
  });
  it("preserves nested RFC822 as an attachment at the documented depth fallback", async () => {
    let source = 'From: sender@test.com\r\nSubject: deepest\r\n\r\nbody';
    for (let i = 0; i < 12; i++) source = `From: sender@test.com\r\nSubject: forward${i}\r\nContent-Type: message/rfc822\r\n\r\n${source}`;
    const parsed = (await processIncoming({ kind: "mime", chunks: [bytes(source)] })).message;
    expect(parsed.attachments.some((part) => part.mime === "message/rfc822" && new TextDecoder().decode(part.bytes).includes("deepest"))).toBe(true);
    expect(parsed).toEqual(await parseRaw(source));
  });
  it("bounds forwarded addresses using the parser public code", async () => {
    const source = `Content-Type: message/rfc822\r\n\r\nFrom: sender@test.com\r\nTo: ${Array.from({ length: 2050 }, (_, i) => `a${i}@test.com`).join(', ')}\r\n\r\nbody`;
    await expect(processIncoming({ kind: "mime", chunks: [bytes(source)] })).rejects.toMatchObject({ code: "mime-limit-addresses" });
  });
});

it("deduplicates reply attachment transfers and preserves exact view bytes", () => {
  const whole = new Uint8Array([0, 255, 128]);
  const message = { kind: "mime" as const, message: { attachments: [{ bytes: whole }, { bytes: whole }, { bytes: whole.subarray(1, 2) }] } } as unknown as Awaited<ReturnType<typeof processIncoming>>;
  const transfer = incomingResultTransfers(message);
  expect(transfer).toHaveLength(2);
  const received = structuredClone(message, { transfer });
  expect(whole.byteLength).toBe(0);
  expect([...received.message.attachments[2]!.bytes!]).toEqual([255]);
  expect(received.message.attachments[0]!.bytes!.buffer).toBe(received.message.attachments[1]!.bytes!.buffer);
});

it("returns only plain allowlisted failures for private parser exceptions", async () => {
  const spy = vi.spyOn(mime, "parseRaw").mockRejectedValueOnce(new Error("private-token-marker https://private.test"));
  try {
    const reply = await runIncomingWorkerRequest({ type: "process", incarnation: 1, job: 2, input: { kind: "mime", chunks: [bytes(plain)] } });
    expect(structuredClone(reply)).toEqual({ type: "error", incarnation: 1, job: 2, code: "worker-fault" });
  } finally { spy.mockRestore(); }
});

it("checks optional result budgets before returning whole cloned text or metadata", async () => {
  await expect(processIncoming({ kind: "mime", chunks: [bytes(plain)] }, { maxResultTextCodeUnits: 2 })).rejects.toMatchObject({ code: "result-limit" });
  await expect(processIncoming({ kind: "mime", chunks: [bytes(plain)] }, { maxResultMetadataCodeUnits: 2 })).rejects.toMatchObject({ code: "result-limit" });
  expect((await processIncoming({ kind: "mime", chunks: [bytes(plain)] })).message.subject).toBe("ordinary");
});
