import { NEW_MAIL_MS, sourceStamp, summaryBlocked, type AiSummaryRow, type AiSummaryState, type NewMailMark, type NewMailWant, type NewMailWants, type SummarySources, type SummaryWrite, type SummaryWriteOutcome } from "@terno/store";
import { T, type Ctx, type R } from "./mail";

/** Plan 131 revision 5 and plan 132 on IndexedDB, like SQL's (packages/db/src/ai-summaries.ts). */

const FLAG: Record<NewMailWant, "wants_summary" | "wants_category"> = { summary: "wants_summary", category: "wants_category" };

const toRow = (r: R): AiSummaryRow => ({
  threadId: r.thread_id,
  state: r.state,
  throughMessageId: r.through_message_id,
  sourceStamp: r.source_stamp ?? null,
  contentHash: r.content_hash ?? null,
  promptVersion: r.prompt_version ?? null,
  language: r.language ?? null,
  model: r.model ?? null,
  provider: r.provider ?? null,
  endpoint: r.endpoint ?? null,
  bodyJson: r.body_json ?? null,
  attempts: r.attempts ?? 0,
  errorKind: r.error_kind ?? null,
  createdAt: r.created_at,
  generatedAt: r.generated_at ?? null,
  failedAt: r.failed_at ?? null,
});

const pendingRow = (threadId: number, through: number, at: number): R => ({
  thread_id: threadId, state: "pending", through_message_id: through, source_stamp: null, content_hash: null, prompt_version: null, language: null, model: null, provider: null, endpoint: null, body_json: null, attempts: 0, error_kind: null, created_at: at, generated_at: null, failed_at: null,
});

function ownAddresses(c: Ctx): Set<string> {
  const own = new Set<string>();
  for (const a of T(c, "accounts").all()) own.add(String(a.email).toLowerCase());
  for (const k of T(c, "correspondents").keysBy("own", 1)) own.add(String(k).toLowerCase());
  return own;
}

/** Ingest's part (in its command): live mail it inserted, marked; a summary queued for its thread, when they want one. */
export function markNewMail(c: Ctx, messageIds: readonly number[], now: number, wants: NewMailWants): void {
  if (!messageIds.length || (!wants.summary && !wants.category)) return;
  const messages = T(c, "messages");
  const marks = T(c, "ai_new_mail");
  const own = ownAddresses(c);
  const through = new Map<number, number>();
  for (const id of messageIds) {
    const m = messages.get(id);
    if (!m || m.is_sent || m.is_draft || m.is_spam || m.is_trash || m.date < now - NEW_MAIL_MS || own.has(String(m.from_email).toLowerCase()) || marks.has(id)) continue;
    marks.insert({ message_id: id, thread_id: m.thread_id, arrived_at: now, wants_summary: wants.summary ? 1 : 0, wants_category: wants.category ? 1 : 0 });
    if (wants.summary) through.set(m.thread_id, Math.max(through.get(m.thread_id) ?? 0, id));
  }
  const rows = T(c, "ai_summaries");
  // a newer message moves it forward and queues it again: the old result stays out of the UI (its stamp) until replaced
  for (const [threadId, id] of through) {
    const row = rows.get(threadId);
    if (!row) rows.insert(pendingRow(threadId, id, now));
    else rows.update(row, { created_at: row.state === "pending" ? row.created_at : now, state: "pending", through_message_id: Math.max(row.through_message_id, id), attempts: 0, error_kind: null });
  }
}

/**
 * A merge (before the vanished thread goes): the marks follow their messages, and the survivor's summary no longer
 * describes it. It's queued again only if a message there still has a mark; otherwise the stale result goes.
 */
export function mergeSummaries(c: Ctx, into: number, from: number): void {
  const marks = T(c, "ai_new_mail");
  for (const m of marks.by("thread", from)) marks.update(m, { thread_id: into });
  let through = 0, at = Infinity;
  for (const m of marks.by("thread", into)) {
    if (m.wants_summary !== 1) continue;
    through = Math.max(through, m.message_id);
    at = Math.min(at, m.arrived_at);
  }
  const rows = T(c, "ai_summaries");
  rows.delete(from);
  rows.delete(into);
  if (through) rows.insert(pendingRow(into, through, at));
}

