import { WAITING_CLOSED, waitingWords, type ClosedAt, type WaitingActRecord, type WaitingActState, type WaitingDone, type WaitingRowFacts, type WaitingSnapshot } from "@terno/store";
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
 * The dated reader's requests from the message follow the conversation's record from `from` to `to` (an act, or its Undo),
 * whenever the reader read it, before or after: Done closes them (as `waiting`: the waiting line says it), Later puts off
 * those not put off already to its moment, another Later moves what it put off, an Undo puts each back. What the user did
 * to an item alone (their own Later) is left as it is.
 */
function followItems(db: Db, messageId: number, from: WaitingActRecord | null, to: WaitingActRecord | null, now: number): void {
  if (to?.state === "done") {
    if (from?.state !== "done") db.run(`UPDATE dated_items SET state = 'dismissed', closed_reason = ?, closed_at = ?, revision = revision + 1 WHERE message_id = ? AND ${ASKED} AND state = 'open'`, WAITING_CLOSED, now, messageId);
    return;
  }
  if (from?.state === "done") {
    // back open; put off again to the Later it had (one read after the Done was stored closed with none)
    db.run(`UPDATE dated_items SET state = 'open', closed_reason = NULL, closed_at = NULL, deferred_until = coalesce(deferred_until, ?), revision = revision + 1 WHERE message_id = ? AND ${ASKED} AND state = 'dismissed' AND closed_reason = ?`, to?.until ?? null, messageId, WAITING_CLOSED);
    return;
  }
  if (from?.state === "later") db.run(`UPDATE dated_items SET deferred_until = ? WHERE message_id = ? AND ${ASKED} AND state = 'open' AND deferred_until = ?`, to?.until ?? null, messageId, from.until);
  else if (to?.state === "later") db.run(`UPDATE dated_items SET deferred_until = ? WHERE message_id = ? AND ${ASKED} AND state = 'open' AND deferred_until IS NULL`, to.until, messageId);
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

/** The waiting message at a conversation's waiting date: the newest shown one then (one seek of messages_thread). */
const WAITING_MESSAGE = `(SELECT x.id FROM messages x INDEXED BY messages_thread WHERE x.thread_id = json_extract(j.value, '$[0]') AND x.date = json_extract(j.value, '$[1]')
  AND x.is_draft = 0 AND x.is_trash = 0 AND x.is_spam = 0 ORDER BY x.date DESC, x.id DESC LIMIT 1)`;

export function waitingRows(db: Db, threads: readonly { threadId: number; since: number }[], now: number, o: { messages: boolean }): Map<number, WaitingRowFacts> {
  const out = new Map<number, WaitingRowFacts>();
  if (!threads.length) return out;
  // the count: only a deferral still ahead changes a row, and most mailboxes have none (one probe of its index)
  if (!o.messages && !db.get("SELECT 1 FROM waiting_acts INDEXED BY waiting_acts_later WHERE state = 'later' AND until > ? LIMIT 1", now)) return out;
  const rows = db.all<{ thread_id: number; message: number; rev: number | null; state: string | null; until: number | null }>(
    `SELECT json_extract(j.value, '$[0]') AS thread_id, m.id AS message, w.rev, w.state, w.until FROM json_each(?) j
     JOIN messages m ON m.id = ${WAITING_MESSAGE} ${o.messages ? "LEFT " : ""}JOIN waiting_acts w ON w.message_id = m.id`,
    JSON.stringify(threads.map((t) => [t.threadId, t.since])),
  );
  for (const r of rows) out.set(r.thread_id, { message: o.messages ? r.message : null, rev: r.rev ?? 0, until: r.state === "later" && r.until !== null && r.until > now ? r.until : null });
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
