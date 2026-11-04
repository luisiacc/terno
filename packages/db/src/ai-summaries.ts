import { NEW_MAIL_MS, sourceStamp, summaryBlocked, type AiSummaryRow, type AiSummaryState, type NewMailMark, type NewMailWant, type NewMailWants, type SummarySources, type SummaryWrite, type SummaryWriteOutcome } from "@terno/store";
import type { Db } from "./sqlite";

/** Plan 131 revision 5 and plan 132 on SQLite (v48): see packages/store/src/ai-summaries.ts. */

const FLAG: Record<NewMailWant, "wants_summary" | "wants_category"> = { summary: "wants_summary", category: "wants_category" };

interface Raw {
  thread_id: number;
  state: AiSummaryState;
  through_message_id: number;
  source_stamp: string | null;
  content_hash: string | null;
  prompt_version: number | null;
  language: string | null;
  model: string | null;
  provider: string | null;
  endpoint: string | null;
  body_json: string | null;
  attempts: number;
  error_kind: string | null;
  created_at: number;
  generated_at: number | null;
  failed_at: number | null;
}

const toRow = (r: Raw): AiSummaryRow => ({
  threadId: r.thread_id,
  state: r.state,
  throughMessageId: r.through_message_id,
  sourceStamp: r.source_stamp,
  contentHash: r.content_hash,
  promptVersion: r.prompt_version,
  language: r.language,
  model: r.model,
  provider: r.provider,
  endpoint: r.endpoint,
  bodyJson: r.body_json,
  attempts: r.attempts,
  errorKind: r.error_kind,
  createdAt: r.created_at,
  generatedAt: r.generated_at,
  failedAt: r.failed_at,
});

/** Ingest's part (in its transaction): live mail it inserted, marked; a summary queued for its thread, when they want one. */
export function markNewMail(db: Db, messageIds: readonly number[], now: number, wants: NewMailWants): void {
  if (!messageIds.length || (!wants.summary && !wants.category)) return;
  const ids = JSON.stringify(messageIds);
  db.run(
    `INSERT OR IGNORE INTO ai_new_mail (message_id, thread_id, arrived_at, wants_summary, wants_category)
     SELECT m.id, m.thread_id, ?, ?, ? FROM messages m
     WHERE m.id IN (SELECT value FROM json_each(?)) AND m.is_sent = 0 AND m.is_draft = 0 AND m.is_spam = 0 AND m.is_trash = 0 AND m.date >= ?
       AND lower(m.from_email) NOT IN (SELECT lower(email) FROM accounts)
       AND NOT EXISTS (SELECT 1 FROM correspondents c WHERE c.email = lower(m.from_email) AND c.own = 1)`,
    now,
    wants.summary ? 1 : 0,
    wants.category ? 1 : 0,
    ids,
    now - NEW_MAIL_MS,
  );
  if (!wants.summary) return;
  // a newer message moves it forward and queues it again: the old result stays out of the UI (its stamp) until replaced
  db.run(
    `INSERT INTO ai_summaries (thread_id, state, through_message_id, created_at)
     SELECT n.thread_id, 'pending', max(n.message_id), ? FROM ai_new_mail n
     WHERE n.message_id IN (SELECT value FROM json_each(?)) AND n.wants_summary = 1 GROUP BY n.thread_id
     ON CONFLICT (thread_id) DO UPDATE SET
       created_at = CASE WHEN state = 'pending' THEN created_at ELSE excluded.created_at END,
       state = 'pending',
       through_message_id = max(through_message_id, excluded.through_message_id),
       attempts = 0,
       error_kind = NULL`,
    now,
    ids,
  );
}

/**
 * A merge (before the vanished thread goes): the marks follow their messages, and the survivor's summary no longer
 * describes it. It's queued again only if a message there still has a mark; otherwise the stale result goes.
 */
export function mergeSummaries(db: Db, into: number, from: number): void {
  db.run("UPDATE ai_new_mail SET thread_id = ? WHERE thread_id = ?", into, from);
  const marked = db.get<{ through: number | null; at: number | null }>("SELECT max(message_id) AS through, min(arrived_at) AS at FROM ai_new_mail WHERE thread_id = ? AND wants_summary = 1", into)!;
  db.run("DELETE FROM ai_summaries WHERE thread_id = ?", from);
  if (marked.through === null) {
    db.run("DELETE FROM ai_summaries WHERE thread_id = ?", into);
    return;
  }
  db.run(
    `INSERT OR REPLACE INTO ai_summaries (thread_id, state, through_message_id, created_at) VALUES (?, 'pending', ?, ?)`,
    into,
    marked.through,
    marked.at!,
  );
}