export function newMailPage(c: Ctx, want: NewMailWant, after: { arrivedAt: number; messageId: number } | null, limit: number): NewMailMark[] {
  return T(c, "ai_new_mail")
    .by(FLAG[want], 1)
    .filter((r) => !after || r.arrived_at > after.arrivedAt || (r.arrived_at === after.arrivedAt && r.message_id > after.messageId))
    .sort((a, b) => a.arrived_at - b.arrived_at || a.message_id - b.message_id)
    .slice(0, limit)
    .map((r) => ({ messageId: r.message_id, threadId: r.thread_id, arrivedAt: r.arrived_at, wantsSummary: r.wants_summary === 1, wantsCategory: r.wants_category === 1 }));
}

function consumeMark(c: Ctx, want: NewMailWant, row: R): void {
  const marks = T(c, "ai_new_mail");
  const next = marks.update(row, { [FLAG[want]]: 0 });
  if (next.wants_summary !== 1 && next.wants_category !== 1) marks.deleteRow(next);
}

export function consumeNewMail(c: Ctx, want: NewMailWant, messageIds: readonly number[]): void {
  const marks = T(c, "ai_new_mail");
  for (const id of messageIds) {
    const row = marks.get(id);
    if (row) consumeMark(c, want, row);
  }
}

export function clearNewMail(c: Ctx, want: NewMailWant): void {
  for (const row of T(c, "ai_new_mail").by(FLAG[want], 1)) consumeMark(c, want, row);
}

export function pruneNewMail(c: Ctx, now: number): number {
  const marks = T(c, "ai_new_mail");
  const old = [...marks.all()].filter((r) => r.arrived_at < now - NEW_MAIL_MS);
  for (const r of old) marks.deleteRow(r);
  return old.length;
}

export function getSummary(c: Ctx, threadId: number): AiSummaryRow | null {
  const r = T(c, "ai_summaries").get(threadId);
  return r ? toRow(r) : null;
}

export function summarySources(c: Ctx, threadId: number): SummarySources | null {
  const thread = T(c, "threads").get(threadId);
  if (!thread) return null;
  const heads = T(c, "body_heads");
  const marks = T(c, "ai_new_mail");
  const own = new Set([...T(c, "accounts").all()].map((a) => String(a.email).toLowerCase()));
  const rows = T(c, "messages").by("fk_thread_id", threadId).sort((a, b) => a.date - b.date || a.id - b.id);
  const messages = rows.filter((r) => !r.is_draft);
  return {
    threadId,
    accountId: thread.account_id,
    subject: thread.subject,
    inInbox: thread.in_inbox === 1,
    inSpam: thread.in_spam === 1,
    inTrash: thread.in_trash === 1,
    hasSpam: rows.some((r) => r.is_spam === 1),
    tab: thread.tab ?? 0,
    stamp: sourceStamp(messages.filter((r) => !r.is_trash).map((r) => ({ id: r.id, bodyState: r.body_state, capture: heads.get(r.id)?.capture_id, tail: r.body_tail_norm }))),
    messages: messages.map((r) => {
      const mark = marks.get(r.id);
      return {
        id: r.id,
        fromName: r.from_name,
        fromEmail: r.from_email,
        date: r.date,
        snippet: r.snippet,
        subject: r.subject,
        own: r.is_sent === 1 || own.has(String(r.from_email).toLowerCase()),
        trash: r.is_trash === 1,
        spam: r.is_spam === 1,
        bodyState: r.body_state,
        bodyUnavailable: r.attachments_captured === 2 && r.body_state !== "full",
        markedAt: mark?.wants_summary === 1 ? mark.arrived_at : null,
      };
    }),
  };
}

export function pendingSummaries(c: Ctx, after: { createdAt: number; threadId: number } | null, limit: number): AiSummaryRow[] {
  return T(c, "ai_summaries")
    .by("state", "pending")
    .filter((r) => !after || r.created_at > after.createdAt || (r.created_at === after.createdAt && r.thread_id > after.threadId))
    .sort((a, b) => a.created_at - b.created_at || a.thread_id - b.thread_id)
    .slice(0, limit)
    .map(toRow);
}

export const pendingSummaryCount = (c: Ctx): number => T(c, "ai_summaries").count("state", "pending");

