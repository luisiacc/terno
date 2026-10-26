import { isFullEmail, normalizeText, tokenize, type MessageTerm } from "@terno/core";
import { RevisionError, StaleCursorError, type IndexBatch, type IndexChange, type ResolvedSearch, type Revision, type SearchCursor, type SearchRequest } from "@terno/store";
import { messageDoc, T, threadDoc, VIEW_TEST, type Ctx, type R } from "./mail";

/** Batches kept for engines catching up (bytes of their id lists), as on SQL. */
export const SEARCH_LOG_BYTES = 32 * 1024 * 1024;

// ───────────────────────────── the outbox ─────────────────────────────

export function searchHead(c: Ctx): Revision {
  const s = T(c, "search_state").get(1)!;
  return { epoch: s.epoch, seq: s.seq };
}

/**
 * Appends one revisioned batch of the ids a command touched, inside the same
 * unit as the command (and so the same IndexedDB transaction): a rollback
 * takes it along. Projections are read when the batch is served.
 */
export function appendOutbox(c: Ctx, messageIds: readonly number[], threadIds: readonly number[], now: number, maxBytes = SEARCH_LOG_BYTES): void {
  if (messageIds.length === 0 && threadIds.length === 0) return;
  const state = T(c, "search_state");
  const s = state.get(1)!;
  const seq = s.seq + 1;
  const bytes = JSON.stringify([messageIds, threadIds]).length;
  T(c, "search_outbox").insert({ seq, at: now, bytes, message_ids: [...messageIds], thread_ids: [...threadIds] });
  let total = s.bytes + bytes;
  if (total > maxBytes) total -= pruneLog(c, total - maxBytes, seq);
  state.update(s, { seq, bytes: total });
}

function pruneLog(c: Ctx, excess: number, newest: number): number {
  let lease: number | null = null;
  for (const l of T(c, "search_leases").all()) lease = lease === null ? l.from_seq : Math.min(lease, l.from_seq);
  const keepFrom = Math.min(newest, lease === null ? newest : lease + 1);
  const outbox = T(c, "search_outbox");
  const old = [...outbox.all()].filter((r) => r.seq < keepFrom).sort((x, y) => x.seq - y.seq);
  let freed = 0;
  for (const r of old.slice(0, 1024)) {
    if (freed >= excess) break;
    freed += r.bytes;
    outbox.deleteRow(r);
  }
  return freed;
}

export interface ChangeIds {
  from: Revision;
  to: Revision;
  messageIds: number[];
  threadIds: number[];
}

/** The ids each batch in (after, through] touched; another epoch, a revision ahead of the head or a pruned gap is refused. */
export function searchChangeIds(c: Ctx, after: Revision, through: Revision, maxCommits: number): ChangeIds[] {
  const head = searchHead(c);
  if (after.epoch !== head.epoch || through.epoch !== head.epoch) throw new RevisionError("epoch", "the search log belongs to another database");
  if (after.seq > head.seq || through.seq > head.seq) throw new RevisionError("ahead", "that revision hasn't been committed");
  if (through.seq <= after.seq) return [];
  const outbox = T(c, "search_outbox");
  let oldest: number | null = null;
  for (const k of outbox.rows.keys()) oldest = oldest === null ? (k as number) : Math.min(oldest, k as number);
  if (oldest === null || oldest > after.seq + 1) throw new RevisionError("gap", `the search log was pruned past revision ${after.seq}`);
  const out: ChangeIds[] = [];
  for (let seq = after.seq + 1; seq <= through.seq && out.length < maxCommits; seq++) {
    const r = outbox.get(seq);
    if (!r) continue;
    out.push({ from: { epoch: head.epoch, seq: seq - 1 }, to: { epoch: head.epoch, seq }, messageIds: r.message_ids, threadIds: r.thread_ids });
  }
  return out;
}

/** Absolute projections (or tombstones), read now: the message bodies must have been read ahead. */
export function materializeChanges(c: Ctx, messageIds: readonly number[], threadIds: readonly number[]): IndexChange[] {
  const messages = T(c, "messages");
  const threads = T(c, "threads");
  const changes: IndexChange[] = [];
  for (const id of messageIds) {
    const m = messages.get(id);
    changes.push(m ? { kind: "upsertMessage", doc: messageDoc(m, c.body(id)?.body_text ?? null) } : { kind: "removeMessage", messageId: id });
  }
  for (const id of threadIds) {
    const t = threads.get(id);
    changes.push(t ? { kind: "upsertThread", doc: threadDoc(c, t) } : { kind: "removeThread", threadId: id });
  }
  return changes;
}

export type { IndexBatch };

// ───────────────────────────── the exact scan ─────────────────────────────

/**
 * Search without the index (it is building, catching up, or over its memory
 * caps): every message is checked, so the answer is exact and complete. Its
 * own implementation of the semantics (same message for all message terms,
 * exact full-email senders, field-local phrases, the last token as a
 * prefix, purely negative text excluding whole threads); the conformance
 * suite holds it to the oracle like any engine.
 */
export interface ScanPlan {
  impossible: boolean;
  /** message predicates exist: candidates are the threads of matching messages */
  messageLevel: boolean;
  /** some term needs a body to be decided */
  needsBodies: boolean;
  messageOk(m: R, columns: () => Columns): boolean;
  /** negative-only text: does this message exclude its thread? */
  excludes(m: R, columns: () => Columns): boolean;
  threadOk(t: R): boolean;
}

export interface Columns {
  subject: string[];
  from: string[];
  to: string[];
  body: string[];
}

