import { ASK_ANSWER_MAX, ASK_QUERIES_JSON_MAX, ASK_SOURCE_HEADER_MAX, ASK_SOURCES_MAX, ASK_TITLE_MAX, askQueryWords, normalizeText, withoutQuotes, type AskCheck, type AskConversationSummary, type AskPlanQuery, type AskSourceRef, type AskTurn, type AskTurnStatus, type ResolvedSearch } from "@terno/core";
import { bodyPartText, type BodyPartSource } from "./body-parts";

/**
 * Plan 141: what Ask reads and keeps. Passages hold what a question needs from long mail (a lease clause may be in the
 * fifth of forty messages, in a body's tail) with the work bounded; history is the last 100 conversations, on this
 * machine only: not exported, not synced, not in search, not on MCP.
 */

/** Rough tokens of 4 characters, as summaries size them. */
export const ASK_HEAD_CHARS = 400;
export const ASK_AROUND_CHARS = 2000;
export const ASK_MESSAGES_MAX = 30;
export const ASK_MAX_CHARS = 24_000 * 4;
/** Messages one thread may hold of the 30, until every thread has had its turn. */
const PER_THREAD = 6;
/** How much of one message is read looking for a word, and of all of them together: past it the page says `incomplete`. */
const READ_MESSAGE_CHARS = 512 * 1024;
const READ_TOTAL_CHARS = 4 * 1024 * 1024;
/** How much mail one query checks for its whole predicate, past what its index can answer. */
export const ASK_MATCH_MESSAGES = 6000;
/** Captured bodies' prepared parts one query scans, newest first (32 KB each). */
export const ASK_MATCH_PARTS = 640;

export interface AskPassageRequest {
  /** in rank order */
  threadIds: readonly number[];
  /** each query's whole predicate decides which of a thread's messages count (revision 5) */
  queries: readonly ResolvedSearch[];
  /** what older mail just fetched, ahead of every local candidate (revision 7) */
  first?: readonly number[];
  maxMessages: number;
  maxChars: number;
  signal?: { readonly aborted: boolean };
  /** captured parts one query may scan; default ASK_MATCH_PARTS (tests) */
  workParts?: number;
}

export interface AskSource extends AskSourceRef {
  text: string;
  /** what a follow-up cites when there's no text: its snippet */
  own: boolean;
}

export interface AskPassages {
  messages: AskSource[];
  /** some mail has no text here yet, or the work's limit was reached */
  incomplete: boolean;
}

export interface AskHeader {
  id: number;
  threadId: number;
  accountId: number;
  fromName: string;
  fromEmail: string;
  subject: string;
  snippet: string;
  date: number;
  own: boolean;
  spam: boolean;
  trash: boolean;
  draft: boolean;
  bodyState: "none" | "partial" | "full";
  bodyUnavailable: boolean;
}

/** What a store provides for `readPassages`. */
export interface AskPassageIo {
  /** the messages in these threads the query's whole predicate holds for, newest first, never in Spam or Trash, nor drafts */
  matching(query: ResolvedSearch, threadIds: readonly number[], signal?: { readonly aborted: boolean }, workParts?: number): Promise<{ ids: { id: number; threadId: number }[]; incomplete: boolean }>;
  /** each thread's newest message that isn't in Spam or Trash, nor a draft */
  newest(threadIds: readonly number[]): Promise<Map<number, number>>;
  headers(ids: readonly number[]): Promise<Map<number, AskHeader>>;
  /** the visible text; null: none here */
  text(messageId: number): Promise<string | BodyPartSource | null>;
}

