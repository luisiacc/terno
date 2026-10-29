import { describe, expect, it } from "vitest";
import { parseRaw, parseRawHeaders } from "./mime";

const raw = (headers: string) => `From: Xataka <boletin@xataka.com>\r\nTo: me@mine.com\r\nSubject: Hola\r\nMessage-ID: <a@x>\r\n${headers}\r\n\r\nCuerpo\r\n`;

describe("parseRaw: bulk headers (plan 17)", () => {
  it("List-Unsubscribe, Precedence bulk/list/junk and Auto-Submitted mark bulk mail; a person's mail has none", async () => {
    expect((await parseRaw(raw(""))).bulk).toBe(false);
    expect((await parseRaw(raw("List-Unsubscribe: <https://xataka.com/u>"))).bulk).toBe(true);
    expect((await parseRaw(raw("Precedence: bulk"))).bulk).toBe(true);
    expect((await parseRaw(raw("Precedence: list"))).bulk).toBe(true);
    expect((await parseRaw(raw("Auto-Submitted: auto-generated"))).bulk).toBe(true);
    expect((await parseRaw(raw("Auto-Submitted: no"))).bulk).toBe(false);
    expect((await parseRaw(raw("List-Id: Boletin <boletin.xataka.com>"))).listId).toBe("boletin.xataka.com");
  });
});


describe("parseRaw: Reply-To", () => {
  it("retains every reply destination and a quoted comma name separately from From", async () => {
    const message = await parseRaw(raw('Reply-To: "Support, Session" <Session@help.test>, List <list@help.test>'));
    expect(message.from).toEqual({ name: "Xataka", email: "boletin@xataka.com" });
    expect(message).toMatchObject({ replyTo: [{ name: "Support, Session", email: "session@help.test" }, { name: "List", email: "list@help.test" }] });
    expect(await parseRaw(raw(""))).toMatchObject({ replyTo: [] });
  });
});


describe("attachment bytes", () => {
  it("retains binary, empty, duplicate filenames and inline CID parts", async () => {
    const source = ["From: me@test.com", "MIME-Version: 1.0", 'Content-Type: multipart/mixed; boundary="parts"', "", "--parts", "Content-Type: text/plain", "", "body", ...["AP+A", "", "AQID"].flatMap((data, i) => ["--parts", "Content-Type: image/png", `Content-Disposition: ${i === 2 ? "inline" : "attachment"}; filename="same.png"`, ...(i === 2 ? ["Content-ID: <Photo@Test>"] : []), "Content-Transfer-Encoding: base64", "", data]), "--parts--", ""].join("\r\n");
    const parsed = await parseRaw(source);
    expect(parsed.attachments).toHaveLength(3);
    expect(parsed.attachments.map((a) => [...a.bytes!])).toEqual([[0,255,128], [], [1,2,3]]);
    expect(parsed.attachments[2]).toMatchObject({ contentId: "Photo@Test" });
  });
});

describe("incoming capture budgets", () => {
  it("parses valid incoming raw sources between 35 and 70 MiB independently of the outgoing ceiling", async () => {
    for (const mib of [36, 70]) {
      const header = 'From: Sender <sender@test.com>\r\nSubject: Large incoming\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="large.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\n';
      const lines = Math.floor((mib * 1024 * 1024 - header.length) / 78);
      const source = new TextEncoder().encode(header + ("paWl".repeat(19) + "\r\n").repeat(lines));
      const parsed = await parseRaw(source);
      expect(parsed.subject).toBe("Large incoming");
      expect(parsed.attachments[0]!.bytes!.length).toBe(lines * 57);
      expect(parsed.attachments[0]!.bytes![0]).toBe(165);
      expect(parsed.attachments[0]!.bytes!.at(-1)).toBe(165);
    }
  }, 60000);

  it("an over-budget source returns bounded headers and an explicit unavailable capture, never truncated content", async () => {
    const source = new Uint8Array(75 * 1024 * 1024 + 1);
    source.set(new TextEncoder().encode('From: Sender <sender@test.com>\r\nSubject: Oversize envelope\r\nContent-Type: multipart/mixed; boundary="not-parsed"\r\n\r\n'));
    const parsed = await parseRaw(source);
    expect(await parseRawHeaders(source.subarray(0, 65536), "size")).toEqual(parsed);
    expect(parsed).toMatchObject({ subject: "Oversize envelope", from: { email: "sender@test.com" }, text: null, html: null, attachments: [], captureUnavailable: "size" });
  });
});

