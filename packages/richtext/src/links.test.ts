/**
 * The autolink scanner (plan 39): what a token spells, every row of the
 * plan's table, the cap, and linear time on hostile text. Then what reads
 * and writes links: the parse rule, the round trip, and the sent mail's
 * honest hrefs.
 */
import { JSDOM } from "jsdom";
import type { Mark, Node as PMNode } from "prosemirror-model";
import { Slice } from "prosemirror-model";
import { describe, expect, it } from "vitest";
import { spelledLinks, spelledSlice } from "./autolinks";
import { toEmailHtml } from "./html";
import { isEmailAddress, linkIn, linksIn, MAX_URL_LENGTH, normalizeHref, spelledHref, urlIn } from "./links";
import { cleanPastedHtml, parseHtml } from "./parse";
import { schema } from "./schema";
import { toPlainText } from "./text";

const { window } = new JSDOM("<!doctype html><html><body></body></html>");
const impl = window.document.implementation;

/** The text a token links and where it goes, or null. */
const link = (token: string) => {
  const f = linkIn(token);
  return f && { text: token.slice(f.start, f.end), href: f.href };
};

describe("what a token spells", () => {
  it("http(s), www. and mailto: as typed; an address as mailto:", () => {
    expect(link("https://santo.com")).toEqual({ text: "https://santo.com", href: "https://santo.com" });
    expect(link("https://santo")).toEqual({ text: "https://santo", href: "https://santo" });
    expect(link("http://x.com/a")).toEqual({ text: "http://x.com/a", href: "http://x.com/a" });
    expect(link("www.x.com")).toEqual({ text: "www.x.com", href: "https://www.x.com" });
    expect(link("WWW.X.COM/a")).toEqual({ text: "WWW.X.COM/a", href: "https://WWW.X.COM/a" });
    expect(link("HTTPS://X.COM")).toEqual({ text: "HTTPS://X.COM", href: "HTTPS://X.COM" });
    expect(link("ana@x.com")).toEqual({ text: "ana@x.com", href: "mailto:ana@x.com" });
    expect(link("ana.b+tag@mail.x.co.uk")).toEqual({ text: "ana.b+tag@mail.x.co.uk", href: "mailto:ana.b+tag@mail.x.co.uk" });
    expect(link("mailto:ana@x.com")).toEqual({ text: "mailto:ana@x.com", href: "mailto:ana@x.com" });
    expect(link("mailto:ana@x.com?subject=hola")).toEqual({ text: "mailto:ana@x.com?subject=hola", href: "mailto:ana@x.com?subject=hola" });
  });

  it("query, fragment, port, userinfo, IDN, punycode, IP addresses and localhost link as typed", () => {
    for (const url of [
      "https://x.com/a?b=1&c=2#frag",
      "https://x.com:8443/p",
      "https://user:pass@x.com/",
      "https://ñandú.es/página",
      "https://xn--and-6ma2c.es",
      "http://192.168.0.1:8080/x",
      "http://[::1]:3000/",
      "http://localhost:5173",
      "https://en.wikipedia.org/wiki/Foo_(bar)",
      "https://x.com/user_",
      "https://x.com/~ana",
      "https://x.com/a*b",
    ])
      expect(link(url), url).toEqual({ text: url, href: url });
  });

  it("trailing punctuation stays outside; a closing bracket stays while it closes one opened inside", () => {
    for (const p of [".", ",", ";", ":", "!", "?", "…", "...", "?!"]) expect(link(`https://x.com${p}`)?.text, p).toBe("https://x.com");
    expect(link("https://x.com/a.")?.text).toBe("https://x.com/a");
    expect(link("(https://x.com)")?.text).toBe("https://x.com");
    expect(link("(https://x.com).")?.text).toBe("https://x.com");
    expect(link("[https://x.com]")?.text).toBe("https://x.com");
    expect(link("{https://x.com}")?.text).toBe("https://x.com");
    expect(link("(https://en.wikipedia.org/wiki/Foo_(bar))")?.text).toBe("https://en.wikipedia.org/wiki/Foo_(bar)");
    expect(link("https://en.wikipedia.org/wiki/Foo_(bar))")?.text).toBe("https://en.wikipedia.org/wiki/Foo_(bar)");
    expect(link("¿https://x.com?")?.text).toBe("https://x.com");
    expect(link("¡www.x.com!")?.text).toBe("www.x.com");
  });

  it("emphasis and quote marks come off only when the same mark stands before the URL", () => {
    expect(link("'https://x.com'")?.text).toBe("https://x.com");
    expect(link("'(https://x.com)'.")?.text).toBe("https://x.com");
    expect(link("*https://x.com*")?.text).toBe("https://x.com");
    expect(link("**https://x.com**")?.text).toBe("https://x.com");
    expect(link("_https://x.com/a_")?.text).toBe("https://x.com/a");
    expect(link("~https://x.com~")?.text).toBe("https://x.com");
    expect(link("https://x.com/user_")?.text).toBe("https://x.com/user_");
    expect(link("https://x.com/a'")?.text).toBe("https://x.com/a'");
    expect(link("(ana@x.com).")).toEqual({ text: "ana@x.com", href: "mailto:ana@x.com" });
    expect(link("'ana@x.com'")?.text).toBe("ana@x.com");
  });

  it("a URL starts a word: after punctuation that wraps it, not after a letter or URL characters", () => {
    expect(link("ahttps://x.com")).toBeNull();
    expect(link("x.www.y.com")).toBeNull();
    expect(link("a-https://x.com")).toBeNull();
    expect(link("a@www.x.com")?.href).toBe("mailto:a@www.x.com");
    expect(link("see:https://x.com")).toBeNull();
    expect(link("(https://x.com")?.text).toBe("https://x.com");
    expect(link("foo(https://x.com)")?.text).toBe("https://x.com");
  });

  it("two URLs with nothing between them are one link to what the text spells", () => {
    expect(link("https://a.comhttps://b.com")).toEqual({ text: "https://a.comhttps://b.com", href: "https://a.comhttps://b.com" });
    expect(linksIn("<https://a.com><https://b.com>").map((f) => f.href)).toEqual(["https://a.com", "https://b.com"]);
  });

  it("never: other schemes, bare hosts, broken hosts, half-typed schemes", () => {
    for (const t of [
      "javascript:alert(1)",
      "JAVASCRIPT://x.com",
      "data:text/html,x",
      "file:///etc/passwd",
      "ftp://x.com",
      "vbscript:x",
      "example.com",
      "file.txt",
      "node.js",
      "https://",
      "https:/santo.com",
      "https:santo.com",
      "http://.",
      "http://-",
      "https://@",
      "www.santo",
      "www.x.c",
      "www.",
      "mailto:",
      "mailto:ana",
      "ana@x",
      "ana@x.c",
      "@x.com",
      "ana@@x.com",
      "a..b@x.com",
      "",
    ])
      expect(link(t), t).toBeNull();
  });

  it("a scheme-less token loses the link when its scheme goes; www. stays a link", () => {
    expect(link("santo.com")).toBeNull();
    expect(link("www.santo.com")?.href).toBe("https://www.santo.com");
  });

  it("long URLs link up to the cap, not past it", () => {
    const at = (n: number) => `https://x.com/${"a".repeat(n - "https://x.com/".length)}`;
    expect(link(at(600))?.text.length).toBe(600);
    expect(link(at(MAX_URL_LENGTH))?.text.length).toBe(MAX_URL_LENGTH);
    expect(link(at(MAX_URL_LENGTH + 1))).toBeNull();
    expect(spelledHref(at(MAX_URL_LENGTH + 1))).toBeNull();
  });
});

