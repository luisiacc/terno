import { JSDOM } from "jsdom";
import type { Mark, Node as PMNode } from "prosemirror-model";
import { describe, expect, it } from "vitest";
import { toEmailHtml } from "./html";
import { isSafeHref, normalizeHref, urlIn } from "./links";
import { contrast, HIGHLIGHT_HEX, HIGHLIGHT_INK, HIGHLIGHTS, inverted, TEXT_COLORS, TEXT_HEX, toHex } from "./palette";
import { cleanPastedHtml, parseHtml } from "./parse";
import { emailDocument, signatureHtml, textToHtml, textToHtmlChunks } from "./quote";
import { schema } from "./schema";
import { fromPlainText, toPlainText } from "./text";

const { window } = new JSDOM("<!doctype html><html><body></body></html>");
const impl = window.document.implementation;

// ── builders
type Inline = PMNode | string;
const m = {
  bold: schema.marks.bold.create(),
  italic: schema.marks.italic.create(),
  underline: schema.marks.underline.create(),
  strike: schema.marks.strike.create(),
  link: (href: string) => schema.marks.link.create({ href }),
  color: (value: string) => schema.marks.color.create({ value }),
  highlight: (value: string) => schema.marks.highlight.create({ value }),
  font: (value: string) => schema.marks.font.create({ value }),
  size: (value: string) => schema.marks.size.create({ value }),
};
const t = (text: string, ...marks: Mark[]) => schema.text(text, marks.reduce<readonly Mark[]>((set, mk) => mk.addToSet(set), []));
const inl = (c: Inline[]) => c.map((x) => (typeof x === "string" ? schema.text(x) : x));
const p = (...c: Inline[]) => schema.node("paragraph", null, inl(c));
const pa = (attrs: { align?: string; indent?: number }, ...c: Inline[]) => schema.node("paragraph", attrs, inl(c));
const br = (...marks: Mark[]) => schema.nodes.hard_break.create(null, null, marks);
const doc = (...blocks: PMNode[]) => schema.node("doc", null, blocks);
const ul = (...items: PMNode[]) => schema.node("bullet_list", null, items);
const ol = (...items: PMNode[]) => schema.node("ordered_list", null, items);
const li = (...blocks: PMNode[]) => schema.node("list_item", null, blocks);
const quote = (...blocks: PMNode[]) => schema.node("blockquote", null, blocks);

const roundTrip = (d: PMNode) => parseHtml(toEmailHtml(d), impl);

