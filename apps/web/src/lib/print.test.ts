// @vitest-environment jsdom
import { setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import { afterEach, describe, expect, it } from "vitest";
import { fullDate } from "./format";
import { buildPrintDocument, defaultPaper, printableWidth, printFileName, remoteUrls, type PrintMessage, type PrintOptions } from "./print";

const yuki = { name: "Yuki Gutiérrez", email: "yuki@acme.studio" };
const luis = { name: "Luis Cordero", email: "luis@terno.mx" };
const DATE = Date.UTC(2026, 9, 20, 16, 12);

const msg = (o: Partial<PrintMessage> = {}): PrintMessage => ({ id: 1, from: yuki, to: [luis], cc: [], date: DATE, bodyHtml: null, bodyText: "Hola, ¿cómo vas?", attachments: [], allowRemote: false, ...o });
const opts = (o: Partial<PrintOptions> = {}): PrintOptions => ({ content: "headers", quoted: "show", paper: "letter", ...o });
const build = (messages: PrintMessage[], o: Partial<PrintOptions> = {}, subject = "Propuesta de campaña") => buildPrintDocument({ subject, messages }, opts(o));
/** The page as a document, to look at what renders (not at the CSS). */
const parse = (html: string) => new DOMParser().parseFromString(html, "text/html");
const shown = (html: string) => parse(html).querySelector("main")!;

afterEach(() => setLocale("en", en));

describe("the print document", () => {
  it("with headers: the subject once, then sender, address, full date, To, Cc and attachments per message", () => {
    const html = build([msg({ cc: [{ name: "", email: "ana@x.mx" }], attachments: [{ filename: "contrato.pdf", size: 245_000 }] }), msg({ id: 2, from: luis, to: [yuki] })]);
    const main = shown(html);
    expect(main.querySelectorAll(".subject")).toHaveLength(1);
    expect(main.querySelector(".subject")!.textContent).toBe("Propuesta de campaña");
    expect(main.querySelectorAll(".msg")).toHaveLength(2);
    const head = main.querySelector(".head")!.textContent!;
    for (const s of ["Yuki Gutiérrez", "yuki@acme.studio", fullDate(DATE), "To", "Luis Cordero", "Cc", "ana@x.mx"]) expect(head).toContain(s);
    expect(main.querySelector(".atts")!.textContent).toContain("contrato.pdf");
    expect(main.querySelector(".atts")!.textContent).toContain("239 KB");
    expect(parse(html).title).toBe("Propuesta de campaña");
  });

  it("content only: the bodies and nothing else — no subject, names, addresses, dates, recipients or attachments", () => {
    const html = build([msg({ cc: [luis], attachments: [{ filename: "contrato.pdf", size: 1 }] }), msg({ id: 2, bodyText: "Segundo" })], { content: "body" });
    const text = shown(html).textContent!;
    expect(text).toContain("Hola, ¿cómo vas?");
    expect(text).toContain("Segundo");
    for (const s of ["Propuesta de campaña", "Yuki", "yuki@acme.studio", "luis@terno.mx", "To", "Cc", "Attachments", "contrato.pdf", fullDate(DATE)]) expect(text).not.toContain(s);
    expect(shown(html).querySelectorAll(".head, .subject, .atts")).toHaveLength(0);
    expect(parse(html).body.className).toBe("body-only");
  });

  it("escapes a hostile subject, names and addresses", () => {
    const evil = `<img src=x onerror=alert(1)>"&'</title><script>alert(1)</script>`;
    const html = build([msg({ from: { name: evil, email: `"><svg onload=alert(1)>@x.mx` }, to: [{ name: evil, email: "a@b.c" }] })], {}, evil);
    const doc = parse(html);
    expect(doc.querySelectorAll("script, svg, img")).toHaveLength(0);
    expect(doc.title).toBe(evil);
    expect(doc.querySelector(".subject")!.textContent).toBe(evil);
    expect(doc.querySelector(".name")!.textContent).toBe(evil);
    expect(html).not.toMatch(/<(script|svg|img)\b/i);
  });

  it("sanitizes HTML bodies like the reader: no scripts, handlers, <style>, frames or javascript: links", () => {
    const body = `<p onclick="steal()">Hola</p><script>alert(1)</script><style>p{color:red}</style><iframe src="https://x.test"></iframe><a href="javascript:alert(1)">clic</a><img src="data:image/png;base64,iVBORw0KGgo=" onerror="x()" alt="logo">`;
    const doc = parse(build([msg({ bodyHtml: body })]));
    const box = doc.querySelector(".body-html")!;
    expect(box.querySelectorAll("script, style, iframe")).toHaveLength(0);
    expect([...box.querySelectorAll("*")].some((el) => [...el.attributes].some((a) => a.name.startsWith("on")))).toBe(false);
    expect(box.querySelector("a")!.getAttribute("href")).toBeNull();
    expect(box.querySelector("img")!.getAttribute("src")).toMatch(/^data:image\/png/);
    expect(box.textContent).toContain("Hola");
  });

  it("drops remote images (keeping their description) unless the message may load them; cid: images never load", () => {
    const body = `<img src="https://t.test/pixel.gif" alt=""><img src="https://img.test/hero.png" alt="Portada"><img src="cid:logo@acme" alt="Logo de Acme" loading="lazy"><table><tr><td background="https://img.test/bg.png">x</td></tr></table><div style="background:url('https://img.test/a.png') #fff;color:red">y</div>`;
    const blocked = parse(build([msg({ bodyHtml: body })]));
    expect(blocked.querySelectorAll(".body-html img")).toHaveLength(0);
    expect([...blocked.querySelectorAll(".img-alt")].map((e) => e.textContent)).toEqual(["Portada", "Logo de Acme"]);
    expect(blocked.documentElement.outerHTML).not.toMatch(/https:\/\/(t|img)\.test/);
    expect(blocked.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute("content")).not.toMatch(/https?:/);
    expect(remoteUrls(blocked)).toEqual([]);

    const allowed = parse(build([msg({ bodyHtml: body, allowRemote: true })]));
    expect([...allowed.querySelectorAll(".body-html img")].map((i) => i.getAttribute("src"))).toEqual(["https://t.test/pixel.gif", "https://img.test/hero.png"]);
    expect(allowed.querySelector("img[loading]")).toBeNull();
    expect(allowed.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute("content")).toContain("img-src data: cid: https: http:");
    expect(remoteUrls(allowed).sort()).toEqual(["https://img.test/a.png", "https://img.test/bg.png", "https://img.test/hero.png", "https://t.test/pixel.gif"]);
  });

  it("an image that can't load in the page (relative, unknown scheme) prints as its description, not a broken icon", () => {
    const doc = parse(build([msg({ bodyHtml: `<img src="x" alt="imagen rota"><img src="/logo.png"><img src="ftp://x.test/a.png" alt="ftp">` })]));
    expect(doc.querySelectorAll(".body-html img")).toHaveLength(0);
    expect([...doc.querySelectorAll(".img-alt")].map((e) => e.textContent)).toEqual(["imagen rota", "ftp"]);
  });

  it("a blocked message loads nothing, whatever carries the URL: SVG, media, forms, styles, presentation attributes", () => {
    const vectors = [
      `<svg><image href="https://tracker.test/svg-image.png" width="1" height="1"/></svg>`,
      `<svg><image xlink:href="https://tracker.test/svg-xlink.png"/></svg>`,
      `<svg><use href="https://tracker.test/sprite.svg#a"/></svg>`,
      `<svg><filter id="f"><feImage href="https://tracker.test/fe.png"/></filter><rect fill="url(https://tracker.test/paint.svg#p)" filter="url(#f)"/></svg>`,
      `<video poster="https://tracker.test/poster.png"><source src="https://tracker.test/v.mp4"></video><audio src="https://tracker.test/a.mp3"></audio>`,
      `<picture><source srcset="https://tracker.test/pic.webp"><img src="https://tracker.test/pic.png" alt="foto"></picture>`,
      `<link rel="stylesheet" href="https://tracker.test/x.css"><input type="image" src="https://tracker.test/input.png">`,
      `<table background="https://tracker.test/table.png"><tr><td style="background:url(//tracker.test/proto-relative.png)">x</td></tr></table>`,
      `<div style="background-image:image-set('https://tracker.test/set.png' 1x)">y</div><div style="background:\\75 rl(https://tracker.test/escaped.png)">z</div>`,
      `<img src="//tracker.test/relative.png" alt="rel"><object data="https://tracker.test/obj.swf"></object><embed src="https://tracker.test/e.swf">`,
    ].join("");
    const doc = parse(build([msg({ bodyHtml: vectors })]));
    expect(doc.querySelector(".body-html")!.outerHTML).not.toContain("tracker.test");
    expect(doc.querySelectorAll("video, audio, source, link, object, embed")).toHaveLength(0);
    // fragment references inside the page stay
    expect(doc.querySelector("rect")!.getAttribute("filter")).toBe("url(#f)");
    expect(remoteUrls(doc)).toEqual([]);
  });

  it("a data: image is left exactly as it is, even when what it holds says url()", () => {
    const svg = `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"/></defs><rect fill="url(#g)"/></svg>')}`;
    const doc = parse(build([msg({ bodyHtml: `<img src="${svg}" alt="hero">` })]));
    expect(doc.querySelector(".body-html img")!.getAttribute("src")).toBe(svg);
  });

  it("an allowed message keeps its web resources (absolute http(s) only), and only they are listed for main", () => {
    const body = `<svg><image href="https://img.test/svg.png"/></svg><td></td><div style="background:url('https://img.test/bg.png')">x</div><img src="/relative.png" alt="rel">`;
    const doc = parse(build([msg({ bodyHtml: body, allowRemote: true }), msg({ id: 2, bodyHtml: `<svg><image href="https://tracker.test/blocked.png"/></svg>` })]));
    expect(doc.querySelector("image")!.getAttribute("href")).toBe("https://img.test/svg.png");
    expect(doc.querySelector(".img-alt")!.textContent).toBe("rel");
    expect(remoteUrls(doc).sort()).toEqual(["https://img.test/bg.png", "https://img.test/svg.png"]);
    expect(doc.documentElement.outerHTML).not.toContain("tracker.test");
  });

  it("follows each message's own consent in a mixed conversation", () => {
    const doc = parse(build([msg({ bodyHtml: `<img src="https://a.test/1.png" alt="uno">`, allowRemote: true }), msg({ id: 2, bodyHtml: `<img src="https://b.test/2.png" alt="dos">` })]));
    expect(remoteUrls(doc)).toEqual(["https://a.test/1.png"]);
    expect(doc.querySelector(".img-alt")!.textContent).toBe("dos");
  });

  it("says a body that isn't downloaded yet is missing, instead of printing nothing", () => {
    expect(shown(build([msg({ bodyText: null })])).querySelector(".missing")!.textContent).toBe("Content not downloaded yet");
  });

  it("speaks the active language: <html lang>, labels, the missing body and the subject fallback", () => {
    const sample = () => [msg({ cc: [luis], attachments: [{ filename: "a.pdf", size: 1 }] }), msg({ id: 2, bodyText: null })];
    const english = parse(build(sample(), {}, "  "));
    expect(english.documentElement.lang).toBe("en-US");
    expect([...english.querySelectorAll(".k")].map((k) => k.textContent)).toEqual(["To", "Cc", "Attachments", "To"]);
    expect(english.title).toBe("(no subject)");
    expect(english.querySelector(".subject")!.textContent).toBe("(no subject)");
    setLocale("es", es);
    const doc = parse(build(sample(), {}, "  "));
    expect(doc.documentElement.lang).toBe("es-MX");
    expect([...doc.querySelectorAll(".k")].map((k) => k.textContent)).toEqual(["Para", "Cc", "Adjuntos", "Para"]);
    expect(doc.querySelector(".missing")!.textContent).toBe("Contenido aún no descargado");
    expect(doc.title).toBe("(sin asunto)");
    expect(doc.querySelector(".date")!.textContent).toBe(fullDate(DATE));
    expect(printFileName("")).toBe("Correo");
  });

  it("sets the page size and a printable width per paper", () => {
    expect(build([msg()], { paper: "letter" })).toContain("@page{size:letter;margin:18mm 16mm 18mm}");
    expect(build([msg()], { paper: "a4" })).toContain("@page{size:A4;margin:18mm 16mm 18mm}");
    expect(printableWidth("letter")).toBe(183.9);
    expect(printableWidth("a4")).toBe(178);
    expect(build([msg()], { paper: "a4" })).toContain(".doc{width:178mm}");
    expect(build([msg()])).toMatch(/^<!doctype html>/);
  });

  it("links URLs in plain text and keeps them escaped", () => {
    const a = shown(build([msg({ bodyText: 'Mira https://acme.studio/a?b=1&c="2" ya' })])).querySelector("a")!;
    expect(a.getAttribute("href")).toBe("https://acme.studio/a?b=1&c=");
    expect(a.closest(".body-text")!.textContent).toBe('Mira https://acme.studio/a?b=1&c="2" ya');
  });
});

describe("quoted text", () => {
  const hidden = (m: Partial<PrintMessage>) => shown(build([msg(m)], { quoted: "hide", content: "body" }));
  const kept = (m: Partial<PrintMessage>) => shown(build([msg(m)], { quoted: "show", content: "body" }));

  it("plain text: the trailing quote and its attribution go; shown, they print as a quote", () => {
    const bodyText = "Va, nos vemos.\n\nEl mar, 20 oct 2026, Yuki escribió:\n> ¿Nos vemos el jueves?";
    expect(hidden({ bodyText }).textContent).toBe("Va, nos vemos.");
    expect(kept({ bodyText }).querySelector(".quote")!.textContent).toContain("> ¿Nos vemos el jueves?");
  });

  it("plain text: an inline reply is kept whole", () => {
    const bodyText = "> ¿Presupuesto?\n$40,000.\n> ¿Fecha?\nEl 3 de noviembre.\n> Gracias";
    expect(hidden({ bodyText }).querySelector(".body-text")!.textContent).toBe(bodyText);
  });

  it("Gmail: the trailing .gmail_quote, attribution inside it", () => {
    const bodyHtml = `<div dir="ltr">Listo, va el archivo.</div><br><div class="gmail_quote"><div class="gmail_attr">El mar, 20 oct 2026 a las 10:12, Yuki escribió:<br></div><blockquote class="gmail_quote">Mándame el archivo</blockquote></div>`;
    expect(hidden({ bodyHtml }).textContent!.trim()).toBe("Listo, va el archivo.");
    expect(kept({ bodyHtml }).textContent).toContain("Mándame el archivo");
  });

  it("Apple Mail: the trailing blockquote[type=cite] and the «wrote:» line above it", () => {
    const bodyHtml = `<div>Gracias, lo reviso.</div><div><br><blockquote type="cite"><div>On Oct 20, 2026, at 10:12, Yuki wrote:</div></blockquote></div><div>On Oct 20, 2026, at 10:12, Yuki &lt;yuki@acme.studio&gt; wrote:</div><blockquote type="cite"><div>Te mando el contrato.</div><blockquote type="cite">anterior</blockquote></blockquote>`;
    // two quotes, the first above the reply's attribution: an inline reply, kept whole
    expect(hidden({ bodyHtml }).textContent).toContain("Te mando el contrato.");
    const simple = `<div>Gracias, lo reviso.</div><div><br></div><div>On Oct 20, 2026, at 10:12, Yuki &lt;yuki@acme.studio&gt; wrote:</div><blockquote type="cite"><div>Te mando el contrato.</div><blockquote type="cite">anterior</blockquote></blockquote>`;
    const text = hidden({ bodyHtml: simple }).textContent!;
    expect(text).toContain("Gracias, lo reviso.");
    expect(text).not.toContain("wrote:");
    expect(text).not.toContain("contrato");
  });

  it("Apple Mail inline replies (answers between quotes) are kept whole", () => {
    const bodyHtml = `<blockquote type="cite">¿Presupuesto?</blockquote><div>$40,000.</div><blockquote type="cite">¿Fecha?</blockquote><div>El 3 de noviembre.</div><blockquote type="cite">Gracias</blockquote>`;
    const text = hidden({ bodyHtml }).textContent!;
    for (const s of ["¿Presupuesto?", "$40,000.", "¿Fecha?", "El 3 de noviembre.", "Gracias"]) expect(text).toContain(s);
  });

  it("Outlook: #divRplyFwdMsg (with its rule) or #appendonsend, and everything after", () => {
    const rply = `<div>Recibido.</div><hr style="display:inline-block;width:98%"><div id="divRplyFwdMsg"><b>De:</b> Ana</div><div>Texto anterior</div><p>más historia</p>`;
    const a = hidden({ bodyHtml: rply });
    expect(a.textContent!.trim()).toBe("Recibido.");
    expect(a.querySelector("hr")).toBeNull();
    const nested = `<div><div>Ok, gracias.</div><div id="appendonsend"></div><div>De: Ana</div></div><div>Historia</div>`;
    expect(hidden({ bodyHtml: nested }).textContent!.trim()).toBe("Ok, gracias.");
  });

  it("nothing is removed when quotes are included", () => {
    const bodyHtml = `<div>Recibido.</div><div id="divRplyFwdMsg">De: Ana</div><div>Texto anterior</div>`;
    expect(kept({ bodyHtml }).textContent).toContain("Texto anterior");
  });
});

describe("paper and file name", () => {
  it("defaults to Letter in the Letter regions (Mexico, US, Canada…) and A4 elsewhere", () => {
    for (const l of ["es-MX", "en-US", "en-CA", "fr-CA", "es-CO", "es-CL", "en-PH"]) expect(defaultPaper(l)).toBe("letter");
    for (const l of ["es-ES", "es", "en-GB", "de-DE", "pt-BR", "es-AR", "ja-JP"]) expect(defaultPaper(l)).toBe("a4");
    expect(defaultPaper("not a locale!")).toBe("a4");
  });

  it("names the file after the subject: no path or reserved characters, capped, never empty", () => {
    expect(printFileName("Re: Factura 03/2026 — ¿pagada?")).toBe("Re Factura 03 2026 — ¿pagada");
    expect(printFileName('../../etc/passwd')).toBe("etc passwd");
    expect(printFileName('a<b>c:"d"|e*f?\u0000g\\h')).toBe("a b c d e f g h");
    expect(printFileName("   ...  ")).toBe("Email");
    expect(printFileName("")).toBe("Email");
    expect([...printFileName("é".repeat(200))]).toHaveLength(80);
    expect(new TextEncoder().encode(printFileName("報".repeat(80))).length).toBeLessThanOrEqual(200);
    expect(printFileName("😀".repeat(80))).toBe("😀".repeat(50));
    expect(printFileName("Reunión 🎉 東京")).toBe("Reunión 🎉 東京");
  });
});