export function columnsOf(m: R, body: string | null): Columns {
  return { subject: tokenize(m.subject), from: tokenize(`${m.from_name} ${m.from_email}`), to: tokenize(m.recipients_text), body: tokenize(body ?? "") };
}

function phraseAt(tokens: readonly string[], needle: readonly string[], prefix: boolean): boolean {
  outer: for (let i = 0; i + needle.length <= tokens.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      const t = tokens[i + j]!;
      const n = needle[j]!;
      if (prefix && j === needle.length - 1 ? !t.startsWith(n) : t !== n) continue outer;
    }
    return true;
  }
  return false;
}

function termIn(cols: Columns, term: MessageTerm, needle: readonly string[]): boolean {
  if (term.field === "text") return phraseAt(cols.subject, needle, term.prefix) || phraseAt(cols.from, needle, term.prefix) || phraseAt(cols.to, needle, term.prefix) || phraseAt(cols.body, needle, term.prefix);
  return phraseAt(cols[term.field], needle, term.prefix);
}

export function planScan(c: Ctx, r: ResolvedSearch): ScanPlan {
  const q = r.query;
  const memberships = T(c, "thread_categories");
  const emails = q.terms.filter((t) => t.field === "from" && isFullEmail(t.value)).map((t) => ({ email: normalizeText(t.value), negate: t.negate }));
  const text = q.terms.filter((t) => !(t.field === "from" && isFullEmail(t.value))).map((t) => ({ term: t, needle: tokenize(t.value) })).filter((t) => t.needle.length > 0);
  const positive = text.filter((t) => !t.term.negate);
  const negative = text.filter((t) => t.term.negate);
  const messageLevel = positive.length > 0 || emails.length > 0 || q.hasAttachment !== undefined || q.before !== undefined || q.after !== undefined;
  const accounts = r.accountIds ? new Set(r.accountIds) : null;
  const excludedAccounts = new Set(r.excludeAccountIds);
  const view = VIEW_TEST[r.view];
  return {
    impossible: r.impossible,
    messageLevel,
    needsBodies: text.some((t) => t.term.field === "text"),
    messageOk(m, columns) {
      if (q.hasAttachment !== undefined && (m.has_attachments === 1) !== q.hasAttachment) return false;
      if (q.before !== undefined && !(m.date < q.before)) return false;
      if (q.after !== undefined && !(m.date >= q.after)) return false;
      for (const e of emails) if ((m.from_email === e.email) === e.negate) return false;
      if (positive.length === 0 && negative.length === 0) return true;
      const cols = columns();
      for (const t of positive) if (!termIn(cols, t.term, t.needle)) return false;
      for (const t of negative) if (termIn(cols, t.term, t.needle)) return false;
      return true;
    },
    excludes(m, columns) {
      if (messageLevel || negative.length === 0) return false;
      const cols = columns();
      return negative.some((t) => termIn(cols, t.term, t.needle));
    },
    threadOk(t) {
      if (!view(t)) return false;
      if (accounts && !accounts.has(t.account_id)) return false;
      if (excludedAccounts.has(t.account_id)) return false;
      for (const id of r.categoryIds) if (!memberships.has(t.id, id)) return false;
      for (const id of r.excludeCategoryIds) if (memberships.has(t.id, id)) return false;
      if (q.unread !== undefined && t.unread_count > 0 !== q.unread) return false;
      if (q.starred !== undefined && (t.is_starred === 1) !== q.starred) return false;
      if (q.threadAttachments && t.has_attachments !== 1) return false;
      if (q.threadPeople && t.person !== 1) return false;
      if (q.threadWaitingSince !== undefined && !(t.waiting_since != null && t.waiting_since >= q.threadWaitingSince)) return false;
      return true;
    },
  };
}

export function checkCursor(req: SearchRequest, at: Revision): void {
  const cur = req.cursor;
  if (!cur) return;
  if (cur.queryKey !== req.search.key) throw new StaleCursorError("query");
  if (cur.revision.epoch !== at.epoch) throw new StaleCursorError("epoch");
  if (cur.revision.seq !== at.seq) throw new StaleCursorError("revision");
}

/** Matching threads newest first, after the cursor, at most limit + 1 (-1: all). */
export function scanPage(c: Ctx, plan: ScanPlan, matched: Set<number> | null, excluded: Set<number>, cursor: { lastDate: number; id: number } | undefined, limit: number, extra?: (t: R) => boolean): number[] {
  const threads = T(c, "threads");
  const ids = c.order.current(threads);
  const out: number[] = [];
  for (let i = cursor ? c.order.after(threads, cursor) : 0; i < ids.length && (limit < 0 || out.length <= limit); i++) {
    const id = ids[i]!;
    if (matched && !matched.has(id)) continue;
    if (excluded.has(id)) continue;
    const t = threads.get(id)!;
    if (!plan.threadOk(t) || (extra && !extra(t))) continue;
    out.push(id);
  }
  return out;
}

export function pageOf(ids: number[], req: SearchRequest, at: Revision, threadOf: (id: number) => R): { threadIds: number[]; nextCursor: SearchCursor | null } {
  const hasMore = ids.length > req.limit;
  const kept = hasMore ? ids.slice(0, req.limit) : ids;
  const last = kept.length ? threadOf(kept[kept.length - 1]!) : null;
  return { threadIds: kept, nextCursor: hasMore && last ? { revision: at, queryKey: req.search.key, lastDate: last.last_date, id: last.id } : null };
}
