import { describe, expect, it } from "vitest";
import { canonicalMessageId, isMailLinkId, mailLink, MESSAGE_ID_MAX, parseMailLink } from "./mail-link";

describe("the canonical Message-ID (plan 201)", () => {
  it("is the header without spaces and brackets, in lower case", () => {
    expect(canonicalMessageId("  <CAF3x+9@Mail.Gmail.com> ")).toBe("caf3x+9@mail.gmail.com");
    expect(canonicalMessageId("CAF3x+9@mail.gmail.com")).toBe("caf3x+9@mail.gmail.com");
    expect(canonicalMessageId("< a@b >")).toBe("a@b");
    expect(canonicalMessageId("<>")).toBeNull();
    expect(canonicalMessageId("")).toBeNull();
    expect(canonicalMessageId(null)).toBeNull();
  });

  it("the same header gives the same link whatever its brackets, spaces and case (any device derives it)", () => {
    const forms = ["<Abc.123$x/y=z%q@Host.Example>", "abc.123$x/y=z%q@host.example", " <ABC.123$X/Y=Z%Q@HOST.EXAMPLE>"];
    const links = new Set(forms.map(mailLink));
    expect(links.size).toBe(1);
    expect([...links][0]).toBe("terno://message/abc.123%24x%2Fy%3Dz%25q%40host.example");
  });
});

describe("links", () => {
  it("round-trip to the canonical id", () => {
    for (const header of ["<caf3x+9@mail.gmail.com>", "<a/b?c#d@x>", "<ñandú@ejemplo.es>", "<1.2.3@[127.0.0.1]>"]) {
      expect(parseMailLink(mailLink(header))).toBe(canonicalMessageId(header));
    }
  });

  it("no Message-ID, no link", () => {
    expect(mailLink(null)).toBeNull();
    expect(mailLink("  <> ")).toBeNull();
    expect(mailLink(`<${"x".repeat(MESSAGE_ID_MAX + 1)}>`)).toBeNull();
  });

  it("reads the scheme and host in any case, and a trailing slash", () => {
    expect(parseMailLink("TERNO://Message/a%40b")).toBe("a@b");
    expect(parseMailLink("terno://message/A%40B/")).toBe("a@b");
  });

  it("refuses anything that isn't exactly a link to one message", () => {
    for (const url of [
      "https://message/a%40b",
      "terno://thread/a%40b",
      "terno://message/",
      "terno://message/a/b",
      "terno://message/a%40b?x=1",
      "terno://message/a%40b#x",
      "terno://message/%E0%A4%A",
      "terno://message/%3C%3E",
      "terno://message/a%0Ab",
      `terno://message/${"x".repeat(MESSAGE_ID_MAX + 1)}`,
      "terno:message/a%40b",
      42,
      null,
    ]) expect(parseMailLink(url), String(url)).toBeNull();
  });

  it("an id is valid only in its canonical form", () => {
    expect(isMailLinkId("a@b")).toBe(true);
    expect(isMailLinkId("A@b")).toBe(false);
    expect(isMailLinkId("<a@b>")).toBe(false);
    expect(isMailLinkId("")).toBe(false);
    expect(isMailLinkId(7)).toBe(false);
  });
});
