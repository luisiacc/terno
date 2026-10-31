import { normalizeText } from "../text";
import { isFullEmail } from "../search/parse";

/** A from condition that names one address exactly matches the address only, never a display name (SQL rules too). */
export const fromIsAddress = (op: TextOp, normalized: string): boolean => op === "equals" && isFullEmail(normalized);
import type { Condition, FilterRule, TextOp } from "./schema";

/**
 * The message shape rules are evaluated against. Text fields are raw; the
 * evaluator normalizes them exactly like the DB stores its *_norm columns.
 */
export interface RuleMessage {
  accountId: number;
  fromName: string;
  fromEmail: string;
  recipients: string;
  subject: string;
  bodyText: string | null;
  /** Omitted when the caller supplies a complete body. */
  bodyComplete?: boolean;
  listId: string | null;
  hasAttachments: boolean;
  date: number;
}

const DAY_MS = 86_400_000;
/** The DB keeps this many trailing body tokens (body_tail_norm) so body endsWith is index-free SQL. */
export const BODY_TAIL_TOKENS = 32;
// letters/numbers plus combining marks that survived (non-Latin scripts keep theirs)
const WORD_WITH_MARKS = /[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu;

/** Combining marks that follow a Latin letter (unicode61 folds diacritics for Latin script only). */
const LATIN_MARKS = /(\p{Script=Latin})[\u0300-\u036f]+/gu;
const NON_ASCII = /[\u0080-\uffff]/;
/** what can combine with a neighbour under canonical (de)composition: marks and Hangul jamo/syllables */
const COMBINES = /[\p{M}\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\uac00-\ud7ff]/u;
const NON_ASCII_CHARS = /[\u{80}-\u{10ffff}]/gu;
const charFolds = new Map<string, string>();

/**
 * Without marks or Hangul nothing interacts across characters under NFD/NFC,
 * so folding each character on its own (cached) equals folding the string.
 */
function foldEachChar(text: string): string {
  const folded = text.replace(NON_ASCII_CHARS, (c) => {
    let f = charFolds.get(c);
    if (f === undefined) charFolds.set(c, (f = c.normalize("NFD").replace(LATIN_MARKS, "$1").normalize("NFC")));
    return f;
  });
  return copyNarrow(folded);
}

/**
 * The token regex runs several times slower on what replace() returns (V8
 * keeps the source's representation) than on a fresh copy; rebuild narrow
 * strings from their char codes.
 */
function copyNarrow(text: string): string {
  const chunks: string[] = [];
  for (let at = 0; at < text.length; at += 4096) {
    const codes: number[] = [];
    for (let i = at; i < Math.min(text.length, at + 4096); i++) {
      const c = text.charCodeAt(i);
      if (c > 0xff) return text;
      codes.push(c);
    }
    chunks.push(String.fromCharCode(...codes));
  }
  return chunks.join("");
}

/**
 * Tokenize like SQLite's unicode61 tokenizer with remove_diacritics:
 *  - canonical decomposition only: compatibility forms (the "ﬁ" ligature) are not expanded
 *  - diacritics are removed from Latin letters only: Greek tonos or Cyrillic й are kept
 * Tokens are recomposed (NFC) so precomposed and decomposed input compare equal.
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  // ASCII has nothing to fold; most other text folds character by character
  const folded = !NON_ASCII.test(text)
    ? text.toLowerCase()
    : !COMBINES.test(text)
      ? foldEachChar(text).toLowerCase()
      : text.normalize("NFD").replace(LATIN_MARKS, "$1").normalize("NFC").toLowerCase();
  return folded.match(WORD_WITH_MARKS) ?? [];
}

function textOp(op: TextOp, haystack: string, needle: string): boolean {
  switch (op) {
    case "contains":
      return haystack.includes(needle);
    case "equals":
      return haystack === needle;
    case "startsWith":
      return haystack.startsWith(needle);
    case "endsWith":
      return haystack.endsWith(needle);
  }
}

/** Index of a whitespace character at or before `at` (or -1). Whitespace is a separator for every tokenizer we mirror. */
function whitespaceBefore(text: string, at: number): number {
  for (let i = Math.min(at, text.length - 1); i >= 0; i--) if (/\s/.test(text[i]!)) return i;
  return -1;
}
function whitespaceAfter(text: string, at: number): number {
  for (let i = Math.max(0, at); i < text.length; i++) if (/\s/.test(text[i]!)) return i;
  return -1;
}

/** First `n` tokens, normalizing only as much of the text as needed (cuts on whitespace so no token is split). */
function leadingTokens(text: string, n: number): string[] {
  for (let size = 256; ; size *= 4) {
    const cut = text.length <= size ? -1 : whitespaceBefore(text, size);
    const tokens = tokenize(cut === -1 ? text : text.slice(0, cut));
    if (cut === -1 || tokens.length >= n) return tokens.slice(0, n);
  }
}

/** Last `n` tokens, scanning from the end. */
export function trailingTokens(text: string, n: number): string[] {
  for (let size = 256; ; size *= 4) {
    const cut = text.length <= size ? -1 : whitespaceAfter(text, text.length - size);
    const tokens = tokenize(cut === -1 ? text : text.slice(cut));
    if (cut === -1 || tokens.length >= n) return tokens.slice(Math.max(0, tokens.length - n));
  }
}

const sameTokens = (a: string[], b: string[]) => a.length === b.length && a.every((t, i) => t === b[i]);

/**
 * `body` uses word/phrase semantics (backed by FTS in SQL): the needle's token
 * sequence must appear contiguously in the body's tokens. `equals` means the
 * whole body is exactly that token sequence; startsWith/endsWith anchor it.
 * Anchored ops only normalize the head/tail of the body (filters over 50k mails).
 */
export function bodyMatches(op: TextOp, body: string | null, value: string): boolean {
  if (body === null) return false;
  const needle = tokenize(value);
  if (needle.length === 0) return false;
  switch (op) {
    case "contains": {
      const tokens = tokenize(body);
      outer: for (let i = 0; i + needle.length <= tokens.length; i++) {
        for (let j = 0; j < needle.length; j++) if (tokens[i + j] !== needle[j]) continue outer;
        return true;
      }
      return false;
    }
    case "startsWith":
      return sameTokens(leadingTokens(body, needle.length), needle);
    case "endsWith":
      return sameTokens(trailingTokens(body, needle.length), needle);
    case "equals": {
      const head = leadingTokens(body, needle.length + 1);
      return sameTokens(head, needle);
    }
  }
}

function evaluateCondition(c: Condition, msg: RuleMessage, now: number): boolean {
  switch (c.field) {
    case "hasAttachment":
      return msg.hasAttachments === c.value;
    case "account":
      return msg.accountId === c.value;
    case "ageDays": {
      const cutoff = now - c.value * DAY_MS;
      return c.op === "gt" ? msg.date < cutoff : msg.date > cutoff;
    }
    case "body":
      return bodyMatches(c.op, msg.bodyText, c.value);
    case "from": {
      const v = normalizeText(c.value);
      // "is exactly this address" is the address: a display name made to look like it doesn't pass (plan 80)
      if (fromIsAddress(c.op, v)) return normalizeText(msg.fromEmail) === v;
      return textOp(c.op, normalizeText(msg.fromName), v) || textOp(c.op, normalizeText(msg.fromEmail), v);
    }
    case "fromDomain": {
      const at = msg.fromEmail.lastIndexOf("@");
      return textOp(c.op, normalizeText(at === -1 ? "" : msg.fromEmail.slice(at + 1)), normalizeText(c.value));
    }
    case "recipients":
      return textOp(c.op, normalizeText(msg.recipients), normalizeText(c.value));
    case "subject":
      return textOp(c.op, normalizeText(msg.subject), normalizeText(c.value));
    case "listId":
      return textOp(c.op, normalizeText(msg.listId), normalizeText(c.value));
  }
}

export function evaluateRule(rule: FilterRule, msg: RuleMessage, now: number): boolean {
  if (msg.bodyComplete === false && rule.conditions.some((c) => c.field === "body")) return false;
  const test = (c: Condition) => evaluateCondition(c, msg, now) !== Boolean(c.negate);
  return rule.match === "all" ? rule.conditions.every(test) : rule.conditions.some(test);
}

/** Human-readable one-liner for a rule, used in lists and AI confirmations. */
export function describeCondition(c: Condition): string {
  const not = c.negate ? "not " : "";
  switch (c.field) {
    case "hasAttachment":
      return c.value !== Boolean(c.negate) ? "has attachments" : "has no attachments";
    case "account":
      return `${not}in account #${c.value}`;
    case "ageDays":
      return `${not}${c.op === "gt" ? "older" : "newer"} than ${c.value} days`;
    default: {
      const ops: Record<TextOp, string> = {
        contains: "contains",
        equals: "is",
        startsWith: "starts with",
        endsWith: "ends with",
      };
      return `${c.field} ${not}${ops[c.op]} “${c.value}”`;
    }
  }
}
