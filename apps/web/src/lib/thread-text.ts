/**
 * Plan 149: a conversation to paste, in two forms from one reading of the mail:
 * plain text for an AI's composer ("the report (https://…)"), and simple HTML
 * for a document (real links, bold, italics). The mail parses into a document with
 * no browsing context (nothing loads or runs); the HTML is written here from
 * its words, never the mail's own, so a paste can't fetch its pixels either.
 */
import type { Address, MessageDetail, ThreadDetail } from "@terno/core";
import { t } from "@terno/i18n";
import { fullDate } from "~/lib/format";
import { splitTextQuote } from "~/lib/quote";
import { stripTrailingQuote } from "~/lib/quote-html";

const SKIP = new Set("head title meta link base script style noscript template svg math select datalist object embed iframe frame frameset audio video canvas".split(" "));
const BLOCK = new Set("address article aside center dd details dialog dir div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr legend li main menu nav ol p pre search section summary ul".split(" "));
/** Set apart by a blank line, unless an inline style says their margin is gone. */
const PARAGRAPH = new Set("dl figure h1 h2 h3 h4 h5 h6 hr p".split(" "));
const BOLD = new Set("b strong h1 h2 h3 h4 h5 h6 th".split(" "));
const ITALIC = new Set("i em cite".split(" "));
const ATOMIC = new Set(["inline-block", "inline-flex", "inline-grid", "inline-table"]);
/** Not there to read: zero-width spaces, BOMs, soft hyphens, word joiners, Gmail's preheader filler; and the markers below, which mail can't forge. */
const INVISIBLE = /[\u200b\ufeff\u00ad\u2060\ue000-\ue002]|\u034f/g;

/** A line's style changes in place, inline, so everything that lays out lines (indents, `> `, ` | `) doesn't need to know: \ue000 flags \ue001 link \ue002, until the next. */
const MARK = /\ue000([bi]*)\ue001([^\ue002]*)\ue002/;
const PLAIN = "\ue000\ue001\ue002";
const markOf = (bold: boolean, italic: boolean, link: string | null) => `\ue000${bold ? "b" : ""}${italic ? "i" : ""}\ue001${link ?? ""}\ue002`;
/** What a mail can link to in a paste; never `javascript:`, a `cid:` or a page-relative address. */
const LINKS = /^(?:https?:\/\/|mailto:|tel:)/i;

type Whitespace = "normal" | "pre" | "pre-line";
/** What a walk inherits; each can be undone further down (a `font-size:0` wrapper's children set their own). */
interface Walk {
  fontZero: boolean;
  invisible: boolean;
  whitespace: Whitespace;
  /** a list directly in a list item follows its text, with no blank line */
  inItem: boolean;
  bold: boolean;
  italic: boolean;
  link: string | null;
}
const START: Walk = { fontZero: false, invisible: false, whitespace: "normal", inItem: false, bold: false, italic: false, link: null };

/** Lines being written: the inline text of the current one, and what separates the next. */
class Lines {
  readonly lines: string[] = [];
  private current = "";
  private mark = PLAIN;
  private preserved = false;
  private onlySpaces = false;
  private gapWanted = false;

  text(raw: string, walk: Walk): void {
    const text = raw.replace(INVISIBLE, "");
    const mark = markOf(walk.bold, walk.italic, walk.link);
    if (walk.whitespace === "normal") return this.collapsed(text, mark);
    const parts = text.split(/\r\n?|\n/);
    parts.forEach((part, i) => {
      if (i > 0) this.lineBreak();
      if (walk.whitespace === "pre") this.put(part, mark);
      // pre-line: spaces collapse, and go around a break; the breaks themselves are as written
      else this.collapsed((i > 0 ? part.trimStart() : part).slice(0, i < parts.length - 1 ? part.trimEnd().length : undefined), mark);
      this.preserved = true;
    });
  }

  private collapsed(text: string, mark: string): void {
    // `&nbsp;` alone in a block is that block's blank line (Outlook's, between its lines)
    if (text.includes("\u00a0") && !text.trim()) this.onlySpaces = true;
    let out = text.replace(/\s+/g, " ");
    if (!this.current || this.current.endsWith(" ")) out = out.replace(/^ /, "");
    this.put(out, mark);
  }

