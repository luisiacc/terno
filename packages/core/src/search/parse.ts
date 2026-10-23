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
  unread?: boolean;
  starred?: boolean;
  view?: View;
  accounts: string[];
  categories: string[];
  /** -account:x / -category:x */
  excludeAccounts: string[];
  excludeCategories: string[];
  /** ms epoch, exclusive bound */
  before?: number;
  /** ms epoch, inclusive bound */
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

/** Accepts YYYY-MM-DD, YYYY/MM/DD, or relative "7d", "2w", "3m", "1y". */
export function parseDate(value: string, now: number): number | undefined {
  const rel = /^(\d+)([dwmy])$/.exec(value);
  if (rel) {
    const amount = Number(rel[1]);
    const unit = { d: 1, w: 7, m: 30, y: 365 }[rel[2] as "d" | "w" | "m" | "y"];
    return now - amount * unit * DAY_MS;
  }
  const abs = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(value);
  if (abs) {
    const t = new Date(Number(abs[1]), Number(abs[2]) - 1, Number(abs[3])).getTime();
    return Number.isNaN(t) ? undefined : t;
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
