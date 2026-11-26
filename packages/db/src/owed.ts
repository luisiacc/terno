import { addressKey, type FollowupRow } from "@terno/core";
import { followupWorth, OWED_MARK_MS, OWED_REQUEUE_MAX, OWED_SCAN_MARK_MS, type FollowupFinishOutcome, type OwedFinish, type OwedMark, type OwedSource } from "@terno/store";
import { RECEIVED_SQL } from "./ai-summaries";
import { datedSource } from "./dated";
import { admitFollowup, followupRow, TRUSTED_SENT, type FollowupRaw } from "./followups";
import type { Db } from "./sqlite";

/** Plan 280 on SQLite (v83): see packages/store/src/owed.ts. */

const toMark = (r: { message_id: number; thread_id: number; sender_key: string; arrived_at: number; queued_at: number; source: string }): OwedMark => ({ messageId: r.message_id, threadId: r.thread_id, senderKey: r.sender_key, arrivedAt: r.arrived_at, queuedAt: r.queued_at, source: r.source === "scan" ? "scan" : "live" });

function mark(db: Db, ids: readonly number[], now: number, since: number, source: "live" | "scan"): number {
  if (!ids.length) return 0;
  let n = 0;
  const rows = db.all<{ id: number; thread_id: number; date: number; from_email: string }>(
    `SELECT m.id, m.thread_id, m.date, m.from_email FROM messages m WHERE m.id IN (SELECT value FROM json_each(?)) AND ${RECEIVED_SQL} AND m.date >= ?`,
    JSON.stringify(ids),
    since,
  );
  for (const m of rows) n += Number(db.run("INSERT OR IGNORE INTO ai_owed_mail (message_id, thread_id, sender_key, arrived_at, queued_at, source) VALUES (?, ?, ?, ?, ?, ?)", m.id, m.thread_id, addressKey(m.from_email), m.date, now, source).changes);
  return n;
}

/** Ingest's part (in its transaction): live received mail, while Follow-ups wants it (revision 1), since `since` if it went on later. */
export function markOwedMail(db: Db, messageIds: readonly number[], now: number, since: number | null): void {
  mark(db, messageIds, now, since == null ? now - OWED_MARK_MS : Math.max(now - OWED_MARK_MS, since), "live");
}

export function owedMarkPage(db: Db, after: { arrivedAt: number; messageId: number } | null, limit: number): OwedMark[] {
  const from = after ? " WHERE arrived_at > ? OR (arrived_at = ? AND message_id > ?)" : "";
  return db.all<Parameters<typeof toMark>[0]>(`SELECT * FROM ai_owed_mail INDEXED BY ai_owed_mail_order${from} ORDER BY arrived_at, message_id LIMIT ?`, ...(after ? [after.arrivedAt, after.arrivedAt, after.messageId] : []), limit).map(toMark);
}

export const owedMarkCount = (db: Db): number => db.get<{ n: number }>("SELECT COUNT(*) AS n FROM ai_owed_mail")!.n;

/** Revision 3: idempotent on the message; a live mark already there is never reset. */
export const queueOwedScan = (db: Db, messageIds: readonly number[], now: number): number => db.tx(() => mark(db, messageIds, now, -Infinity, "scan"));

/** Revision 1: a debtor's received mail in this account since `since`, marked again, newest first, at most `OWED_REQUEUE_MAX`. */
export function requeueOwed(db: Db, personEmail: string, accountId: number, since: number, now: number): number {
  const key = addressKey(personEmail);
  return db.tx(() => {
    const ids = db
      .all<{ id: number; from_email: string }>(`SELECT m.id, m.from_email FROM messages m INDEXED BY messages_from WHERE m.from_email IN (?, ?) AND m.account_id = ? AND m.date >= ? AND ${RECEIVED_SQL} ORDER BY m.date DESC, m.id DESC LIMIT 200`, personEmail, personEmail.toLowerCase(), accountId, since)
      .filter((m) => addressKey(m.from_email) === key)
      .slice(0, OWED_REQUEUE_MAX)
      .map((m) => m.id);
    return mark(db, ids, now, since, "scan");
  });
}