  /** Spaces never change the style, and go before a change: a link starts at its first word. */
  private put(text: string, mark: string): void {
    if (!text.trim() || mark === this.mark) {
      this.current += text;
      return;
    }
    const lead = text.length - text.trimStart().length;
    this.current += text.slice(0, lead) + mark + text.slice(lead);
    this.mark = mark;
  }

  /** Ends the line if there is one; a block's edge, and nothing when the line is already empty. Its style ends with it. */
  endLine(): void {
    const closing = this.mark === PLAIN ? "" : PLAIN;
    if (this.preserved) this.push(this.current + closing, true);
    else if (this.current.trim()) this.push(this.current.trimEnd() + closing);
    else if (this.onlySpaces) this.push("");
    this.current = "";
    this.mark = PLAIN;
    this.preserved = false;
    this.onlySpaces = false;
  }

  /** `<br>`: an empty line ends too, so `<div><br></div>` is one blank line and a trailing `<br>` adds nothing. */
  lineBreak(): void {
    if (this.current.trim() || this.preserved) return this.endLine();
    this.current = "";
    this.onlySpaces = false;
    this.push("");
  }

  /** One blank line before what comes next, however many blocks ask for it. */
  gap(): void {
    this.endLine();
    this.gapWanted = true;
  }

  /** A finished line. Exact: a line someone already laid out (`<pre>`, a list item, a cell) keeps its blanks. */
  push(line: string, exact = false): void {
    const last = this.lines[this.lines.length - 1];
    if (line === "" && !exact) {
      this.gapWanted = false;
      if (last !== undefined && last !== "") this.lines.push("");
      return;
    }
    if (this.gapWanted && last !== undefined && last !== "") this.lines.push("");
    this.gapWanted = false;
    this.lines.push(line);
  }

  finish(): string[] {
    this.endLine();
    const blank = (l: string | undefined) => l !== undefined && !l.trim();
    let start = 0;
    let end = this.lines.length;
    while (start < end && blank(this.lines[start])) start++;
    while (end > start && blank(this.lines[end - 1])) end--;
    return this.lines.slice(start, end);
  }
}

const isZero = (value: string) => parseFloat(value) === 0;

/** Gone with everything inside it, whatever a descendant says; `render` removes these before anything reads the mail. */
function gone(el: HTMLElement): boolean {
  const s = el.style;
  return s.display === "none" || (el.hasAttribute("hidden") && !s.display) || isZero(s.opacity) || (isZero(s.maxHeight) && /hidden|clip/.test(s.overflow || s.overflowY));
}

function linkOf(el: HTMLElement): string | null {
  const href = el.getAttribute("href")?.replace(INVISIBLE, "").trim();
  return href && LINKS.test(href) ? href : null;
}

const heavy = (weight: string) => weight === "bold" || weight === "bolder" || parseInt(weight) >= 600;

function within(el: HTMLElement, walk: Walk): Walk {
  const s = el.style;
  const name = el.localName;
  const size = s.fontSize;
  const visibility = s.visibility;
  const space = s.whiteSpace;
  return {
    ...walk,
    fontZero: size ? isZero(size) : walk.fontZero,
    invisible: visibility === "hidden" || visibility === "collapse" ? true : visibility === "visible" ? false : walk.invisible,
    whitespace: /^(pre|pre-wrap|break-spaces)$/.test(space) ? "pre" : space === "pre-line" ? "pre-line" : space === "normal" || space === "nowrap" ? "normal" : name === "pre" ? "pre" : walk.whitespace,
    bold: s.fontWeight ? heavy(s.fontWeight) : walk.bold || BOLD.has(name),
    italic: s.fontStyle ? s.fontStyle !== "normal" : walk.italic || ITALIC.has(name),
    link: (name === "a" && linkOf(el)) || walk.link,
  };
}

/** Its own block of lines, to indent, prefix or lay out beside others. */
function linesOf(el: HTMLElement, walk: Walk): string[] {
  const out = new Lines();
  walkChildren(el, out, walk);
  return out.finish();
}

