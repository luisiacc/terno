import type { Mark, Node as PMNode } from "prosemirror-model";
import { spelledLinks } from "./autolinks";
import { FONT_CSS, HIGHLIGHT_HEX, HIGHLIGHT_INK, SIZE_CSS, TEXT_HEX, type Font, type Highlight, type Size, type TextColor } from "./palette";
import { encodeSpaces, escapeHtml, QUOTE_STYLE } from "./quote";
import { blockStyle } from "./schema";

/**
 * A document as the text/html part of a mail (plan 16 §3): inline styles
 * only (what Gmail and Outlook keep), no <style>, no classes or ids; the only
 * attributes are style, href and start. Default text carries no font, size
 * or color: the recipient's defaults, as Gmail's own mail does, so dark
 * modes and our own reader keep it readable. parseHtml reads it back to the
 * same document (the draft's storage).
 */

export const LIST_STYLE = "margin:0 0 0 24px;padding:0";

const styleAttr = (style: string) => (style ? ` style="${style}"` : "");

function openTag(mark: Mark): string {
  const v = mark.attrs.value as string;
  switch (mark.type.name) {
    case "link":
      return `<a href="${escapeHtml(mark.attrs.href as string)}">`;
    case "bold":
      return "<b>";
    case "italic":
      return "<i>";
    case "underline":
      return "<u>";
    case "strike":
      return "<s>";
    case "font":
      return `<span style="font-family:${FONT_CSS[v as Font]}">`;
    case "size":
      return `<span style="font-size:${SIZE_CSS[v as Size]}">`;
    case "highlight":
      return `<span style="background-color:${HIGHLIGHT_HEX[v as Highlight]};color:${HIGHLIGHT_INK}">`;
    case "color":
      return `<span style="color:${TEXT_HEX[v as TextColor]}">`;
    default:
      return "";
  }
}

const CLOSE: Record<string, string> = { link: "</a>", bold: "</b>", italic: "</i>", underline: "</u>", strike: "</s>" };
const closeTag = (mark: Mark) => CLOSE[mark.type.name] ?? "</span>";

/** A textblock's inline content; "" when it has none. A break carries marks too (typed inside bold, it is bold). */
function inlineHtml(textblock: PMNode): string {
  // an autolink goes where its text says (plan 39)
  const block = spelledLinks(textblock);
  let out = "";
  const open: Mark[] = [];
  let lineStart = true;
  let afterSpace = false;
  const count = block.childCount;
  for (let i = 0; i < count; i++) {
    const child = block.child(i);
    const isBreak = child.type.name === "hard_break";
    if (!isBreak && !child.isText) continue;
    const marks = child.marks;
    let keep = 0;
    while (keep < open.length && keep < marks.length && open[keep]!.eq(marks[keep]!)) keep++;
    while (open.length > keep) out += closeTag(open.pop()!);
    for (let m = keep; m < marks.length; m++) {
      out += openTag(marks[m]!);
      open.push(marks[m]!);
    }
    if (isBreak) {
      out += "<br>";
      lineStart = true;
      afterSpace = false;
      continue;
    }
    const next = i + 1 < count ? block.child(i + 1) : null;
    const lineEnd = !next || next.type.name === "hard_break";
    out += encodeSpaces(escapeHtml(child.text!).replace(/\u00a0/g, "&nbsp;"), lineStart, lineEnd, afterSpace);
    // the next run starts after a regular space only when this one's last char came out as one
    afterSpace = out.endsWith(" ");
    lineStart = false;
  }
  while (open.length) out += closeTag(open.pop()!);
  // a line that ends in a break shows one more (empty) line in the editor: the browser needs a second <br> for it
  if (count > 0 && block.child(count - 1).type.name === "hard_break") out += "<br>";
  return out;
}

const isPlain = (p: PMNode) => p.type.name === "paragraph" && p.attrs.align === "left" && p.attrs.indent === 0;

function blockHtml(node: PMNode): string {
  switch (node.type.name) {
    case "paragraph":
      return `<div${styleAttr(blockStyle(node.attrs))}>${inlineHtml(node) || "<br>"}</div>`;
    case "blockquote": {
      let inner = "";
      node.forEach((c) => (inner += blockHtml(c)));
      return `<blockquote style="${QUOTE_STYLE}">${inner}</blockquote>`;
    }
    case "bullet_list":
    case "ordered_list": {
      const tag = node.type.name === "ordered_list" ? "ol" : "ul";
      const start = tag === "ol" && node.attrs.start !== 1 ? ` start="${node.attrs.start}"` : "";
      let items = "";
      node.forEach((item) => {
        let inner = "";
        item.forEach((c, _offset, i) => {
          // the first line of an item sits in the <li> itself (the common case, and what every client lists well)
          // (an empty first line followed by more stays a <div>: a lone <br> before a block draws nothing)
          inner += i === 0 && isPlain(c) && (c.childCount > 0 || item.childCount === 1) ? inlineHtml(c) || "<br>" : blockHtml(c);
        });
        items += `<li>${inner}</li>`;
      });
      return `<${tag}${start} style="${LIST_STYLE}">${items}</${tag}>`;
    }
    default:
      return "";
  }
}

/** The document's text/html fragment. */
export function toEmailHtml(doc: PMNode): string {
  let out = "";
  doc.forEach((block) => (out += blockHtml(block)));
  return out;
}