export const consumeOwedMark = (db: Db, messageId: number): void => void db.run("DELETE FROM ai_owed_mail WHERE message_id = ?", messageId);
export const clearOwedMarks = (db: Db): void => void db.run("DELETE FROM ai_owed_mail");
export const pruneOwedMarks = (db: Db, now: number): number => Number(db.run("DELETE FROM ai_owed_mail WHERE (source = 'scan' AND queued_at < ?) OR (source <> 'scan' AND queued_at < ?)", now - OWED_SCAN_MARK_MS, now - OWED_MARK_MS).changes);

/** Revision 3: one account's received mail in a span, newest first, no list or bulk mail (a check finds what's promised; no debt yet for a service to deliver) */
export function owedScanCandidates(db: Db, since: number, limit: number, accountId: number): number[] {
  return db.all<{ id: number }>(
    `SELECT m.id FROM threads t INDEXED BY threads_acct_all JOIN messages m INDEXED BY messages_thread ON m.thread_id = t.id AND m.date >= ?
     WHERE t.account_id = ? AND t.in_trash = 0 AND t.in_spam = 0 AND t.last_date >= ? AND ${RECEIVED_SQL} AND m.list_id IS NULL AND m.is_bulk = 0
     ORDER BY m.date DESC, m.id DESC LIMIT ?`,
    since,
    accountId,
    since,
    limit,
  ).map((r) => r.id);
}

export function owedSource(db: Db, messageId: number): OwedSource | null {
  const base = datedSource(db, messageId);
  if (!base) return null;
  const m = db.get<{ rfc_message_id: string | null; in_reply_to: string | null }>("SELECT rfc_message_id, in_reply_to FROM messages WHERE id = ?", messageId)!;
  // revision 4: only a trusted send of yours on this account and conversation, never another's mail it names
  const answering = m.in_reply_to
    ? db.get<{ id: number; body_state: OwedSource["bodyState"]; attachments_captured: number }>(`SELECT id, body_state, attachments_captured FROM messages WHERE account_id = ? AND thread_id = ? AND rfc_message_id = ? AND id != ? AND ${TRUSTED_SENT} LIMIT 1`, base.accountId, base.threadId, m.in_reply_to, messageId)
    : undefined;
  return {
    ...base,
    rfcMessageId: m.rfc_message_id,
    attachments: db.all<{ filename: string }>("SELECT filename FROM attachments WHERE message_id = ? ORDER BY id LIMIT 10", messageId).map((r) => r.filename),
    answering: answering ? { id: answering.id, bodyState: answering.body_state, bodyUnavailable: answering.attachments_captured === 2 && answering.body_state !== "full" } : null,
  };
}

/**
 * Open promises of theirs this message could act on: its conversation's and its sender's in this account, none of a
 * conversation in Trash or with anything in Spam (the code review: a promise read from mail moved to Spam since is never
 * material, whatever the rest of its conversation)
 */
export function openOwedFor(db: Db, o: { threadId: number; accountId: number; senderKey: string; before: number; limit: number }): FollowupRow[] {
  return db
    .all<FollowupRaw>(
      `SELECT f.* FROM followups f JOIN threads t ON t.id = f.thread_id
       WHERE f.id IN (SELECT id FROM followups INDEXED BY followups_thread WHERE thread_id = ? AND state IN ('open','due') UNION SELECT id FROM followups INDEXED BY followups_owed WHERE person_key = ? AND kind = 'theirs' AND state IN ('open','due'))
         AND f.kind = 'theirs' AND f.sent_at < ? AND t.account_id = ? AND t.in_trash = 0 AND t.in_spam = 0
         AND NOT EXISTS (SELECT 1 FROM messages x INDEXED BY messages_thread WHERE x.thread_id = f.thread_id AND x.is_spam = 1)
       ORDER BY f.sent_at DESC, f.id DESC LIMIT ?`,
      o.threadId, o.senderKey, o.before, o.accountId, o.limit,
    )
    .map(followupRow);
}

const OPEN_THEIRS = "kind = 'theirs' AND state IN ('open','due')";

