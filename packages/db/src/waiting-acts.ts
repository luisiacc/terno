import { waitingCutoff, type WaitingDeferred } from "@terno/core";
import { WAITING_CLOSED, waitingWords, type ClosedAt, type WaitingActRecord, type WaitingActState, type WaitingDone, type WaitingSnapshot } from "@terno/store";
import { recomputeContext, refreshFacts, waitingFactsOf } from "./facts";
import type { Db } from "./sqlite";

/** Plan 215 on SQLite (v74): see packages/store/src/waiting-acts.ts. */

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
 * The dated reader's requests from the message follow the conversation's record from `from` to `to` (an act, or its Undo):
 * what Later put off with it closes with Done, moves with another Later, comes back with an Undo. Only what this record
 * did (closed as `waiting`, put off to its very moment): an item the user acted on is left as it is.
 */
function followItems(db: Db, messageId: number, from: WaitingActRecord | null, to: WaitingActRecord | null, now: number): void {
  if (to?.state === "done") {
    if (from?.state === "later") db.run(`UPDATE dated_items SET state = 'dismissed', closed_reason = ?, closed_at = ?, revision = revision + 1 WHERE message_id = ? AND ${ASKED} AND state = 'open' AND deferred_until = ?`, WAITING_CLOSED, now, messageId, from.until);
    return;
  }
  if (from?.state === "done") {
    db.run(`UPDATE dated_items SET state = 'open', closed_reason = NULL, closed_at = NULL, deferred_until = coalesce(?, deferred_until), revision = revision + 1 WHERE message_id = ? AND ${ASKED} AND state = 'dismissed' AND closed_reason = ?`, to?.until ?? null, messageId, WAITING_CLOSED);
    return;
  }
  if (from?.state === "later") db.run(`UPDATE dated_items SET deferred_until = ? WHERE message_id = ? AND ${ASKED} AND state = 'open' AND deferred_until = ?`, to?.until ?? null, messageId, from.until);
}

export function actOnWaiting(db: Db, o: { threadId: number; since: number; rev: number; state: WaitingActState; until: number | null; now: number }): WaitingSnapshot | null {
  return db.tx(() => {
    const ctx = recomputeContext(db);
    if (!ctx) return null;
    // the message the facts judge waiting now, walked again in this transaction: never a date's
    const f = waitingFactsOf(db, o.threadId, ctx);
    if (f.waitingMessageId === null || f.waitingSince !== o.since) return null;
    const before = recordOf(db, f.waitingMessageId);
    if ((before?.rev ?? 0) !== o.rev) return null;
    const words = db.get<{ from_name: string | null; from_email: string; subject: string | null; has_sent: number }>(
      "SELECT m.from_name, m.from_email, t.subject, t.has_sent FROM messages m JOIN threads t ON t.id = m.thread_id WHERE m.id = ?",
      f.waitingMessageId,
    )!;
    const next: WaitingActRecord = { messageId: f.waitingMessageId, state: o.state, until: o.state === "later" ? o.until : null, at: o.now, rev: o.rev + 1, who: waitingWords(words.from_name || words.from_email), subject: waitingWords(words.subject), wrote: words.has_sent === 1 };
    write(db, next);
    followItems(db, next.messageId, before, next, o.now);
    if (o.state === "done") refreshFacts(db, o.threadId);
    return { messageId: next.messageId, threadId: o.threadId, rev: next.rev, before };
  });
}

export function restoreWaiting(db: Db, s: WaitingSnapshot): number | null {
  return db.tx(() => {
    const current = recordOf(db, s.messageId);
    if (!current || current.rev !== s.rev) return null;
    if (s.before) write(db, s.before);
    else db.run("DELETE FROM waiting_acts WHERE message_id = ?", s.messageId);
    followItems(db, s.messageId, current, s.before, current.at);
    // its conversation now (a merge since moves it with its message)
    const thread = db.get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE id = ?", s.messageId)!.thread_id;
    refreshFacts(db, thread);
    return thread;
  });
}

export function waitingRevs(db: Db, threads: readonly { threadId: number; since: number }[]): Map<number, number> {
  // most mailboxes have no record at all: nothing is probed
  if (!threads.length || !db.get("SELECT 1 FROM waiting_acts LIMIT 1")) return new Map();
  // each conversation's message at its waiting date (messages_thread is (thread_id, date, id)), then its record
  const rows = db.all<{ thread_id: number; rev: number }>(
    `SELECT m.thread_id, w.rev FROM json_each(?) j
     JOIN messages m INDEXED BY messages_thread ON m.thread_id = json_extract(j.value, '$[0]') AND m.date = json_extract(j.value, '$[1]')
     JOIN waiting_acts w ON w.message_id = m.id`,
    JSON.stringify(threads.map((t) => [t.threadId, t.since])),
  );
  return new Map(rows.map((r) => [r.thread_id, r.rev]));
}

export function waitingDeferred(db: Db, now: number, limit: number): WaitingDeferred[] {
  // a deferral holds while its conversation still waits at its message (a newer one from them isn't put off), in the Inbox
  return db
    .all<{ thread_id: number; until: number; rev: number; last_date: number; has_sent: number; waiting_since: number }>(
      `SELECT m.thread_id, w.until, w.rev, t.last_date, t.has_sent, t.waiting_since FROM waiting_acts w INDEXED BY waiting_acts_later
       JOIN messages m ON m.id = w.message_id JOIN threads t ON t.id = m.thread_id
       WHERE w.state = 'later' AND w.until > ? AND t.waiting_since = m.date AND t.waiting_since >= ? AND t.in_inbox = 1 AND t.in_spam = 0 AND t.in_trash = 0
       ORDER BY w.until, w.message_id LIMIT ?`,
      now,
      waitingCutoff(now),
      limit,
    )
    .map((r) => ({ threadId: r.thread_id, until: r.until, rev: r.rev, lastDate: r.last_date, hasSent: r.has_sent === 1, waitingSince: r.waiting_since }));
}

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

export const pruneWaiting = (db: Db, now: number): number => Number(db.run("DELETE FROM waiting_acts WHERE state = 'later' AND until <= ?", now).changes);
