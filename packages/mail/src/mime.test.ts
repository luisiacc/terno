import { createRequire } from "node:module";
import PostalMime from "postal-mime";
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

  it("chooses only the inner representation when an outer alternative contains related alternatives", async () => {
    const inner = wireMultipart("alternative", "i", [wirePart("text/plain", "Chosen plain"), wirePart("text/html", "<p>Chosen HTML</p>")]);
    const source = envelope(wireMultipart("alternative", "o", [wirePart("text/plain", "Outer fallback"), wireMultipart("related", "r", [inner])]));
    const message = await parseRaw(source);
    expect({ text: message.text, html: message.html }).toEqual({ text: "Chosen plain", html: "<p>Chosen HTML</p>" });
  });
});

describe("parseRaw: nested alternative selection (W10 patch)", () => {
  it("preserves the original CommonJS constructor and static parse API", async () => {
    const CommonJS: typeof PostalMime = createRequire(import.meta.url)("postal-mime");
    const source = envelope(wireMultipart("alternative", "o", [wirePart("text/plain", "Fallback"), wireMultipart("alternative", "i", [wirePart("text/plain", "Chosen"), wirePart("text/html", "<p>Chosen HTML</p>")])]));
    const parsed = await CommonJS.parse(source);
    expect(parsed).toMatchObject({ messageId: "<outer@test>", text: "Chosen", html: "<p>Chosen HTML</p>" });
    expect(await new CommonJS().parse(source)).toEqual(parsed);
  });

  const plain = (text: string) => wirePart("text/plain", text);
  const html = (text: string) => wirePart("text/html", text);
  const chosen = wireMultipart("alternative", "i", [plain("Chosen plain"), html("<p>Chosen HTML</p>")]);

  it.each([
    ["direct nested alternatives", wireMultipart("alternative", "o", [plain("Outer fallback"), chosen]), "Chosen plain", "<p>Chosen HTML</p>"],
    ["missing inner plain retains outer plain", wireMultipart("alternative", "o", [plain("Outer fallback"), wireMultipart("alternative", "i", [html("<p>Chosen HTML</p>")])]), "Outer fallback", "<p>Chosen HTML</p>"],
    ["missing inner HTML retains outer HTML", wireMultipart("alternative", "o", [html("<p>Outer fallback</p>"), wireMultipart("alternative", "i", [plain("Chosen plain")])]), "Chosen plain", "<p>Outer fallback</p>"],
    ["sequential parts within selected mixed branch", wireMultipart("alternative", "o", [plain("Outer fallback"), wireMultipart("mixed", "m", [plain("Start"), chosen, plain("End")])]), "Start\nChosen plain\nEnd", "<div>Start</div>\n<p>Chosen HTML</p>\n<div>End</div>"],
    ["sequential siblings outside alternatives", wireMultipart("mixed", "m", [wireMultipart("alternative", "o", [plain("Outer fallback"), chosen]), plain("Middle"), wireMultipart("alternative", "s", [plain("Sibling plain"), html("<p>Sibling HTML</p>")])]), "Chosen plain\nMiddle\nSibling plain", "<p>Chosen HTML</p>\n<div>Middle</div>\n<p>Sibling HTML</p>"],
    ["explicit empty plain preserves visible HTML fallback", wireMultipart("alternative", "o", [plain("Outer fallback"), wireMultipart("alternative", "i", [plain(""), html('<span hidden>Hidden</span><p>Useful HTML</p>')])]), "Useful HTML", '<span hidden>Hidden</span><p>Useful HTML</p>'],
    ["explicit empty HTML remains absent publicly", wireMultipart("alternative", "o", [html("<p>Outer fallback</p>"), wireMultipart("alternative", "i", [plain("Useful plain"), html("")])]), "Useful plain", null],
    ["mixed HTML then plain converts each entry", wireMultipart("alternative", "o", [plain("Outer fallback"), wireMultipart("mixed", "m", [html("<p>First</p>"), plain("Last")])]), "\nFirst\n\nLast", "<p>First</p>\n<div>Last</div>"],
    ["mixed plain then HTML converts each entry", wireMultipart("alternative", "o", [plain("Outer fallback"), wireMultipart("mixed", "m", [plain("First"), html("<p>Last</p>")])]), "First\n\nLast\n", "<div>First</div>\n<p>Last</p>"],
    ["empty sequential entry retains separators", wireMultipart("alternative", "o", [plain("Outer fallback"), wireMultipart("mixed", "m", [plain("Start"), plain(""), plain("End")])]), "Start\n\nEnd", null],
    ["last same-type alternative wins", wireMultipart("alternative", "o", [plain("First fallback"), html("<p>HTML</p>"), plain("Last plain")]), "Last plain", "<p>HTML</p>"],
  ] as const)("%s", async (_name, body, text, expectedHtml) => {
    expect(await parseRaw(envelope(body))).toMatchObject({ ...identity, text, html: expectedHtml, attachments: [] });
  });

  it("retains fallback for an unsupported branch and exact attachments from every branch", async () => {
    const attachment = wirePart("application/octet-stream", "AP+A", ["Content-Disposition: attachment; filename=part.bin", "Content-Transfer-Encoding: base64"]);
    const source = envelope(wireMultipart("alternative", "o", [wireMultipart("mixed", "m", [plain("Outer fallback"), attachment]), wireMultipart("related", "r", [attachment])]));
    const message = await parseRaw(source);
    expect(message).toMatchObject({ ...identity, text: "Outer fallback", html: null });
    expect(message.attachments).toEqual(Array.from({ length: 2 }, () => ({ filename: "part.bin", mime: "application/octet-stream", size: 3, contentId: null, bytes: new Uint8Array([0, 255, 128]) })));
  });

  it("preserves the related root, CID resources and sequential attachments in both package entries", async () => {
    const image = (cid: string, data: string) => wirePart("image/png", data, [`Content-ID: <${cid}>`, `Content-Disposition: inline; filename=${cid}.png`, "Content-Transfer-Encoding: base64"]);
    const root = ["Content-ID: <root>", wireMultipart("alternative", "i", [plain("Chosen plain"), html('<p>Chosen HTML<img src="cid:before"></p>')])].join("\r\n");
    const related = wirePart('multipart/related; boundary="r"; start="<root>"', ["--r", image("before", "AP+A"), "--r", root, "--r", image("after", "AQID"), "--r--"].join("\r\n"));
    const source = envelope(wireMultipart("alternative", "o", [plain("Outer fallback"), related]));
    const message = await parseRaw(source);
    expect(message).toMatchObject({ ...identity, text: "Chosen plain", html: '<p>Chosen HTML<img src="cid:before"></p>' });
    expect(message.attachments).toEqual([
      { filename: "before.png", mime: "image/png", size: 3, contentId: "before", bytes: new Uint8Array([0, 255, 128]) },
      { filename: "after.png", mime: "image/png", size: 3, contentId: "after", bytes: new Uint8Array([1, 2, 3]) },
    ]);
    const commonjs: { default: typeof PostalMime } = createRequire(import.meta.url)("postal-mime");
    for (const parser of [PostalMime, commonjs.default]) {
      const parsed = await parser.parse(source);
      expect({ text: parsed.text, html: parsed.html }).toEqual({ text: message.text, html: message.html });
      expect(parsed.attachments.map((part) => ({ cid: part.contentId, bytes: [...new Uint8Array(typeof part.content === "string" ? new TextEncoder().encode(part.content) : part.content)] }))).toEqual([{ cid: "<before>", bytes: [0, 255, 128] }, { cid: "<after>", bytes: [1, 2, 3] }]);
    }
  });

  const commonjs: { default: typeof PostalMime } = createRequire(import.meta.url)("postal-mime");
  it.each([PostalMime, commonjs.default])("keeps explicit empty representations and RFC822 groups in %s", async (parser) => {
    for (const [parts, omitted, retained] of [
      [[plain("Outer fallback"), wireMultipart("alternative", "i", [plain(""), html("<p>Useful</p>")])], "text", { html: "<p>Useful</p>" }],
      [[html("<p>Outer fallback</p>"), wireMultipart("alternative", "i", [plain("Useful"), html("")])], "html", { text: "Useful" }],
    ] as const) {
      const parsed = await parser.parse(envelope(wireMultipart("alternative", "o", [...parts])));
      expect(Object.hasOwn(parsed, omitted)).toBe(false);
      expect(parsed).toMatchObject(retained);
    }
    const forwarded = ["From: Inner <inner@test.com>", "Subject: Forwarded", wireMultipart("mixed", "f", [plain("Forwarded body"), wirePart("application/octet-stream", "AP+A", ["Content-Transfer-Encoding: base64", "Content-Disposition: attachment; filename=inner.bin"])])].join("\r\n");
    const forwardPart = wirePart("message/rfc822", Buffer.from(forwarded).toString("base64"), ["Content-Transfer-Encoding: base64"]);
    for (const [parts, expected] of [
      [[forwardPart, chosen], "Chosen plain"],
      [[chosen, forwardPart], "\n-------------------------------\nFrom:    Inner <inner@test.com>\nSubject: Forwarded\n-------------------------------\n\nForwarded body"],
    ] as const) {
      const parsed = await parser.parse(envelope(wireMultipart("alternative", "o", [...parts])));
      expect(parsed.text).toBe(expected);
      expect(parsed.html).toBe("<p>Chosen HTML</p>");
      expect(parsed.attachments.map((part) => ({ filename: part.filename, bytes: [...new Uint8Array(typeof part.content === "string" ? new TextEncoder().encode(part.content) : part.content)] }))).toEqual([{ filename: "inner.bin", bytes: [0, 255, 128] }]);
    }
    const limited = await parseRaw(envelope(wireMultipart("alternative", "o", [forwardPart, chosen])), { limits: { maxRfc822NestingDepth: 0 } });
    expect(limited).toMatchObject({ ...identity, text: "Chosen plain", html: "<p>Chosen HTML</p>" });
    expect(limited.attachments).toEqual([{ filename: "attachment", mime: "message/rfc822", size: Buffer.byteLength(forwarded), contentId: null, bytes: new TextEncoder().encode(forwarded) }]);
  });

  it("enforces limits inside discarded branches with bounded selected controls", async () => {
    const baseline = envelope(wireMultipart("alternative", "o", [chosen]));
    for (const limits of [{ maxPartCount: 8 }, { maxNestingDepth: 3 }, { maxHeadersSize: 4096 }, { maxForwardedAddresses: 1 }]) {
      expect(await parseRaw(baseline, { limits })).toMatchObject({ text: "Chosen plain", html: "<p>Chosen HTML</p>" });
    }
    const source = (branch: string) => envelope(wireMultipart("alternative", "o", [branch, chosen]));
    const forward = (body: string) => wirePart("message/rfc822", body);
    await expect(parseRaw(source(forward(wireMultipart("mixed", "f", Array.from({ length: 10 }, () => plain("x"))))), { limits: { maxPartCount: 8 } })).rejects.toMatchObject({ code: "EMAXPARTCOUNT" });
    let deep = plain("x");
    for (let i = 0; i < 6; i++) deep = wireMultipart("mixed", `d${i}`, [deep]);
    await expect(parseRaw(source(forward(deep)), { limits: { maxNestingDepth: 3 } })).rejects.toMatchObject({ code: "EMAXNESTINGDEPTH" });
    await expect(parseRaw(source(forward(`X-Pad: ${"x".repeat(5000)}\r\n\r\nx`)), { limits: { maxHeadersSize: 4096 } })).rejects.toMatchObject({ code: "EMAXHEADERSIZE" });
    await expect(parseRaw(source(forward("From: one@test.com\r\nTo: two@test.com\r\n\r\nForwarded")), { limits: { maxForwardedAddresses: 1 } })).rejects.toMatchObject({ code: "EMAXFORWARDEDADDRESSES" });
  });

  it("preserves deep sequential groups and wide independent alternatives without duplicating fallbacks", async () => {
    let deep = chosen;
    const expected = ["Chosen plain"];
    for (let i = 0; i < 32; i++) {
      deep = wireMultipart("alternative", `a${i}`, [plain("Unused fallback"), wireMultipart("mixed", `m${i}`, [deep, plain(`Tail${i}`)])]);
      expected.push(`Tail${i}`);
    }
    expect((await parseRaw(envelope(deep))).text).toBe(expected.join("\n"));
    const wide = wireMultipart("mixed", "w", Array.from({ length: 64 }, (_, i) => wireMultipart("alternative", `a${i}`, [plain("Unused fallback"), wireMultipart("alternative", `b${i}`, [plain(`Plain${i}`), html(`<p>HTML${i}</p>`)])])));
    const message = await parseRaw(envelope(wide));
    expect(message.text).toBe(Array.from({ length: 64 }, (_, i) => `Plain${i}`).join("\n"));
    expect(message.html).toBe(Array.from({ length: 64 }, (_, i) => `<p>HTML${i}</p>`).join("\n"));
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
