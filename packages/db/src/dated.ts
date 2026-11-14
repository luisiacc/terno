import { addressKey, DATED_ACTIVE_MAX, DATED_CLOSED_KEEP_MS, type DatedRow } from "@terno/core";
import { DATED_MARK_MS, DATED_SCAN_MARK_MS, datedTab, NEW_MAIL_MS, readerIn, recipientList, type DatedFinish, type DatedFinishOutcome, type DatedMark, type DatedSnapshot, type DatedSource } from "@terno/store";
import { OWN_SENDER_SQL, RECEIVED_SQL } from "./ai-summaries";
import { ownAddresses } from "./facts";
import type { Db } from "./sqlite";

/** Plan 204 on SQLite (v56): see packages/store/src/dated.ts. */

interface Raw {
  id: number; thread_id: number; message_id: number; item: number; kind: DatedRow["kind"]; text: string; quote: string; sender_key: string; due_day: string; due_at: number; timed: number; dated: number; act_at: number;
  deferred_until: number | null; arrived_at: number; state: DatedRow["state"]; closed_reason: string | null; closed_at: number | null; from_scan: number; revision: number; model: string | null; provider: string | null; created_at: number;
}
const toRow = (r: Raw): DatedRow => ({
  id: r.id, threadId: r.thread_id, messageId: r.message_id, item: r.item, kind: r.kind, text: r.text, quote: r.quote, senderKey: r.sender_key, dueDay: r.due_day, dueAt: r.due_at, timed: r.timed === 1, dated: r.dated === 1, actAt: r.act_at,
  deferredUntil: r.deferred_until, arrivedAt: r.arrived_at, state: r.state, closedReason: r.closed_reason, closedAt: r.closed_at, fromScan: r.from_scan === 1, revision: r.revision, model: r.model, provider: r.provider, createdAt: r.created_at,
});

/** Ingest's part (in its transaction): received live mail, by the new-mail rule, and since the feature went on. */
export function markDatedMail(db: Db, messageIds: readonly number[], now: number, since: number | null): void {
  if (!messageIds.length) return;
  db.run(
    `INSERT OR IGNORE INTO ai_dated_mail (message_id, thread_id, arrived_at, queued_at, source)
     SELECT m.id, m.thread_id, m.date, ?, 'live' FROM messages m
     WHERE m.id IN (SELECT value FROM json_each(?)) AND ${RECEIVED_SQL} AND m.date >= ?`,
    now,
    JSON.stringify(messageIds),
    since == null ? now - NEW_MAIL_MS : Math.max(now - NEW_MAIL_MS, since),
  );
}

/** A merge: the marks follow their messages, and the items their thread (a new revision: what was shown has moved). */
export function mergeDated(db: Db, into: number, from: number): void {
  db.run("UPDATE ai_dated_mail SET thread_id = ? WHERE thread_id = ?", into, from);
  db.run("UPDATE OR IGNORE dated_items SET thread_id = ?, revision = revision + 1 WHERE thread_id = ?", into, from);
}

const toMark = (r: { message_id: number; thread_id: number; arrived_at: number; queued_at: number; source: "live" | "scan" }): DatedMark => ({ messageId: r.message_id, threadId: r.thread_id, arrivedAt: r.arrived_at, queuedAt: r.queued_at, source: r.source });

export function datedMarkPage(db: Db, after: { arrivedAt: number; messageId: number } | null, limit: number): DatedMark[] {
  const from = after ? " WHERE arrived_at > ? OR (arrived_at = ? AND message_id > ?)" : "";
  return db.all<Parameters<typeof toMark>[0]>(`SELECT * FROM ai_dated_mail${from} ORDER BY arrived_at, message_id LIMIT ?`, ...(after ? [after.arrivedAt, after.arrivedAt, after.messageId] : []), limit).map(toMark);
}

export const datedMarkCount = (db: Db): number => db.get<{ n: number }>("SELECT COUNT(*) AS n FROM ai_dated_mail")!.n;

/** Not marked, not read: what a check may still take. */
const UNREAD_SQL = "NOT EXISTS (SELECT 1 FROM ai_dated_mail d WHERE d.message_id = m.id) AND NOT EXISTS (SELECT 1 FROM dated_items i WHERE i.message_id = m.id)";

export function queueDatedScan(db: Db, messageIds: readonly number[], now: number): number {
  return db.tx(() => {
    let n = 0;
    for (const id of messageIds) {
      n += Number(db.run(
        `INSERT INTO ai_dated_mail (message_id, thread_id, arrived_at, queued_at, source)
         SELECT m.id, m.thread_id, m.date, ?, 'scan' FROM messages m WHERE m.id = ? AND ${RECEIVED_SQL} AND ${UNREAD_SQL}`,
        now,
        id,
      ).changes);
    }
    return n;
  });
}

