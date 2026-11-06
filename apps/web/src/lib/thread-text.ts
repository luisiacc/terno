/**
 * Plan 149: a conversation as plain text, formatted to read and to paste into
 * an AI. Only the click on "Copy conversation as text" loads this chunk. The
 * mail parses into a document with no browsing context (nothing loads or runs)
 * and leaves as a string, so nothing here needs a sanitizer.
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
const ATOMIC = new Set(["inline-block", "inline-flex", "inline-grid", "inline-table"]);
/** Not there to read: zero-width spaces, BOMs, soft hyphens, word joiners, Gmail's preheader filler. */
const INVISIBLE = /[​﻿­⁠]|͏/g;

type Whitespace = "normal" | "pre" | "pre-line";
/** What a walk inherits; each can be undone further down (a `font-size:0` wrapper's children set their own). */
interface Walk {
  fontZero: boolean;
  invisible: boolean;
  whitespace: Whitespace;
  /** a list directly in a list item follows its text, with no blank line */
  inItem: boolean;
}
const START: Walk = { fontZero: false, invisible: false, whitespace: "normal", inItem: false };

/** Lines being written: the inline text of the current one, and what separates the next. */
class Lines {
  readonly lines: string[] = [];
  private current = "";
  private preserved = false;
  private onlySpaces = false;
  private gapWanted = false;

  text(raw: string, whitespace: Whitespace): void {
    const text = raw.replace(INVISIBLE, "");
    if (whitespace === "normal") return this.collapsed(text);
    const parts = text.split(/\r\n?|\n/);
    parts.forEach((part, i) => {
      if (i > 0) this.lineBreak();
      if (whitespace === "pre") {
        this.current += part;
        this.preserved = true;
      } else this.collapsed(part);
    });
  }

  private collapsed(text: string): void {
    // `&nbsp;` alone in a block is that block's blank line (Outlook's, between its lines)
    if (text.includes(" ") && !text.trim()) this.onlySpaces = true;
    let out = text.replace(/\s+/g, " ");
    if (!this.current || this.current.endsWith(" ")) out = out.replace(/^ /, "");
    this.current += out;
  }

  /** Ends the line if there is one; a block's edge, and nothing when the line is already empty. */
  endLine(): void {
    if (this.preserved) this.push(this.current, true);
    else if (this.current.trim()) this.push(this.current.trimEnd());
    else if (this.onlySpaces) this.push("");
    this.current = "";
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

/** Gone with everything inside it, whatever a descendant says. */
function gone(el: HTMLElement): boolean {
  const s = el.style;
  return s.display === "none" || (el.hasAttribute("hidden") && !s.display) || isZero(s.opacity) || (isZero(s.maxHeight) && /hidden|clip/.test(s.overflow || s.overflowY));
}

function within(el: HTMLElement, walk: Walk): Walk {
  const s = el.style;
  const size = s.fontSize;
  const visibility = s.visibility;
  const space = s.whiteSpace;
  return {
    ...walk,
    fontZero: size ? isZero(size) : walk.fontZero,
    invisible: visibility === "hidden" || visibility === "collapse" ? true : visibility === "visible" ? false : walk.invisible,
    whitespace: /^(pre|pre-wrap|break-spaces)$/.test(space) ? "pre" : space === "pre-line" ? "pre-line" : space === "normal" || space === "nowrap" ? "normal" : el.localName === "pre" ? "pre" : walk.whitespace,
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
    if (gone(c)) continue;
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
    if (gone(row)) continue;
    const inRow = within(row, walk);
    const cells = [...row.cells].filter((c) => !gone(c)).map((c) => linesOf(c, within(c, inRow))).filter((c) => c.length > 0);
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

function walkChildren(parent: Element, out: Lines, walk: Walk): void {
  // recursive: the HTML parser caps nesting at 512, so this can't overflow
  for (const node of parent.childNodes) {
    if (node.nodeType === 3) {
      if (!walk.fontZero && !walk.invisible) out.text(node.nodeValue ?? "", walk.whitespace);
      continue;
    }
    if (node.nodeType !== 1) continue;
    const el = node as HTMLElement;
    const name = el.localName;
    if (SKIP.has(name) || !el.style || gone(el)) continue;
    const inner = within(el, walk);
    const s = el.style;
    if (name === "br") out.lineBreak();
    else if (name === "img") {
      if (!inner.fontZero && !inner.invisible) out.text(` ${el.getAttribute("alt") ?? ""} `, "normal");
    } else if (name === "table") table(el as HTMLTableElement, out, inner);
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
      if (atomic) out.text(" ", "normal");
      walkChildren(el, out, inner);
      if (atomic) out.text(" ", "normal");
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
  if (strip) stripTrailingQuote(body);
  return linesOf(body, within(body, START)).join("\n");
};

/** An HTML body as formatted text. `keepHistory`: nothing above in the conversation repeats its quotes. */
export function htmlBodyText(html: string, keepHistory: boolean): string {
  if (keepHistory) return render(html, false);
  // a bare forward is nothing but history: it stays
  return render(html, true) || render(html, false);
}

/** A plain-text body, tidied: line ends and blank runs, indentation untouched. */
export function plainBodyText(raw: string, keepHistory: boolean): string {
  const text = raw.replace(/\r\n?/g, "\n");
  const body = keepHistory ? text : splitTextQuote(text).main;
  return body
    .replace(INVISIBLE, "")
    .replace(/ /g, " ")
    .replace(/[^\S\n]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .trimEnd();
}

const person = (a: Address) => (a.name && a.name !== a.email ? `${a.name} <${a.email}>` : a.email);

/** What the message says, and whether part of it couldn't be had. */
function bodyOf(m: MessageDetail, keepHistory: boolean): { text: string; missing: boolean } {
  const text = (m.bodyHtml ? htmlBodyText(m.bodyHtml, keepHistory) : "") || (m.bodyText ? plainBodyText(m.bodyText, keepHistory) : "");
  if (text) return m.bodyState === "partial" ? { text: `${text}\n\n[${t("threadText.partial")}]`, missing: true } : { text, missing: false };
  if (m.bodyUnavailable) return { text: `[${t("attachments.bodyUnavailable")}]`, missing: true };
  if (m.bodyState === "full") return { text: `[${t("attachments.noBody")}]`, missing: false };
  return { text: `[${t("print.doc.notDownloaded")}]`, missing: true };
}

function headOf(m: MessageDetail): string[] {
  // an image the mail shows in place isn't something it has attached
  const attached = m.attachments.filter((a) => !(a.contentId && m.bodyHtml?.includes(`cid:${a.contentId.replace(/[<>]/g, "")}`)));
  return [
    `${t("threadText.from")}: ${person(m.from)}`,
    ...(m.to.length ? [`${t("print.doc.to")}: ${m.to.map(person).join(", ")}`] : []),
    ...(m.cc.length ? [`${t("print.doc.cc")}: ${m.cc.map(person).join(", ")}`] : []),
    `${t("threadText.date")}: ${fullDate(m.date)}`,
    ...(attached.length ? [`${t("print.doc.attachments")}: ${attached.map((a) => a.filename).join(", ")}`] : []),
  ];
}

export interface ThreadText {
  text: string;
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
  const subject = detail.thread.subject.trim();
  const text = parts.join("\n\n---\n\n");
  return { text: subject ? `${t("threadText.subject")}: ${subject}\n\n${text}` : text, messages: detail.messages.length, missing };
}