export function lastSummaryFailure(c: Ctx): { kind: string; at: number } | null {
  let last: R | null = null;
  for (const r of T(c, "ai_summaries").by("state", "failed")) if (r.error_kind && (!last || r.failed_at > last.failed_at)) last = r;
  return last ? { kind: last.error_kind, at: last.failed_at } : null;
}

export function attemptSummary(c: Ctx, threadId: number, kind: string, max: number, now: number): AiSummaryState | null {
  const rows = T(c, "ai_summaries");
  const r = rows.get(threadId);
  if (!r) return null;
  if (r.state !== "pending") return r.state;
  const attempts = (r.attempts ?? 0) + 1;
  const state: AiSummaryState = attempts >= max ? "failed" : "pending";
  rows.update(r, { attempts, state, error_kind: kind, failed_at: now });
  return state;
}

export function failSummary(c: Ctx, threadId: number, kind: string, now: number): void {
  const rows = T(c, "ai_summaries");
  const r = rows.get(threadId);
  if (r?.state === "pending") rows.update(r, { state: "failed", error_kind: kind, failed_at: now });
}

function consumeThread(c: Ctx, threadId: number): void {
  for (const m of T(c, "ai_new_mail").by("thread", threadId)) if (m.wants_summary === 1) consumeMark(c, "summary", m);
}

export function dropSummary(c: Ctx, threadId: number, expectThrough: number): void {
  const rows = T(c, "ai_summaries");
  const r = rows.get(threadId);
  if (r?.state !== "pending" || r.through_message_id !== expectThrough) return;
  if (r.body_json == null) rows.deleteRow(r);
  else rows.update(r, { state: "ready" });
  consumeThread(c, threadId);
}

export function finishSummary(c: Ctx, w: SummaryWrite): SummaryWriteOutcome {
  const sources = summarySources(c, w.threadId);
  if (!sources) return "gone";
  if (summaryBlocked(sources)) return "blocked";
  if (sources.stamp !== w.stamp) return "moved";
  const rows = T(c, "ai_summaries");
  const row = rows.get(w.threadId);
  if (row && row.through_message_id !== w.expectThrough) return "moved";
  const through = Math.max(row?.through_message_id ?? 0, ...sources.messages.filter((m) => !m.trash).map((m) => m.id));
  if (w.reuse) {
    if (row?.body_json == null) return "moved";
    rows.update(row, { state: "ready", through_message_id: through, source_stamp: w.stamp, attempts: 0, error_kind: null });
  } else {
    rows.put({
      thread_id: w.threadId, state: "ready", through_message_id: through, source_stamp: w.stamp, content_hash: w.contentHash, prompt_version: w.promptVersion, language: w.language, model: w.model, provider: w.provider, endpoint: w.endpoint, body_json: w.bodyJson,
      attempts: 0, error_kind: null, created_at: row?.created_at ?? w.now, generated_at: w.now, failed_at: null,
    });
  }
  consumeThread(c, w.threadId);
  return "written";
}

export function dropPendingSummaries(c: Ctx): void {
  const rows = T(c, "ai_summaries");
  for (const r of rows.by("state", "pending")) {
    if (r.body_json == null) rows.deleteRow(r);
    else rows.update(r, { state: "ready" });
  }
  clearNewMail(c, "summary");
}

export function clearSummaries(c: Ctx): void {
  const rows = T(c, "ai_summaries");
  for (const r of [...rows.all()]) rows.deleteRow(r);
  clearNewMail(c, "summary");
}

export function pruneSummaries(c: Ctx, now: number, maxRows: number): number {
  const rows = T(c, "ai_summaries");
  const floor = now - NEW_MAIL_MS;
  let gone = 0;
  for (const r of rows.by("state", "pending")) {
    if (r.created_at >= floor) continue;
    if (r.body_json == null) rows.deleteRow(r);
    else rows.update(r, { state: "ready" });
    gone++;
  }
  const all = [...rows.all()];
  const over = all.length - maxRows;
  if (over > 0) {
    const age = (r: R) => r.generated_at ?? r.failed_at ?? r.created_at;
    for (const r of all.filter((x) => x.state !== "pending").sort((a, b) => age(a) - age(b)).slice(0, over)) {
      rows.deleteRow(r);
      gone++;
    }
  }
  return gone;
}
