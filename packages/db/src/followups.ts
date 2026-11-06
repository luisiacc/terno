import { addressKey, type FollowupRow } from "@terno/core";
import { FOLLOWUP_CLOSED_KEEP_MS, FOLLOWUPS_ACTIVE_MAX, recipientList, SCAN_MARK_MS, SENT_MARK_MS, type FollowupFinish, type FollowupFinishOutcome, type FollowupSnapshot, type FollowupSource, type SentMark } from "@terno/store";
import { ownAddresses } from "./facts";
import type { Db } from "./sqlite";

/** Plan 142 on SQLite (v52): see packages/store/src/followups.ts. */

interface Raw {
  id: number; thread_id: number; message_id: number; rfc_message_id: string | null; item: number; kind: FollowupRow["kind"]; text: string; quote: string | null; person_name: string | null; person_email: string | null;
  sent_at: number; due_at: number; dated: number; state: FollowupRow["state"]; inbox_state: FollowupRow["inboxState"]; closed_reason: string | null; closed_at: number | null; notified_at: number | null; from_scan: number; revision: number; model: string | null; provider: string | null; created_at: number;
}
const toRow = (r: Raw): FollowupRow => ({ id: r.id, threadId: r.thread_id, messageId: r.message_id, rfcMessageId: r.rfc_message_id, item: r.item, kind: r.kind, text: r.text, quote: r.quote, personName: r.person_name, personEmail: r.person_email, sentAt: r.sent_at, dueAt: r.due_at, dated: r.dated === 1, state: r.state, inboxState: r.inbox_state, closedReason: r.closed_reason, closedAt: r.closed_at, notifiedAt: r.notified_at, fromScan: r.from_scan === 1, revision: r.revision, model: r.model, provider: r.provider, createdAt: r.created_at });

/** Yours and for someone else: mail only to your own addresses says nothing to anyone. */
function toSomeoneElse(db: Db, to: string, cc: string): boolean {
  const own = ownAddresses(db);
  return [...recipientList(to).addresses, ...recipientList(cc).addresses].some((a) => !own.has(addressKey(a)));
}

function markSent(db: Db, messageId: number, now: number, source: "live" | "scan", since?: number | null): void {
  const m = db.get<{ thread_id: number; date: number; to_json: string; cc_json: string; is_sent: number; is_draft: number }>("SELECT thread_id, date, to_json, cc_json, is_sent, is_draft FROM messages WHERE id = ?", messageId);
  if (!m || m.is_sent !== 1 || m.is_draft === 1 || (since != null && m.date < since) || !toSomeoneElse(db, m.to_json, m.cc_json)) return;
  db.run("INSERT OR IGNORE INTO ai_sent_mail (message_id, thread_id, sent_at, queued_at, source) VALUES (?, ?, ?, ?, ?)", messageId, m.thread_id, m.date, now, source);
}

/** Your own message reached the server: it ends the waits before it on this thread, and the worker decides afresh (revision 3). */
function closeWaitsBefore(db: Db, messageId: number, now: number): void {
  const m = db.get<{ thread_id: number; date: number }>("SELECT thread_id, date FROM messages WHERE id = ?", messageId);
  if (!m) return;
  db.run("UPDATE followups SET state = 'done', closed_reason = 'superseded', closed_at = ?, inbox_state = 'none', revision = revision + 1 WHERE thread_id = ? AND kind = 'awaiting' AND state IN ('open','due') AND sent_at < ?", now, m.thread_id, m.date);
}

/** In the commit that records a send as done. `wanted`: the feature is on for this account. */
export function followupSendConfirmed(db: Db, messageId: number, now: number, wanted: boolean, since?: number | null): void {
  closeWaitsBefore(db, messageId, now);
  // what you sent before you turned it on is read only with a yes
  if (wanted) markSent(db, messageId, now, "live", since);
}

