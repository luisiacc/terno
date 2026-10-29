import { CODE_WORDS } from "@terno/i18n";
import { QUOTE_HEADER } from "./categorize/features";
import { baseSubject, normalizeText } from "./text";

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

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
/** Text inside these is never shown (raw text: skipped to their closing tag). */
const RAW = new Set(["script", "style", "title", "textarea", "noscript", "xmp"]);
/** Elements skipped with everything inside: what isn't shown, and quoted mail (nested quotes included). */
const SKIP = new Set(["head", "template", "blockquote", "iframe", "object", "svg"]);
/** Inline tags: between digits they don't split them ("<b>12</b>3456" reads 123456); elsewhere a space. */
const INLINE = new Set(["a", "abbr", "b", "big", "code", "em", "font", "i", "kbd", "label", "mark", "s", "small", "span", "strong", "sub", "sup", "tt", "u", "wbr"]);
/** Cells and images separate words without breaking the line: per-digit boxes read "1 2 3 4 5 6". */
const SPACED = new Set(["td", "th", "img"]);
const HIDDEN = /\shidden(?=[\s=/>])|display\s*:\s*none|visibility\s*:\s*hidden|(?:max-height|font-size|opacity)\s*:\s*0(?:\.0+)?(?:px|em|rem|%)?\s*(?:[;"'!]|$)/;
const TAG_NAME = /^<(\/?)([a-z][a-z0-9-]*)/;
const NAMED: Record<string, string> = {
  nbsp: " ", ensp: " ", emsp: " ", thinsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", pound: "£", euro: "€", yen: "¥", cent: "¢",
  dollar: "$", num: "#", plus: "+", sol: "/", colon: ":", period: ".", comma: ",", hyphen: "-", ndash: "–", mdash: "—", szlig: "ß",
};
const MARKS: Record<string, string> = { acute: "\u0301", grave: "\u0300", uml: "\u0308", circ: "\u0302", tilde: "\u0303", cedil: "\u0327", ring: "\u030a" };
const ENTITY = /&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z][a-z0-9]{1,9}));/gi;

function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(ENTITY, (whole, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (name === undefined) {
      const cp = dec !== undefined ? Number(dec) : parseInt(hex!, 16);
      return cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    }
    const lower = name.toLowerCase();
    if (NAMED[lower] !== undefined) return NAMED[lower];
    // "&oacute;" is o plus its accent, which normalizing folds away
    const mark = MARKS[name.slice(1)];
    return mark !== undefined ? name[0] + mark : whole;
  });
}

/**
 * The text a reader sees in an HTML body, roughly: no head, styles, scripts, hidden elements or quoted mail; inline
 * tags and cells become spaces and other tags line breaks, so a `<code>` tag is never the word "code". One linear
 * scan (every search moves forward), so hostile markup can't stall the reader.
 */
export function htmlText(html: string): string {
  const src = html.slice(0, HTML_CAP);
  const lower = src.toLowerCase();
  const n = src.length;
  const out: string[] = [];
  let last = "";
  // what separates the next text from the last: "~" joins digits and is a space otherwise
  let gap: "" | "~" | " " | "\n" = "";
  const sep = (g: " " | "~" | "\n") => {
    if (g === "\n" || gap === "" || (g === " " && gap === "~")) gap = g;
  };
  const emit = (raw: string) => {
    // the source's own line breaks are spaces, as HTML shows them
    const text = decodeEntities(raw).replace(/\s+/g, " ");
    if (!text) return;
    if (gap === "\n" || gap === " ") out.push(gap);
    else if (gap === "~" && !(/\d/.test(last) && /^\d/.test(text))) out.push(" ");
    gap = "";
    out.push(text);
    last = text[text.length - 1]!;
  };
  // past the element opened just before `from`, nested ones of the same name included
  const skip = (name: string, from: number): number => {
    let depth = 1;
    for (let j = from; ; ) {
      const lt = lower.indexOf("<", j);
      if (lt === -1) return n;
      const m = TAG_NAME.exec(lower.slice(lt, lt + name.length + 3));
      if (m && m[2] === name) {
        const gt = lower.indexOf(">", lt);
        if (gt === -1) return n;
        if (m[1]) depth--;
        else if (lower[gt - 1] !== "/") depth++;
        if (depth === 0) return gt + 1;
        j = gt + 1;
      } else j = lt + 1;
    }
  };
  let i = 0;
  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt === -1) {
      emit(src.slice(i));
      break;
    }
    if (lt > i) emit(src.slice(i, lt));
    const next = lower[lt + 1] ?? "";
    if (lower.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    // "a < b": not a tag (checked before looking for ">", so a run of "<" stays linear)
    if (!(next === "/" || next === "!" || next === "?" || (next >= "a" && next <= "z"))) {
      emit("<");
      i = lt + 1;
      continue;
    }
    const gt = src.indexOf(">", lt + 1);
    if (gt === -1) {
      emit(src.slice(lt));
      break;
    }
    i = gt + 1;
    const m = TAG_NAME.exec(lower.slice(lt, Math.min(gt + 1, lt + 40)));
    if (!m) continue; // <!doctype>, <?xml?>
    const [, closing, name] = m as unknown as [string, string, string];
    const kind = INLINE.has(name) ? "~" : SPACED.has(name) ? " " : "\n";
    if (!closing && !VOID.has(name) && lower[gt - 1] !== "/") {
      if (RAW.has(name)) {
        const end = lower.indexOf(`</${name}`, i);
        const close = end === -1 ? -1 : lower.indexOf(">", end);
        i = close === -1 ? n : close + 1;
        sep(" ");
        continue;
      }
      if (SKIP.has(name) || HIDDEN.test(lower.slice(lt, gt + 1))) {
        i = skip(name, i);
        sep(kind === "~" ? " " : kind);
        continue;
      }
    }
    sep(kind);
  }
  return out
    .join("")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
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
 * "code" or "código". The subject (not a reply's) wins over the body; a subject that announces a code ("Your sign-in code") takes
 * the body's only six-digit number even when no word sits beside it.
 */
export function findCode(subject: string, bodyText: string | null, bodyHtml: string | null): string | null {
  // a reply's or forward's subject repeats the original's: its code is the old one
  const reply = baseSubject(subject) !== subject.trim();
  const head = closest(reply ? "" : normalizeText(subject));
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
