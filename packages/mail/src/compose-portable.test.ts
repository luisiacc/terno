import { expect, it } from "vitest";
import { buildRawPortable } from "./compose-portable";
import { parseRaw } from "./mime";

const base = {
  from: { name: "Luis Cordero", email: "luis@example.com" },
  to: [{ name: "Ana Pérez", email: "ana@example.com" }],
  cc: [],
  bcc: [],
  subject: "Reunión",
  text: "hola",
  messageId: "m1@terno",
  inReplyTo: null,
  references: [],
  providerThreadId: null,
};

it("round-trips through a MIME parser: encoded words, threading headers, UTF-8 body", async () => {
  const raw = await buildRawPortable({ ...base, inReplyTo: "p@x", references: ["r@x", "p@x"], text: "línea uno\nlínea dos ".repeat(30) }, { now: new Date(Date.UTC(2026, 9, 23, 12, 0, 0)) });
  const text = new TextDecoder().decode(raw);
  expect(text).toMatch(/^Date: Fri, 23 Oct 2026 12:00:00 \+0000\r$/m);
  expect(text.split("\r\n").every((l) => l.length <= 998)).toBe(true);
  const parsed = await parseRaw(raw);
  expect(parsed).toMatchObject({ subject: "Reunión", from: { name: "Luis Cordero", email: "luis@example.com" }, to: [{ name: "Ana Pérez", email: "ana@example.com" }], rfcMessageId: "m1@terno", inReplyTo: "p@x", references: ["r@x", "p@x"] });
  expect(parsed.text?.replace(/\r\n/g, "\n")).toBe("línea uno\nlínea dos ".repeat(30));
});

it("no header can be injected through a name, a subject or an id", async () => {
  const raw = await buildRawPortable({ ...base, to: [{ name: "Ana\r\nBcc: spy@evil.com", email: "ana@example.com" }], subject: "Hola\r\nBcc: spy@evil.com", messageId: "m1\r\nBcc: x@y" });
  const text = new TextDecoder().decode(raw);
  expect(text).not.toMatch(/^Bcc:/m);
  expect((await parseRaw(raw)).bcc).toEqual([]);
});

// plan 16: a rich draft sends multipart/alternative, from both builders (web and desktop), and through the web's Gmail path

const html = '<!DOCTYPE html><html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"></head><body><div><b>Hola</b> <span style="color:#b3261e">Ana</span> ñ</div><ul style="margin:0 0 0 24px;padding:0"><li>uno</li></ul></body></html>';
const text = "Hola Ana ñ\n• uno";

it("with html: multipart/alternative, text first and HTML last, both UTF-8 and decoding to what was given", async () => {
  const raw = await buildRawPortable({ ...base, text, html });
  const source = new TextDecoder().decode(raw);
  expect(source).toMatch(/^Content-Type: multipart\/alternative; boundary="([^"]+)"\r$/m);
  const parts = [...source.matchAll(/Content-Type: (text\/\w+); charset=utf-8/g)].map((m) => m[1]);
  expect(parts).toEqual(["text/plain", "text/html"]);
  expect(source.split("\r\n").every((l) => l.length <= 998)).toBe(true);
  const parsed = await parseRaw(raw);
  expect(parsed.text?.replace(/\r\n/g, "\n")).toBe(text);
  expect(parsed.html).toBe(html);
});

it("nodemailer (desktop) writes the same structure from the same payload", async () => {
  const { buildRaw } = await import("./compose");
  const raw = await buildRaw({ ...base, text, html });
  const source = raw.toString("utf8");
  expect(source).toMatch(/^Content-Type: multipart\/alternative;/m);
  expect(source.indexOf("Content-Type: text/plain")).toBeLessThan(source.indexOf("Content-Type: text/html"));
  const parsed = await parseRaw(raw);
  expect(parsed.text?.replace(/\r\n/g, "\n")).toBe(text);
  expect(parsed.html?.trim()).toBe(html);
  // without html it stays one text/plain part
  expect((await buildRaw({ ...base, text })).toString("utf8")).not.toMatch(/multipart/);
  expect(new TextDecoder().decode(await buildRawPortable({ ...base, text }))).not.toMatch(/multipart/);
});