function list(el: HTMLElement, out: Lines, walk: Walk): void {
  const ordered = el.localName === "ol";
  let n = ordered ? Number(el.getAttribute("start")) || 1 : 0;
  const item = { ...walk, inItem: true };
  for (const c of el.children as HTMLCollectionOf<HTMLElement>) {
    if (c.localName === "ul" || c.localName === "ol") {
      // Word and Outlook put a nested list straight in the list
      const nested = new Lines();
      list(c, nested, within(c, walk));
      for (const line of nested.finish()) out.push(line && `  ${line}`, true);
      continue;
    }
    const marker = ordered ? `${n++}. ` : "- ";
    const pad = " ".repeat(marker.length);
    linesOf(c, within(c, item)).forEach((line, i) => out.push(i === 0 ? marker + line : line && pad + line, true));
  }
}

/**
 * Mail lays out with tables, so a row only reads as a row when its cells are one line each. Anything larger is
 * content in columns: its cells follow each other. An empty row is a spacer.
 */
function table(el: HTMLTableElement, out: Lines, walk: Walk): void {
  out.gap();
  if (el.caption) for (const line of linesOf(el.caption, within(el.caption, walk))) out.push(line, true);
  for (const row of el.rows) {
    // `rows` skips over its section, which can hold what the row inherits
    const inRow = within(row, within(row.parentElement as HTMLElement, walk));
    const cells = [...row.cells].map((c) => linesOf(c, within(c, inRow))).filter((c) => c.length > 0);
    if (cells.length === 0) out.gap();
    else if (cells.every((c) => c.length === 1)) out.push(cells.map((c) => c[0]).join(" | "), true);
    else {
      out.gap();
      for (const cell of cells) {
        for (const line of cell) out.push(line, true);
        out.gap();
      }
    }
  }
  out.gap();
}

/** A picture that links and says nothing, not even in its description: all there is to show is where it goes. */
function wordless(a: HTMLElement): boolean {
  const images = [...a.querySelectorAll("img")];
  return images.length > 0 && !a.textContent?.trim() && !images.some((img) => img.getAttribute("alt")?.trim());
}

function walkChildren(parent: Element, out: Lines, walk: Walk): void {
  // recursive: the HTML parser caps nesting at 512, so this can't overflow
  for (const node of parent.childNodes) {
    if (node.nodeType === 3) {
      if (!walk.fontZero && !walk.invisible) out.text(node.nodeValue ?? "", walk);
      continue;
    }
    if (node.nodeType !== 1) continue;
    const el = node as HTMLElement;
    const name = el.localName;
    const inner = within(el, walk);
    const s = el.style;
    const inline = { ...inner, whitespace: "normal" as const };
    if (name === "br") out.lineBreak();
    else if (name === "img") {
      if (!inner.fontZero && !inner.invisible) out.text(` ${el.getAttribute("alt") ?? ""} `, inline);
    } else if (name === "a" && inner.link && !inner.invisible && wordless(el)) out.text(` ${inner.link} `, inline);
    else if (name === "table") table(el as HTMLTableElement, out, inner);
    else if (name === "ul" || name === "ol") {
      const tight = walk.inItem;
      if (tight) out.endLine();
      else out.gap();
      list(el, out, { ...inner, inItem: false });
      if (tight) out.endLine();
      else out.gap();
    } else if (name === "blockquote") {
      out.gap();
      for (const line of linesOf(el, { ...inner, inItem: false })) out.push(line ? `> ${line}` : ">", true);
      out.gap();
    } else if (name === "pre" && inner.whitespace === "pre") {
      out.gap();
      walkChildren(el, out, inner);
      out.gap();
    } else if (s.display === "inline" || s.display === "contents" || ATOMIC.has(s.display)) {
      const atomic = ATOMIC.has(s.display);
      if (atomic) out.text(" ", inline);
      walkChildren(el, out, inner);
      if (atomic) out.text(" ", inline);
    } else if (BLOCK.has(name) || s.display) {
      const zero = isZero(s.marginTop) && isZero(s.marginBottom);
      const margin = parseFloat(s.marginTop) > 0 || parseFloat(s.marginBottom) > 0;
      // Outlook's lines: no margin in its stylesheet, an explicit `&nbsp;` paragraph between them
      const apart = PARAGRAPH.has(name) ? !zero && !el.classList.contains("MsoNormal") : margin;
      if (apart) out.gap();
      else out.endLine();
      walkChildren(el, out, inner);
      if (apart) out.gap();
      else out.endLine();
    } else walkChildren(el, out, inner);
  }
}

