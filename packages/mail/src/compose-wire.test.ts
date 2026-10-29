import { createRequire } from "node:module";
import PostalMime from "postal-mime";
import nodemailer from "nodemailer";
import { ATTACHMENT_CHUNK, MAX_MIME_BYTES } from "@terno/core";
import { afterEach, expect, it, vi } from "vitest";
import { buildRaw, checkSmtpWire } from "./compose";
import { parseRaw } from "./mime";
import { sendViaSmtp } from "./smtp";
import type { SendPayload } from "./types";

const { SMTPServer } = createRequire(new URL("../../backend/src/imap.int.test.ts", import.meta.url))("smtp-server") as typeof import("../../backend/node_modules/@types/smtp-server");
const closes: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of closes.splice(0)) await close(); });

const base: SendPayload = {
  from: { name: "Remitente 日本語", email: "sender@example.test" },
  to: [{ name: "Destinatário", email: "recipient@example.test" }],
  cc: [], bcc: [{ name: "Hidden", email: "hidden@example.test" }],
  subject: "Réunion 日本語", text: "First\n.Second\n.\n..Last",
  messageId: "wire@example.test", inReplyTo: "parent@example.test", references: ["root@example.test", "parent@example.test"], providerThreadId: null,
};
const binary = Buffer.from(Array.from({ length: 49157 }, (_, i) => i % 256));
const attachments = [binary, Buffer.alloc(0)].map((bytes, i) => ({ assetId: `synthetic-${i}`, filename: "résumé.bin", mime: "application/octet-stream", size: bytes.length, dataBase64: bytes.toString("base64"), ...(i === 0 ? { contentId: "picture" } : {}) }));
const cases = [
  { name: "ASCII LF and dot lines", text: base.text },
  { name: "ASCII CRLF", text: base.text.replace(/\n/g, "\r\n") },
  { name: "mixed LF and CRLF", text: "First\r\n.Second\n.\r\n..Last" },
  { name: "bare CR remains encoded data", text: "a\rb\r.\rLast" },
  { name: "all CR/LF forms", text: "First\rSecond\n.\r\nLast" },
  { name: "HTML alternatives", text: base.text, html: "<div>First</div>\n<div>.Second</div>\r\n<div>Last</div>" },
  { name: "Unicode quoted printable", text: "Mostly ASCII with café and 日本語\n.Second line" },
  { name: "long base64 body", text: ("a".repeat(8191) + "\r\n😀界\n.Dot").repeat(3) },
  { name: "binary, empty and CID attachments", text: base.text, html: '<div>Files</div>\n<img src="cid:picture">', attachments },
];

it.each(cases)("$name: immutable preparation equals real SMTP DATA and returned Sent source", async (fixture) => {
  const received: Buffer[] = [];
  const recipients: string[][] = [];
  const server = new SMTPServer({ disabledCommands: ["STARTTLS"], onAuth: (_auth, _session, cb) => cb(null, { user: "synthetic" }), onData(stream, session, cb) {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk)); stream.on("error", cb);
    stream.on("end", () => { received.push(Buffer.concat(chunks)); recipients.push(session.envelope.rcptTo.map((r) => r.address)); cb(); });
  } });
  closes.push(() => new Promise<void>((resolve) => server.close(resolve)));
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const payload = { ...base, ...fixture };
  let prepared: Buffer | undefined;
  const { raw } = await sendViaSmtp({ host: "127.0.0.1", port: (server.server.address() as { port: number }).port, secure: false, user: "synthetic", password: "synthetic", allowInsecure: true }, payload, {
    async prepare(input) { prepared = Buffer.from(input); return input; },
  });
  expect(received).toEqual([prepared]);
  expect(raw).toEqual(prepared);
  expect(raw.toString()).not.toMatch(/(?<!\r)\n|\r(?!\n)/);
  expect(recipients).toEqual([["recipient@example.test", "hidden@example.test"]]);
  expect(raw.toString()).not.toMatch(/^Bcc:/mi);
  const parsed = await parseRaw(raw);
  expect(parsed).toMatchObject({ subject: base.subject, from: base.from, to: base.to, bcc: [], rfcMessageId: base.messageId, inReplyTo: base.inReplyTo, references: base.references });
  expect(parsed.text?.trimEnd()).toBe(payload.text.replace(/\r\n/g, "\n"));
  if (fixture.html !== undefined) expect(parsed.html?.trimEnd().replace(/\r\n/g, "\n")).toBe(fixture.html.replace(/\r\n/g, "\n"));
  if ("attachments" in fixture) {
    expect(parsed.attachments.map((a) => Buffer.from(a.bytes!))).toEqual([binary, Buffer.alloc(0)]);
    expect(parsed.attachments[0]).toMatchObject({ filename: "résumé.bin", contentId: "picture" });
  }
  if (fixture.name.includes("quoted printable")) expect(raw.toString()).toContain("Content-Transfer-Encoding: quoted-printable");
  if (fixture.name.includes("base64 body")) expect(raw.toString()).toContain("Content-Transfer-Encoding: base64");
});

