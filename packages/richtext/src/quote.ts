import { isSafeHref } from "./links";

/**
 * The HTML pieces of a sent message that aren't the editor's document: the
 * signature, the quoted original and the document around them (plan 16 §5).
 * No ProseMirror here: the send path runs from stored strings, in the
 * renderer's entry chunk.
 */

export const QUOTE_STYLE = "margin:0 0 0 0.8ex;border-left:2px solid #ccc;padding-left:1ex";

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Spaces that HTML would collapse (leading, trailing, runs) as alternating &nbsp;, tabs kept with white-space:pre. */
export function encodeSpaces(escaped: string, lineStart: boolean, lineEnd: boolean, afterSpace = false): string {
  const last = escaped.length;
  return escaped
    .replace(/ +/g, (run, offset: number) => {
      let out = "";
      let prevRegular = offset === 0 ? afterSpace : false;
      for (let i = 0; i < run.length; i++) {
        const atStart = offset === 0 && i === 0 && lineStart;
        const atEnd = offset + i === last - 1 && lineEnd;
        if (atStart || atEnd || prevRegular) {
          out += "&nbsp;";
          prevRegular = false;
        } else {
          out += " ";
          prevRegular = true;
        }
      }
      return out;
    })
    .replace(/\t/g, '<span style="white-space:pre">\t</span>');
}

const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g;

/** Part of a line as HTML (`start`/`end`: whether it begins or ends the line, for its edge spaces). */
function partHtml(line: string, start: boolean, end: boolean): string {
  let out = "";
  let at = 0;
  for (const m of line.matchAll(URL_RE)) {
    const url = m[0];
    const i = m.index;
    out += encodeSpaces(escapeHtml(line.slice(at, i)), start && at === 0, false);
    out += isSafeHref(url) ? `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>` : escapeHtml(url);
    at = i + url.length;
  }
  return out + encodeSpaces(escapeHtml(line.slice(at)), start && at === 0, end);
}

/** One line of plain text as HTML: escaped, its spaces kept, its http(s) URLs as links. */
export function lineHtml(line: string): string {
  return line === "" ? "<br>" : partHtml(line, true, true);
}

/** Quote levels past this stay as text (a hostile "> > > …" line can't nest without end). */
export const MAX_QUOTE_DEPTH = 32;

/** A line's quote depth ("> " per level, capped) and what follows it. */
function quoteDepth(line: string): [number, string] {
  let depth = 0;
  let rest = line;
  while (depth < MAX_QUOTE_DEPTH && rest.startsWith(">")) {
    rest = rest.replace(/^> ?/, "");
    depth++;
  }
  return [depth, rest];
}

/**
 * Plain lines as the composer's lines (one <div> each), "> " runs as nested
 * blockquotes: iterative, scanned as it goes, in pieces of about `budget`
 * characters (a caller in a time budget yields between them; a line longer
 * than that is cut into parts too).
 */
export function* textToHtmlChunks(text: string, budget = 16_384): Generator<string> {
  let open = 0;
  let out: string[] = [];
  let spent = 0;
  const flush = function* () {
    if (spent < budget) return;
    yield out.join("");
    out = [];
    spent = 0;
  };
  for (let pos = 0; pos <= text.length; ) {
    // CRLF and a lone CR end a line too
    let nl = pos;
    while (nl < text.length && text[nl] !== "\n" && text[nl] !== "\r") nl++;
    const line = text.slice(pos, nl);
    pos = nl + (text[nl] === "\r" && text[nl + 1] === "\n" ? 2 : 1);
    const [depth, rest] = quoteDepth(line);
    for (; open < depth; open++) out.push(`<blockquote style="${QUOTE_STYLE}">`);
    for (; open > depth; open--) out.push("</blockquote>");
    if (rest.length <= budget) {
      out.push(`<div>${lineHtml(rest)}</div>`);
      spent += rest.length + 1;
    } else {
      out.push("<div>");
      for (let i = 0; i < rest.length; i += budget) {
        out.push(partHtml(rest.slice(i, i + budget), i === 0, i + budget >= rest.length));
        spent += budget;
        yield* flush();
      }
      out.push("</div>");
    }
    yield* flush();
    if (nl >= text.length) break;
  }
  for (; open > 0; open--) out.push("</blockquote>");
  yield out.join("");
}

/** A plain text (a signature, a quote, a forward's header and text) as HTML. */
export function textToHtml(text: string): string {
  let out = "";
  for (const piece of textToHtmlChunks(text)) out += piece;
  return out;
}

/** The signature block below the text ("-- " marks it, so clients can fold it). */
export function signatureHtml(signature: string): string {
  const sig = signature.replace(/\s+$/, "");
  return sig ? `<div>-- <br>${sig.replace(/\r\n?/g, "\n").split("\n").map(lineHtml).join("<br>")}</div>` : "";
}

/** The empty line between parts, as the composer writes one. */
export const GAP = "<div><br></div>";

/** The text/html part's document: the body only, inline styles, no <style>. */
export function emailDocument(fragment: string): string {
  return `<!DOCTYPE html><html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"></head><body>${fragment}</body></html>`;
}