it("the web's Gmail send: the queued payload's HTML goes out through the API, Bcc kept for Gmail, in the conversation's thread", async () => {
  const { createGmailTokenBroker } = await import("./gmail-web");
  const sent: { raw: string; threadId?: string }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/messages/send")) {
      sent.push(JSON.parse(String(init!.body)));
      return new Response(JSON.stringify({ id: "g1", threadId: "t1" }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof globalThis.fetch;
  const broker = createGmailTokenBroker({ now: () => 0 });
  broker.set(7, "token", 10 * 60_000);
  const provider = broker.provider({ account: { id: 7 }, fetch, store: {} } as never);
  const attachments = [{ assetId: crypto.randomUUID(), filename: "binary.dat", mime: "application/octet-stream", size: 3, dataBase64: "AP+A" }, { assetId: crypto.randomUUID(), filename: "empty", mime: "text/plain", size: 0, dataBase64: "" }];
  const payload = { ...base, bcc: [{ name: "", email: "spy@example.com" }], text, html, providerThreadId: "t1", attachments };
  await expect(provider.execute({ id: "op1", kind: "send", target: {}, payload })).resolves.toEqual({ providerMsgId: "g1", providerThreadId: "t1" });
  expect(sent).toHaveLength(1);
  expect(sent[0]!.threadId).toBe("t1");
  const raw = Uint8Array.from(atob(sent[0]!.raw.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const parsed = await parseRaw(raw);
  expect(parsed.html).toBe(html);
  expect(parsed.text?.replace(/\r\n/g, "\n")).toBe(text);
  expect(parsed.bcc).toEqual([{ name: "", email: "spy@example.com" }]);
  expect(parsed.attachments.map((a) => [...a.bytes!])).toEqual([[0,255,128], []]);
});

it("both MIME builders preserve exact attachments, duplicate Unicode names, empty files and CID bytes", async () => {
  const { buildRaw } = await import("./compose");
  const attachments = ["AP+A", "", "AQID"].map((dataBase64, i) => ({ assetId: crypto.randomUUID(), filename: "résumé.pdf", mime: "application/octet-stream", size: i === 1 ? 0 : 3, dataBase64, ...(i === 2 ? { contentId: "photo" } : {}) }));
  const p = { ...base, text, html, attachments };
  for (const raw of [await buildRawPortable(p), await buildRaw(p)]) {
    const parsed = await parseRaw(raw);
    expect(parsed.attachments.map((a) => [...a.bytes!]).sort((a,b) => a.length - b.length || (a[0] ?? 0) - (b[0] ?? 0))).toEqual([[], [0,255,128], [1,2,3]]);
    expect(parsed.attachments.map((a) => a.filename)).toEqual(attachments.map((a) => a.filename));
    expect(parsed.attachments.find((a) => a.contentId === "photo")?.bytes).toEqual(new Uint8Array([1,2,3]));
    expect(parsed.text?.replace(/\r\n/g, "\n")).toBe(text);
  }
});

it("both builders fail closed for unresolved refs and size mismatch before transport", async () => {
  const { buildRaw } = await import("./compose");
  const ref = { assetId: crypto.randomUUID(), filename: "file", mime: "application/octet-stream", size: 3 };
  for (const attachment of [ref, { ...ref, dataBase64: "" }]) {
    await expect(buildRawPortable({ ...base, attachments: [attachment] })).rejects.toThrow();
    await expect(buildRaw({ ...base, attachments: [attachment] })).rejects.toThrow();
  }
});

it("both builders validate canonical padding without decoding full attachments and retain immutable input", async () => {
  const { buildRaw, envelopeOf } = await import("./compose");
  const frozen = Object.freeze({ assetId: "fixed", filename: "a.bin", mime: "application/octet-stream", size: 1, dataBase64: "AA==" });
  const p = { ...base, bcc: [{ name: "Hidden", email: "hidden@test.com" }], attachments: [frozen] };
  for (const build of [buildRawPortable, buildRaw]) {
    for (const dataBase64 of ["AAAA", "AAA=", "AB==", "AAB=", "AA=", "AA==\n", "====", "AA==AAAA"]) {
      await expect(build({ ...p, attachments: [{ ...frozen, dataBase64 }] })).rejects.toThrow();
    }
    for (const length of [0, 1, 2, 3, 49153, 49154]) {
      const bytes = Buffer.alloc(length, 0xff);
      const raw = await build({ ...p, attachments: [{ ...frozen, size: length, dataBase64: bytes.toString("base64") }] });
      expect(Buffer.from((await parseRaw(raw)).attachments[0]!.bytes!).equals(bytes)).toBe(true);
    }
    await expect(build({ ...p, text: "a".repeat(19 * 1024 * 1024) })).rejects.toMatchObject({ retryable: false });
  }
  expect(frozen.dataBase64).toBe("AA==");
  expect(envelopeOf(p)).toEqual({ from: base.from.email, to: [base.to[0]!.email, "hidden@test.com"] });
});

it("large bodies preserve UTF-8 and CRLF at preparation chunk boundaries", async () => {
  const { buildRaw } = await import("./compose");
  const text = ("a".repeat(8191) + "\r\n😀界").repeat(4);
  for (const build of [buildRawPortable, buildRaw]) {
    const parsed = await parseRaw(await build({ ...base, text }));
    expect(parsed.text?.replace(/\r\n/g, "\n")).toBe(text.replace(/\r\n/g, "\n"));
  }
});

it("portable final wire ceiling refuses CRLF expansion before allocating an oversized wire buffer", async () => {
  await expect(buildRawPortable({ ...base, text: "\n".repeat(10 * 1024 * 1024) })).rejects.toMatchObject({ retryable: false });
});
