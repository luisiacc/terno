import { normalizeText } from "../text";
import type { View } from "../types";

/** A message-level term: all message terms must match the *same* message. */
export interface MessageTerm {
  field: "text" | "from" | "to" | "subject";
  value: string;
  phrase: boolean;
  negate: boolean;
  /** true for the token the user is still typing (enables prefix matching) */
  prefix: boolean;
}

export interface SearchQuery {
  terms: MessageTerm[];
  hasAttachment?: boolean;
  /** the conversation has attachments (the list's quick filter, plan 15): never typed, set by the caller; thread-level unlike `hasAttachment` */
  threadAttachments?: boolean;
  /** plan 17: the newest inbound message is from a person (the People filter); never typed */
  threadPeople?: boolean;
  /** plan 17: waiting for your reply since this date or later (the Waiting filter at the caller's clock); never typed */
  threadWaitingSince?: number;
  unread?: boolean;
  starred?: boolean;
  view?: View;
  accounts: string[];
  categories: string[];
  /** -account:x / -category:x */
  excludeAccounts: string[];
  excludeCategories: string[];
  /** ms epoch, exclusive bound; an absolute date starts in the runtime's local zone */
  before?: number;
  /** ms epoch, inclusive bound (on/after); an absolute date starts in the runtime's local zone */
  after?: number;
}

const KEY_ALIASES: Record<string, string> = {
  from: "from",
  de: "from",
  to: "to",
  para: "to",
  subject: "subject",
  asunto: "subject",
  has: "has",
  tiene: "has",
  is: "is",
  es: "is",
  in: "in",
  en: "in",
  account: "account",
  cuenta: "account",
  category: "category",
  categoria: "category",
  label: "category",
  before: "before",
  antes: "before",
  after: "after",
  despues: "after",
};

const VIEW_ALIASES: Record<string, View> = {
  inbox: "inbox",
  entrada: "inbox",
  archive: "archive",
  archivo: "archive",
  archivados: "archive",
  sent: "sent",
  enviados: "sent",
  spam: "spam",
  trash: "trash",
  papelera: "trash",
  starred: "starred",
  destacados: "starred",
  all: "all",
  todo: "all",
};

interface RawToken {
  key: string | null;
  value: string;
  quoted: boolean;
  negate: boolean;
  /** token ran to the end of input without trailing whitespace */
  atEnd: boolean;
}

function lex(input: string): RawToken[] {
  const tokens: RawToken[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    while (i < n && /\s/.test(input[i]!)) i++;
    if (i >= n) break;
    let negate = false;
    if (input[i] === "-" && i + 1 < n && !/\s/.test(input[i + 1]!)) {
      negate = true;
      i++;
    }
    let key: string | null = null;
    // key:value — key is letters only, immediately followed by ':'
    const keyMatch = /^([a-zA-Záéíóú]+):(?=\S)/.exec(input.slice(i));
    if (keyMatch && KEY_ALIASES[normalizeText(keyMatch[1])]) {
      key = KEY_ALIASES[normalizeText(keyMatch[1])]!;
      i += keyMatch[0].length;
    }
    let value = "";
    let quoted = false;
    if (input[i] === '"') {
      quoted = true;
      i++;
      const start = i;
      while (i < n && input[i] !== '"') i++;
      value = input.slice(start, i);
      if (i < n) i++; // closing quote
    } else {
      const start = i;
      while (i < n && !/\s/.test(input[i]!)) i++;
      value = input.slice(start, i);
    }
    tokens.push({ key, value, quoted, negate, atEnd: i >= n });
  }
  return tokens;
}

const DAY_MS = 86_400_000;

/** Absolute calendar dates start in the runtime's local zone; relative units are elapsed durations. */
export function parseDate(value: string, now: number): number | undefined {
  const rel = /^(\d+)([dwmy])$/.exec(value);
  if (rel) {
    const amount = Number(rel[1]);
    const unit = { d: 1, w: 7, m: 30, y: 365 }[rel[2] as "d" | "w" | "m" | "y"];
    const date = now - amount * unit * DAY_MS;
    return Number.isFinite(date) ? date : undefined;
  }
  const abs = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(value);
  if (abs) {
    const year = Number(abs[1]);
    const month = Number(abs[2]) - 1;
    const day = Number(abs[3]);
    const date = new Date(year, month, day);
    if (year < 100) date.setFullYear(year, month, day);
    return date.getFullYear() === year && date.getMonth() === month && date.getDate() === day ? date.getTime() : undefined;
  }
  return undefined;
}

export function parseSearch(input: string, now: number = Date.now()): SearchQuery {
  const query: SearchQuery = { terms: [], accounts: [], categories: [], excludeAccounts: [], excludeCategories: [] };
  for (const tok of lex(input)) {
    const value = tok.value.trim();
    if (!value) continue;
    const v = normalizeText(value);
    const pushTerm = (field: MessageTerm["field"], raw: string) =>
      query.terms.push({
        field,
        value: raw,
        phrase: tok.quoted,
        negate: tok.negate,
        prefix: tok.atEnd && !tok.quoted,
      });
    switch (tok.key) {
      case "from":
      case "to":
      case "subject":
        pushTerm(tok.key, value);
        break;
      case "has":
        if (["attachment", "attachments", "adjunto", "adjuntos"].includes(v)) {
          query.hasAttachment = !tok.negate;
        } else pushTerm("text", `has:${value}`);
        break;
      case "is":
        if (v === "unread" || v === "noleido") query.unread = !tok.negate;
        else if (v === "read" || v === "leido") query.unread = tok.negate;
        else if (v === "starred" || v === "destacado") query.starred = !tok.negate;
        else pushTerm("text", `is:${value}`);
        break;
      case "in": {
        const view = VIEW_ALIASES[v];
        if (view && !tok.negate) query.view = view;
        else pushTerm("text", `in:${value}`);
        break;
      }
      case "account":
        (tok.negate ? query.excludeAccounts : query.accounts).push(v);
        break;
      case "category":
        (tok.negate ? query.excludeCategories : query.categories).push(v);
        break;
      case "before":
      case "after": {
        const date = parseDate(value, now);
        // -before:X means "on/after X" and -after:X means "before X"
        const asBefore = (tok.key === "before") !== tok.negate;
        if (date === undefined) pushTerm("text", `${tok.key}:${value}`);
        else if (asBefore) query.before = date;
        else query.after = date;
        break;
      }
      default:
        pushTerm("text", value);
    }
  }
  return query;
}

export function isEmptyQuery(q: SearchQuery): boolean {
  return (
    q.terms.length === 0 &&
    q.hasAttachment === undefined &&
    q.unread === undefined &&
    q.starred === undefined &&
    q.view === undefined &&
    q.accounts.length === 0 &&
    q.categories.length === 0 &&
    q.excludeAccounts.length === 0 &&
    q.excludeCategories.length === 0 &&
    q.before === undefined &&
    q.after === undefined
  );
}

/** Heuristic: a from: value that is a complete address can use the exact-sender index. */
export function isFullEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * A search narrowed to unread threads (the list's unread filter): the query
 * with `is:unread` in front, so the token still being typed stays the last
 * (prefix-matched) one; null when the query itself asks for read threads
 * (both together match nothing).
 */
export function withUnreadOnly(query: string, now: number = Date.now()): string | null {
  return parseSearch(query, now).unread === false ? null : `is:unread ${query}`;
}