export function newMailPage(db: Db, want: NewMailWant, after: { arrivedAt: number; messageId: number } | null, limit: number): NewMailMark[] {
  const from = after ? " AND (arrived_at > ? OR (arrived_at = ? AND message_id > ?))" : "";
  return db
    .all<{ message_id: number; thread_id: number; arrived_at: number; wants_summary: number; wants_category: number }>(
      `SELECT message_id, thread_id, arrived_at, wants_summary, wants_category FROM ai_new_mail WHERE ${FLAG[want]} = 1${from} ORDER BY arrived_at, message_id LIMIT ?`,
      ...(after ? [after.arrivedAt, after.arrivedAt, after.messageId] : []),
      limit,
    )
    .map((r) => ({ messageId: r.message_id, threadId: r.thread_id, arrivedAt: r.arrived_at, wantsSummary: r.wants_summary === 1, wantsCategory: r.wants_category === 1 }));
}

export function consumeNewMail(db: Db, want: NewMailWant, messageIds: readonly number[]): void {
  if (!messageIds.length) return;
  const ids = JSON.stringify(messageIds);
  db.tx(() => {
    db.run(`UPDATE ai_new_mail SET ${FLAG[want]} = 0 WHERE message_id IN (SELECT value FROM json_each(?))`, ids);
    db.run("DELETE FROM ai_new_mail WHERE message_id IN (SELECT value FROM json_each(?)) AND wants_summary = 0 AND wants_category = 0", ids);
  });
}

export function clearNewMail(db: Db, want: NewMailWant): void {
  db.tx(() => {
    db.run(`UPDATE ai_new_mail SET ${FLAG[want]} = 0 WHERE ${FLAG[want]} = 1`);
    db.run("DELETE FROM ai_new_mail WHERE wants_summary = 0 AND wants_category = 0");
  });
}

export function pruneNewMail(db: Db, now: number): number {
  return Number(db.run("DELETE FROM ai_new_mail WHERE arrived_at < ?", now - NEW_MAIL_MS).changes);
}

export function getSummary(db: Db, threadId: number): AiSummaryRow | null {
  const r = db.get<Raw>("SELECT * FROM ai_summaries WHERE thread_id = ?", threadId);
  return r ? toRow(r) : null;
}

export function summarySources(db: Db, threadId: number): SummarySources | null {
  const thread = db.get<{ account_id: number; subject: string; in_inbox: number; in_spam: number; in_trash: number; tab: number | null }>("SELECT account_id, subject, in_inbox, in_spam, in_trash, tab FROM threads WHERE id = ?", threadId);
  if (!thread) return null;
  const rows = db.all<{ id: number; from_name: string; from_email: string; date: number; snippet: string; subject: string; is_sent: number; is_draft: number; is_trash: number; is_spam: number; body_state: "none" | "partial" | "full"; body_tail_norm: string | null; attachments_captured: number; capture_id: string | null; marked_at: number | null }>(
    `SELECT m.id, m.from_name, m.from_email, m.date, m.snippet, m.subject, m.is_sent, m.is_draft, m.is_trash, m.is_spam, m.body_state, m.body_tail_norm, m.attachments_captured, h.capture_id,
            (SELECT n.arrived_at FROM ai_new_mail n WHERE n.message_id = m.id AND n.wants_summary = 1) AS marked_at
     FROM messages m LEFT JOIN body_heads h ON h.message_id = m.id WHERE m.thread_id = ? ORDER BY m.date, m.id`,
    threadId,
  );
  const own = new Set(db.all<{ email: string }>("SELECT lower(email) AS email FROM accounts").map((r) => r.email));
  const messages = rows.filter((r) => r.is_draft === 0);
  return {
    threadId,
    accountId: thread.account_id,
    subject: thread.subject,
    inInbox: thread.in_inbox === 1,
    inSpam: thread.in_spam === 1,
    inTrash: thread.in_trash === 1,
    hasSpam: rows.some((r) => r.is_spam === 1),
    tab: thread.tab ?? 0,
    stamp: sourceStamp(messages.filter((r) => r.is_trash === 0).map((r) => ({ id: r.id, bodyState: r.body_state, capture: r.capture_id, tail: r.body_tail_norm }))),
    messages: messages.map((r) => ({
      id: r.id,
      fromName: r.from_name,
      fromEmail: r.from_email,
      date: r.date,
      snippet: r.snippet,
      subject: r.subject,
      own: r.is_sent === 1 || own.has(r.from_email.toLowerCase()),
      trash: r.is_trash === 1,
      spam: r.is_spam === 1,
      bodyState: r.body_state,
      bodyUnavailable: r.attachments_captured === 2 && r.body_state !== "full",
      markedAt: r.marked_at,
    })),
  };
}

export function pendingSummaries(db: Db, after: { createdAt: number; threadId: number } | null, limit: number): AiSummaryRow[] {
  const from = after ? " AND (created_at > ? OR (created_at = ? AND thread_id > ?))" : "";
  return db.all<Raw>(`SELECT * FROM ai_summaries WHERE state = 'pending'${from} ORDER BY created_at, thread_id LIMIT ?`, ...(after ? [after.createdAt, after.createdAt, after.threadId] : []), limit).map(toRow);
}

export const pendingSummaryCount = (db: Db): number => db.get<{ n: number }>("SELECT COUNT(*) AS n FROM ai_summaries WHERE state = 'pending'")!.n;

