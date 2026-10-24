/**
 * The print document: one self-contained, script-less HTML page built from a
 * conversation and the print sheet's options. It is always paper (near-black
 * on white, whatever the app's theme) and the same document everywhere: the
 * sheet previews it, fits wide mail to the page, and prints or exports
 * exactly what it previewed. Only the print sheet (a lazy chunk) imports it.
 */
import type { Address } from "@terno/core";
import { PRINT_INK as INK } from "@terno/ui/themes/print";
import DOMPurify from "dompurify";
import { formatBytes, fullDate } from "~/lib/format";
import { csp } from "~/lib/mail";
import { splitTextQuote } from "~/lib/quote";
import { exposeForTests } from "~/lib/render-probe";

export type Paper = "letter" | "a4";

export interface PrintOptions {
  /** "headers": subject, sender, date, recipients, attachments; "body": only what the mail says */
  content: "headers" | "body";
  quoted: "hide" | "show";
  paper: Paper;
}

export interface PrintMessage {
  id: number;
  from: Address;
  to: Address[];
  cc: Address[];
  date: number;
  bodyHtml: string | null;
  bodyText: string | null;
  attachments: { filename: string; size: number }[];
  /** the reader's answer for this message: the setting or its "Cargar contenido", never in local mode */
  allowRemote: boolean;
}

/** Paper and margins, in mm: one geometry for the preview, the browser's print and the desktop PDF. */
export const PAGE: Record<Paper, { width: number; height: number }> = { letter: { width: 215.9, height: 279.4 }, a4: { width: 210, height: 297 } };
export const MARGIN = { top: 18, bottom: 18, side: 16 };
export const printableWidth = (paper: Paper): number => Math.round((PAGE[paper].width - 2 * MARGIN.side) * 100) / 100;
/** Below this, wide mail stops shrinking and wraps instead (still never cut off). */
export const MIN_ZOOM = 0.5;

/** Regions on US Letter (CLDR); everywhere else prints on A4. */
const LETTER_REGIONS = new Set(["US", "CA", "MX", "BZ", "CL", "CO", "CR", "GT", "NI", "PA", "PH", "PR", "SV", "VE"]);

export function defaultPaper(locale: string): Paper {
  try {
    const region = new Intl.Locale(locale).maximize().region;
    return region && LETTER_REGIONS.has(region) ? "letter" : "a4";
  } catch {
    return "a4";
  }
}

