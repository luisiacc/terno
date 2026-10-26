/**
 * Plan 29 at the mail layer: what other clients write in address headers is
 * read by our parser (Gmail's raw messages, IMAP's raw fields beside the
 * envelope), and what we write parses back the same in any client.
 */
import type { Address } from "@terno/core";
import { describe, expect, it } from "vitest";
import { buildRaw } from "./compose";
import { buildRawPortable } from "./compose-portable";
import { headerFields, messageAddresses, parseRaw } from "./mime";

const A = (name: string, email: string): Address => ({ name, email });
const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const message = (headers: string) => `${headers}\r\nSubject: s\r\nMessage-ID: <m@x>\r\n\r\nbody\r\n`;

describe("parseRaw reads address headers itself", () => {
  it("the user's mangled Cc gives both people", async () => {
    const p = await parseRaw(message(`From: Ana <ana@x.com>\r\nTo: me@mine.com\r\nCc: "=?utf-8?Q?Jos=C3=A9?=_David_Sucre_L.?= <david@sucre.net> , Luis Alberto Medina" <lmedina@sucre.net>`));
    expect(p.cc).toEqual([A("José David Sucre L.", "david@sucre.net"), A("Luis Alberto Medina", "lmedina@sucre.net")]);
  });

  it("an encoded word can't spoof the sender's address (postal-mime alone would show boss@corp.com)", async () => {
    const p = await parseRaw(message(`From: =?UTF-8?B?${b64("boss@corp.com <boss@corp.com>")}?= <attacker@evil.com>\r\nTo: me@mine.com`));
    expect(p.from.email).toBe("attacker@evil.com");
    expect(p.from.name).not.toContain("@");
  });

  it("every Cc line counts; Reply-To is read ([] when there is none); addresses lowercased as the store keys them", async () => {
    const p = await parseRaw(message(`From: Ana <Ana@X.com>\r\nTo: me@mine.com\r\nCc: a@x.com\r\nCc: B <B@Y.COM>\r\nReply-To: List <list@lists.x.com>, ana@x.com`));
    expect(p.from).toEqual(A("Ana", "ana@x.com"));
    expect(p.cc).toEqual([A("", "a@x.com"), A("B", "b@y.com")]);
    expect(p.replyTo).toEqual([A("List", "list@lists.x.com"), A("", "ana@x.com")]);
    expect((await parseRaw(message("From: a@x.com\r\nTo: b@x.com"))).replyTo).toEqual([]);
  });

  it("groups, comments, Outlook's [mailto:], smart quotes", async () => {
    const p = await parseRaw(message(`From: (Jane Doe) jane@x.com\r\nTo: undisclosed-recipients:;\r\nCc: Team: a@x.com, b@x.com;, Outlook User [mailto:ol@x.com] <ol@x.com>, “Smart” <s@x.com>`));
    expect(p.from).toEqual(A("Jane Doe", "jane@x.com"));
    expect(p.to).toEqual([]);
    expect(p.cc).toEqual([A("", "a@x.com"), A("", "b@x.com"), A("Outlook User", "ol@x.com"), A("Smart", "s@x.com")]);
  });
});

describe("IMAP: the raw fields beside the envelope", () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  it("the raw field wins over what the server's envelope made of it", () => {
    const fields = headerFields(enc(`From: =?UTF-8?B?${b64("boss@corp.com <boss@corp.com>")}?= <attacker@evil.com>\r\nCc: "=?utf-8?Q?Jos=C3=A9?=_David_Sucre_L.?= <david@sucre.net> , Luis Alberto Medina" <lmedina@sucre.net>\r\n\r\n`));
    const a = messageAddresses(fields, { from: [{ name: "x", address: "boss@corp.com" }], cc: [{ name: "José_David_Sucre_L.?= <david@sucre.net> , Luis Alberto Medina", address: "lmedina@sucre.net" }] });
    expect(a.from.email).toBe("attacker@evil.com");
    expect(a.cc.map((x) => x.email)).toEqual(["david@sucre.net", "lmedina@sucre.net"]);
  });

  it("without raw fields the envelope stands in, repaired; its Reply-To copied from From is no Reply-To", () => {
    const from = [{ name: "'Ana'", address: "Ana@X.com" }];
    const a = messageAddresses(headerFields(undefined), { from, to: [{ name: "", address: "me@mine.com" }], cc: [{ name: "_David_Sucre_L.?= <david@sucre.net> , Luis Alberto Medina", address: "lmedina@sucre.net" }], replyTo: from });
    expect(a.from).toEqual(A("Ana", "ana@x.com"));
    expect(a.cc).toEqual([A("David Sucre L.", "david@sucre.net"), A("Luis Alberto Medina", "lmedina@sucre.net")]);
    expect(a.replyTo).toEqual([]);
  });

  it("headerFields unfolds, keeps every occurrence, and reads 8-bit Latin-1", () => {
    const latin1 = Uint8Array.from([..."Cc: Jos\xe9 <j@x.com>\r\nCc: b@x.com,\r\n c@x.com\r\n"].map((c) => c.charCodeAt(0)));
    expect(headerFields(latin1)("cc")).toEqual(["José <j@x.com>", "b@x.com, c@x.com"]);
  });
});