/** Ingest's part (in its transaction): live mail you sent from elsewhere, the same way. */
export function followupLiveSent(db: Db, messageIds: readonly number[], now: number, wanted: boolean, since?: number | null): void {
  if (!messageIds.length) return;
  for (const r of db.all<{ id: number }>("SELECT id FROM messages WHERE id IN (SELECT value FROM json_each(?)) AND is_sent = 1 AND is_draft = 0 AND is_spam = 0 AND is_trash = 0 AND date >= ?", JSON.stringify(messageIds), now - SENT_MARK_MS)) {
    closeWaitsBefore(db, r.id, now);
    if (wanted) markSent(db, r.id, now, "live", since);
  }
}

export function mergeFollowups(db: Db, into: number, from: number): void {
  db.run("UPDATE ai_sent_mail SET thread_id = ? WHERE thread_id = ?", into, from);
  db.run("UPDATE OR IGNORE followups SET thread_id = ?, revision = revision + 1 WHERE thread_id = ?", into, from);
}

const toMark = (r: { message_id: number; thread_id: number; sent_at: number; queued_at: number; source: "live" | "scan" }): SentMark => ({ messageId: r.message_id, threadId: r.thread_id, sentAt: r.sent_at, queuedAt: r.queued_at, source: r.source });

export function sentMarkPage(db: Db, after: { sentAt: number; messageId: number } | null, limit: number): SentMark[] {
  const from = after ? " WHERE sent_at > ? OR (sent_at = ? AND message_id > ?)" : "";
  return db.all<Parameters<typeof toMark>[0]>(`SELECT * FROM ai_sent_mail${from} ORDER BY sent_at, message_id LIMIT ?`, ...(after ? [after.sentAt, after.sentAt, after.messageId] : []), limit).map(toMark);
}

export const sentMarkCount = (db: Db): number => db.get<{ n: number }>("SELECT COUNT(*) AS n FROM ai_sent_mail")!.n;

export function queueScan(db: Db, messageIds: readonly number[], now: number): number {
  return db.tx(() => {
    let n = 0;
    for (const id of messageIds) {
      const before = db.get("SELECT 1 FROM ai_sent_mail WHERE message_id = ?", id);
      // written here and not yet confirmed: it may never go
      if (before || db.get("SELECT 1 FROM messages WHERE id = ? AND coalesce(provider_msg_id, 'local:') LIKE 'local:%'", id)) continue;
      markSent(db, id, now, "scan");
      if (db.get("SELECT 1 FROM ai_sent_mail WHERE message_id = ?", id)) n++;
    }
    return n;
  });
}

export function pruneSentMarks(db: Db, now: number): number {
  return Number(db.run("DELETE FROM ai_sent_mail WHERE (source = 'live' AND queued_at < ?) OR (source = 'scan' AND queued_at < ?)", now - SENT_MARK_MS, now - SCAN_MARK_MS).changes);
}

export function followupScanCandidates(db: Db, since: number, limit: number): number[] {
  return db.all<{ id: number }>(
    `SELECT m.id FROM messages m WHERE m.is_sent = 1 AND m.is_draft = 0 AND m.is_spam = 0 AND m.is_trash = 0 AND m.date >= ? AND m.list_id IS NULL AND m.is_bulk = 0 AND coalesce(m.provider_msg_id, 'local:') NOT LIKE 'local:%'
       AND m.id NOT IN (SELECT message_id FROM followups) ORDER BY m.date DESC, m.id DESC LIMIT ?`,
    since,
    limit,
  ).map((r) => r.id);
}

