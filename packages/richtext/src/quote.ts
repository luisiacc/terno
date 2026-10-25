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

/** One line of plain text as HTML: escaped, its spaces kept, its http(s) URLs as links. */
export function lineHtml(line: string): string {
  if (line === "") return "<br>";
  let out = "";
  let at = 0;
  for (const m of line.matchAll(URL_RE)) {
    const url = m[0];
    const i = m.index;
    out += encodeSpaces(escapeHtml(line.slice(at, i)), at === 0, false);
    out += isSafeHref(url) ? `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>` : escapeHtml(url);
    at = i + url.length;
  }
  return out + encodeSpaces(escapeHtml(line.slice(at)), at === 0, true);
}

/** Plain lines as the composer's lines (one <div> each), "> " runs as nested blockquotes. */
function linesHtml(lines: readonly string[]): string {
  let out = "";
  for (let i = 0; i < lines.length; ) {
    if (lines[i]!.startsWith(">")) {
      const run: string[] = [];
      while (i < lines.length && lines[i]!.startsWith(">")) run.push(lines[i++]!.replace(/^> ?/, ""));
      out += `<blockquote style="${QUOTE_STYLE}">${linesHtml(run)}</blockquote>`;
    } else out += `<div>${lineHtml(lines[i++]!)}</div>`;
  }
  return out;
}

/** A plain text (a signature, a quote, a forward's header and text) as HTML. */
export function textToHtml(text: string): string {
  return linesHtml(text.replace(/\r\n?/g, "\n").split("\n"));
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