export function lastSummaryFailure(db: Db): { kind: string; at: number } | null {
  const r = db.get<{ error_kind: string; failed_at: number }>("SELECT error_kind, failed_at FROM ai_summaries WHERE state = 'failed' AND error_kind IS NOT NULL ORDER BY failed_at DESC LIMIT 1");
  return r ? { kind: r.error_kind, at: r.failed_at } : null;
}

export function attemptSummary(db: Db, threadId: number, kind: string, max: number, now: number): AiSummaryState | null {
  return db.tx(() => {
    const r = db.get<{ state: AiSummaryState; attempts: number }>("SELECT state, attempts FROM ai_summaries WHERE thread_id = ?", threadId);
    if (!r) return null;
    if (r.state !== "pending") return r.state;
    const attempts = r.attempts + 1;
    const state = attempts >= max ? "failed" : "pending";
    db.run("UPDATE ai_summaries SET attempts = ?, state = ?, error_kind = ?, failed_at = ? WHERE thread_id = ?", attempts, state, kind, now, threadId);
    return state;
  });
}

export function failSummary(db: Db, threadId: number, kind: string, now: number): void {
  db.run("UPDATE ai_summaries SET state = 'failed', error_kind = ?, failed_at = ? WHERE thread_id = ? AND state = 'pending'", kind, now, threadId);
}

function consumeThread(db: Db, threadId: number): void {
  db.run("UPDATE ai_new_mail SET wants_summary = 0 WHERE thread_id = ? AND wants_summary = 1", threadId);
  db.run("DELETE FROM ai_new_mail WHERE thread_id = ? AND wants_summary = 0 AND wants_category = 0", threadId);
}

export function dropSummary(db: Db, threadId: number, expectThrough: number): void {
  db.tx(() => {
    const r = db.get<{ through_message_id: number; body_json: string | null }>("SELECT through_message_id, body_json FROM ai_summaries WHERE thread_id = ? AND state = 'pending'", threadId);
    if (r?.through_message_id !== expectThrough) return;
    if (r.body_json === null) db.run("DELETE FROM ai_summaries WHERE thread_id = ?", threadId);
    else db.run("UPDATE ai_summaries SET state = 'ready' WHERE thread_id = ?", threadId);
    consumeThread(db, threadId);
  });
}

export function finishSummary(db: Db, w: SummaryWrite): SummaryWriteOutcome {
  return db.tx(() => {
    const sources = summarySources(db, w.threadId);
    if (!sources) return "gone";
    if (summaryBlocked(sources)) return "blocked";
    if (sources.stamp !== w.stamp) return "moved";
    const row = db.get<Raw>("SELECT * FROM ai_summaries WHERE thread_id = ?", w.threadId);
    if (row && row.through_message_id !== w.expectThrough) return "moved";
    const through = Math.max(row?.through_message_id ?? 0, ...sources.messages.filter((m) => !m.trash).map((m) => m.id));
    if (w.reuse) {
      if (!row?.body_json) return "moved";
      db.run("UPDATE ai_summaries SET state = 'ready', through_message_id = ?, source_stamp = ?, attempts = 0, error_kind = NULL WHERE thread_id = ?", through, w.stamp, w.threadId);
    } else {
      db.run(
        `INSERT OR REPLACE INTO ai_summaries (thread_id, state, through_message_id, source_stamp, content_hash, prompt_version, language, model, provider, endpoint, body_json, attempts, created_at, generated_at)
         VALUES (?, 'ready', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        w.threadId, through, w.stamp, w.contentHash, w.promptVersion, w.language, w.model, w.provider, w.endpoint, w.bodyJson, row?.created_at ?? w.now, w.now,
      );
    }
    consumeThread(db, w.threadId);
    return "written";
  });
}

export function dropPendingSummaries(db: Db): void {
  db.tx(() => {
    db.run("DELETE FROM ai_summaries WHERE state = 'pending' AND body_json IS NULL");
    db.run("UPDATE ai_summaries SET state = 'ready' WHERE state = 'pending'");
    clearNewMail(db, "summary");
  });
}

export function clearSummaries(db: Db): void {
  db.tx(() => {
    db.run("DELETE FROM ai_summaries");
    clearNewMail(db, "summary");
  });
}

export function pruneSummaries(db: Db, now: number, maxRows: number): number {
  return db.tx(() => {
    const floor = now - NEW_MAIL_MS;
    let gone = Number(db.run("DELETE FROM ai_summaries WHERE state = 'pending' AND created_at < ? AND body_json IS NULL", floor).changes);
    gone += Number(db.run("UPDATE ai_summaries SET state = 'ready' WHERE state = 'pending' AND created_at < ?", floor).changes);
    const over = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM ai_summaries")!.n - maxRows;
    if (over > 0) gone += Number(db.run("DELETE FROM ai_summaries WHERE thread_id IN (SELECT thread_id FROM ai_summaries WHERE state != 'pending' ORDER BY coalesce(generated_at, failed_at, created_at) LIMIT ?)", over).changes);
    return gone;
  });
}
