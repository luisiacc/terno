import { describe, expect, it } from "vitest";
import { authenticationResults, describeOriginal, ORIGINAL_HEADERS_MAX, ORIGINAL_SOURCE_MAX, originalFields, originalFilename } from "./original";

const bytes = (s: string) => new TextEncoder().encode(s);

const MESSAGE = [
  "Delivered-To: me@example.test",
  "Received: by 2002:a05:1234 with SMTP id x;",
  "        Tue, 25 Nov 2025 10:00:02 -0800 (PST)",
  "Authentication-Results: mx.google.com;",
  "       dkim=pass header.i=@news.example.com header.s=s1 header.b=abc;",
  "       spf=pass (google.com: domain of bounce@news.example.com designates 192.0.2.1 as permitted sender) smtp.mailfrom=bounce@news.example.com;",
  "       dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=example.com",
  "Authentication-Results: relay.example.net; spf=fail smtp.mailfrom=forged.test",
  "Message-ID: <abc.123@news.example.com>",
  "Date: Tue, 25 Nov 2025 10:00:00 -0800",
  "From: =?UTF-8?Q?Caf=C3=A9_News?= <news@example.com>",
  "To: Me <me@example.test>",
  "Subject: =?UTF-8?B?SGVsbG8g8J+Riw==?=",
  " and more",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<p>Hi</p>",
  "",
].join("\r\n");

describe("describeOriginal (plan 272)", () => {
  it("reads the summary from the header block: unfolded, encoded words decoded", () => {
    const view = describeOriginal(bytes(MESSAGE));
    expect(view.size).toBe(bytes(MESSAGE).length);
    expect(view.headers.startsWith("Delivered-To: me@example.test\r\n")).toBe(true);
    expect(view.headers.endsWith("Content-Type: text/html; charset=utf-8")).toBe(true);
    expect(view.headersCut).toBe(false);
    expect(view.source).toBe(MESSAGE);
    expect(view.sourceCut).toBe(false);
    expect(view.summary).toMatchObject({
      messageId: "abc.123@news.example.com",
      date: { text: "Tue, 25 Nov 2025 10:00:00 -0800", time: Date.UTC(2025, 10, 25, 18) },
      from: "Café News <news@example.com>",
      to: "Me <me@example.test>",
      subject: "Hello 👋 and more",
      deliveredTo: "me@example.test",
    });
  });

  it("takes the topmost Authentication-Results and names its reporter", () => {
    expect(describeOriginal(bytes(MESSAGE)).summary.auth).toEqual({
      reporter: "mx.google.com",
      spf: { result: "pass", about: "bounce@news.example.com" },
      dkim: { result: "pass", about: "news.example.com" },
      dmarc: { result: "pass", about: "example.com" },
    });
  });

  it("reads comments, quoted values and several results for one method", () => {
    expect(authenticationResults("mx.example; dkim=fail (bad sig) header.d=a.test; dkim=pass header.d=\"b.test\"; spf=softfail (x; y) smtp.helo=h.test")).toEqual({
      reporter: "mx.example",
      dkim: { result: "pass", about: "b.test" },
      spf: { result: "softfail", about: "h.test" },
    });
    // no authserv-id: nothing to name, so nothing is shown
    expect(authenticationResults("spf=pass smtp.mailfrom=a.test")).toBeUndefined();
  });

  it("never reads a verdict out of a quoted value, and reads spaces around = (Codex code review #9)", () => {
    expect(authenticationResults('mx.example; spf = pass smtp.mailfrom = a.test; dkim=fail reason="refused; dmarc=pass header.from=forged.test; check policy" header.d=a.test')).toEqual({
      reporter: "mx.example",
      spf: { result: "pass", about: "a.test" },
      dkim: { result: "fail", about: "a.test" },
    });
  });

  it("reads a field folded over thousands of lines once, kept to its bound", () => {
    const folded = `Authentication-Results: mx.example; spf=pass smtp.mailfrom=a.test\n${" x\n".repeat(60_000)}Subject: after`;
    const fields = originalFields(folded);
    expect(fields.map((f) => f.name)).toEqual(["authentication-results", "subject"]);
    expect(fields[0]!.value.length).toBeLessThanOrEqual(16 * 1024);
  });

  it("leaves out what the headers don't have", () => {
    const view = describeOriginal(bytes("From: a@b.test\nDate: not a date\n\nbody"));
    expect(view.summary).toEqual({ from: "a@b.test", date: { text: "not a date", time: null } });
    expect(view.headers).toBe("From: a@b.test\nDate: not a date");
  });

  it("shows a message of nothing but headers whole", () => {
    expect(describeOriginal(bytes("Subject: only")).headers).toBe("Subject: only");
  });

  it("cuts the header block at its bound, and reads a folded field cut there by its start", () => {
    const long = `Subject: s\nX-Long: ${"a".repeat(ORIGINAL_HEADERS_MAX)}\n folded\n\nbody`;
    const view = describeOriginal(bytes(long));
    expect(view.headersCut).toBe(true);
    expect(view.headers.length).toBe(ORIGINAL_HEADERS_MAX);
    expect(view.summary.subject).toBe("s");
  });

  it("cuts the source at the last line break before its bound and keeps the size", () => {
    const line = `${"x".repeat(99)}\n`;
    const source = `Subject: big\n\n${line.repeat(Math.ceil(ORIGINAL_SOURCE_MAX / 100) + 10)}`;
    const view = describeOriginal(bytes(source));
    expect(view.sourceCut).toBe(true);
    expect(view.size).toBe(source.length);
    expect(view.source.length).toBeLessThanOrEqual(ORIGINAL_SOURCE_MAX);
    expect(view.source.endsWith("\n")).toBe(true);
  });

  it("unfolds fields in order", () => {
    expect(originalFields("A: 1\nB: 2\n\t3\nnot a field\nC:4")).toEqual([{ name: "a", value: "1" }, { name: "b", value: "2 3" }, { name: "c", value: "4" }]);
  });
});

describe("originalFilename (plan 272, Codex code review #11)", () => {
  it("keeps .eml on a long subject, and a slash as part of the name", () => {
    const long = originalFilename("Re: ".repeat(60), "message");
    expect(long.endsWith(".eml")).toBe(true);
    expect(long.length).toBeLessThanOrEqual(104);
    expect(originalFilename("Invoice 3/2026: paid", "message")).toBe("Invoice 3-2026- paid.eml");
    expect(originalFilename("  ...  ", "mensaje")).toBe("mensaje.eml");
  });
});