describe("mail HTML", () => {
  it("writes each line as a div and an empty line as <div><br></div>, with nothing but inline styles", () => {
    expect(toEmailHtml(doc(p("Hola"), p(), p("Adiós")))).toBe("<div>Hola</div><div><br></div><div>Adiós</div>");
    expect(toEmailHtml(doc(pa({ align: "center", indent: 2 }, "x")))).toBe('<div style="text-align:center;margin-left:80px">x</div>');
  });

  it("writes each mark as the tag or inline style mail clients keep", () => {
    expect(toEmailHtml(doc(p(t("b", m.bold), t("i", m.italic), t("u", m.underline), t("s", m.strike))))).toBe("<div><b>b</b><i>i</i><u>u</u><s>s</s></div>");
    expect(toEmailHtml(doc(p(t("red", m.color("red")))))).toBe('<div><span style="color:#b3261e">red</span></div>');
    expect(toEmailHtml(doc(p(t("hl", m.highlight("yellow")))))).toBe('<div><span style="background-color:#fff2a8;color:#202124">hl</span></div>');
    expect(toEmailHtml(doc(p(t("serif", m.font("serif")))))).toBe(`<div><span style="font-family:Georgia, 'Times New Roman', serif">serif</span></div>`);
    expect(toEmailHtml(doc(p(t("big", m.size("huge")))))).toBe('<div><span style="font-size:2em">big</span></div>');
    expect(toEmailHtml(doc(p(t("site", m.link("https://a.example/?q=1&b=2")))))).toBe('<div><a href="https://a.example/?q=1&amp;b=2">site</a></div>');
  });

  it("nests marks in schema order and keeps an open mark open across runs", () => {
    expect(toEmailHtml(doc(p(t("a", m.bold), t("b", m.bold, m.italic), t("c", m.bold))))).toBe("<div><b>a<i>b</i>c</b></div>");
    // a highlight's ink sits outside a chosen color: the color wins
    expect(toEmailHtml(doc(p(t("x", m.color("blue"), m.highlight("yellow")))))).toBe('<div><span style="background-color:#fff2a8;color:#202124"><span style="color:#1557b0">x</span></span></div>');
  });

  it("escapes text and keeps spaces HTML would collapse", () => {
    expect(toEmailHtml(doc(p("<script>&\"")))).toBe("<div>&lt;script&gt;&amp;&quot;</div>");
    expect(toEmailHtml(doc(p("  a   b  ")))).toBe("<div>&nbsp; a &nbsp; b &nbsp;</div>");
    expect(toEmailHtml(doc(p("a\tb")))).toBe('<div>a<span style="white-space:pre">\t</span>b</div>');
  });

  it("writes lists with their first line inside the <li>, and quotes with a left rule", () => {
    expect(toEmailHtml(doc(ul(li(p("uno")), li(p("dos"), ol(li(p("a")))))))).toBe(
      '<ul style="margin:0 0 0 24px;padding:0"><li>uno</li><li>dos<ol style="margin:0 0 0 24px;padding:0"><li>a</li></ol></li></ul>',
    );
    expect(toEmailHtml(doc(quote(p("citado"))))).toBe('<blockquote style="margin:0 0 0 0.8ex;border-left:2px solid #ccc;padding-left:1ex"><div>citado</div></blockquote>');
    expect(toEmailHtml(doc(schema.node("ordered_list", { start: 3 }, [li(p("x"))])))).toContain('<ol start="3"');
  });

  it("a line ending in a break carries the browser's extra <br>", () => {
    expect(toEmailHtml(doc(p("a", br())))).toBe("<div>a<br><br></div>");
    expect(toEmailHtml(doc(p("a", br(), "b")))).toBe("<div>a<br>b</div>");
  });

  it("over generated documents: no class, id, <style> or event attribute; only style, href and start", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const html = toEmailHtml(randomDoc(seed));
      expect(html).not.toMatch(/<style|class=|id=|\son\w+=/i);
      for (const [, attr] of html.matchAll(/\s([a-z-]+)="/g)) expect(["style", "href", "start"]).toContain(attr);
    }
  });
});

describe("parsing back", () => {
  it("gives the same document for every node, mark and attribute", () => {
    const d = doc(
      p("Hola ", t("negrita", m.bold), " y ", t("todo", m.bold, m.italic, m.underline, m.strike)),
      pa({ align: "right", indent: 3 }, t("rojo", m.color("red"), m.highlight("blue"), m.size("large"), m.font("mono"))),
      p(),
      p("a", br(), br(m.bold), t("b", m.bold), br()),
      ul(li(p("uno")), li(pa({ align: "center" }, "dos"), p("segunda línea"), ol(li(p("x")), li(p())))),
      schema.node("ordered_list", { start: 4 }, [li(p("cuatro"))]),
      quote(p("citado"), quote(p("más"))),
      p(t("enlace", m.link("mailto:ana@example.com")), " ", t("web", m.link("https://example.com/a?b=c&d=e"), m.bold)),
      p("  espacios   y\ttabs "),
    );
    expect(roundTrip(d).toJSON()).toEqual(d.toJSON());
    // a second save and reopen is the same again
    expect(roundTrip(roundTrip(d)).eq(d)).toBe(true);
  });

  it("over generated documents", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const d = randomDoc(seed);
      const back = roundTrip(d);
      if (!back.eq(d)) expect({ seed, html: toEmailHtml(d), back: JSON.stringify(back.toJSON()) }).toEqual({ seed, html: toEmailHtml(d), back: JSON.stringify(d.toJSON()) });
    }
  });

  it("an unsafe link keeps its text and loses the link", () => {
    const d = parseHtml('<div><a href="javascript:alert(1)">x</a> <a href="data:text/html,1">y</a> <a href="file:///etc">z</a></div>', impl);
    expect(d.toJSON()).toEqual(doc(p("x y z")).toJSON());
  });
});