const render = (html: string, strip: boolean): string => {
  const { body } = new DOMParser().parseFromString(html, "text/html");
  // first: what can't be seen isn't words after a quote that make it an inline reply (a tracking footer, a `<style>`)
  for (const el of body.querySelectorAll<HTMLElement>("*")) if (SKIP.has(el.localName) || gone(el)) el.remove();
  if (strip) stripTrailingQuote(body);
  return linesOf(body, within(body, START)).join("\n");
};

/** An HTML body as marked lines. `keepHistory`: nothing above in the conversation repeats its quotes. */
function htmlBodyLines(html: string, keepHistory: boolean): string {
  // no words left without the history (a picture with no description above it): it stays
  return keepHistory ? render(html, false) : render(html, true) || render(html, false);
}

interface Run {
  text: string;
  bold: boolean;
  italic: boolean;
  link: string | null;
}

/** Marked text as runs in one style; a word split over bold and plain is one link, if it is one. */
function runsOf(marked: string): Run[] {
  const parts = marked.split(MARK);
  const runs: Run[] = [{ text: parts[0]!, bold: false, italic: false, link: null }];
  for (let i = 1; i < parts.length; i += 3) runs.push({ text: parts[i + 2]!, bold: parts[i]!.includes("b"), italic: parts[i]!.includes("i"), link: parts[i + 1] || null });
  return runs.filter((r) => r.text);
}

const edges = (text: string) => ({ lead: text.slice(0, text.length - text.trimStart().length), trail: text.slice(text.trimEnd().length) });
/** A link's address as it reads: an email or a phone without its scheme. */
const shownAddress = (link: string) => (/^(?:mailto|tel):/i.test(link) ? link.replace(/^[a-z]+:/i, "").replace(/\?.*$/, "") : link);
const sameAddress = (a: string) => a.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");

/** Runs grouped by link: a link's text may be several runs, its spaces at the edges stay outside it. */
function eachLink(runs: Run[], write: (link: string | null, runs: Run[]) => void): void {
  for (let i = 0; i < runs.length; ) {
    let end = i + 1;
    if (runs[i]!.link) while (end < runs.length && runs[end]!.link === runs[i]!.link) end++;
    write(runs[i]!.link, runs.slice(i, end));
    i = end;
  }
}