export function pruneDatedMarks(db: Db, now: number): number {
  return Number(db.run("DELETE FROM ai_dated_mail WHERE (source = 'live' AND queued_at < ?) OR (source = 'scan' AND queued_at < ?)", now - DATED_MARK_MS, now - DATED_SCAN_MARK_MS).changes);
}

export function datedScanCandidates(db: Db, since: number, limit: number): number[] {
  return db.all<{ id: number }>(`SELECT m.id FROM messages m WHERE m.date >= ? AND ${RECEIVED_SQL} AND ${UNREAD_SQL} ORDER BY m.date DESC, m.id DESC LIMIT ?`, since, limit).map((r) => r.id);
}

export function datedSource(db: Db, messageId: number): DatedSource | null {
  const m = db.get<{ id: number; thread_id: number; account_id: number; subject: string; date: number; from_name: string; from_email: string; is_bulk: number; list_id: string | null; tab: number; category: number | null; is_sent: number; is_draft: number; is_spam: number; is_trash: number; own: number; thread_spam: number; body_state: DatedSource["bodyState"]; attachments_captured: number; to_json: string; cc_json: string }>(
    `SELECT m.id, m.thread_id, m.account_id, m.subject, m.date, m.from_name, m.from_email, m.is_bulk, m.list_id, t.tab, m.category, m.is_sent, m.is_draft, m.is_spam, m.is_trash, m.body_state, m.attachments_captured, m.to_json, m.cc_json,
       ${OWN_SENDER_SQL} AS own,
       EXISTS (SELECT 1 FROM messages x INDEXED BY messages_thread WHERE x.thread_id = m.thread_id AND x.is_spam = 1) AS thread_spam
     FROM messages m JOIN threads t ON t.id = m.thread_id WHERE m.id = ?`,
    messageId,
  );
  if (!m) return null;
  const people = (json: string) => {
    const list = recipientList(json);
    return list.addresses.map((email) => ({ name: list.names[email] ?? "", email }));
  };
  const to = people(m.to_json);
  const cc = people(m.cc_json);
  return {
    id: m.id, threadId: m.thread_id, accountId: m.account_id, subject: m.subject, date: m.date, fromName: m.from_name, fromEmail: m.from_email, senderKey: addressKey(m.from_email),
    to, cc, readerIn: readerIn(to, cc, ownAddresses(db)),
    automated: m.is_bulk === 1 || m.list_id !== null, tab: datedTab(m.tab, m.category),
    draft: m.is_draft === 1, sent: m.is_sent === 1, spam: m.is_spam === 1, trash: m.is_trash === 1, threadSpam: m.thread_spam === 1, own: m.own === 1,
    bodyState: m.body_state, bodyUnavailable: m.attachments_captured === 2 && m.body_state !== "full",
  };
}

export function openDatedFor(db: Db, o: { threadId: number; senderKey: string; before: number; limit: number }): DatedRow[] {
  return db.all<Raw>(
    `SELECT * FROM dated_items WHERE id IN (SELECT id FROM dated_items INDEXED BY dated_thread WHERE thread_id = ? AND state = 'open' UNION SELECT id FROM dated_items INDEXED BY dated_sender WHERE sender_key = ? AND state = 'open')
       AND arrived_at < ?
       AND NOT EXISTS (SELECT 1 FROM messages x INDEXED BY messages_thread WHERE x.thread_id = dated_items.thread_id AND x.is_spam = 1)
     ORDER BY arrived_at DESC, id DESC LIMIT ?`,
    o.threadId, o.senderKey, o.before, o.limit,
  ).map(toRow);
}