describe("whole texts", () => {
  it("spelledHref: the href when the whole text is one link, nothing around it", () => {
    expect(spelledHref("https://x.com")).toBe("https://x.com");
    expect(spelledHref("www.x.com")).toBe("https://www.x.com");
    expect(spelledHref("ana@x.com")).toBe("mailto:ana@x.com");
    expect(spelledHref("https://x.com/user_")).toBe("https://x.com/user_");
    expect(spelledHref("https://x.com.")).toBeNull();
    expect(spelledHref("(https://x.com)")).toBeNull();
    expect(spelledHref("https://x.com/a b")).toBeNull();
    expect(spelledHref("https://x.com ")).toBeNull();
    expect(spelledHref("https://x.com￼y")).toBeNull();
    expect(spelledHref("click here")).toBeNull();
  });

  it("urlIn (a URL pasted alone) is the whole trimmed text", () => {
    expect(urlIn(" https://x.com/user_ \n")).toBe("https://x.com/user_");
    expect(urlIn("https://x.com.")).toBeNull();
    expect(urlIn("see https://x.com")).toBeNull();
    expect(urlIn("ana@x.com")).toBe("mailto:ana@x.com");
  });

  it("linksIn: every link of a pasted line, in order", () => {
    expect(linksIn("see https://a.com, and (www.b.com) or ana@c.com.").map((f) => f.href)).toEqual(["https://a.com", "https://www.b.com", "mailto:ana@c.com"]);
    const line = "x https://a.com y";
    const [f] = linksIn(line);
    expect(line.slice(f!.start, f!.end)).toBe("https://a.com");
    expect(linksIn("nothing here, javascript:alert(1)")).toEqual([]);
  });

  it("isEmailAddress: the common forms", () => {
    expect(isEmailAddress("ana@x.com")).toBe(true);
    expect(isEmailAddress("josé@ñandú.es")).toBe(true);
    expect(isEmailAddress("ana@x.c0m")).toBe(true);
    expect(isEmailAddress("ana@1.2.3.4")).toBe(false);
    expect(isEmailAddress(".ana@x.com")).toBe(false);
    expect(isEmailAddress("ana@-x.com")).toBe(false);
  });
});

