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
const WORD = /[\p{L}\p{N}]+/gu;

/** Tokenize like SQLite's unicode61 tokenizer with remove_diacritics. */
export function tokenize(text: string): string[] {
  return normalizeText(text).match(WORD) ?? [];
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

/**
 * `body` uses word/phrase semantics (backed by FTS in SQL): the needle's token
 * sequence must appear contiguously in the body's tokens. `equals` means the
 * whole body is exactly that token sequence; startsWith/endsWith anchor it.
 */
export function bodyMatches(op: TextOp, body: string | null, value: string): boolean {
  if (body === null) return false;
  const needle = tokenize(value);
  if (needle.length === 0) return false;
  const tokens = tokenize(body);
  const at = (i: number) => needle.every((t, j) => tokens[i + j] === t);
  switch (op) {
    case "contains":
      for (let i = 0; i + needle.length <= tokens.length; i++) if (at(i)) return true;
      return false;
    case "equals":
      return tokens.length === needle.length && at(0);
    case "startsWith":
      return tokens.length >= needle.length && at(0);
    case "endsWith":
      return tokens.length >= needle.length && at(tokens.length - needle.length);
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