it("Gmail keepBcc retains encoded recipients and MIME without mutating its payload", async () => {
  const payload = { ...base, html: "<div>Café</div>\n<div>Next</div>", attachments };
  const snapshot = structuredClone(payload);
  const raw = await buildRaw(payload, { keepBcc: true });
  expect((await parseRaw(raw)).bcc).toEqual(base.bcc);
  expect(payload).toEqual(snapshot);
});

it.each(["bare LF", "bare CR", "no final CRLF", "oversize"])("refuses prepared %s before transport creation without rewriting the supplied view", async (kind) => {
  const raw = kind === "oversize" ? Buffer.alloc(MAX_MIME_BYTES + 1, 65) : Buffer.from("From: sender@example.test\r\n\r\n" + (kind === "bare LF" ? "old\nwire\r\n" : kind === "bare CR" ? "old\rwire\r\n" : "wire"));
  const padded = Buffer.concat([Buffer.from("prefix"), raw, Buffer.from("suffix")]);
  const view = padded.subarray(6, 6 + raw.length);
  const transport = vi.spyOn(nodemailer, "createTransport");
  await expect(sendViaSmtp({ host: "127.0.0.1", port: 1, secure: false, user: "synthetic", password: "synthetic", allowInsecure: true }, base, { prepare: async () => view })).rejects.toMatchObject({ retryable: false, ambiguous: false });
  expect(transport).not.toHaveBeenCalled();
  expect(view.equals(raw)).toBe(true);
});

it("validates CRLF across scan slices and excludes bytes outside the prepared view", async () => {
  const wire = Buffer.concat([Buffer.alloc(ATTACHMENT_CHUNK - 1, 65), Buffer.from("\r\nEnd\r\n")]);
  const padded = Buffer.concat([Buffer.from("\n"), wire, Buffer.from("\r")]);
  await expect(checkSmtpWire(padded.subarray(1, 1 + wire.length))).resolves.toBeUndefined();
});

it.each(["LF", "CR", "terminal CR"])("refuses a message/rfc822 attachment with %s before immutable preparation", async (ending) => {
  const data = Buffer.from("From: nested@example.test\r\n\r\n" + (ending === "LF" ? "One\nTwo\r\n" : ending === "CR" ? "One\rTwo\r\n" : "One\r"));
  const prepare = vi.fn(async (raw: Uint8Array) => raw);
  const transport = vi.spyOn(nodemailer, "createTransport");
  await expect(sendViaSmtp({ host: "127.0.0.1", port: 1, secure: false, user: "synthetic", password: "synthetic", allowInsecure: true }, { ...base, attachments: [{ assetId: "nested", filename: "mail.eml", mime: "message/rfc822", size: data.length, dataBase64: data.toString("base64") }] }, { prepare })).rejects.toMatchObject({ retryable: false, ambiguous: false });
  expect(prepare).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
});

it.each([true, false])("keeps a canonical message/rfc822 attachment byte-exact (terminal newline=%s)", async (terminal) => {
  const data = Buffer.from("From: nested@example.test\r\nTo: other@example.test\r\nSubject: Nested\r\n\r\nOne\r\n.Dot" + (terminal ? "\r\n" : ""));
  const raw = await buildRaw({ ...base, attachments: [{ assetId: "nested", filename: "mail.eml", mime: "message/rfc822", size: data.length, dataBase64: data.toString("base64") }] }, { smtp: true });
  await checkSmtpWire(raw);
  const parsed = await new PostalMime({ forceRfc822Attachments: true }).parse(raw);
  expect(Buffer.from(parsed.attachments[0]!.content as ArrayBuffer).equals(data)).toBe(true);
});

it("refuses a changed preparation confirmation before SMTP", async () => {
  const original = await buildRaw(base, { smtp: true });
  const changed = Buffer.from(original.toString().replace("First", "Other"));
  let calls = 0;
  const transport = vi.spyOn(nodemailer, "createTransport");
  await expect(sendViaSmtp({ host: "127.0.0.1", port: 1, secure: false, user: "synthetic", password: "synthetic", allowInsecure: true }, base, { prepare: async () => ++calls === 1 ? original : changed })).rejects.toMatchObject({ retryable: false, ambiguous: false });
  expect(calls).toBe(2); expect(transport).not.toHaveBeenCalled();
});