describe("hostile text stays linear", () => {
  /** ms for one call on the input (best of 3) */
  const time = (fn: () => unknown) => {
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      fn();
      best = Math.min(best, performance.now() - t0);
    }
    return best;
  };
  const HOSTILE: Record<string, (n: number) => string> = {
    dots: (n) => `https://x${".".repeat(n)}`,
    parens: (n) => `https://x.com/${"(".repeat(n)}`,
    closers: (n) => `https://x.com/${")".repeat(n)}`,
    openers: (n) => `${"(".repeat(n)}https://x.com`,
    wrappers: (n) => `${"*_~'".repeat(n / 4)}https://x.com${"*_~'".repeat(n / 4)}`,
    www: (n) => "www.".repeat(n / 4),
    schemes: (n) => "http://".repeat(n / 7),
    ats: (n) => "a@".repeat(n / 2),
    dottedAddress: (n) => `a@${"a.".repeat(n / 2)}:`,
    labels: (n) => `www.${"a.".repeat(n / 2)}!`,
  };

  for (const [name, make] of Object.entries(HOSTILE))
    it(`${name}: within budget, ~linear from 8 k to 80 k characters`, () => {
      const small = make(8_000);
      const big = make(80_000);
      // past the cap a token is refused at once; the scanner's own work is measured under it, and linksIn over the big one
      const tSmall = time(() => (linkIn(small.slice(0, MAX_URL_LENGTH)), linksIn(small), normalizeHref(small)));
      const tBig = time(() => (linkIn(big.slice(0, MAX_URL_LENGTH)), linksIn(big), normalizeHref(big)));
      expect(tBig).toBeLessThan(100);
      expect(tBig).toBeLessThan(Math.max(2, tSmall) * 25);
    });
});

// ── reading and writing links

const autoLink = (href: string) => schema.marks.link.create({ href, auto: true });
const manualLink = (href: string) => schema.marks.link.create({ href });
const t = (text: string, ...marks: Mark[]) => schema.text(text, marks);
const p = (...c: PMNode[]) => schema.node("paragraph", null, c);
const doc = (...blocks: PMNode[]) => schema.node("doc", null, blocks);
const links = (d: PMNode) => {
  const out: { text: string; href: string; auto: boolean }[] = [];
  d.descendants((n) => {
    const m = n.marks.find((x) => x.type === schema.marks.link);
    if (n.isText && m) out.push({ text: n.text!, href: m.attrs.href as string, auto: m.attrs.auto as boolean });
  });
  return out;
};