export function followupSource(db: Db, messageId: number): FollowupSource | null {
  const m = db.get<{ id: number; thread_id: number; account_id: number; subject: string; rfc_message_id: string | null; in_reply_to: string | null; date: number; is_bulk: number; list_id: string | null; is_draft: number; is_spam: number; is_trash: number; to_json: string; cc_json: string; body_state: FollowupSource["bodyState"]; attachments_captured: number }>(
    "SELECT id, thread_id, account_id, subject, rfc_message_id, in_reply_to, date, is_bulk, list_id, is_draft, is_spam, is_trash, to_json, cc_json, body_state, attachments_captured FROM messages WHERE id = ?",
    messageId,
  );
  if (!m) return null;
  const own = ownAddresses(db);
  // what it answers: the message it says it answers; only with none, the newest before it from someone else
  const target = m.in_reply_to ? db.get<{ id: number; from_email: string; body_state: FollowupSource["bodyState"]; attachments_captured: number }>("SELECT id, from_email, body_state, attachments_captured FROM messages WHERE account_id = ? AND rfc_message_id = ? AND is_draft = 0 AND is_spam = 0 AND is_trash = 0 AND id != ? LIMIT 1", m.account_id, m.in_reply_to, m.id) : undefined;
  // it names one we can't use (gone, or your own): nothing, rather than a message it isn't answering
  const before = m.in_reply_to ? (target && !own.has(addressKey(target.from_email)) ? target : undefined) : db.all<{ id: number; from_email: string; body_state: FollowupSource["bodyState"]; attachments_captured: number }>(
    "SELECT id, from_email, body_state, attachments_captured FROM messages INDEXED BY messages_thread WHERE thread_id = ? AND (date < ? OR (date = ? AND id < ?)) AND is_draft = 0 AND is_spam = 0 AND is_trash = 0 AND is_sent = 0 ORDER BY date DESC, id DESC LIMIT 20",
    m.thread_id, m.date, m.date, m.id,
  ).find((r) => !own.has(addressKey(r.from_email)));
  const people = (json: string) => {
    const list = recipientList(json);
    return list.addresses.map((email) => ({ name: list.names[email] ?? "", email }));
  };
  return {
    id: m.id, threadId: m.thread_id, accountId: m.account_id, subject: m.subject, rfcMessageId: m.rfc_message_id, date: m.date, bulk: m.is_bulk === 1 || m.list_id !== null, draft: m.is_draft === 1, spam: m.is_spam === 1, trash: m.is_trash === 1,
    to: people(m.to_json), cc: people(m.cc_json),
    attachments: db.all<{ filename: string }>("SELECT filename FROM attachments WHERE message_id = ? ORDER BY id LIMIT 10", messageId).map((r) => r.filename),
    bodyState: m.body_state, bodyUnavailable: m.attachments_captured === 2 && m.body_state !== "full",
    answering: before ? { id: before.id, bodyState: before.body_state, bodyUnavailable: before.attachments_captured === 2 && before.body_state !== "full" } : null,
  };
}

/** Someone other than you answered since: on the thread, or naming the source in its references (Gmail's other threads). */
function replied(db: Db, own: ReadonlySet<string>, row: { accountId: number; threadId: number; sentAt: number; rfcMessageId: string | null }): boolean {
  const onThread = db.all<{ from_email: string }>("SELECT from_email FROM messages INDEXED BY messages_thread WHERE thread_id = ? AND date > ? AND is_sent = 0 AND is_draft = 0 AND is_spam = 0 AND is_trash = 0", row.threadId, row.sentAt);
  if (onThread.some((m) => !own.has(addressKey(m.from_email)))) return true;
  if (!row.rfcMessageId) return false;
  const named = db.all<{ from_email: string }>(
    "SELECT m.from_email FROM message_refs r JOIN messages m ON m.id = r.message_id WHERE r.account_id = ? AND r.ref = ? AND m.date > ? AND m.is_sent = 0 AND m.is_draft = 0 AND m.is_spam = 0 AND m.is_trash = 0",
    row.accountId, row.rfcMessageId, row.sentAt,
  );
  return named.some((m) => !own.has(addressKey(m.from_email)));
}