const wirePart = (type: string, body: string, headers: string[] = []) => [`Content-Type: ${type}`, ...headers, "", body].join("\r\n");
const wireMultipart = (kind: string, boundary: string, parts: string[]) => wirePart(`multipart/${kind}; boundary="${boundary}"`, [...parts.map((part) => `--${boundary}\r\n${part}`), `--${boundary}--`].join("\r\n"));
const envelope = (body: string) => ["From: Outer <outer@test.com>", "To: outside@test.com", "Subject: Envelope", "Message-ID: <outer@test>", "In-Reply-To: <parent@test>", "References: <root@test> <parent@test>", "MIME-Version: 1.0", body].join("\r\n");
const identity = { from: { name: "Outer", email: "outer@test.com" }, to: [{ name: "", email: "outside@test.com" }], subject: "Envelope", rfcMessageId: "outer@test", inReplyTo: "parent@test", references: ["root@test", "parent@test"], date: null };

describe("parseRaw: MIME tree compatibility (W10)", () => {
  it("selects representations in alternatives but retains sequential mixed content", async () => {
    const parts = [wirePart("text/plain", "Author plain"), wirePart("text/html", "<p>HTML representation</p>")];
    expect(await parseRaw(envelope(wireMultipart("alternative", "a", parts)))).toMatchObject({ ...identity, text: "Author plain", html: "<p>HTML representation</p>", attachments: [] });
    expect(await parseRaw(envelope(wireMultipart("mixed", "m", [...parts, wirePart("text/plain", "Tail")])))).toMatchObject({ ...identity, text: "Author plain\n\nHTML representation\n\nTail", html: "<div>Author plain</div>\n<p>HTML representation</p>\n<div>Tail</div>", attachments: [] });
  });

  it("keeps nested related/alternative bodies, sequential default text and exact CID/attachment bytes", async () => {
    const alternative = wireMultipart("alternative", "a", [wirePart("text/plain; charset=utf-8", "Useful café"), wirePart("text/html; charset=utf-8", '<p>Useful café<img src="cid:Photo@Test"></p>')]);
    const related = wireMultipart("related", "r", [alternative, wirePart("image/png", "AP+A", ["Content-Disposition: inline; filename=photo.png", "Content-ID: <Photo@Test>", "Content-Transfer-Encoding: base64"])]);
    const message = await parseRaw(envelope(wireMultipart("mixed", "m", [related, "\r\nDefault tail", wirePart("text/plain", "Private attachment", ["Content-Disposition: attachment; filename=notes.txt"])])));
    expect(message).toMatchObject({ ...identity, text: "Useful café\nDefault tail", html: '<p>Useful café<img src="cid:Photo@Test"></p>\n<div>Default tail</div>' });
    expect(message.attachments).toEqual([
      { filename: "photo.png", mime: "image/png", size: 3, contentId: "Photo@Test", bytes: new Uint8Array([0, 255, 128]) },
      { filename: "notes.txt", mime: "text/plain", size: 18, contentId: null, bytes: new TextEncoder().encode("Private attachment") },
    ]);
  });

  it("keeps useful plain text when its HTML alternative is empty", async () => {
    expect(await parseRaw(envelope(wireMultipart("alternative", "a", [wirePart("text/plain", "Useful plain"), wirePart("text/html", "")])))).toMatchObject({ ...identity, text: "Useful plain", html: null, attachments: [] });
  });

  it("uses visible HTML fallback when the plain alternative is empty", async () => {
    const source = envelope(wireMultipart("alternative", "a", [wirePart("text/plain", ""), wirePart("text/html", '<span hidden>Hidden preheader</span><p>Useful fallback</p>')]));
    expect(await parseRaw(source)).toMatchObject({ ...identity, text: "Useful fallback", html: '<span hidden>Hidden preheader</span><p>Useful fallback</p>', attachments: [] });
  });

  const forwarded = ["From: Inner <inner@test.com>", "To: inside@test.com", "Subject: Forwarded", "Message-ID: <inner@test>", "", "Inner body"].join("\r\n");
  it.each(["explicit RFC822", "default digest"])("inlines %s without replacing outer source identity", async (kind) => {
    const body = kind === "explicit RFC822" ? wirePart("message/rfc822", forwarded) : wireMultipart("digest", "d", [`\r\n${forwarded}`]);
    expect(await parseRaw(envelope(body))).toMatchObject({ ...identity, html: null, attachments: [], text: "\n-------------------------------\nFrom:    Inner <inner@test.com>\nSubject: Forwarded\nTo:      inside@test.com\n-------------------------------\n\nInner body\n" });
  });

  it("retains attached RFC822 bytes without promoting its body or identity", async () => {
    const bytes = new TextEncoder().encode(forwarded + "\r\n");
    const body = wireMultipart("mixed", "m", [wirePart("text/plain", "Outer body"), wirePart("message/rfc822", Buffer.from(bytes).toString("base64"), ["Content-Disposition: attachment; filename=forward.eml", "Content-Transfer-Encoding: base64"])]);
    expect(await parseRaw(envelope(body))).toMatchObject({ ...identity, text: "Outer body", html: null, attachments: [{ filename: "forward.eml", mime: "message/rfc822", size: bytes.length, contentId: null, bytes }] });
  });

  // PostalMime4.1.3 loses the outer selector; no public option repairs assembly (Plan33 W10 blocker).
  it.fails("BLOCKED: chooses only the inner representation when an outer alternative contains related alternatives", async () => {
    const inner = wireMultipart("alternative", "i", [wirePart("text/plain", "Chosen plain"), wirePart("text/html", "<p>Chosen HTML</p>")]);
    const source = envelope(wireMultipart("alternative", "o", [wirePart("text/plain", "Outer fallback"), wireMultipart("related", "r", [inner])]));
    const message = await parseRaw(source);
    expect({ text: message.text, html: message.html }).toEqual({ text: "Chosen plain", html: "<p>Chosen HTML</p>" });
  });
});

