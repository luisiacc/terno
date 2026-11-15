import { addressKey, ANSWERED_KINDS, DATED_ACTIVE_MAX, DATED_CLOSED_KEEP_MS, senderIsPerson, THREAD_SCOPED_KINDS, waitingCutoff, type DatedRow } from "@terno/core";
import { DATED_MARK_MS, DATED_SCAN_MARK_MS, datedTab, NEW_MAIL_MS, readerIn, readNothingAsked, recipientList, type ClosedAt, type DatedFinish, type DatedFinishOutcome, type DatedMark, type DatedSnapshot, type DatedSource } from "@terno/store";
import { OWN_SENDER_SQL, RECEIVED_SQL } from "./ai-summaries";
import { ownAddresses } from "./facts";
import type { Db } from "./sqlite";

/** Plan 204 on SQLite (v56, v57 admits `ask`): see packages/store/src/dated.ts. */

/** `ANSWERED_KINDS` as SQL's list: what a send of yours answers */
const ANSWERED_SQL = `kind IN (${ANSWERED_KINDS.map((k) => `'${k}'`).join(", ")})`;
/** the sixth panel round: what the sender's mail may reach elsewhere (`THREAD_SCOPED_KINDS` only from their own conversation) */
const SENDER_REACHES_SQL = `kind NOT IN (${THREAD_SCOPED_KINDS.map((k) => `'${k}'`).join(", ")})`;

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
  db.run("UPDATE dated_nothing_asked SET thread_id = ? WHERE thread_id = ?", into, from);
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
  const m = db.get<{ id: number; thread_id: number; account_id: number; subject: string; date: number; from_name: string; from_email: string; is_bulk: number; list_id: string | null; gmail_labels: string | null; tab: number; category: number | null; is_sent: number; is_draft: number; is_spam: number; is_trash: number; own: number; thread_spam: number; body_state: DatedSource["bodyState"]; attachments_captured: number; to_json: string; cc_json: string }>(
    `SELECT m.id, m.thread_id, m.account_id, m.subject, m.date, m.from_name, m.from_email, m.is_bulk, m.list_id, m.gmail_labels, t.tab, m.category, m.is_sent, m.is_draft, m.is_spam, m.is_trash, m.body_state, m.attachments_captured, m.to_json, m.cc_json,
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
    person: senderIsPerson(m, { written: (key) => db.get<{ written: number }>("SELECT written FROM correspondents WHERE email = ?", key)?.written === 1 }),
    draft: m.is_draft === 1, sent: m.is_sent === 1, spam: m.is_spam === 1, trash: m.is_trash === 1, threadSpam: m.thread_spam === 1, own: m.own === 1,
    bodyState: m.body_state, bodyUnavailable: m.attachments_captured === 2 && m.body_state !== "full",
  };
}

export function openDatedFor(db: Db, o: { threadId: number; senderKey: string; before: number; limit: number }): DatedRow[] {
  return db.all<Raw>(
    `SELECT * FROM dated_items WHERE id IN (SELECT id FROM dated_items INDEXED BY dated_thread WHERE thread_id = ? AND state = 'open' UNION SELECT id FROM dated_items INDEXED BY dated_sender WHERE sender_key = ? AND state = 'open' AND ${SENDER_REACHES_SQL})
       AND arrived_at < ?
       AND NOT EXISTS (SELECT 1 FROM messages x INDEXED BY messages_thread WHERE x.thread_id = dated_items.thread_id AND x.is_spam = 1)
     ORDER BY arrived_at DESC, id DESC LIMIT ?`,
    o.threadId, o.senderKey, o.before, o.limit,
  ).map(toRow);
}

/**
 * Codex code review of the fixes: mail that is yours for certain, not only by its From (IMAP sets `is_sent` for any
 * message claiming your address, in any folder, and the store doesn't keep which folder is Sent): Gmail's SENT label. Never
 * a local copy not confirmed yet. Terno's own confirmed send is trusted where it's known (`settleAnswered`); a reply sent
 * from another IMAP client leaves the request for the user's Done (round 2: safe over convenient).
 */
const TRUSTED_SENT = "is_sent = 1 AND is_draft = 0 AND is_spam = 0 AND is_trash = 0 AND coalesce(provider_msg_id, 'local:') NOT LIKE 'local:%' AND gmail_labels LIKE '%\"SENT\"%'";

/** The newest message in this thread that's certainly yours, or null. */
const lastTrustedSend = (db: Db, threadId: number): number | null =>
  db.get<{ at: number | null }>(`SELECT max(date) AS at FROM messages INDEXED BY messages_thread WHERE thread_id = ? AND ${TRUSTED_SENT}`, threadId)?.at ?? null;

/** A reply of yours at `before` answers the thread's open requests from messages before it. */
export function settleAnswered(db: Db, threadId: number, before: number, now: number): number {
  return Number(db.run(
    `UPDATE dated_items SET state = 'settled', closed_reason = 'answered', closed_at = ?, revision = revision + 1 WHERE id IN (SELECT id FROM dated_items INDEXED BY dated_thread WHERE thread_id = ? AND state = 'open') AND ${ANSWERED_SQL} AND arrived_at < ?`,
    now, threadId, before,
  ).changes);
}

/**
 * After the panel (Codex review of the fixes, revision 1): a message you sent answers the requests made before it on its
 * thread, as plan 142's `closeWaitsBefore` ends waits; your promise, if it made one, is then the obligation. For the
 * threads an ingest or a flag/location reconciliation touched (a draft sent elsewhere is an update, not an insert), by
 * their newest trusted send. Only requests (`respond`, and an `ask`): a bill isn't paid by writing back.
 */
export function datedAnswered(db: Db, threadIds: Iterable<number>, now: number): number {
  let n = 0;
  for (const threadId of threadIds) {
    if (!db.get("SELECT 1 FROM dated_items INDEXED BY dated_thread WHERE thread_id = ? AND state = 'open' LIMIT 1", threadId)) continue;
    const at = lastTrustedSend(db, threadId);
    if (at !== null) n += settleAnswered(db, threadId, at, now);
  }
  return n;
}

export function finishDated(db: Db, w: DatedFinish): DatedFinishOutcome {
  return db.tx(() => {
    let repliedAt: number | undefined;
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
      // before the bound (Codex review, round 2): an answered request is stored closed, and never evicts open work
      const answered = ANSWERED_KINDS.includes(r.kind) && (repliedAt ??= lastTrustedSend(db, src.threadId) ?? -1) > src.date;
      if (!answered && open >= DATED_ACTIVE_MAX) {
        // the bound keeps the soonest: the furthest of them all isn't added
        const furthest = db.get<{ id: number; act_at: number }>("SELECT id, act_at FROM dated_items INDEXED BY dated_open WHERE state = 'open' ORDER BY act_at DESC, id DESC LIMIT 1");
        if (!furthest || furthest.act_at <= r.actAt) continue;
        db.run("DELETE FROM dated_items WHERE id = ?", furthest.id);
        open--;
      }
      if (answered) {
        db.run(
          `INSERT OR IGNORE INTO dated_items (thread_id, message_id, item, kind, text, quote, sender_key, due_day, due_at, timed, dated, act_at, deferred_until, arrived_at, state, closed_reason, closed_at, from_scan, revision, model, provider, prompt_version, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'settled', 'answered', ?, ?, 0, ?, ?, ?, ?)`,
          src.threadId, w.messageId, r.item, r.kind, r.text, r.quote, src.senderKey, r.dueDay, r.dueAt, r.timed ? 1 : 0, r.dated ? 1 : 0, r.actAt, src.date, w.now, w.fromScan ? 1 : 0, w.model, w.provider, w.promptVersion, w.now,
        );
        continue;
      }
      open += Number(db.run(
        `INSERT OR IGNORE INTO dated_items (thread_id, message_id, item, kind, text, quote, sender_key, due_day, due_at, timed, dated, act_at, deferred_until, arrived_at, state, from_scan, revision, model, provider, prompt_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'open', ?, 0, ?, ?, ?, ?)`,
        src.threadId, w.messageId, r.item, r.kind, r.text, r.quote, src.senderKey, r.dueDay, r.dueAt, r.timed ? 1 : 0, r.dated ? 1 : 0, r.actAt, src.date, w.fromScan ? 1 : 0, w.model, w.provider, w.promptVersion, w.now,
      ).changes);
    }
    for (const s of w.settled) {
      db.run(
        `UPDATE dated_items SET state = 'settled', closed_reason = 'settled', closed_at = ?, revision = revision + 1 WHERE id = ? AND revision = ? AND state = 'open' AND (thread_id = ? OR (sender_key = ? AND ${SENDER_REACHES_SQL}))`,
        w.now, s.id, s.revision, src.threadId, src.senderKey,
      );
    }
    for (const m of w.movedPromises ?? []) {
      db.run(
        "UPDATE followups SET due_at = ?, dated = 1, state = CASE WHEN ? > ? THEN 'open' ELSE state END, inbox_state = 'none', revision = revision + 1 WHERE id = ? AND revision = ? AND thread_id = ? AND kind = 'promise' AND state IN ('open','due')",
        m.dueAt, m.dueAt, w.now, m.id, m.revision, src.threadId,
      );
    }
    for (const m of w.moved ?? []) {
      db.run(
        // the revision stays: a Later just before stays undoable, and the move changes no choice of the user's (Codex review);
        // its new words, if it gives some, in the same write (the fifth panel round)
        `UPDATE dated_items SET due_day = ?, due_at = ?, timed = ?, dated = 1, act_at = ?, text = coalesce(?, text) WHERE id = ? AND state = 'open' AND (thread_id = ? OR (sender_key = ? AND ${SENDER_REACHES_SQL}))`,
        m.dueDay, m.dueAt, m.timed ? 1 : 0, m.actAt, m.text ?? null, m.id, src.threadId, src.senderKey,
      );
    }
    // plan 210 (iteration 2): read with nothing asked of the reader, which Needs you reads while it's their latest; a reading
    // again (the 14-day check) that finds a request takes it back
    if (readNothingAsked(w)) db.run("INSERT OR REPLACE INTO dated_nothing_asked (message_id, thread_id, arrived_at, prompt_version) VALUES (?, ?, ?, ?)", w.messageId, src.threadId, src.date, w.promptVersion);
    else db.run("DELETE FROM dated_nothing_asked WHERE message_id = ?", w.messageId);
    db.run("DELETE FROM ai_dated_mail WHERE message_id = ?", w.messageId);
    return "written";
  });
}

export const activeDated = (db: Db): DatedRow[] => db.all<Raw>("SELECT * FROM dated_items INDEXED BY dated_open WHERE state = 'open' ORDER BY act_at, id LIMIT ?", DATED_ACTIVE_MAX).map(toRow);
export const datedWritten = (db: Db, keys: readonly string[]): Set<string> =>
  new Set([...new Set(keys)].filter((key) => db.get<{ written: number }>("SELECT written FROM correspondents WHERE email = ?", key)?.written === 1));
export const threadDated = (db: Db, threadId: number): DatedRow[] => db.all<Raw>("SELECT * FROM dated_items INDEXED BY dated_thread WHERE thread_id = ? AND state = 'open' ORDER BY act_at, id", threadId).map(toRow);
/** Plan 210: closed rows by closing time (`dated_closed`), strictly after `after`, newest first. */
export function closedDatedPage(db: Db, o: { since: number; after: ClosedAt | null; limit: number }): DatedRow[] {
  const { after } = o;
  return db
    .all<Raw>(
      `SELECT * FROM dated_items INDEXED BY dated_closed WHERE state <> 'open' AND closed_at >= ?${after ? " AND (closed_at, id) < (?, ?)" : ""} ORDER BY closed_at DESC, id DESC LIMIT ?`,
      o.since,
      ...(after ? [after.at, after.id] : []),
      o.limit,
    )
    .map(toRow);
}

/** Plan 210: each thread's newest closing since `since`: one seek of `dated_closed_thread` each (never a thread's every row). */
export function newestClosedDated(db: Db, threadIds: readonly number[], since: number): Map<number, ClosedAt> {
  return newestEach(db, "SELECT closed_at AS at, id FROM dated_items INDEXED BY dated_closed_thread WHERE thread_id = ? AND state <> 'open' AND closed_at >= ? ORDER BY closed_at DESC, id DESC LIMIT 1", threadIds, since);
}

/** A newest-closing query, one row a thread. */
export function newestEach(db: Db, sql: string, threadIds: readonly number[], since: number): Map<number, ClosedAt> {
  const out = new Map<number, ClosedAt>();
  for (const id of new Set(threadIds)) {
    const top = db.get<ClosedAt>(sql, id, since);
    if (top) out.set(id, top);
  }
  return out;
}

export function getDated(db: Db, id: number): DatedRow | null {
  const r = db.get<Raw>("SELECT * FROM dated_items WHERE id = ?", id);
  return r ? toRow(r) : null;
}

const snapshot = (r: Raw): DatedSnapshot => ({ id: r.id, revision: r.revision, state: r.state, deferredUntil: r.deferred_until, closedReason: r.closed_reason, closedAt: r.closed_at });

export function updateDated(db: Db, id: number, revision: number, patch: Partial<Pick<DatedRow, "state" | "deferredUntil" | "closedReason" | "closedAt">>, schedule?: { dueDay: string; dueAt: number }): DatedSnapshot | null {
  return db.tx(() => {
    const r = db.get<Raw>("SELECT * FROM dated_items WHERE id = ? AND revision = ?", id, revision);
    if (!r || (schedule && (r.due_day !== schedule.dueDay || r.due_at !== schedule.dueAt))) return null;
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
  return db.tx(() =>
    Number(db.run("DELETE FROM dated_items WHERE state != 'open' AND coalesce(closed_at, created_at) < ?", now - DATED_CLOSED_KEEP_MS).changes) +
    // past the waiting window, no conversation it's the latest of is waiting
    Number(db.run("DELETE FROM dated_nothing_asked WHERE arrived_at < ?", waitingCutoff(now)).changes),
  );
}

export function clearDated(db: Db): void {
  db.tx(() => {
    db.run("DELETE FROM dated_items");
    db.run("DELETE FROM ai_dated_mail");
    db.run("DELETE FROM dated_nothing_asked");
  });
}
