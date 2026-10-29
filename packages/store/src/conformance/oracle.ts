import { isFullEmail, normalizeText, parseSearch, tokenize, type MessageTerm, type SearchView, type View } from "@terno/core";
import type { SearchMessageDoc, SearchThreadDoc } from "../search";

/**
 * A brute-force, independent implementation of search semantics. It must
 * never reuse an engine's matcher: only the parser and the tokenizer (which
 * mirrors FTS5 unicode61 remove_diacritics 2) are shared.
 */
export interface SearchCorpus {
  messages: readonly SearchMessageDoc[];
  threads: readonly SearchThreadDoc[];
  accounts: readonly { id: number; email: string; display_name: string }[];
  categories: readonly { id: number; name: string }[];
}

export interface UiScope {
  accountId?: number;
  categoryId?: number;
}

/** tokenize() per column, remembered per doc object (docs are immutable projections) */
const columnTokens = new WeakMap<SearchMessageDoc, Record<"subject" | "from" | "to" | "body", string[]>>();

function columnsOf(m: SearchMessageDoc): Record<"subject" | "from" | "to" | "body", string[]> {
  let c = columnTokens.get(m);
  if (!c) columnTokens.set(m, (c = { subject: tokenize(m.subject), from: tokenize(m.fromText), to: tokenize(m.recipients), body: tokenize(m.body) }));
  return c;
}

function phraseIn(tokens: readonly string[], term: MessageTerm): boolean {
  const needle = tokenize(term.value);
  if (needle.length === 0) return false;
  for (let i = 0; i + needle.length <= tokens.length; i++) {
    if (needle.every((t, j) => (term.prefix && j === needle.length - 1 ? tokens[i + j]!.startsWith(t) : tokens[i + j] === t))) {
      return true;
    }
  }
  return false;
}

/** One message term on one message, by brute force (also a reference phrase doclist for engines' fallbacks). */
export function termMatches(m: SearchMessageDoc, term: MessageTerm): boolean {
  const columns = columnsOf(m);
  if (term.field === "text") return Object.values(columns).some((c) => phraseIn(c, term));
  return phraseIn(columns[term.field], term);
}

export const VIEW_TEST: Record<View, (t: SearchThreadDoc) => boolean> = {
  inbox: (t) => t.inInbox,
  starred: (t) => t.isStarred && !t.inTrash && !t.inSpam,
  sent: (t) => t.hasSent && !t.inTrash && !t.inSpam,
  archive: (t) => !t.inInbox && !t.inTrash && !t.inSpam,
  spam: (t) => t.inSpam && !t.inTrash,
  trash: (t) => t.inTrash,
  all: (t) => !t.inTrash && !t.inSpam,
};
const SEARCH_VIEW_TEST: Record<SearchView, (t: SearchThreadDoc) => boolean> = { ...VIEW_TEST, anywhere: () => true };

export function byRecency(a: SearchThreadDoc, b: SearchThreadDoc): number {
  return b.lastDate - a.lastDate || b.threadId - a.threadId;
}

/** Thread ids matching `query`, newest first. */
export function oracleSearch(corpus: SearchCorpus, query: string, now: number, scope: UiScope = {}): number[] {
  const q = parseSearch(query, now);
  const { accounts, categories } = corpus;
  const emailTerms = q.terms.filter((t) => t.field === "from" && isFullEmail(t.value));
  const textTerms = q.terms.filter((t) => !(t.field === "from" && isFullEmail(t.value)) && tokenize(t.value).length > 0);
  const positive = textTerms.filter((t) => !t.negate);
  const negative = textTerms.filter((t) => t.negate);
  const hasMessagePredicate =
    positive.length > 0 || emailTerms.length > 0 || q.hasAttachment !== undefined || q.before !== undefined || q.after !== undefined;

  const messageOk = (m: SearchMessageDoc) =>
    positive.every((t) => termMatches(m, t)) &&
    // negatives are message-level whenever any message predicate exists
    (!hasMessagePredicate || negative.every((t) => !termMatches(m, t))) &&
    emailTerms.every((t) => (normalizeText(t.value) === m.fromEmail) !== t.negate) &&
    (q.hasAttachment === undefined || m.hasAttachments === q.hasAttachment) &&
    (q.before === undefined || m.date < q.before) &&
    (q.after === undefined || m.date >= q.after);

  const threads = new Map(corpus.threads.map((t) => [t.threadId, t]));
  const candidate = new Set<number>();
  if (hasMessagePredicate) {
    for (const m of corpus.messages) if (messageOk(m)) candidate.add(m.threadId);
  } else {
    for (const id of threads.keys()) candidate.add(id);
  }
  if (!hasMessagePredicate && negative.length > 0) {
    // negative-only: threads with no message matching any negated term
    for (const m of corpus.messages) if (negative.some((t) => termMatches(m, t))) candidate.delete(m.threadId);
  }

  const accountMatch = (token: string) =>
    accounts.filter((a) => normalizeText(a.email).includes(token) || normalizeText(a.display_name).includes(token)).map((a) => a.id);
  const categoryMatch = (token: string) =>
    (categories.find((x) => normalizeText(x.name) === token) ?? categories.find((x) => normalizeText(x.name).startsWith(token)))?.id;

  let impossible = false;
  const accountIds = new Set<number>(scope.accountId !== undefined ? [scope.accountId] : []);
  for (const token of q.accounts) {
    const matches = accountMatch(token);
    if (!matches.length) impossible = true;
    if (scope.accountId !== undefined) {
      if (!matches.includes(scope.accountId)) impossible = true;
    } else {
      for (const id of matches) accountIds.add(id);
    }
  }
  const excludedAccounts = new Set(q.excludeAccounts.flatMap(accountMatch));
  const excludedCategories = q.excludeCategories.map(categoryMatch).filter((x): x is number => x !== undefined);
  const categoryIds = scope.categoryId !== undefined ? [scope.categoryId] : [];
  for (const token of q.categories) {
    const c = categoryMatch(token);
    if (c === undefined) impossible = true;
    else categoryIds.push(c);
  }
  if (impossible) return [];
  const view = q.view ?? "anywhere";
  return [...candidate]
    .map((id) => threads.get(id)!)
    .filter(
      (t) =>
        SEARCH_VIEW_TEST[view](t) &&
        (accountIds.size === 0 || accountIds.has(t.accountId)) &&
        !excludedAccounts.has(t.accountId) &&
        excludedCategories.every((c) => !t.categoryIds.includes(c)) &&
        categoryIds.every((c) => t.categoryIds.includes(c)) &&
        (q.unread === undefined || t.unreadCount > 0 === q.unread) &&
        (q.starred === undefined || t.isStarred === q.starred),
    )
    .sort(byRecency)
    .map((t) => t.threadId);
}