export function finishOwed(db: Db, w: OwedFinish): FollowupFinishOutcome {
  return db.tx(() => {
    if (!db.get("SELECT 1 FROM ai_owed_mail WHERE message_id = ?", w.messageId)) return "gone";
    const src = datedSource(db, w.messageId);
    if (!src || src.threadId !== w.threadId || src.spam || src.trash || src.draft || src.threadSpam || src.own || src.sent) {
      consumeOwedMark(db, w.messageId);
      return "gone";
    }
    const rfc = db.get<{ rfc_message_id: string | null }>("SELECT rfc_message_id FROM messages WHERE id = ?", w.messageId)!.rfc_message_id;
    for (const r of w.rows) {
      // only the sender owes what their own mail promises
      if (addressKey(r.personEmail) !== src.senderKey) continue;
      if (db.get("SELECT 1 FROM followups WHERE message_id = ? AND item = ?", w.messageId, r.item)) continue;
      if (!admitFollowup(db, followupWorth({ kind: "theirs", dated: r.dated, firm: r.firm }))) continue;
      db.run(
        `INSERT INTO followups (thread_id, message_id, rfc_message_id, item, kind, text, quote, person_name, person_email, person_key, sent_at, due_at, dated, due_day, firm, timed, part_of_day, state, inbox_state, from_scan, model, provider, prompt_version, created_at)
         VALUES (?, ?, ?, ?, 'theirs', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 'none', ?, ?, ?, ?, ?)`,
        src.threadId, w.messageId, rfc, r.item, r.text, r.quote, r.personName, r.personEmail, src.senderKey, src.date, r.dueAt, r.dated ? 1 : 0, r.dueDay, r.firm ? 1 : 0, r.timed ? 1 : 0, r.partOfDay ?? null, w.fromScan ? 1 : 0, w.model, w.provider, w.promptVersion, w.now,
      );
    }
    // §2 and revision 8: only the debtor's own mail, in this account, after the promise, at the revision shown
    // (the code review: and newer than the mail that last moved it, so an older one read again can't undo a newer move)
    const mine = `${OPEN_THEIRS} AND id = ? AND revision = ? AND person_key = ? AND sent_at < ? AND coalesce(moved_at, sent_at) < ? AND (SELECT t.account_id FROM threads t WHERE t.id = followups.thread_id) = ?`;
    const at = (r: { id: number; revision: number }) => [r.id, r.revision, src.senderKey, src.date, src.date, src.accountId] as const;
    const closed = new Set<number>();
    for (const k of w.kept) {
      if (db.run(`UPDATE followups SET state = 'done', closed_reason = 'kept', closed_at = ?, settled_by = ?, settled_at = ?, inbox_state = 'none', revision = revision + 1 WHERE ${mine}`, w.now, w.messageId, src.date, ...at(k)).changes) closed.add(k.id);
    }
    for (const k of w.withdrawn) {
      if (closed.has(k.id)) continue;
      if (db.run(`UPDATE followups SET state = 'dismissed', closed_reason = 'withdrawn', closed_at = ?, settled_by = ?, settled_at = ?, inbox_state = 'none', revision = revision + 1 WHERE ${mine}`, w.now, w.messageId, src.date, ...at(k)).changes) closed.add(k.id);
    }
    for (const m of w.moved) {
      if (closed.has(m.id)) continue;
      // a new day keeps the user's Later (`deferred_until`); late again only when the new moment has passed
      db.run(
        `UPDATE followups SET due_at = ?, due_day = ?, dated = 1, timed = ?, part_of_day = ?, state = CASE WHEN ? > ? THEN 'open' ELSE state END, inbox_state = CASE WHEN ? > ? THEN 'none' ELSE inbox_state END, notified_at = NULL, moved_at = ?, revision = revision + 1 WHERE ${mine}`,
        m.dueAt, m.dueDay, m.timed ? 1 : 0, m.partOfDay ?? null, m.dueAt, w.now, m.dueAt, w.now, src.date, ...at(m),
      );
    }
    // revision 5: a relay names the debtor: it may have arrived (whoever sent the relay; never a close)
    for (const h of w.hints) {
      if (closed.has(h.id)) continue;
      // (the Astra review: as IndexedDB's, never from mail older than the last move)
      db.run(`UPDATE followups SET arrived_hint = ?, revision = revision + 1 WHERE ${OPEN_THEIRS} AND id = ? AND revision = ? AND sent_at < ? AND coalesce(moved_at, sent_at) < ? AND (SELECT t.account_id FROM threads t WHERE t.id = followups.thread_id) = ?`, w.messageId, h.id, h.revision, src.date, src.date, src.accountId);
    }
    consumeOwedMark(db, w.messageId);
    return "written";
  });
}
