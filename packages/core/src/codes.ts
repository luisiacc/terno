import { CODE_WORDS } from "@terno/i18n";
import { QUOTE_HEADER } from "./categorize/features";
import { normalizeText } from "./text";

/** A code is offered only on mail at most this old (plan 69). */
export const CODE_MAX_AGE = 2 * 3_600_000;
/** Mail dated a little ahead (the sender's clock) still counts as fresh. */
const CLOCK_SKEW = 5 * 60_000;
/** How far (in characters) a code may sit from the word that announces it. */
const NEAR = 120;
const BODY_CAP = 20_000;
const HTML_CAP = 200_000;

/** Scripts written without spaces: their words match anywhere, not only between word boundaries. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// every language's words, whatever the UI's: the mail's language is what counts
const WORDS = new RegExp(
  [...new Set(Object.values(CODE_WORDS).flat().map(normalizeText))].map((w) => (UNSPACED.test(w) ? escape(w) : `(?<![\\p{L}\\p{N}])${escape(w)}(?![\\p{L}\\p{N}])`)).join("|"),
  "gu",
);
/**
 * Six digits standing alone: together, split 3+3 by one space or hyphen, or one per box ("1 2 3 4 5 6", as HTML
 * templates lay them out). Not inside an id ("A123456", "#123456"), an amount ("$123456", "12.123456"), a phone
 * number ("650 253 0000"), a reference ("123456/789"), a date or a time.
 */
const CANDIDATE = /(?<![\p{L}\p{N}_#$€£¥+/@=]|[\p{L}\p{N}][.,-]|\p{N}\s)(\d{3}[ -]?\d{3}|\d(?:\s\d){5})(?![\p{L}\p{N}_%]|[.,/:-]? ?\p{N})/gu;
const URL = /\b(?:https?:\/\/|www\.|mailto:)\S+/gi;

interface Span {
  start: number;
  end: number;
}

function spans(re: RegExp, text: string): (Span & { value: string })[] {
  return [...text.matchAll(re)].map((m) => ({ start: m.index, end: m.index + m[0].length, value: m[0] }));
}

/** Inline tags between digits don't split them: "<b>12</b>3456" reads 123456. */
const INLINE_BETWEEN_DIGITS = /(\d)(?:<\/?(?:a|b|strong|i|em|u|s|span|font|small|big|mark|sup|sub|code|kbd|tt|wbr)\b[^>]*>)+(?=\d)/gi;

/**
 * The text a reader sees in an HTML body, roughly: no head, styles, scripts or quoted mail; inline tags and table cells
 * become spaces and other tags line breaks, so a `<code>` tag is never the word "code".
 */
export function htmlText(html: string): string {
  return html
    .slice(0, HTML_CAP)
    .replace(/<(head|style|script|title|blockquote)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(INLINE_BETWEEN_DIGITS, "$1")
    .replace(/<\/?(?:t[dh]|a|b|strong|i|em|u|s|span|font|small|big|mark|sup|sub|code|kbd|tt|wbr|img)\b[^>]*>/gi, " ")
    .replace(/<[^>]*>/g, "\n")
    .replace(/&(?:nbsp|ensp|emsp|thinsp|#160|#xa0);/gi, " ")
    .replace(/&#(\d{1,7});/g, (s, n: string) => (Number(n) <= 0x10ffff ? String.fromCodePoint(Number(n)) : s))
    .replace(/&#x([0-9a-f]{1,6});/gi, (s, n: string) => (parseInt(n, 16) <= 0x10ffff ? String.fromCodePoint(parseInt(n, 16)) : s))
    .replace(/&amp;/gi, "&")
    .replace(/[^\S\n]*\n\s*/g, "\n")
    .replace(/[^\S\n]+/g, " ");
}

/** What this message itself says: quoted lines and the replied-to history go (an old code must not come back in a reply). */
function ownText(text: string): string {
  const head = text.slice(0, BODY_CAP);
  const cut = QUOTE_HEADER.exec(head);
  return (cut ? head.slice(0, cut.index) : head)
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n");
}

/** In one stretch of text: the code closest to a word that announces it, if one is near enough. */
function closest(text: string): { code: string | null; announced: boolean; codes: Set<string> } {
  const words = spans(WORDS, text);
  const candidates = spans(CANDIDATE, text);
  const codes = new Set(candidates.map((c) => c.value.replace(/\D/g, "")));
  let best: string | null = null;
  let bestGap = NEAR + 1;
  for (const c of candidates) {
    for (const w of words) {
      const gap = c.start >= w.end ? c.start - w.end : w.start >= c.end ? w.start - c.end : 0;
      if (gap < bestGap) {
        bestGap = gap;
        best = c.value.replace(/\D/g, "");
      }
    }
  }
  return { code: best, announced: words.length > 0, codes };
}

/**
 * The verification code a message carries, or null (plan 69). Simple on purpose: six digits near a word like
 * "code" or "código". The subject wins over the body; a subject that announces a code ("Your sign-in code") takes
 * the body's only six-digit number even when no word sits beside it.
 */
export function findCode(subject: string, bodyText: string | null, bodyHtml: string | null): string | null {
  const head = closest(normalizeText(subject));
  if (head.code) return head.code;
  // the body the reader shows: its HTML when there is one
  const raw = bodyHtml ? htmlText(bodyHtml) : (bodyText ?? "");
  const body = closest(normalizeText(ownText(raw).replace(URL, " ")));
  if (body.code) return body.code;
  return head.announced && body.codes.size === 1 ? [...body.codes][0]! : null;
}

/** Whether a message is recent enough to offer its code. */
export function codeFresh(date: number, now: number): boolean {
  const age = now - date;
  return Number.isFinite(age) && age >= -CLOCK_SKEW && age <= CODE_MAX_AGE;
}

/** When a fresh message's code stops being offered. */
export function codeExpiry(date: number): number {
  return date + CODE_MAX_AGE;
}