/** For a composer that only takes text: "the report (https://…)", or only the address when it is all the text says. */
function plainOf(marked: string): string {
  let out = "";
  eachLink(runsOf(marked), (link, runs) => {
    const all = runs.map((r) => r.text).join("");
    if (!link) return void (out += all);
    const label = all.trim();
    const address = shownAddress(link);
    const { lead, trail } = edges(all);
    out += lead + (sameAddress(label) === sameAddress(address) ? address : `${label} (${address})`) + trail;
  });
  return out;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const spaced = (s: string) => esc(s).replace(/ {2,}/g, (run) => "&nbsp;".repeat(run.length));
/** An address written out in the words is a link too (all a plain-text mail has). */
const BARE_URL = /(https?:\/\/(?:[^\s<>"'()]|\([^\s<>"'()]*\))*(?:[^\s<>"'().,;:!?]|\([^\s<>"'()]*\)))/g;
/** A run's tags hold its words: the spaces at its edges stay outside them. */
function styled(r: Run, words: (text: string) => string): string {
  const inner = words(r.text.trim());
  if (!inner) return spaced(r.text);
  const { lead, trail } = edges(r.text);
  const bold = r.bold ? `<b>${inner}</b>` : inner;
  return spaced(lead) + (r.italic ? `<i>${bold}</i>` : bold) + spaced(trail);
}

const withBareLinks = (text: string) =>
  text
    .split(BARE_URL)
    .map((part, i) => (i % 2 ? `<a href="${esc(part)}">${esc(part)}</a>` : spaced(part)))
    .join("");

function htmlLine(marked: string): string {
  let out = "";
  eachLink(runsOf(marked), (link, runs) => {
    if (!link) {
      for (const r of runs) out += styled(r, withBareLinks);
      return;
    }
    const { lead, trail } = edges(runs.map((r) => r.text).join(""));
    const inside = runs.map((r, i) => {
      let text = r.text;
      if (i === 0) text = text.trimStart();
      if (i === runs.length - 1) text = text.trimEnd();
      return styled({ ...r, text }, spaced);
    });
    out += `${lead}<a href="${esc(link)}">${inside.join("")}</a>${trail}`;
  });
  // indentation is what lays a list or `<pre>` out, and HTML would collapse it
  return out.replace(/^ +/, (run) => "&nbsp;".repeat(run.length));
}

/** For a document: blank lines make paragraphs, lines breaks. */
function htmlOf(marked: string): string {
  return marked
    .split(/\n{2,}/)
    .map((block) => `<p>${block.split("\n").map(htmlLine).join("<br>")}</p>`)
    .join("");
}

/** A plain-text body, tidied: line ends and blank runs, indentation untouched. */
export function plainBodyText(raw: string, keepHistory: boolean): string {
  const text = raw.replace(/\r\n?/g, "\n");
  const body = keepHistory ? text : splitTextQuote(text).main;
  return body
    .replace(INVISIBLE, "")
    .replace(/\u00a0/g, " ")
    .replace(/[^\S\n]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .trimEnd();
}

const person = (a: Address) => (a.name && a.name !== a.email ? `${a.name} <${a.email}>` : a.email);

/** What the message says, and whether part of it couldn't be had. */
function bodyOf(m: MessageDetail, keepHistory: boolean): { text: string; missing: boolean } {
  const text = (m.bodyHtml ? htmlBodyLines(m.bodyHtml, keepHistory) : "") || (m.bodyText ? plainBodyText(m.bodyText, keepHistory) : "");
  if (text) return m.bodyState === "partial" ? { text: `${text}\n\n[${t("threadText.partial")}]`, missing: true } : { text, missing: false };
  if (m.bodyUnavailable) return { text: `[${t("attachments.bodyUnavailable")}]`, missing: true };
  if (m.bodyState === "full") return { text: `[${t("attachments.noBody")}]`, missing: false };
  return { text: `[${t("print.doc.notDownloaded")}]`, missing: true };
}

const label = (key: string) => `${markOf(true, false, null)}${key}:${PLAIN} `;
const words = (s: string) => s.replace(INVISIBLE, "");

function headOf(m: MessageDetail): string[] {
  // an image the mail shows in place isn't something it has attached
  const attached = m.attachments.filter((a) => !(a.contentId && m.bodyHtml?.includes(`cid:${a.contentId.replace(/[<>]/g, "")}`)));
  const people = (list: Address[]) => words(list.map(person).join(", "));
  return [
    `${label(t("threadText.from"))}${words(person(m.from))}`,
    ...(m.to.length ? [`${label(t("print.doc.to"))}${people(m.to)}`] : []),
    ...(m.cc.length ? [`${label(t("print.doc.cc"))}${people(m.cc)}`] : []),
    `${label(t("threadText.date"))}${fullDate(m.date)}`,
    ...(attached.length ? [`${label(t("print.doc.attachments"))}${words(attached.map((a) => a.filename).join(", "))}`] : []),
  ];
}

export interface ThreadText {
  text: string;
  html: string;
  messages: number;
  /** messages that are in the text only in part or as a note */
  missing: number;
}

/**
 * The conversation, oldest first. A message's quoted history goes when everything it can repeat is above it in full;
 * in the first message, or below a body we don't have, it may be the only copy.
 */
export async function threadText(detail: ThreadDetail): Promise<ThreadText> {
  const parts: string[] = [];
  let missing = 0;
  let covered = false;
  for (const [i, m] of detail.messages.entries()) {
    // one parse each: a long conversation doesn't freeze the window
    if (i > 0) await new Promise((resolve) => setTimeout(resolve));
    const body = bodyOf(m, !covered);
    if (body.missing) missing++;
    covered = i === 0 ? !body.missing : covered && !body.missing;
    parts.push(`${headOf(m).join("\n")}\n\n${body.text}`);
  }
  const subject = words(detail.thread.subject).trim();
  const head = subject ? `${label(t("threadText.subject"))}${subject}\n\n` : "";
  return {
    text: plainOf(head + parts.join("\n\n---\n\n")),
    html: (head ? htmlOf(head.trim()) : "") + parts.map(htmlOf).join("<hr>"),
    messages: detail.messages.length,
    missing,
  };
}

/** One HTML body as the text a composer gets. */
export const htmlBodyText = (html: string, keepHistory: boolean): string => plainOf(htmlBodyLines(html, keepHistory));
/** One HTML body as the HTML a document gets. */
export const htmlBodyHtml = (html: string, keepHistory: boolean): string => htmlOf(htmlBodyLines(html, keepHistory));
