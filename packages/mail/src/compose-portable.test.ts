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
  messageId: "m1@unica",
  inReplyTo: null,
  references: [],
  providerThreadId: null,
};

it("round-trips through a MIME parser: encoded words, threading headers, UTF-8 body", async () => {
  const raw = buildRawPortable({ ...base, inReplyTo: "p@x", references: ["r@x", "p@x"], text: "línea uno\nlínea dos ".repeat(30) }, { now: new Date(Date.UTC(2026, 9, 23, 12, 0, 0)) });
  const text = new TextDecoder().decode(raw);
  expect(text).toMatch(/^Date: Fri, 23 Oct 2026 12:00:00 \+0000\r$/m);
  expect(text.split("\r\n").every((l) => l.length <= 998)).toBe(true);
  const parsed = await parseRaw(raw);
  expect(parsed).toMatchObject({ subject: "Reunión", from: { name: "Luis Cordero", email: "luis@example.com" }, to: [{ name: "Ana Pérez", email: "ana@example.com" }], rfcMessageId: "m1@unica", inReplyTo: "p@x", references: ["r@x", "p@x"] });
  expect(parsed.text?.replace(/\r\n/g, "\n")).toBe("línea uno\nlínea dos ".repeat(30));
});

it("no header can be injected through a name, a subject or an id", async () => {
  const raw = buildRawPortable({ ...base, to: [{ name: "Ana\r\nBcc: spy@evil.com", email: "ana@example.com" }], subject: "Hola\r\nBcc: spy@evil.com", messageId: "m1\r\nBcc: x@y" });
  const text = new TextDecoder().decode(raw);
  expect(text).not.toMatch(/^Bcc:/m);
  expect((await parseRaw(raw)).bcc).toEqual([]);
});
