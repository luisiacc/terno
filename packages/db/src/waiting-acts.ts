import { WAITING_CLOSED, waitingWords, type ClosedAt, type DatedSnapshot, type WaitingActRecord, type WaitingActState, type WaitingDone, type WaitingRowFacts, type WaitingSnapshot } from "@terno/store";
import { recomputeContext, refreshFacts, waitingFactsOf } from "./facts";
import type { Db } from "./sqlite";

/** Plans 215 and 216 on SQLite (v74, v75): see packages/store/src/waiting-acts.ts. */

interface Raw {
  message_id: number;
  state: WaitingActState;
  until: number | null;
  at: number;
  rev: number;
  who: string;
  subject: string;
  wrote: number;
}

const toRecord = (r: Raw): WaitingActRecord => ({ messageId: r.message_id, state: r.state, until: r.until, at: r.at, rev: r.rev, who: r.who, subject: r.subject, wrote: r.wrote === 1 });
const recordOf = (db: Db, messageId: number): WaitingActRecord | null => {
  const r = db.get<Raw>("SELECT * FROM waiting_acts WHERE message_id = ?", messageId);
  return r ? toRecord(r) : null;
};

function write(db: Db, r: WaitingActRecord): void {
  db.run("INSERT OR REPLACE INTO waiting_acts (message_id, state, until, at, rev, who, subject, wrote) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", r.messageId, r.state, r.until, r.at, r.rev, r.who, r.subject, r.wrote ? 1 : 0);
}

/** A request the dated reader read from the message (an ask, a "respond"): what follows the conversation's choice. */
const ASKED = "kind IN ('ask', 'respond')";

/**
 * The dated reader's requests from the message (read before the act) follow it: Done closes the open ones (as `waiting`:
 * the waiting line says it); Later puts off those not put off to a moment of the user's own (none, one passed, or the Later
 * it replaces). Each changed one's revision moves and its snapshot is the act's, so Undo puts back exactly what it changed
 * (Codex code review 2, #1, #2).
 */
function applyItems(db: Db, messageId: number, from: WaitingActRecord | null, to: WaitingActRecord, now: number): DatedSnapshot[] {
  // plan 216: Remove takes the row off What matters, and leaves the reader's requests as they are
  if (to.state === "removed") return [];
  const rows = db.all<{ id: number; revision: number; state: DatedSnapshot["state"]; deferred_until: number | null; closed_reason: string | null; closed_at: number | null }>(
    `SELECT id, revision, state, deferred_until, closed_reason, closed_at FROM dated_items WHERE message_id = ? AND ${ASKED} AND state = 'open'`,
    messageId,
  );
  const changed: DatedSnapshot[] = [];
  for (const r of rows) {
    if (to.state === "later" && !(r.deferred_until === null || r.deferred_until <= now || (from?.state === "later" && r.deferred_until === from.until))) continue;
    if (to.state === "done") db.run("UPDATE dated_items SET state = 'dismissed', closed_reason = ?, closed_at = ?, revision = revision + 1 WHERE id = ?", WAITING_CLOSED, now, r.id);
    else db.run("UPDATE dated_items SET deferred_until = ?, revision = revision + 1 WHERE id = ?", to.until, r.id);
    changed.push({ id: r.id, revision: r.revision, state: r.state, deferredUntil: r.deferred_until, closedReason: r.closed_reason, closedAt: r.closed_at });
  }
  return changed;
}

/**
 * Undo's: what the act changed, back as it was (its revision too) while it's at the act's revision; and what the reader stored from the message since
 * (untouched since, revision 0), as the record now restored would have had it stored.
 */