export function finishDated(db: Db, w: DatedFinish): DatedFinishOutcome {
  return db.tx(() => {
    if (!db.get("SELECT 1 FROM ai_dated_mail WHERE message_id = ?", w.messageId)) return "gone";
    const src = datedSource(db, w.messageId);
    if (!src || src.spam || src.trash || src.draft || src.threadSpam) {
      db.run("DELETE FROM ai_dated_mail WHERE message_id = ?", w.messageId);
      return "gone";
    }
    // a merge since it was read: the mark stays, and the worker reads it again on its thread
    if (src.threadId !== w.threadId) return "moved";
    let open = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM dated_items INDEXED BY dated_open WHERE state = 'open'")!.n;
    for (const r of w.rows) {
      if (db.get("SELECT 1 FROM dated_items WHERE message_id = ? AND item = ?", w.messageId, r.item)) continue;
      if (open >= DATED_ACTIVE_MAX) {
        // the bound keeps the soonest: the furthest of them all isn't added
        const furthest = db.get<{ id: number; act_at: number }>("SELECT id, act_at FROM dated_items INDEXED BY dated_open WHERE state = 'open' ORDER BY act_at DESC, id DESC LIMIT 1");
        if (!furthest || furthest.act_at <= r.actAt) continue;
        db.run("DELETE FROM dated_items WHERE id = ?", furthest.id);
        open--;
      }
      open += Number(db.run(
        `INSERT OR IGNORE INTO dated_items (thread_id, message_id, item, kind, text, quote, sender_key, due_day, due_at, timed, dated, act_at, deferred_until, arrived_at, state, from_scan, revision, model, provider, prompt_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'open', ?, 0, ?, ?, ?, ?)`,
        src.threadId, w.messageId, r.item, r.kind, r.text, r.quote, src.senderKey, r.dueDay, r.dueAt, r.timed ? 1 : 0, r.dated ? 1 : 0, r.actAt, src.date, w.fromScan ? 1 : 0, w.model, w.provider, w.promptVersion, w.now,
      ).changes);
    }
    for (const s of w.settled) {
      db.run(
        "UPDATE dated_items SET state = 'settled', closed_reason = 'settled', closed_at = ?, revision = revision + 1 WHERE id = ? AND revision = ? AND state = 'open' AND (thread_id = ? OR sender_key = ?)",
        w.now, s.id, s.revision, src.threadId, src.senderKey,
      );
    }
    db.run("DELETE FROM ai_dated_mail WHERE message_id = ?", w.messageId);
    return "written";
  });
}

export const activeDated = (db: Db): DatedRow[] => db.all<Raw>("SELECT * FROM dated_items INDEXED BY dated_open WHERE state = 'open' ORDER BY act_at, id LIMIT ?", DATED_ACTIVE_MAX).map(toRow);
export const threadDated = (db: Db, threadId: number): DatedRow[] => db.all<Raw>("SELECT * FROM dated_items INDEXED BY dated_thread WHERE thread_id = ? AND state = 'open' ORDER BY act_at, id", threadId).map(toRow);
export function getDated(db: Db, id: number): DatedRow | null {
  const r = db.get<Raw>("SELECT * FROM dated_items WHERE id = ?", id);
  return r ? toRow(r) : null;
}

const snapshot = (r: Raw): DatedSnapshot => ({ id: r.id, revision: r.revision, state: r.state, deferredUntil: r.deferred_until, closedReason: r.closed_reason, closedAt: r.closed_at });

export function updateDated(db: Db, id: number, revision: number, patch: Partial<Pick<DatedRow, "state" | "deferredUntil" | "closedReason" | "closedAt">>): DatedSnapshot | null {
  return db.tx(() => {
    const r = db.get<Raw>("SELECT * FROM dated_items WHERE id = ? AND revision = ?", id, revision);
    if (!r) return null;
    db.run(
      "UPDATE dated_items SET state = ?, deferred_until = ?, closed_reason = ?, closed_at = ?, revision = revision + 1 WHERE id = ?",
      patch.state ?? r.state, patch.deferredUntil !== undefined ? patch.deferredUntil : r.deferred_until, patch.closedReason !== undefined ? patch.closedReason : r.closed_reason, patch.closedAt !== undefined ? patch.closedAt : r.closed_at, id,
    );
    return snapshot(r);
  });
}

export function restoreDated(db: Db, rows: readonly { snapshot: DatedSnapshot; expectRevision: number }[]): number {
  return db.tx(() => {
    let n = 0;
    for (const { snapshot: s, expectRevision } of rows) n += Number(db.run("UPDATE dated_items SET state = ?, deferred_until = ?, closed_reason = ?, closed_at = ?, revision = revision + 1 WHERE id = ? AND revision = ?", s.state, s.deferredUntil, s.closedReason, s.closedAt, s.id, expectRevision).changes);
    return n;
  });
}

export function pruneDated(db: Db, now: number): number {
  return Number(db.run("DELETE FROM dated_items WHERE state != 'open' AND coalesce(closed_at, created_at) < ?", now - DATED_CLOSED_KEEP_MS).changes);
}

export function clearDated(db: Db): void {
  db.tx(() => {
    db.run("DELETE FROM dated_items");
    db.run("DELETE FROM ai_dated_mail");
  });
}