describe("parseRaw: optional header and charset compatibility (W10)", () => {
  it.each([
    ["missing", "", null],
    ["invalid", "Date: definitely not a date\r\n", null],
    ["future", "Date: Thu, 01 Jan 2099 12:00:00 +0000\r\n", 4070952000000],
    ["duplicate invalid first", "Date: invalid\r\nDate: Thu, 01 Jan 2099 12:00:00 +0000\r\n", null],
    ["duplicate valid first", "Date: Thu, 01 Jan 2099 12:00:00 +0000\r\nDate: invalid\r\n", 4070952000000],
  ])("maps %s dates without inventing a current date", async (_name, headers, date) => {
    expect(await parseRaw(envelope(`${headers}Content-Type: text/plain\r\n\r\nUseful body`))).toMatchObject({ ...identity, date, text: "Useful body\n", html: null, attachments: [] });
  });

  it("uses first scalar headers and accumulates repeated recipient headers in source order", async () => {
    const source = envelope(["Subject: Other subject", "Message-ID: <other@test>", "In-Reply-To: <other-parent@test>", "References: <other-root@test>", "Cc: First <FIRST@test.com>", "Cc: Second <SECOND@test.com>", "Reply-To: Help <HELP@test.com>", "Reply-To: List <LIST@test.com>", "List-Id: Team <team.test>", "List-Id: Other <other.test>", "", "Useful body"].join("\r\n"));
    expect(await parseRaw(source)).toMatchObject({ ...identity, text: "Useful body\n", cc: [{ name: "First", email: "first@test.com" }, { name: "Second", email: "second@test.com" }], replyTo: [{ name: "Help", email: "help@test.com" }, { name: "List", email: "list@test.com" }], listId: "team.test" });
  });

  it.each([
    ["UTF8", "caf=C3=A9", "café"],
    ["legacy bytes", "caf=E9 =80", "café €"],
  ])("recovers an unknown charset with %s bytes", async (_name, encoded, text) => {
    const source = envelope(wirePart('text/plain; charset="not-a-real-charset"', encoded, ["Content-Transfer-Encoding: quoted-printable"]));
    expect(await parseRaw(new TextEncoder().encode(source))).toMatchObject({ ...identity, text: `${text}\n`, html: null, attachments: [] });
    const htmlSource = envelope(wirePart('text/html; charset="not-a-real-charset"', `<p>${encoded}</p>`, ["Content-Transfer-Encoding: quoted-printable"]));
    expect(await parseRaw(new TextEncoder().encode(htmlSource))).toMatchObject({ ...identity, text, html: `<p>${text}</p>\n`, attachments: [] });
  });
});