describe("plain text", () => {
  it("lists as 1. and •, links as text (url), quotes as > , indent as spaces", () => {
    const d = doc(
      p("Hola,"),
      ol(li(p("uno")), li(p("dos"), ul(li(p("a")), li(p("b"))))),
      p(t("la web", m.link("https://example.com")), " y ", t("https://x.example", m.link("https://x.example")), " y ", t("ana@example.com", m.link("mailto:ana@example.com"))),
      quote(p("citado"), p(), quote(p("anidado"))),
      pa({ indent: 1 }, "sangría"),
      p("a", br(), "b"),
    );
    expect(toPlainText(d)).toBe(
      ["Hola,", "1. uno", "2. dos", "   • a", "   • b", "la web (https://example.com) y https://x.example y ana@example.com", "> citado", ">", "> > anidado", "    sangría", "a", "b"].join("\n"),
    );
  });

  it("fromPlainText → toPlainText is the text itself (every draft before rich text)", () => {
    const samples = ["", "\n", "Hola", "a\n\nb\n", "> quoted\n> > deeper\n", "\ttab\t", "  spaces  ", "• not a list\n1. not either", "emoji 👋🏽 y ñ", "trailing\n\n\n", "a b"];
    for (let seed = 1; seed <= 200; seed++) samples.push(randomText(seed));
    for (const s of samples) expect(toPlainText(fromPlainText(s))).toBe(s);
    expect(toPlainText(fromPlainText("a\r\nb\rc"))).toBe("a\nb\nc");
  });

  it("a plain draft's document, saved as HTML and reopened, gives the same text", () => {
    for (let seed = 1; seed <= 100; seed++) {
      const s = randomText(seed).replace(/ /g, " ");
      expect(toPlainText(roundTrip(fromPlainText(s)))).toBe(s);
    }
  });
});