/** A file name from the subject: no path or reserved characters, length-capped, "Correo" when nothing is left. */
export function printFileName(subject: string): string {
  const clean = subject
    // oxlint-disable-next-line no-control-regex -- control characters are exactly what a file name can't hold
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s.]+|[\s.]+$/g, "");
  const capped = [...clean].slice(0, 80).join("").trim();
  return capped || "Correo";
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const URL_RE = /(https?:\/\/[^\s<>"')]+)/g;
/** Plain text as HTML: escaped, links kept as links. */
function textToHtml(text: string): string {
  return text
    .split(URL_RE)
    .map((part, i) => (i % 2 ? `<a href="${esc(part)}">${esc(part)}</a>` : esc(part)))
    .join("");
}

const REMOTE_URL = /^\s*https?:/i;
const STYLE_REMOTE_URL = /url\(\s*['"]?\s*https?:[^)]*\)/gi;
const ATTRIBUTION = /(escribió|wrote|a écrit|schrieb):\s*$/i;

/** An image that won't print, as its description (if it has one). */
function replaceWithAlt(img: Element) {
  const alt = img.getAttribute("alt")?.trim();
  if (alt) {
    const span = img.ownerDocument.createElement("span");
    span.className = "img-alt";
    span.textContent = alt;
    img.replaceWith(span);
  } else img.remove();
}

/** Removes a node and everything after it in document order, up to the root. */
function removeFrom(node: Node, root: Node) {
  for (let n: Node | null = node; n && n !== root; n = n.parentNode) while (n.nextSibling) n.nextSibling.remove();
  node.parentNode?.removeChild(node);
}

/**
 * Quoted history in HTML mail, trailing only: Outlook's marker and everything
 * after it, or the last Gmail/Apple Mail quote with its "… wrote:" line when
 * nothing of the reply comes after it. Quotes above the reply's last words
 * make it an inline reply, kept whole.
 */
function stripTrailingQuote(root: DocumentFragment) {
  const outlook = root.querySelector("#appendonsend, #divRplyFwdMsg");
  if (outlook) {
    const prev = outlook.previousElementSibling;
    if (prev?.tagName === "HR") prev.remove();
    removeFrom(outlook, root);
    return;
  }
  const all = [...root.querySelectorAll(".gmail_quote_container, .gmail_quote, blockquote[type=cite]")];
  const quotes = all.filter((el) => !all.some((o) => o !== el && o.contains(el)));
  if (!quotes.length) return;
  // what the mail says, in order, and the quote each piece is in
  const leaves: { node: Node; quote: Element | null }[] = [];
  const walker = root.ownerDocument!.createTreeWalker(root, 0x5 /* elements and text */);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === 3 ? n.nodeValue!.trim() : (n as Element).tagName === "IMG") leaves.push({ node: n, quote: quotes.find((q) => q.contains(n)) ?? null });
  }
  let i = leaves.length - 1;
  while (i >= 0 && leaves[i]!.quote) i--;
  const trailing = new Set(leaves.slice(i + 1).map((l) => l.quote!));
  if (!trailing.size || leaves.slice(0, i + 1).some((l) => l.quote)) return;
  const last = leaves[i]?.node;
  if (last?.nodeType === 3 && ATTRIBUTION.test(last.nodeValue!.trim())) {
    const block = last.parentElement;
    // the attribution's own line goes, never the reply sharing its block
    if (block && root.contains(block) && block.textContent!.trim() === last.nodeValue!.trim()) block.remove();
    else last.parentNode!.removeChild(last);
  }
  for (const q of trailing) q.remove();
}

/** The reader's sanitizer config: no <style>, no srcset; scripts and handlers never survive DOMPurify. */
const PURIFY = { FORBID_TAGS: ["style"], FORBID_ATTR: ["srcset"], ADD_ATTR: ["target"] };

/** One HTML body, safe and print-ready: remote resources only where allowed, cid: images as their alt text, lazy loading off. */
function htmlBody(html: string, allowRemote: boolean, hideQuoted: boolean): string {
  const frag = DOMPurify.sanitize(html, { ...PURIFY, RETURN_DOM_FRAGMENT: true });
  if (hideQuoted) stripTrailingQuote(frag);
  // querySelectorAll is static: replacing an image doesn't disturb the loop
  for (const img of frag.querySelectorAll("img")) {
    img.removeAttribute("loading");
    const src = img.getAttribute("src") ?? "";
    // only data: images (and allowed remote ones) can load here; cid: (attachment content isn't fetched), relative
    // or unknown sources would print a broken-image icon: they print as their description
    if (!(/^\s*data:image\//i.test(src) || (REMOTE_URL.test(src) && allowRemote))) replaceWithAlt(img);
  }
  if (!allowRemote) {
    for (const el of frag.querySelectorAll("[background]")) if (REMOTE_URL.test(el.getAttribute("background")!)) el.removeAttribute("background");
    for (const el of frag.querySelectorAll("[style]")) {
      const style = el.getAttribute("style")!;
      if (STYLE_REMOTE_URL.test(style)) el.setAttribute("style", style.replace(STYLE_REMOTE_URL, "none"));
      STYLE_REMOTE_URL.lastIndex = 0;
    }
  }
  const box = frag.ownerDocument!.createElement("div");
  box.append(frag);
  return box.innerHTML;
}

function textBody(text: string, hideQuoted: boolean): string {
  const { main, quoted } = splitTextQuote(text);
  if (!quoted) return `<div class="body-text">${textToHtml(text)}</div>`;
  return `<div class="body-text">${textToHtml(main)}</div>${hideQuoted ? "" : `<div class="body-text quote">${textToHtml(quoted)}</div>`}`;
}

const person = (a: Address) => (a.name && a.name !== a.email ? `${esc(a.name)} <span class="addr">&lt;${esc(a.email)}&gt;</span>` : esc(a.email));

function messageHtml(m: PrintMessage, o: PrintOptions): string {
  const hide = o.quoted === "hide";
  const body = m.bodyHtml ? `<div class="body-html">${htmlBody(m.bodyHtml, m.allowRemote, hide)}</div>` : m.bodyText !== null ? textBody(m.bodyText, hide) : `<p class="missing">Contenido aún no descargado</p>`;
  if (o.content === "body") return `<article class="msg">${body}</article>`;
  const line = (label: string, list: Address[]) => (list.length ? `<div class="line"><span class="k">${label}</span> ${list.map(person).join(", ")}</div>` : "");
  const head = `<header class="head"><div class="from"><span class="name">${esc(m.from.name || m.from.email)}</span>${m.from.name && m.from.name !== m.from.email ? `<span class="addr">${esc(m.from.email)}</span>` : ""}<span class="date">${esc(fullDate(m.date))}</span></div>${line("Para", m.to)}${line("Cc", m.cc)}</header>`;
  const atts = m.attachments.length ? `<div class="atts"><span class="k">Adjuntos</span> ${m.attachments.map((a) => `<span class="att">${esc(a.filename)} <span class="size">${esc(formatBytes(a.size))}</span></span>`).join("")}</div>` : "";
  return `<article class="msg">${head}${body}${atts}</article>`;
}

const FONT = `-apple-system, BlinkMacSystemFont, "Helvetica Neue", "Segoe UI", Roboto, "Noto Sans", "PingFang SC", "Hiragino Sans", "Apple SD Gothic Neo", "Noto Sans CJK SC", sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"`;

function css(paper: Paper): string {
  const m = `${MARGIN.top}mm ${MARGIN.side}mm ${MARGIN.bottom}mm`;
  return [
    `@page{size:${paper === "a4" ? "A4" : "letter"};margin:${m}}`,
    `:root{color-scheme:light}`,
    `html{background:${INK.paper}}`,
    `body{margin:0;color:${INK.text};font:10.5pt/1.5 ${FONT};overflow-wrap:anywhere;-webkit-print-color-adjust:exact;print-color-adjust:exact;-webkit-text-size-adjust:none}`,
    // a definite printable width on screen too, so the fit pass measures what the page will hold
    `.doc{width:${printableWidth(paper)}mm}`,
    `@media screen{body{padding:${m}}}`,
    `@media print{.doc{width:auto}}`,
    `.subject{margin:0 0 16pt;font-size:16pt;font-weight:600;line-height:1.25;letter-spacing:-.01em;text-wrap:balance}`,
    `.msg{break-inside:auto}`,
    `.msg.keep{break-inside:avoid}`,
    `p,li,.body-text,.body-html div{orphans:3;widows:3}`,
    `.msg+.msg{margin-top:20pt;padding-top:16pt;border-top:.75pt solid ${INK.rule}}`,
    `.body-only .msg+.msg{margin-top:22pt;padding-top:20pt;border-top-color:${INK.ruleSoft}}`,
    `.head{margin-bottom:11pt;font-size:9pt;line-height:1.45;color:${INK.secondary};break-inside:avoid;break-after:avoid}`,
    `.from{display:flex;align-items:baseline;gap:6pt;margin-bottom:1.5pt}`,
    `.name{font-size:10.5pt;font-weight:600;color:${INK.text}}`,
    `.date{margin-left:auto;padding-left:12pt;white-space:nowrap;font-variant-numeric:tabular-nums}`,
    `.k{margin-right:3pt;font-weight:500;color:${INK.text}}`,
    `.addr{color:${INK.tertiary}}`,
    `.body-text{white-space:pre-wrap}`,
    `.quote{margin-top:9pt;padding-left:9pt;border-left:1.5pt solid ${INK.rule};color:${INK.secondary}}`,
    `.body-html img{max-width:100%;height:auto}`,
    `.body-html pre{white-space:pre-wrap}`,
    `.body-html blockquote[type=cite],.body-html .gmail_quote{margin:6pt 0 6pt 2pt;padding-left:9pt;border-left:1.5pt solid ${INK.rule};color:${INK.quote}}`,
    // past the smallest zoom: everything wraps to the page instead of running off it
    `.fit-wrap *{max-width:100%!important;min-width:0!important}`,
    `.fit-wrap table{table-layout:fixed;width:100%!important}`,
    `.img-alt{color:${INK.tertiary};font-style:italic}`,
    `.img-alt::before{content:"["}.img-alt::after{content:"]"}`,
    `.missing{margin:0;color:${INK.tertiary};font-style:italic}`,
    `.atts{margin-top:11pt;font-size:9pt;color:${INK.secondary};break-inside:avoid}`,
    `.att{display:inline-block;margin-right:10pt}`,
    `.size{color:${INK.tertiary}}`,
    `a{color:${INK.link};text-decoration:underline;text-decoration-thickness:.5pt;text-underline-offset:1.5pt}`,
  ].join("");
}

/**
 * The whole page for the given messages. Everything from the mail is
 * escaped or sanitized; remote resources only load where `allowRemote` says
 * (the CSP allows them only if one message may), and nothing scripts.
 */
export function buildPrintDocument(input: { subject: string; messages: PrintMessage[] }, options: PrintOptions): string {
  const subject = input.subject.trim() || "(sin asunto)";
  const headers = options.content === "headers";
  const remote = input.messages.some((m) => m.allowRemote && m.bodyHtml);
  const body = (headers ? `<h1 class="subject">${esc(subject)}</h1>` : "") + input.messages.map((m) => messageHtml(m, options)).join("");
  return `<!doctype html><html lang="es" data-print-doc data-paper="${options.paper}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp(remote)}"><title>${esc(subject)}</title><style>${css(options.paper)}</style></head><body class="${headers ? "with-headers" : "body-only"}"><main class="doc">${body}</main></body></html>`;
}

/**
 * Fits HTML mail wider than the printable width: each block that runs past
 * it (a 1000px table, a fixed-width layout) gets a zoom that brings it down
 * to it, so the text around it keeps its size; never below MIN_ZOOM (past
 * that it wraps). Short messages are kept on one page. Runs on the loaded
 * preview (same-origin, no scripts inside) and starts over on every build.
 */
export function fitPrintDocument(doc: Document): void {
  for (const el of doc.querySelectorAll<HTMLElement>("[data-fit]")) {
    el.style.zoom = "";
    el.classList.remove("fit-wrap", "keep");
    el.removeAttribute("data-fit");
  }
  const zoomTo = (el: HTMLElement, room: number, need: number) => {
    const zoom = Math.floor((room / need) * 1000) / 1000;
    el.dataset.fit = "";
    el.style.zoom = String(Math.max(zoom, MIN_ZOOM));
    if (zoom < MIN_ZOOM) el.classList.add("fit-wrap");
  };
  for (const body of doc.querySelectorAll<HTMLElement>(".body-html")) {
    const room = body.clientWidth;
    if (!room || body.scrollWidth <= room + 0.5) continue;
    const left = body.getBoundingClientRect().left;
    for (const child of body.children as HTMLCollectionOf<HTMLElement>) {
      const box = child.getBoundingClientRect();
      const need = box.left - left + Math.max(box.width, child.scrollWidth);
      if (need > room + 0.5) zoomTo(child, room, need);
    }
    // what still runs over (inline content, offsets): the whole body
    if (body.scrollWidth > room + 0.5) zoomTo(body, room, body.scrollWidth);
  }
  // a message shorter than a third of a page never splits across two
  const paper: Paper = doc.documentElement.dataset.paper === "a4" ? "a4" : "letter";
  const third = ((PAGE[paper].height - MARGIN.top - MARGIN.bottom) * (96 / 25.4)) / 3;
  for (const msg of doc.querySelectorAll<HTMLElement>(".msg")) {
    if (msg.getBoundingClientRect().height < third) {
      msg.dataset.fit = "";
      msg.classList.add("keep");
    }
  }
}

/** Waits (bounded) until what changes the layout has settled: fonts, and every image decoded or failed. */
export async function settlePrintDocument(doc: Document, timeoutMs = 4000): Promise<void> {
  const images = [...doc.images].map((img) => (img.complete ? Promise.resolve() : img.decode().catch(() => {})));
  await Promise.race([Promise.all([doc.fonts.ready, ...images]), new Promise((r) => setTimeout(r, timeoutMs))]);
}

/** The fitted page as printed or exported, in standards mode. */
export function serializePrintDocument(doc: Document): string {
  return `<!doctype html>${doc.documentElement.outerHTML}`;
}

/** Remote URLs still in the page (only allowed messages keep any): the desktop's print window loads these and nothing else. */
export function remoteUrls(doc: Document): string[] {
  const urls = new Set<string>();
  for (const img of doc.images) if (REMOTE_URL.test(img.getAttribute("src") ?? "")) urls.add(img.src);
  for (const el of doc.querySelectorAll("[background]")) if (REMOTE_URL.test(el.getAttribute("background")!)) urls.add(new URL(el.getAttribute("background")!.trim(), doc.baseURI).href);
  for (const el of doc.querySelectorAll("[style]")) {
    for (const m of el.getAttribute("style")!.matchAll(/url\(\s*['"]?\s*(https?:[^'")]+)/gi)) {
      try {
        urls.add(new URL(m[1]!.trim()).href);
      } catch {
        /* not a URL: it won't load either */
      }
    }
  }
  return [...urls];
}

exposeForTests({ buildPrintDocument });