export function finishFollowups(db: Db, w: FollowupFinish): FollowupFinishOutcome {
  return db.tx(() => {
    const mark = db.get("SELECT 1 FROM ai_sent_mail WHERE message_id = ?", w.messageId);
    const src = followupSource(db, w.messageId);
    if (!mark) return "gone";
    if (!src || src.trash || src.spam || src.draft) {
      db.run("DELETE FROM ai_sent_mail WHERE message_id = ?", w.messageId);
      return "gone";
    }
    const own = ownAddresses(db);
    let active = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM followups WHERE state IN ('open','due')")!.n;
    const add = (r: FollowupFinish["rows"][number]) => db.run(
      `INSERT OR IGNORE INTO followups (thread_id, message_id, rfc_message_id, item, kind, text, quote, person_name, person_email, sent_at, due_at, dated, state, inbox_state, from_scan, model, provider, prompt_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 'none', ?, ?, ?, ?, ?)`,
      src.threadId, w.messageId, src.rfcMessageId, r.item, r.kind, r.text, r.quote, r.personName, r.personEmail, src.date, r.dueAt, r.dated ? 1 : 0, w.fromScan ? 1 : 0, w.model, w.provider, w.promptVersion, w.now,
    ).changes;
    const later = db.get("SELECT 1 FROM messages INDEXED BY messages_thread WHERE thread_id = ? AND date > ? AND is_sent = 1 AND is_draft = 0 AND is_trash = 0 AND is_spam = 0 AND provider_msg_id NOT LIKE 'local:%' LIMIT 1", src.threadId, src.date);
    for (const r of w.rows) {
      if (r.kind === "awaiting" && (later || replied(db, own, { accountId: src.accountId, threadId: src.threadId, sentAt: src.date, rfcMessageId: src.rfcMessageId }))) continue;
      if (active >= FOLLOWUPS_ACTIVE_MAX) {
        if (r.kind === "awaiting") continue;
        // a promise takes the place of the oldest wait
        const oldest = db.get<{ id: number }>("SELECT id FROM followups WHERE kind = 'awaiting' AND state IN ('open','due') ORDER BY sent_at, id LIMIT 1");
        if (!oldest) continue;
        db.run("DELETE FROM followups WHERE id = ?", oldest.id);
        active--;
      }
      active += Number(add(r));
    }
    for (const k of w.kept) db.run("UPDATE followups SET state = 'done', closed_reason = 'kept', closed_at = ?, inbox_state = 'none', revision = revision + 1 WHERE id = ? AND revision = ? AND thread_id = ? AND kind = 'promise' AND state IN ('open','due')", w.now, k.id, k.revision, src.threadId);
    db.run("DELETE FROM ai_sent_mail WHERE message_id = ?", w.messageId);
    return "written";
  });
}

export const activeFollowups = (db: Db): FollowupRow[] => db.all<Raw>("SELECT * FROM followups INDEXED BY followups_active WHERE state IN ('open','due') ORDER BY due_at, id LIMIT ?", FOLLOWUPS_ACTIVE_MAX).map(toRow);
export const threadFollowups = (db: Db, threadId: number): FollowupRow[] => db.all<Raw>("SELECT * FROM followups WHERE thread_id = ? AND state IN ('open','due') ORDER BY due_at, id", threadId).map(toRow);
export function getFollowup(db: Db, id: number): FollowupRow | null {
  const r = db.get<Raw>("SELECT * FROM followups WHERE id = ?", id);
  return r ? toRow(r) : null;
}
export const nextFollowupDue = (db: Db): number | null => db.get<{ at: number | null }>("SELECT min(due_at) AS at FROM followups WHERE state = 'open'")?.at ?? null;

export function makeFollowupsDue(db: Db, now: number): FollowupRow[] {
  return db.tx(() => {
    const rows = db.all<Raw>("SELECT * FROM followups WHERE state = 'open' AND due_at <= ?", now);
    for (const r of rows) db.run("UPDATE followups SET state = 'due', inbox_state = ?, revision = revision + 1 WHERE id = ?", r.from_scan ? "none" : "onTop", r.id);
    return rows.map((r) => ({ ...toRow(r), state: "due" as const, inboxState: r.from_scan ? ("none" as const) : ("onTop" as const), revision: r.revision + 1 }));
  });
}

