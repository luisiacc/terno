import { normalizeText } from "../text";
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

/**
 * Tokenize like SQLite's unicode61 tokenizer with remove_diacritics:
 *  - canonical decomposition only: compatibility forms (the "ﬁ" ligature) are not expanded
 *  - diacritics are removed from Latin letters only: Greek tonos or Cyrillic й are kept
 * Tokens are recomposed (NFC) so precomposed and decomposed input compare equal.
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const folded = text.normalize("NFD").replace(LATIN_MARKS, "$1").normalize("NFC").toLowerCase();
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