/** Where a word starts in the raw text. NFKD can change a length, so a position through it is near enough for a window. */
function locate(text: string, words: readonly string[]): number {
  const normalized = normalizeText(text);
  let at = -1;
  for (const word of words) {
    const i = normalized.indexOf(normalizeText(word));
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return -1;
  return normalized.length === text.length ? at : Math.floor((at / normalized.length) * text.length);
}

/** The start of a message, and the stretch around the first word it was found by. */
export function passageOf(text: string, words: readonly string[]): string {
  const head = text.slice(0, ASK_HEAD_CHARS);
  const at = locate(text, words);
  if (at < 0 || text.length <= ASK_HEAD_CHARS) return head;
  const half = Math.floor(ASK_AROUND_CHARS / 2);
  const from = Math.max(ASK_HEAD_CHARS, at - half);
  if (from >= text.length) return head;
  const around = text.slice(from, from + ASK_AROUND_CHARS);
  return from === ASK_HEAD_CHARS ? head + around : `${head}\n…\n${around}`;
}

/**
 * Reads until a word turns up (and a window past it), or the message's limit. `budget` is what's left of the whole
 * read's work; running out is `partial`, never a stall.
 */
async function readUntilFound(source: string | BodyPartSource, words: readonly string[], budget: { left: number }, signal?: { readonly aborted: boolean }): Promise<{ text: string; partial: boolean }> {
  if (typeof source === "string") {
    budget.left -= source.length;
    return { text: source, partial: false };
  }
  let text = "";
  let checked = 0;
  let foundAt = -1;
  const longest = Math.max(0, ...words.map((w) => w.length));
  const limit = words.length ? READ_MESSAGE_CHARS : ASK_HEAD_CHARS * 4;
  try {
    for await (const part of bodyPartText(source)) {
      if (signal?.aborted) return { text, partial: true };
      text += part;
      budget.left -= part.length;
      if (foundAt < 0 && words.length) {
        const start = Math.max(0, checked - longest);
        const i = locate(text.slice(start), words);
        if (i >= 0) foundAt = start + i;
        checked = text.length;
      }
      if (foundAt >= 0 && text.length >= foundAt + ASK_AROUND_CHARS) return { text, partial: false };
      if (text.length >= limit) return { text, partial: words.length > 0 && foundAt < 0 };
      if (budget.left <= 0) return { text, partial: true };
    }
  } finally {
    source.close?.();
  }
  return { text, partial: false };
}

const clipped = (value: string, max: number) => (value.length > max ? value.slice(0, max) : value);

/**
 * The messages for a question, in order: what older mail fetched; then, thread by thread in rank order, the messages
 * each query's whole predicate holds for (else the thread's newest); then, with room left, each thread's newest for
 * context. Only stored visible text, with quotes removed: the first 400 characters and up to 2,000 around a word.
 */
export async function readPassages(req: AskPassageRequest, io: AskPassageIo): Promise<AskPassages> {
  let incomplete = false;
  const threadIds = req.threadIds;
  const wordsOf = new Map<number, Set<string>>();
  const byThread = new Map<number, number[]>();
  if (threadIds.length) {
    for (const query of req.queries) {
      if (req.signal?.aborted) return { messages: [], incomplete: true };
      const found = await io.matching(query, threadIds, req.signal, req.workParts ?? ASK_MATCH_PARTS);
      incomplete ||= found.incomplete;
      const words = askQueryWords(query);
      for (const { id, threadId } of found.ids) {
        const list = byThread.get(threadId) ?? [];
        if (!list.includes(id)) list.push(id);
        byThread.set(threadId, list);
        const held = wordsOf.get(id) ?? new Set<string>();
        for (const w of words) held.add(w);
        wordsOf.set(id, held);
      }
    }
    for (const list of byThread.values()) list.sort((a, b) => b - a);
  }
  const newest = threadIds.length ? await io.newest(threadIds) : new Map<number, number>();
  // what older mail fetched may lie outside every page of the search: its words are the whole plan's
  const allWords = req.queries.flatMap(askQueryWords);
  for (const id of req.first ?? []) wordsOf.set(id, new Set(allWords));
  const chosen: number[] = [];
  const taken = new Set<number>();
  const take = (id: number | undefined) => {
    if (id === undefined || taken.has(id) || chosen.length >= req.maxMessages) return;
    taken.add(id);
    chosen.push(id);
  };
  for (const id of req.first ?? []) take(id);
  for (let turn = 0; turn < PER_THREAD && chosen.length < req.maxMessages; turn++) {
    for (const threadId of threadIds) {
      const list = byThread.get(threadId);
      if (list) take(list[turn]);
      else if (turn === 0) take(newest.get(threadId));
    }
  }
  // context: what the conversation stands at now, around what matched
  for (const threadId of threadIds) take(newest.get(threadId));

  const headers = await io.headers(chosen);
  const budget = { left: READ_TOTAL_CHARS };
  let chars = 0;
  const messages: AskSource[] = [];
  for (const id of chosen) {
    if (req.signal?.aborted) return { messages, incomplete: true };
    const m = headers.get(id);
    // a stored message can have moved since it was found: Spam and Trash are never read
    if (!m || m.spam || m.trash || m.draft) continue;
    const left = req.maxChars - chars;
    if (left <= 0) break;
    const words = [...(wordsOf.get(id) ?? [])];
    let text: string | null = null;
    if (m.bodyState === "none" && !m.bodyUnavailable) incomplete = true;
    else if (budget.left <= 0) incomplete = true;
    else {
      const source = await io.text(id);
      if (source !== null) {
        const read = await readUntilFound(source, words, budget, req.signal);
        incomplete ||= read.partial;
        text = passageOf(withoutQuotes(read.text), words);
      }
    }
    const body = clipped(text || m.snippet, left);
    chars += body.length;
    messages.push({ messageId: m.id, threadId: m.threadId, accountId: m.accountId, fromName: m.fromName, fromEmail: m.fromEmail, subject: m.subject, date: m.date, own: m.own, text: body });
  }
  return { messages, incomplete };
}

/** One turn as it's written: every field with a length, trimmed the same way in both stores (revision 11). */
export interface AskTurnWrite {
  conversationId: number | null;
  kind: "question" | "command";
  question: string;
  answer: string | null;
  status: AskTurnStatus;
  sources: readonly AskSourceRef[];
  queries: readonly AskPlanQuery[];
  checks: AskCheck;
  /** every account that fed it, cited or not (revision 3) */
  accountIds: readonly number[];
  model: string | null;
  provider: string | null;
  promptVersion: number | null;
  now: number;
  /** `history.clearGeneration()` before it read anything: a clear since then refuses the write */
  clearGeneration: number;
}

const headerOf = (value: string) => clipped(value, ASK_SOURCE_HEADER_MAX);

export function boundedTurn(w: AskTurnWrite): { title: string; question: string; answer: string | null; sourcesJson: string; queriesJson: string; checksJson: string; accountIdsJson: string } {
  const sources = w.sources.slice(0, ASK_SOURCES_MAX).map((s) => ({ ...s, fromName: headerOf(s.fromName), fromEmail: headerOf(s.fromEmail), subject: headerOf(s.subject) }));
  let queries = JSON.stringify(w.queries);
  // a plan too long to keep isn't kept: Ask again plans afresh
  if (queries.length > ASK_QUERIES_JSON_MAX) queries = "[]";
  const checks: AskCheck = { unlinked: w.checks.unlinked, unsupported: w.checks.unsupported.slice(0, 20).map((s) => clipped(s, 200)) };
  return {
    title: clipped(w.question, ASK_TITLE_MAX),
    question: clipped(w.question, ASK_TITLE_MAX * 5),
    answer: w.answer === null ? null : clipped(w.answer, ASK_ANSWER_MAX),
    sourcesJson: JSON.stringify(sources),
    queriesJson: queries,
    checksJson: JSON.stringify(checks),
    accountIdsJson: JSON.stringify([...new Set(w.accountIds)]),
  };
}

const parsed = <T,>(json: string | null | undefined, fallback: T): T => {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
};

/** A stored row as both stores read it. */
export interface AskTurnRow {
  id: number;
  conversation_id: number;
  kind: "question" | "command";
  question: string;
  answer: string | null;
  status: AskTurnStatus;
  sources_json: string;
  queries_json: string;
  checks_json?: string | null;
  account_ids_json?: string | null;
  model: string | null;
  provider: string | null;
  created_at: number;
}

export const turnOfRow = (r: AskTurnRow): AskTurn => ({
  id: r.id,
  conversationId: r.conversation_id,
  kind: r.kind,
  question: r.question,
  answer: r.answer,
  status: r.status,
  sources: parsed<AskSourceRef[]>(r.sources_json, []),
  queries: parsed<AskPlanQuery[]>(r.queries_json, []),
  model: r.model,
  provider: r.provider,
  createdAt: r.created_at,
  checks: parsed<AskCheck>(r.checks_json, { unlinked: false, unsupported: [] }),
});

/** A deleted conversation as Undo brings it back. */
export interface AskConversationCopy {
  summary: AskConversationSummary;
  rows: AskTurnRow[];
}

/** The history a store keeps. `add` refuses (null) a conversation deleted or cleared since the request began, or one drawing on an account that's gone. */
export interface AskHistory {
  add(write: AskTurnWrite): Promise<{ conversationId: number; turnId: number } | null>;
  list(): Promise<AskConversationSummary[]>;
  turns(conversationId: number): Promise<AskTurn[]>;
  /** how many turns it has (null: gone) */
  turnCount(conversationId: number): Promise<number | null>;
  /** the accounts that have fed it, so a follow-up depends on them too */
  accountsOf(conversationId: number): Promise<number[]>;
  /** what Undo needs, and it's gone */
  remove(conversationId: number): Promise<AskConversationCopy | null>;
  restore(copy: AskConversationCopy): Promise<void>;
  /** the conversations that went */
  removeForAccount(accountId: number): Promise<number[]>;
  /** Settings → Storage → Clear AI data; refuses every `add` that started before it */
  clear(): Promise<void>;
  clearGeneration(): number;
}