export function claimFollowupNotice(db: Db, ids: readonly number[], now: number): number[] {
  return db.tx(() => ids.filter((id) => db.run("UPDATE followups SET notified_at = ? WHERE id = ? AND notified_at IS NULL", now, id).changes > 0));
}

export function closeAnsweredFollowups(db: Db, ids: readonly number[], now: number): number[] {
  return db.tx(() => {
    const own = ownAddresses(db);
    const closed: number[] = [];
    for (const id of ids) {
      const r = db.get<Raw & { account_id: number }>("SELECT f.*, t.account_id FROM followups f JOIN threads t ON t.id = f.thread_id WHERE f.id = ? AND f.kind = 'awaiting' AND f.state IN ('open','due')", id);
      if (!r || !replied(db, own, { accountId: r.account_id, threadId: r.thread_id, sentAt: r.sent_at, rfcMessageId: r.rfc_message_id })) continue;
      db.run("UPDATE followups SET state = 'done', closed_reason = 'replied', closed_at = ?, inbox_state = 'none', revision = revision + 1 WHERE id = ?", now, id);
      closed.push(id);
    }
    return closed;
  });
}

const snapshot = (r: Raw): FollowupSnapshot => ({ id: r.id, revision: r.revision, state: r.state, dueAt: r.due_at, inboxState: r.inbox_state, closedReason: r.closed_reason, closedAt: r.closed_at });

export function endFollowupTop(db: Db, threadIds: readonly number[]): FollowupSnapshot[] {
  if (!threadIds.length) return [];
  return db.tx(() => {
    const rows = db.all<Raw>("SELECT * FROM followups WHERE inbox_state = 'onTop' AND thread_id IN (SELECT value FROM json_each(?))", JSON.stringify(threadIds));
    for (const r of rows) db.run("UPDATE followups SET inbox_state = 'seen', revision = revision + 1 WHERE id = ?", r.id);
    return rows.map(snapshot);
  });
}

export function updateFollowup(db: Db, id: number, revision: number, patch: Partial<Pick<FollowupRow, "state" | "dueAt" | "inboxState" | "closedReason" | "closedAt">>): FollowupSnapshot | null {
  return db.tx(() => {
    const r = db.get<Raw>("SELECT * FROM followups WHERE id = ? AND revision = ?", id, revision);
    if (!r) return null;
    db.run(
      "UPDATE followups SET state = ?, due_at = ?, inbox_state = ?, closed_reason = ?, closed_at = ?, revision = revision + 1 WHERE id = ?",
      patch.state ?? r.state, patch.dueAt ?? r.due_at, patch.inboxState ?? r.inbox_state, patch.closedReason !== undefined ? patch.closedReason : r.closed_reason, patch.closedAt !== undefined ? patch.closedAt : r.closed_at, id,
    );
    return snapshot(r);
  });
}

export function restoreFollowups(db: Db, rows: readonly { snapshot: FollowupSnapshot; expectRevision: number }[]): number {
  return db.tx(() => {
    let n = 0;
    for (const { snapshot: s, expectRevision } of rows) n += Number(db.run("UPDATE followups SET state = ?, due_at = ?, inbox_state = ?, closed_reason = ?, closed_at = ?, revision = revision + 1 WHERE id = ? AND revision = ?", s.state, s.dueAt, s.inboxState, s.closedReason, s.closedAt, s.id, expectRevision).changes);
    return n;
  });
}

export function pruneFollowups(db: Db, now: number): number {
  return Number(db.run("DELETE FROM followups WHERE state IN ('done','dismissed') AND closed_at < ?", now - FOLLOWUP_CLOSED_KEEP_MS).changes);
}

export function clearFollowups(db: Db): void {
  db.tx(() => {
    db.run("DELETE FROM followups");
    db.run("DELETE FROM ai_sent_mail");
  });
}

