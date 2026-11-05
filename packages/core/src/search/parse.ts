import { tokenize } from "../rules/evaluate";
import { normalizeText } from "../text";
import type { View } from "../types";

/** Where a search looks: a sidebar view, or everywhere (plan 64: every place, Spam and Trash too; what a search means by default). */
export type SearchView = View | "anywhere";

/** A message-level term: all message terms must match the *same* message. */
export interface MessageTerm {
  /** address (plan 140): the sender or a recipient is that address, a whole space-bounded word of them; `value` is normalized */
  field: "text" | "from" | "to" | "subject" | "address";
  value: string;
  phrase: boolean;
  negate: boolean;
  /** true for the token the user is still typing (enables prefix matching) */
  prefix: boolean;
}

export interface SearchQuery {
  terms: MessageTerm[];
  /** plan 140: each group needs one of its terms to hold, on the same message as everything else. Two or more positive terms each. */
  anyOf: MessageTerm[][];
  hasAttachment?: boolean;
  /** the conversation has attachments (the list's quick filter, plan 15): never typed, set by the caller; thread-level unlike `hasAttachment` */
  threadAttachments?: boolean;
  /** plan 17: the newest inbound message is from a person (the People filter); never typed */
  threadPeople?: boolean;
  /** plan 17: waiting for your reply since this date or later (the Waiting filter at the caller's clock); never typed */
  threadWaitingSince?: number;
  unread?: boolean;
  starred?: boolean;
  view?: SearchView;
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

const VIEW_ALIASES: Record<string, SearchView> = {
  anywhere: "anywhere",
  everywhere: "anywhere",
  todas: "anywhere",
  cualquiera: "anywhere",
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
  /** a comma stands between this token and the one before it */
  linked: boolean;
}

/** The keys whose value is a comma list; the rest keep commas (a category's name may have one, and account: already widens when repeated). */
const isListKey = (key: string | null) => key === null || key === "from" || key === "to" || key === "subject";

/** A number, not a list: 1,000 · 12,50 · $1,200.50 · 1.200,50. The whole token decides (build1,2 and 2024,2025 are lists). */
const NUMBER = /^[$€£¥]?\d+(?:[.,]\d{1,3})*[$€£¥%]?$/;
const NUMBER_START = /^[$€£¥]?\d/;

function lex(input: string): RawToken[] {
  const tokens: RawToken[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    let comma = false;
    while (i < n && (/\s/.test(input[i]!) || input[i] === ",")) {
      if (input[i] === ",") comma = true;
      i++;
    }
    if (i >= n) break;
    const before = tokens[tokens.length - 1];
    const linked = comma && before !== undefined;
    // a comma carries the negation and the key along: -a,b is neither, from:a,b is from either
    let negate = linked && before.negate;
    if (input[i] === "-" && i + 1 < n && !/\s/.test(input[i + 1]!)) {
      negate = true;
      i++;
    }
    let key: string | null = linked && isListKey(before.key) ? before.key : null;
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
      const list = isListKey(key);
      while (i < n && !/\s/.test(input[i]!) && !(list && input[i] === ",")) i++;
      if (i < n && input[i] === "," && NUMBER_START.test(input.slice(start, i))) {
        let end = i;
        while (end < n && !/\s/.test(input[end]!)) end++;
        if (NUMBER.test(input.slice(start, end))) i = end;
      }
      value = input.slice(start, i);
      if (!list) value = value.replace(/,+$/, "");
    }
    tokens.push({ key, value, quoted, negate, atEnd: i >= n, linked });
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
    const date = new Date(0);
    date.setHours(0, 0, 0, 0);
    date.setFullYear(year, month, day);
    date.setHours(0, 0, 0, 0);
    return date.getFullYear() === year && date.getMonth() === month && date.getDate() === day ? date.getTime() : undefined;
  }
  return undefined;
}

/** The address a bare token types, normalized: a full one, or the one still being typed at the end of the input (it narrows as it's typed). */
function typedAddress(value: string, atEnd: boolean): string | null {
  const bare = value.replace(/^<|>$/g, "");
  if (!isFullEmail(bare) && !(atEnd && /^[^\s@]+@[^\s@]*$/.test(bare))) return null;
  return tokenize(bare).length > 0 ? normalizeText(bare) : null;
}

/** Comma runs into `terms` and `anyOf`: an alternative with nothing to search goes, and addresses on their own are one "any of" (plan 140). */
function settleRuns(runs: readonly MessageTerm[][], query: SearchQuery): void {
  const addresses: MessageTerm[] = [];
  let addressesAt = -1;
  const settled: MessageTerm[][] = [];
  for (const run of runs) {
    const kept = run.length > 1 ? run.filter((t) => tokenize(t.value).length > 0) : run;
    if (kept.length > 0 && kept.every((t) => t.field === "address")) {
      if (addressesAt < 0) addressesAt = settled.push([]) - 1;
      addresses.push(...kept);
    } else if (kept.length > 0) settled.push(kept);
  }
  if (addressesAt >= 0) settled[addressesAt] = addresses;
  for (const run of settled) {
    if (run.length === 1) query.terms.push(run[0]!);
    else query.anyOf.push(run);
  }
}

export function parseSearch(input: string, now: number = Date.now()): SearchQuery {
  const query: SearchQuery = { terms: [], anyOf: [], accounts: [], categories: [], excludeAccounts: [], excludeCategories: [] };
  const runs: MessageTerm[][] = [];
  let open: MessageTerm[] | null = null;
  for (const tok of lex(input)) {
    const value = tok.value.trim();
    if (!value) continue;
    const v = normalizeText(value);
    let pushed = false;
    const pushTerm = (field: MessageTerm["field"], raw: string, prefix = tok.atEnd && !tok.quoted) => {
      pushed = true;
      const term: MessageTerm = { field, value: raw, phrase: tok.quoted, negate: tok.negate, prefix };
      if (term.negate) {
        runs.push([term]);
        open = null;
      } else if (tok.linked && open) open.push(term);
      else runs.push((open = [term]));
    };
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
      default: {
        // quotes ask for the text anywhere; an exclusion stays the text it always was
        const address = tok.quoted || tok.negate ? null : typedAddress(value, tok.atEnd);
        if (address) pushTerm("address", address, tok.atEnd && !value.endsWith(">"));
        else pushTerm("text", value);
      }
    }
    // an operator isn't an alternative: what follows it starts over
    if (!pushed) open = null;
  }
  settleRuns(runs, query);
  return query;
}

/** Every message term of the query, wherever it stands: what preparing a search needs to see. */
export function searchTerms(q: SearchQuery): MessageTerm[] {
  return q.anyOf.length === 0 ? q.terms : [...q.terms, ...q.anyOf.flat()];
}

export function isEmptyQuery(q: SearchQuery): boolean {
  return (
    q.terms.length === 0 &&
    q.anyOf.length === 0 &&
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