const base = { from: { name: "Luis Cordero", email: "luis@example.com" }, to: [] as Address[], cc: [] as Address[], bcc: [] as Address[], subject: "s", text: "hola", messageId: "m1@terno", inReplyTo: null, references: [], providerThreadId: null };
const NASTY: Address[] = [
  A('Pérez, "Lucho" (MX)', "l@x.mx"),
  A("John Q. Public", "j@x.com"),
  A("Back\\slash; semi: colon", "s@x.com"),
  A("山田 太郎", "y@x.jp"),
  A("שלום עליכם", "s@x.co.il"),
  A("Zuleika Ñúñez de la Peña y Fernández-Villaverde, Directora General", "z@acme.studio"),
  A("", "plain@x.com"),
];
// (a name that is itself an address, or spells one in brackets, reads back without it by design: core address.test.ts)

describe("what we write parses back the same (both builders)", () => {
  const builders = {
    portable: async (p: typeof base) => buildRawPortable(p),
    nodemailer: async (p: typeof base) => new Uint8Array(await buildRaw(p)),
  };
  for (const [label, build] of Object.entries(builders)) {
    it(`${label}: nasty names round-trip through a parser`, async () => {
      const raw = await build({ ...base, to: NASTY, cc: [A("Ünï", "user@bücher.de")] });
      const parsed = await parseRaw(raw);
      expect(parsed.to).toEqual(NASTY.map((a) => ({ ...a, email: a.email.toLowerCase() })));
      // a Unicode domain goes out as punycode
      expect(parsed.cc).toEqual([A("Ünï", "user@xn--bcher-kva.de")]);
    });

    it(`${label}: encoded words stay within 75 characters and lines within 998, with 300 recipients`, async () => {
      const many = Array.from({ length: 300 }, (_, i) => A(`Persona Número ${i} — ñandú`, `p${i}@x.com`));
      const raw = new TextDecoder().decode(await build({ ...base, to: many, subject: "Reunión ".repeat(40) }));
      const head = raw.slice(0, raw.indexOf("\r\n\r\n"));
      expect(head.split("\r\n").every((l) => l.length <= 998)).toBe(true);
      for (const w of head.match(/=\?[^?]+\?[BQbq]\?[^?]*\?=/g) ?? []) expect(w.length).toBeLessThanOrEqual(75);
      const parsed = await parseRaw(raw);
      expect(parsed.to).toHaveLength(300);
      expect(parsed.to[299]).toEqual(A("Persona Número 299 — ñandú", "p299@x.com"));
      expect(parsed.subject).toBe("Reunión ".repeat(40));
    });

    it(`${label}: no line break, bidi control or zero-width character goes out in a name`, async () => {
      const raw = new TextDecoder().decode(await build({ ...base, to: [A("Ana\r\nBcc: spy@evil.com\u{202E}\u{200B}", "ana@x.com")] }));
      expect(raw).not.toMatch(/^Bcc:/m);
      expect(raw).not.toMatch(/[\u{202E}\u{200B}]/u);
      expect((await parseRaw(raw)).to).toEqual([A("Ana Bcc: spy@evil.com", "ana@x.com")]);
    });
  }
});

describe("what the Codex review of the reconciliation with plan 27 changed", () => {
  it("1 a raw Reply-To is never split, even with a bracketed address and a comma in its name (a Cc still is)", async () => {
    const p = await parseRaw(message(`From: a@x.com\r\nTo: me@mine.com\r\nReply-To: "Support <audit@thirdparty.test>, Helpdesk" <session@help.test>\r\nCc: "Support <audit@thirdparty.test>, Helpdesk" <session@help.test>`));
    expect(p.replyTo).toEqual([A("Support, Helpdesk", "session@help.test")]);
    expect(p.cc.map((a) => a.email)).toEqual(["audit@thirdparty.test", "session@help.test"]);
  });

  it("3 without the raw field, only an envelope Reply-To that is exactly From is dropped; a list that includes From is kept whole", () => {
    const from = [{ name: "Sender", address: "sender@example.com" }];
    const none = headerFields(undefined);
    expect(messageAddresses(none, { from, replyTo: from }).replyTo).toEqual([]);
    expect(messageAddresses(none, { from, replyTo: [...from, { name: "Support", address: "support@example.com" }] }).replyTo).toEqual([A("Sender", "sender@example.com"), A("Support", "support@example.com")]);
    // with the raw field, Reply-To equal to From is what the message says
    const raw = headerFields(new TextEncoder().encode("From: Sender <sender@example.com>\r\nReply-To: Sender <sender@example.com>\r\n\r\n"));
    expect(messageAddresses(raw).replyTo).toEqual([A("Sender", "sender@example.com")]);
  });
});