describe("the link mark's auto attribute", () => {
  it("parse: a link whose text spells its href is an autolink; a labelled one is not", () => {
    expect(links(parseHtml('<div><a href="https://x.com">https://x.com</a> <a href="https://www.y.com">www.y.com</a> <a href="mailto:a@x.com">a@x.com</a></div>', impl)).map((l) => l.auto)).toEqual([true, true, true]);
    expect(links(parseHtml('<div><a href="https://tracker.example/r">https://real.example</a> <a href="https://x.com">click</a></div>', impl))).toEqual([
      { text: "https://real.example", href: "https://tracker.example/r", auto: false },
      { text: "click", href: "https://x.com", auto: false },
    ]);
  });

  it("parse: the editor's DOM and Terno's copies are read back as drawn (data-rt-auto, data-rt-manual), whatever the text", () => {
    const paste = (html: string) => parseHtml(cleanPastedHtml(`<div data-pm-slice="1 1 []">${html}</div>`, impl), impl);
    // (the editor's live links put a pasted autolink right; the mail written from it is honest whatever: below)
    expect(links(paste('<a href="https://santo.com" data-rt-auto="">https://santo.co</a>'))).toEqual([{ text: "https://santo.co", href: "https://santo.com", auto: true }]);
    expect(links(paste('<a href="https://x.com" data-rt-manual="">https://x.com</a>'))).toEqual([{ text: "https://x.com", href: "https://x.com", auto: false }]);
    expect(links(parseHtml('<a href="javascript:alert(1)" data-rt-auto="">https://x.com</a>', impl))).toEqual([]);
    // past the cap the editor never draws one: a manual link (Codex review: the live links looped on one)
    const long = `https://x.com/${"a".repeat(MAX_URL_LENGTH)}`;
    expect(links(paste(`<a href="${long}" data-rt-auto="">${long}</a>`))[0]!.auto).toBe(false);
  });

  it("parse: a link with a line break in it spells nothing (a break ends a token)", () => {
    expect(links(parseHtml('<div><a href="https://x.comfoo">https://x.com<br>foo</a></div>', impl)).every((l) => !l.auto)).toBe(true);
  });

  it("the editor's DOM and copies say which kind a link is; the mail HTML doesn't", () => {
    const d = doc(p(t("https://x.com", autoLink("https://x.com"))));
    expect(toEmailHtml(d)).toBe('<div><a href="https://x.com">https://x.com</a></div>');
    const spec = schema.marks.link.spec.toDOM!(autoLink("https://x.com"), true) as [string, Record<string, string>];
    expect(spec[1]["data-rt-auto"]).toBe("");
    const manual = schema.marks.link.spec.toDOM!(manualLink("https://x.com"), true) as [string, Record<string, string>];
    expect(manual[1]["data-rt-manual"]).toBe("");
    expect("data-rt-auto" in manual[1]).toBe(false);
  });

  it("round trip: autolinks, formatted ones and manual links next to them come back the same", () => {
    const bold = schema.marks.bold.create();
    const d = doc(
      p(t("ver "), t("https://x.com/a", autoLink("https://x.com/a")), t(" y "), t("www.", autoLink("https://www.y.com")), t("y", autoLink("https://www.y.com"), bold), t(".com", autoLink("https://www.y.com"))),
      p(t("https://z.com", autoLink("https://z.com")), t("aquí", manualLink("https://z.com")), t(" "), t("ana@x.com", autoLink("mailto:ana@x.com"))),
    );
    expect(parseHtml(toEmailHtml(d), impl).eq(d)).toBe(true);
  });
});

describe("what is sent: an autolink goes where its text says", () => {
  it("a stale autolink writes the href its text spells; one that spells nothing is text; a manual link is as it is", () => {
    const d = doc(p(t("https://santo", autoLink("https://santo.com")), t(" y "), t("anto", autoLink("https://santo.com")), t(" y "), t("https://real.example", manualLink("https://tracker.example"))));
    expect(toEmailHtml(d)).toBe('<div><a href="https://santo">https://santo</a> y anto y <a href="https://tracker.example">https://real.example</a></div>');
    expect(toPlainText(d)).toBe("https://santo y anto y https://real.example (https://tracker.example)");
  });

  it("a run split by formatting is read whole", () => {
    const bold = schema.marks.bold.create();
    const d = doc(p(t("https://", autoLink("https://x.co")), t("x", autoLink("https://x.co"), bold), t(".com", autoLink("https://x.co"))));
    expect(toEmailHtml(d)).toBe('<div><a href="https://x.com">https://<b>x</b>.com</a></div>');
    expect(toPlainText(d)).toBe("https://x.com");
  });

  it("plain text: a link whose text spells its href is the text alone; an autolink and a manual link to one place are two", () => {
    const d = doc(p(t("www.x.com", autoLink("https://www.x.com")), t("aquí", manualLink("https://www.x.com"))));
    expect(toPlainText(d)).toBe("www.x.comaquí (https://www.x.com)");
  });

  it("spelledLinks returns a line without stale autolinks as it is", () => {
    const line = p(t("https://x.com", autoLink("https://x.com")), t(" y "), t("l", manualLink("https://e.com")));
    expect(spelledLinks(line)).toBe(line);
  });

  it("a copied part of an autolink carries the href its text spells", () => {
    const d = doc(p(t("ver "), t("https://santo.com", autoLink("https://santo.com"))));
    // "https://santo.co" out of it (inline content at the top), and the same across two lines
    const slice = d.slice(1 + 4, 1 + 4 + "https://santo.co".length);
    const copied = spelledSlice(slice);
    expect(copied).toBeInstanceOf(Slice);
    expect(links(p(...(copied.content.content as PMNode[])))).toEqual([{ text: "https://santo.co", href: "https://santo.co", auto: true }]);
    // "santo.com" + the next line: it spells nothing, so no link
    const two = doc(p(t("https://santo.com", autoLink("https://santo.com"))), p(t("x")));
    const across = spelledSlice(two.slice(1 + 8, two.content.size - 1));
    expect(across.content.childCount).toBe(2);
    expect(links(doc(...(across.content.content as PMNode[])))).toEqual([]);
    const whole = d.slice(0, d.content.size);
    expect(spelledSlice(whole)).toBe(whole);
  });
});