function unapplyItems(db: Db, s: WaitingSnapshot, current: WaitingActRecord): void {
  // exactly, its revision too, so an Undo after an Undo (Later, Done, back, back) puts back what the first changed
  for (const i of s.items) db.run("UPDATE dated_items SET state = ?, deferred_until = ?, closed_reason = ?, closed_at = ?, revision = ? WHERE id = ? AND revision = ?", i.state, i.deferredUntil, i.closedReason, i.closedAt, i.revision, i.id, i.revision + 1);
  const later = s.before?.state === "later" ? s.before.until : null;
  // (plan 216) a Remove changed none; the reader stored a removed message's requests as any other's: put off with the Later
  // restored, as the reader would have stored them under it (revision 0, so that Later's own Undo takes them back too: Codex
  // review of plan 216, #1; code review, #2)
  if (current.state === "removed") {
    if (later !== null) db.run(`UPDATE dated_items SET deferred_until = ? WHERE message_id = ? AND ${ASKED} AND state = 'open' AND deferred_until IS NULL AND revision = 0`, later, s.messageId);
    return;
  }
  if (current.state === "done") {
    if (s.before?.state !== "done") db.run(`UPDATE dated_items SET state = 'open', closed_reason = NULL, closed_at = NULL, deferred_until = ?, revision = revision + 1 WHERE message_id = ? AND ${ASKED} AND state = 'dismissed' AND closed_reason = ? AND revision = 0`, later, s.messageId, WAITING_CLOSED);
  } else if (s.before?.state === "done") db.run(`UPDATE dated_items SET state = 'dismissed', closed_reason = ?, closed_at = ?, revision = revision + 1 WHERE message_id = ? AND ${ASKED} AND state = 'open' AND deferred_until = ? AND revision = 0`, WAITING_CLOSED, s.before.at, s.messageId, current.until);
  else db.run(`UPDATE dated_items SET deferred_until = ?, revision = revision + 1 WHERE message_id = ? AND ${ASKED} AND state = 'open' AND deferred_until = ? AND revision = 0`, later, s.messageId, current.until);
}

export function actOnWaiting(db: Db, o: { threadId: number; since: number; message: number; rev: number; state: WaitingActState; until: number | null; now: number }): WaitingSnapshot | null {
  return db.tx(() => {
    const ctx = recomputeContext(db);
    if (!ctx) return null;
    // the message the facts judge waiting now, walked again in this transaction: never a date's
    const f = waitingFactsOf(db, o.threadId, ctx);
    // the message the row was drawn for, still the one waiting (a newer one at the same moment isn't: Codex code review 1, #2)
    if (f.waitingMessageId !== o.message || f.waitingSince !== o.since) return null;
    const before = recordOf(db, f.waitingMessageId);
    if ((before?.rev ?? 0) !== o.rev) return null;
    const words = db.get<{ from_name: string | null; from_email: string; subject: string | null; has_sent: number }>(
      "SELECT m.from_name, m.from_email, t.subject, t.has_sent FROM messages m JOIN threads t ON t.id = m.thread_id WHERE m.id = ?",
      f.waitingMessageId,
    )!;
    const next: WaitingActRecord = { messageId: f.waitingMessageId, state: o.state, until: o.state === "later" ? o.until : null, at: o.now, rev: o.rev + 1, who: waitingWords(words.from_name || words.from_email), subject: waitingWords(words.subject), wrote: words.has_sent === 1 };
    write(db, next);
    const items = applyItems(db, next.messageId, before, next, o.now);
    if (o.state === "done") refreshFacts(db, o.threadId);
    return { messageId: next.messageId, threadId: o.threadId, rev: next.rev, before, items };
  });
}

export function restoreWaiting(db: Db, s: WaitingSnapshot): number | null {
  return db.tx(() => {
    const current = recordOf(db, s.messageId);
    if (!current || current.rev !== s.rev) return null;
    if (s.before) write(db, s.before);
    else db.run("DELETE FROM waiting_acts WHERE message_id = ?", s.messageId);
    unapplyItems(db, s, current);
    // its conversation now (a merge since moves it with its message)
    const thread = db.get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE id = ?", s.messageId)!.thread_id;
    refreshFacts(db, thread);
    return thread;
  });
}