describe("paste", () => {
  const pasted = (html: string) => parseHtml(cleanPastedHtml(html, impl).replace(/data-pm-slice="[^"]*"/, ""), impl);
  const foreign = (html: string) => {
    const cleaned = cleanPastedHtml(html, impl);
    // what ProseMirror's clipboard parser does with it: the schema's rules over the cleaned markup
    const d = window.document.implementation.createHTMLDocument("");
    d.body.innerHTML = cleaned;
    return { cleaned, doc: parseHtml(cleaned, impl) };
  };

  it("keeps bold, italic, underline, strike, lists, links, quotes; headings become sized bold lines", () => {
    const { doc: d } = foreign('<h1>Título</h1><h2>Sub</h2><h3>Tres</h3><p><strong>b</strong> <em>i</em> <u>u</u> <del>s</del></p><ul><li>x</li></ul><blockquote>q</blockquote><a href="https://e.com">l</a>');
    expect(d.toJSON()).toEqual(
      doc(
        p(t("Título", m.bold, m.size("huge"))),
        p(t("Sub", m.bold, m.size("large"))),
        p(t("Tres", m.bold)),
        p(t("b", m.bold), " ", t("i", m.italic), " ", t("u", m.underline), " ", t("s", m.strike)),
        ul(li(p("x"))),
        quote(p("q")),
        p(t("l", m.link("https://e.com"))),
      ).toJSON(),
    );
  });

  it("drops colors, fonts, sizes and alignment from outside Terno (even palette values), keeps them from a Terno copy", () => {
    const html = '<p style="text-align:center;margin-left:40px"><span style="color:#b3261e;background-color:#fff2a8;font-family:Georgia;font-size:2em">x</span></p>';
    expect(foreign(html).doc.toJSON()).toEqual(doc(p("x")).toJSON());
    const own = pasted(`<p data-pm-slice="1 1 []" style="text-align:center;margin-left:40px"><span style="color:#b3261e;background-color:#fff2a8;font-family:Georgia;font-size:2em">x</span></p>`);
    expect(own.toJSON()).toEqual(doc(pa({ align: "center", indent: 1 }, t("x", m.color("red"), m.highlight("yellow"), m.font("serif"), m.size("huge")))).toJSON());
    // a Terno copy still can't bring an off-palette color
    expect(pasted('<p data-pm-slice="1 1 []"><span style="color:#123456">x</span></p>').toJSON()).toEqual(doc(p("x")).toJSON());
  });

  it("Google Docs' <b style=font-weight:normal> wrapper isn't bold; its bold spans are", () => {
    const { doc: d } = foreign('<b style="font-weight:normal;" id="docs-internal-guid-1"><p dir="ltr"><span style="font-weight:700">B</span><span style="font-weight:400">n</span></p></b>');
    expect(d.toJSON()).toEqual(doc(p(t("B", m.bold), "n")).toJSON());
  });

  it("hostile and noisy markup: nothing but allowed nodes, marks and attributes survives", () => {
    for (const html of HOSTILE) {
      const { cleaned, doc: d } = foreign(html);
      expect(cleaned, html).not.toMatch(/<(script|style|img|iframe|svg|math|object|embed|form|input|button|link|meta|base|template|video|audio|frame)\b/i);
      expect(cleaned, html).not.toMatch(/\s(on\w+|class|id|src|srcset|background|action|formaction|lang|dir|width|height|align|bgcolor)=/i);
      expect(cleaned, html).not.toMatch(/javascript:|vbscript:/i);
      d.descendants((node) => {
        for (const mk of node.marks) if (mk.type.name === "link") expect(isSafeHref(mk.attrs.href as string), html).toBe(true);
        return true;
      });
      expect(toEmailHtml(d)).not.toMatch(/javascript:|<script|onerror|<img/i);
    }
  });

  it("Word's markup: classes, o:p fillers and typed list bullets go, the text stays", () => {
    const word = `<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><style>p.MsoNormal{margin:0}</style></head><body><!--[if gte mso 9]><xml><o:OfficeDocumentSettings/></xml><![endif]--><p class=MsoNormal><b>Hola<o:p></o:p></b></p><p class=MsoListParagraph style='mso-list:l0 level1 lfo1'><![if !supportLists]><span style='mso-list:Ignore'>·<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp; </span></span><![endif]>Uno<o:p></o:p></p><p class=MsoNormal><o:p>&nbsp;</o:p></p></body></html>`;
    const { cleaned, doc: d } = foreign(word);
    expect(cleaned).not.toMatch(/Mso|o:p|mso-/i);
    expect(toPlainText(d)).toBe("Hola\nUno\n");
  });
});

describe("links", () => {
  it("allows http, https and mailto only; completes bare hosts and addresses", () => {
    expect(normalizeHref("https://example.com/a")).toBe("https://example.com/a");
    expect(normalizeHref("example.com/x?y")).toBe("https://example.com/x?y");
    expect(normalizeHref("docs.example.co.uk")).toBe("https://docs.example.co.uk");
    expect(normalizeHref("ana@example.com")).toBe("mailto:ana@example.com");
    expect(normalizeHref("mailto:ana@example.com")).toBe("mailto:ana@example.com");
    expect(normalizeHref("localhost:3000/x")).toBe("https://localhost:3000/x");
    for (const bad of ["javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,x", "file:///etc/passwd", "ftp://x.example", "vbscript:x", "hello world", "", "   ", "https://", "notaurl"]) expect(normalizeHref(bad), bad).toBeNull();
    expect(isSafeHref(" https://x.example ")).toBe(true);
    expect(isSafeHref("mailto:")).toBe(false);
  });

  it("finds a URL that is the whole text (autolink, paste over a selection)", () => {
    expect(urlIn("https://example.com/a")).toBe("https://example.com/a");
    expect(urlIn(" www.example.com ")).toBe("https://www.example.com");
    expect(urlIn("see https://example.com")).toBeNull();
    expect(urlIn("javascript:alert(1)")).toBeNull();
  });
});

describe("palette", () => {
  it("every text color is AA on white, on every highlight, and inverted (a recipient's dark mode)", () => {
    for (const c of TEXT_COLORS) {
      const hex = TEXT_HEX[c];
      expect(contrast(hex, "#ffffff"), c).toBeGreaterThanOrEqual(4.5);
      expect(contrast(inverted(hex), "#000000"), c).toBeGreaterThanOrEqual(4.5);
      for (const h of HIGHLIGHTS) {
        expect(contrast(hex, HIGHLIGHT_HEX[h]), `${c} on ${h}`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(inverted(hex), inverted(HIGHLIGHT_HEX[h])), `${c} on ${h}, inverted`).toBeGreaterThanOrEqual(4.5);
      }
    }
    for (const h of HIGHLIGHTS) expect(contrast(HIGHLIGHT_INK, HIGHLIGHT_HEX[h])).toBeGreaterThanOrEqual(7);
  });

  it("reads hex and rgb() back to the same color", () => {
    expect(toHex("rgb(179, 38, 30)")).toBe("#b3261e");
    expect(toHex("#FFF")).toBe("#ffffff");
    expect(toHex("rgba(0, 0, 0, 0.5)")).toBeNull();
    expect(toHex("red")).toBeNull();
  });
});

describe("quote, signature and the document around them", () => {
  it("a reply's quote: attribution line, then nested blockquotes by > depth", () => {
    expect(textToHtml("On Mon, Ana wrote:\n> hola\n> > antes\n> fin")).toBe(
      '<div>On Mon, Ana wrote:</div><blockquote style="margin:0 0 0 0.8ex;border-left:2px solid #ccc;padding-left:1ex"><div>hola</div><blockquote style="margin:0 0 0 0.8ex;border-left:2px solid #ccc;padding-left:1ex"><div>antes</div></blockquote><div>fin</div></blockquote>',
    );
  });

  it("a hostile quote can't nest without end or blow the stack; a 2 MB quote converts in pieces, fast", () => {
    const deep = textToHtml(`${">".repeat(10_000)}texto`);
    expect(deep.match(/<blockquote/g)).toHaveLength(32);
    expect(deep.match(/<\/blockquote>/g)).toHaveLength(32);
    expect(deep).toContain(`${"&gt;".repeat(10_000 - 32)}texto`);
    const big = Array.from({ length: 40_000 }, (_, i) => `> línea ${i} de la cita, con algo de texto para pesar`).join("\n");
    const pieces = [...textToHtmlChunks(big)];
    expect(pieces.length).toBeGreaterThan(10);
    expect(pieces.join("")).toBe(textToHtml(big));
    expect(pieces.join("").startsWith('<blockquote style="')).toBe(true);
    // each piece is a short step, also for one 5-million-character line (the backend yields between pieces)
    for (const text of [big.repeat(3), "x ".repeat(2_500_000)]) {
      let worst = 0;
      const it = textToHtmlChunks(text);
      for (;;) {
        const t0 = performance.now();
        const r = it.next();
        worst = Math.max(worst, performance.now() - t0);
        if (r.done) break;
      }
      expect(worst).toBeLessThan(25);
    }
    expect(textToHtml("a\r\nb\rc")).toBe("<div>a</div><div>b</div><div>c</div>");
    // a long line cut into parts keeps its links and its double spaces whole, wherever the boundary falls
    for (let pad = 16_340; pad < 16_400; pad++) {
      const line = `${"x ".repeat(pad / 2)}  ver https://example.com/path  fin`;
      const html = textToHtml(line);
      expect(html, String(pad)).toContain('<a href="https://example.com/path">https://example.com/path</a>');
      expect(html.match(/&nbsp;/g)?.length, String(pad)).toBe(2);
    }
  });

  it("escapes, keeps blank lines, links URLs", () => {
    expect(textToHtml("a <b>\n\nhttps://e.com/x.")).toBe('<div>a &lt;b&gt;</div><div><br></div><div><a href="https://e.com/x">https://e.com/x</a>.</div>');
  });

  it("the signature keeps the -- separator and its lines", () => {
    expect(signatureHtml("Luis\nAcme <Studio>\n\n")).toBe("<div>-- <br>Luis<br>Acme &lt;Studio&gt;</div>");
    expect(signatureHtml("  \n")).toBe("");
  });

  it("the document has no <style> and says its charset", () => {
    expect(emailDocument("<div>x</div>")).toBe('<!DOCTYPE html><html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"></head><body><div>x</div></body></html>');
  });
});

// ── generators (deterministic)

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

const WORDS = ["hola", "mundo", "a", "ñandú", "x<y", "&amp;", '"q"', "👋", "fin.", "https://e.com", "  ", " ", "\t", "dos  espacios", "café"];

function randomText(seed: number): string {
  const r = rng(seed);
  const n = Math.floor(r() * 12);
  let s = "";
  for (let i = 0; i < n; i++) s += r() < 0.15 ? "\n" : r() < 0.1 ? " " : WORDS[Math.floor(r() * WORDS.length)];
  return s;
}

function randomDoc(seed: number): PMNode {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const marks = (): Mark[] => {
    const out: Mark[] = [];
    if (r() < 0.3) out.push(m.bold);
    if (r() < 0.2) out.push(m.italic);
    if (r() < 0.15) out.push(m.underline);
    if (r() < 0.1) out.push(m.strike);
    if (r() < 0.1) out.push(m.color(pick(TEXT_COLORS)));
    if (r() < 0.1) out.push(m.highlight(pick(HIGHLIGHTS)));
    if (r() < 0.08) out.push(m.font(pick(["serif", "mono"])));
    if (r() < 0.08) out.push(m.size(pick(["small", "large", "huge"])));
    if (r() < 0.08) out.push(m.link(pick(["https://e.com/a?b=1&c=2", "mailto:ana@example.com", "http://x.example"])));
    return out;
  };
  const inline = (): PMNode[] => {
    const out: PMNode[] = [];
    const n = Math.floor(r() * 6);
    for (let i = 0; i < n; i++) {
      // plan 39: an autolink (its text spells its href), other formatting on it, a space after it so no run runs into it
      if (r() < 0.1) {
        const url = pick(["https://e.com/a?b=1&c=2", "www.e.com", "ana@example.com", "http://x.example/(a)"]);
        const href = url.startsWith("www.") ? `https://${url}` : url.includes("@") ? `mailto:${url}` : url;
        out.push(t(url, schema.marks.link.create({ href, auto: true }), ...marks().filter((mk) => mk.type !== schema.marks.link)), schema.text(" "));
        continue;
      }
      out.push(r() < 0.12 ? br(...marks()) : t(pick(WORDS), ...marks()));
    }
    return out;
  };
  const para = () => schema.node("paragraph", { align: r() < 0.8 ? "left" : pick(["center", "right"]), indent: r() < 0.85 ? 0 : Math.floor(r() * 4) }, inline());
  const block = (depth: number): PMNode => {
    const k = r();
    if (depth < 3 && k < 0.12) return schema.node(r() < 0.5 ? "bullet_list" : "ordered_list", null, Array.from({ length: 1 + Math.floor(r() * 3) }, () => schema.node("list_item", null, [para(), ...(r() < 0.3 ? [block(depth + 1)] : [])])));
    if (depth < 3 && k < 0.2) return quote(...Array.from({ length: 1 + Math.floor(r() * 2) }, () => block(depth + 1)));
    return para();
  };
  return doc(...Array.from({ length: 1 + Math.floor(r() * 6) }, () => block(0)));
}

const HOSTILE = [
  '<script>window.pwned=1</script><p>hi</p>',
  '<img src=x onerror="window.pwned=1"><p>hi</p>',
  '<img src="https://tracker.example/pixel.gif" width=1 height=1>',
  '<a href="javascript:alert(1)" onclick="x()">click</a>',
  '<a href=" JaVaScRiPt:alert(1)">x</a>',
  '<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>',
  '<style>body{display:none}</style><p class="x" id="y" style="position:fixed;top:0;color:red">styled</p>',
  '<iframe src="https://evil.example"></iframe><object data=x></object><embed src=y>',
  '<svg onload="x()"><script>1</script><a xlink:href="javascript:1">s</a></svg>',
  '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)></style></mglyph></table></mtext></math>',
  '<form action="https://evil.example"><input name=a value=b><button formaction="javascript:1">go</button></form>',
  '<table background="https://t.example/bg.png" bgcolor=red><tr><td align=center>a</td><td>b</td></tr></table>',
  '<div style="background:url(https://t.example/x.png)">bg</div>',
  '<p lang="en" dir="rtl"><span data-x="1" title="t">t</span></p>',
  '<base href="https://evil.example"><link rel=stylesheet href="https://evil.example/x.css"><meta http-equiv="refresh" content="0;url=https://evil.example">',
  '<template><img src=x onerror=1></template><noscript><img src=x></noscript>',
  '<video src=x poster="https://t.example/p.png"></video><audio src=y></audio>',
  '<p>a<!-- <img src=x onerror=1> -->b</p>',
  '<frameset><frame src="https://evil.example"></frameset>',
];
