import { CODE_WORDS } from "@terno/i18n";
import { baseSubject, normalizeText } from "./text";

/** A code is offered only on mail at most this old (plan 72). */
export const CODE_MAX_AGE = 2 * 3_600_000;
/** Mail dated a little ahead (the sender's clock) still counts as fresh. */
const CLOCK_SKEW = 5 * 60_000;
/** How far (in characters) a code may sit from the word that announces it. */
const NEAR = 120;
const SUBJECT_CAP = 1_000;
const BODY_CAP = 20_000;

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
/**
 * Where replied-to history starts ("On … wrote:", "El … escribió:", "-- Original message --"), anywhere in a line:
 * a list snippet runs a body's lines together.
 */
const QUOTE_HEADER = /(?:^|\s)(?:el .{0,120}? escribi[oó]:|on .{0,120}? wrote:|-{2,} ?(?:mensaje (?:original|reenviado)|original message|forwarded message) ?-{2,})/i;
const URL = /\b(?:https?:\/\/|www\.|mailto:)\S+/gi;

interface Span {
  start: number;
  end: number;
}

function spans(re: RegExp, text: string): (Span & { value: string })[] {
  return [...text.matchAll(re)].map((m) => ({ start: m.index, end: m.index + m[0].length, value: m[0] }));
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

/** In one stretch of text: the code closest to a word that announces it, if one is near enough. One pass: both lists come in order. */
function closest(text: string): { code: string | null; announced: boolean; codes: Set<string> } {
  const words = spans(WORDS, text);
  const candidates = spans(CANDIDATE, text);
  const codes = new Set(candidates.map((c) => c.value.replace(/\D/g, "")));
  let best: string | null = null;
  let bestGap = NEAR + 1;
  let w = 0;
  for (const c of candidates) {
    // the last word starting before this code, and the one after it, are the only ones that can be closest
    while (w + 1 < words.length && words[w + 1]!.start <= c.start) w++;
    for (const word of [words[w], words[w + 1]]) {
      if (!word) continue;
      const gap = c.start >= word.end ? c.start - word.end : word.start >= c.end ? word.start - c.end : 0;
      if (gap < bestGap) {
        bestGap = gap;
        best = c.value.replace(/\D/g, "");
      }
    }
  }
  return { code: best, announced: words.length > 0, codes };
}

/**
 * The verification code a message carries, or null (plan 72). Simple on purpose: six digits near a word like
 * "code" or "código". `body` is the text the reader shows (an HTML body's visible text: the renderer's `mailText`).
 * The subject (not a reply's) wins over the body; a subject that announces a code ("Your sign-in code") takes the
 * body's only six-digit number even when no word sits beside it.
 */
export function findCode(subject: string, body: string | null): string | null {
  // a reply's or forward's subject repeats the original's: its code is the old one
  const reply = baseSubject(subject) !== subject.trim();
  const head = closest(reply ? "" : normalizeText(subject.slice(0, SUBJECT_CAP)));
  if (head.code) return head.code;
  const own = closest(normalizeText(ownText(body ?? "").replace(URL, " ")));
  if (own.code) return own.code;
  return head.announced && own.codes.size === 1 ? [...own.codes][0]! : null;
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