export function waitingRows(db: Db, threads: readonly { threadId: number; since: number }[], now: number, o: { messages: boolean }): Map<number, WaitingRowFacts> {
  const out = new Map<number, WaitingRowFacts>();
  if (!threads.length) return out;
  let asked = threads;
  // the count: only a deferral still ahead or (plan 216) a Remove changes a row, and most mailboxes have neither (a probe of
  // each index). Removes are kept with their message, so they add up: with no deferral ahead and fewer of them than rows,
  // only the conversations a removed record sits at the waiting date of are resolved
  if (!o.messages && !db.get("SELECT 1 FROM waiting_acts INDEXED BY waiting_acts_later WHERE state = 'later' AND until > ? LIMIT 1", now)) {
    // (read at most one past the page's size: past that, resolving the page itself is the cheaper, bounded read)
    const removed = db.all<{ thread_id: number; date: number }>("SELECT m.thread_id, m.date FROM waiting_acts w INDEXED BY waiting_acts_removed JOIN messages m ON m.id = w.message_id WHERE w.state = 'removed' LIMIT ?", threads.length + 1);
    if (!removed.length) return out;
    if (removed.length <= threads.length) {
      const since = new Map(threads.map((t) => [t.threadId, t.since]));
      const at = new Set(removed.flatMap((r) => (since.get(r.thread_id) === r.date ? [r.thread_id] : [])));
      if (!at.size) return out;
      asked = threads.filter((t) => at.has(t.threadId));
    }
  }
  // each conversation's newest received message at its waiting date (a range of messages_thread a row), then its record
  const rows = db.all<{ thread_id: number; message: number; rev: number | null; state: WaitingActState | null; until: number | null }>(
    `SELECT p.thread_id, p.message, w.rev, w.state, w.until FROM (
       SELECT x.thread_id, max(x.id) AS message FROM json_each(?) j JOIN messages x INDEXED BY messages_thread ON x.thread_id = j.value ->> 0 AND x.date = j.value ->> 1
       WHERE x.is_sent = 0 AND x.is_draft = 0 AND x.is_trash = 0 AND x.is_spam = 0 GROUP BY x.thread_id
     ) p ${o.messages ? "LEFT " : ""}JOIN waiting_acts w ON w.message_id = p.message`,
    JSON.stringify(asked.map((t) => [t.threadId, t.since])),
  );
  for (const r of rows) {
    const until = r.state === "later" && r.until !== null && r.until > now ? r.until : null;
    const removed = r.state === "removed";
    // (the count's: what keeps a row out, nothing else)
    if (!o.messages && until === null && !removed) continue;
    out.set(r.thread_id, { message: o.messages ? r.message : null, rev: r.rev ?? 0, until, ...(removed && { removed }) });
  }
  return out;
}

/** The deferrals' moments still ahead, soonest first (the clock's: one that no longer holds wakes it for nothing). */
export const waitingMoments = (db: Db, now: number, limit: number): number[] =>
  db.all<{ until: number }>("SELECT until FROM waiting_acts INDEXED BY waiting_acts_later WHERE state = 'later' AND until > ? ORDER BY until LIMIT ?", now, limit).map((r) => r.until);

export function waitingDonePage(db: Db, o: { since: number; after: ClosedAt | null; limit: number }): WaitingDone[] {
  const { after } = o;
  return db
    .all<Raw & { thread_id: number }>(
      `SELECT w.*, m.thread_id FROM waiting_acts w INDEXED BY waiting_acts_done JOIN messages m ON m.id = w.message_id
       WHERE w.state = 'done' AND w.at >= ?${after ? " AND (w.at, w.message_id) < (?, ?)" : ""} ORDER BY w.at DESC, w.message_id DESC LIMIT ?`,
      o.since,
      ...(after ? [after.at, after.id] : []),
      o.limit,
    )
    .map((r) => ({ messageId: r.message_id, threadId: r.thread_id, at: r.at, who: r.who, subject: r.subject, wrote: r.wrote === 1 }));
}
