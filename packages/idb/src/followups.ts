import { addressKey, type FollowupRow } from "@terno/core";
import { FOLLOWUP_CLOSED_KEEP_MS, FOLLOWUPS_ACTIVE_MAX, recipientList, SCAN_MARK_MS, SENT_MARK_MS, type FollowupFinish, type FollowupFinishOutcome, type FollowupSnapshot, type FollowupSource, type SentMark } from "@terno/store";
import { T, type Ctx, type R } from "./mail";

/** Plan 142 on IndexedDB, like SQL's (packages/db/src/followups.ts). */

const toRow = (r: R): FollowupRow => ({ id: r.id, threadId: r.thread_id, messageId: r.message_id, rfcMessageId: r.rfc_message_id ?? null, item: r.item, kind: r.kind, text: r.text, quote: r.quote ?? null, personName: r.person_name ?? null, personEmail: r.person_email ?? null, sentAt: r.sent_at, dueAt: r.due_at, dated: r.dated === 1, state: r.state, inboxState: r.inbox_state, closedReason: r.closed_reason ?? null, closedAt: r.closed_at ?? null, notifiedAt: r.notified_at ?? null, fromScan: r.from_scan === 1, revision: r.revision, model: r.model ?? null, provider: r.provider ?? null, createdAt: r.created_at });

function own(c: Ctx): Set<string> {
  const out = new Set<string>();
  for (const a of T(c, "accounts").all()) out.add(addressKey(String(a.email)));
  for (const k of T(c, "correspondents").keysBy("own", 1)) out.add(addressKey(String(k)));
  return out;
}

const live = (r: R) => r.state === "open" || r.state === "due";
const unconfirmed = (m: R) => String(m.provider_msg_id ?? "local:").startsWith("local:");

function markSent(c: Ctx, messageId: number, now: number, source: "live" | "scan", since?: number | null): void {
  const m = T(c, "messages").get(messageId);
  if (!m || !m.is_sent || m.is_draft || (since != null && m.date < since)) return;
  const mine = own(c);
  if (![...recipientList(m.to_json).addresses, ...recipientList(m.cc_json).addresses].some((a) => !mine.has(addressKey(a)))) return;
  const marks = T(c, "ai_sent_mail");
  if (!marks.has(messageId)) marks.insert({ message_id: messageId, thread_id: m.thread_id, sent_at: m.date, queued_at: now, source });
}

function closeWaitsBefore(c: Ctx, messageId: number, now: number): void {
  const m = T(c, "messages").get(messageId);
  if (!m) return;
  const rows = T(c, "followups");
  for (const r of rows.by("fk_thread_id", m.thread_id)) if (r.kind === "awaiting" && live(r) && r.sent_at < m.date) rows.update(r, { state: "done", closed_reason: "superseded", closed_at: now, inbox_state: "none", revision: r.revision + 1 });
}

export function followupSendConfirmed(c: Ctx, messageId: number, now: number, wanted: boolean, since?: number | null): void {
  closeWaitsBefore(c, messageId, now);
  // what you sent before you turned it on is read only with a yes
  if (wanted) markSent(c, messageId, now, "live", since);
}

export function followupLiveSent(c: Ctx, messageIds: readonly number[], now: number, wanted: boolean, since?: number | null): void {
  const messages = T(c, "messages");
  for (const id of messageIds) {
    const m = messages.get(id);
    if (!m || !m.is_sent || m.is_draft || m.is_spam || m.is_trash || m.date < now - SENT_MARK_MS) continue;
    closeWaitsBefore(c, id, now);
    if (wanted) markSent(c, id, now, "live", since);
  }
}

export function mergeFollowups(c: Ctx, into: number, from: number): void {
  const marks = T(c, "ai_sent_mail");
  for (const m of marks.by("thread", from)) marks.update(m, { thread_id: into });
  const rows = T(c, "followups");
  for (const r of rows.by("fk_thread_id", from)) rows.update(r, { thread_id: into, revision: r.revision + 1 });
}

const toMark = (r: R): SentMark => ({ messageId: r.message_id, threadId: r.thread_id, sentAt: r.sent_at, queuedAt: r.queued_at, source: r.source });

export function sentMarkPage(c: Ctx, after: { sentAt: number; messageId: number } | null, limit: number): SentMark[] {
  return [...T(c, "ai_sent_mail").all()]
    .filter((r) => !after || r.sent_at > after.sentAt || (r.sent_at === after.sentAt && r.message_id > after.messageId))
    .sort((a, b) => a.sent_at - b.sent_at || a.message_id - b.message_id)
    .slice(0, limit)
    .map(toMark);
}

export const sentMarkCount = (c: Ctx): number => [...T(c, "ai_sent_mail").all()].length;

export function queueScan(c: Ctx, messageIds: readonly number[], now: number): number {
  const marks = T(c, "ai_sent_mail");
  let n = 0;
  for (const id of messageIds) {
    // written here and not yet confirmed: it may never go
    if (marks.has(id) || unconfirmed(T(c, "messages").get(id) ?? {})) continue;
    markSent(c, id, now, "scan");
    if (marks.has(id)) n++;
  }
  return n;
}

export function pruneSentMarks(c: Ctx, now: number): number {
  const marks = T(c, "ai_sent_mail");
  const old = [...marks.all()].filter((r) => r.queued_at < now - (r.source === "scan" ? SCAN_MARK_MS : SENT_MARK_MS));
  for (const r of old) marks.deleteRow(r);
  return old.length;
}

export function followupScanCandidates(c: Ctx, since: number, limit: number): number[] {
  const tracked = new Set([...T(c, "followups").all()].map((r) => r.message_id));
  const out: R[] = [];
  for (const m of T(c, "messages").all()) if (m.is_sent && !m.is_draft && !m.is_spam && !m.is_trash && m.date >= since && m.list_id == null && !m.is_bulk && !unconfirmed(m) && !tracked.has(m.id)) out.push(m);
  return out.sort((a, b) => b.date - a.date || b.id - a.id).slice(0, limit).map((m) => m.id);
}

export function followupSource(c: Ctx, messageId: number): FollowupSource | null {
  const messages = T(c, "messages");
  const m = messages.get(messageId);
  if (!m) return null;
  const mine = own(c);
  // what it answers: the message it says it answers; only with none, the newest before it from someone else
  const target = m.in_reply_to ? messages.by("rfc", m.account_id, m.in_reply_to).find((x) => x.id !== m.id && !x.is_draft && !x.is_spam && !x.is_trash) : undefined;
  const before = target && !mine.has(addressKey(String(target.from_email))) ? target : messages.by("fk_thread_id", m.thread_id)
    .filter((x) => (x.date < m.date || (x.date === m.date && x.id < m.id)) && !x.is_draft && !x.is_spam && !x.is_trash && !x.is_sent && !mine.has(addressKey(String(x.from_email))))
    .sort((a, b) => b.date - a.date || b.id - a.id)[0];
  const people = (json: string) => {
    const list = recipientList(json);
    return list.addresses.map((email) => ({ name: list.names[email] ?? "", email }));
  };
  return {
    id: m.id, threadId: m.thread_id, accountId: m.account_id, subject: m.subject, rfcMessageId: m.rfc_message_id ?? null, date: m.date, bulk: !!m.is_bulk || m.list_id != null, draft: !!m.is_draft, spam: !!m.is_spam, trash: !!m.is_trash,
    to: people(m.to_json), cc: people(m.cc_json),
    attachments: T(c, "attachments").by("fk_message_id", messageId).sort((a, b) => a.id - b.id).slice(0, 10).map((a) => a.filename as string),
    bodyState: m.body_state, bodyUnavailable: m.attachments_captured === 2 && m.body_state !== "full",
    answering: before ? { id: before.id, bodyState: before.body_state, bodyUnavailable: before.attachments_captured === 2 && before.body_state !== "full" } : null,
  };
}

function replied(c: Ctx, mine: ReadonlySet<string>, row: { accountId: number; threadId: number; sentAt: number; rfcMessageId: string | null }): boolean {
  const messages = T(c, "messages");
  const counts = (m: R) => m.date > row.sentAt && !m.is_sent && !m.is_draft && !m.is_spam && !m.is_trash && !mine.has(addressKey(String(m.from_email)));
  if (messages.by("fk_thread_id", row.threadId).some(counts)) return true;
  if (!row.rfcMessageId) return false;
  return T(c, "message_refs").by("ref", row.accountId, row.rfcMessageId).some((r) => {
    const m = messages.get(r.message_id);
    return !!m && counts(m);
  });
}

export function finishFollowups(c: Ctx, w: FollowupFinish): FollowupFinishOutcome {
  const marks = T(c, "ai_sent_mail");
  const mark = marks.get(w.messageId);
  if (!mark) return "gone";
  const src = followupSource(c, w.messageId);
  if (!src || src.trash || src.spam || src.draft) {
    marks.deleteRow(mark);
    return "gone";
  }
  const rows = T(c, "followups");
  const mine = own(c);
  let active = rows.by("state", "open").length + rows.by("state", "due").length;
  const later = T(c, "messages").by("fk_thread_id", src.threadId).some((m) => m.date > src.date && m.is_sent && !m.is_draft && !m.is_trash && !String(m.provider_msg_id ?? "").startsWith("local:"));
  for (const r of w.rows) {
    if (r.kind === "awaiting" && (later || replied(c, mine, { accountId: src.accountId, threadId: src.threadId, sentAt: src.date, rfcMessageId: src.rfcMessageId }))) continue;
    if (rows.by("identity", w.messageId, r.item).length) continue;
    if (active >= FOLLOWUPS_ACTIVE_MAX) {
      if (r.kind === "awaiting") continue;
      const oldest = [...rows.by("state", "open"), ...rows.by("state", "due")].filter((x) => x.kind === "awaiting").sort((a, b) => a.sent_at - b.sent_at || a.id - b.id)[0];
      if (!oldest) continue;
      rows.deleteRow(oldest);
      active--;
    }
    rows.put({ thread_id: src.threadId, message_id: w.messageId, rfc_message_id: src.rfcMessageId, item: r.item, kind: r.kind, text: r.text, quote: r.quote, person_name: r.personName, person_email: r.personEmail, sent_at: src.date, due_at: r.dueAt, dated: r.dated ? 1 : 0, state: "open", inbox_state: "none", closed_reason: null, closed_at: null, notified_at: null, from_scan: w.fromScan ? 1 : 0, revision: 0, model: w.model, provider: w.provider, prompt_version: w.promptVersion, created_at: w.now });
    active++;
  }
  for (const k of w.kept) {
    const r = rows.get(k.id);
    if (r && r.revision === k.revision && r.thread_id === src.threadId && r.kind === "promise" && live(r)) rows.update(r, { state: "done", closed_reason: "kept", closed_at: w.now, inbox_state: "none", revision: r.revision + 1 });
  }
  marks.deleteRow(mark);
  return "written";
}

const byDue = (a: R, b: R) => a.due_at - b.due_at || a.id - b.id;

export function activeFollowups(c: Ctx): FollowupRow[] {
  const rows = T(c, "followups");
  return [...rows.by("state", "open"), ...rows.by("state", "due")].sort(byDue).slice(0, FOLLOWUPS_ACTIVE_MAX).map(toRow);
}
export const threadFollowups = (c: Ctx, threadId: number): FollowupRow[] => T(c, "followups").by("fk_thread_id", threadId).filter(live).sort(byDue).map(toRow);
export function getFollowup(c: Ctx, id: number): FollowupRow | null {
  const r = T(c, "followups").get(id);
  return r ? toRow(r) : null;
}
export function nextFollowupDue(c: Ctx): number | null {
  let at: number | null = null;
  for (const r of T(c, "followups").by("state", "open")) if (at === null || r.due_at < at) at = r.due_at;
  return at;
}

export function makeFollowupsDue(c: Ctx, now: number): FollowupRow[] {
  const rows = T(c, "followups");
  const out: FollowupRow[] = [];
  for (const r of rows.by("state", "open")) {
    if (r.due_at > now) continue;
    out.push(toRow(rows.update(r, { state: "due", inbox_state: r.from_scan ? "none" : "onTop", revision: r.revision + 1 })));
  }
  return out;
}

export function claimFollowupNotice(c: Ctx, ids: readonly number[], now: number): number[] {
  const rows = T(c, "followups");
  return ids.filter((id) => {
    const r = rows.get(id);
    if (!r || r.notified_at != null) return false;
    rows.update(r, { notified_at: now });
    return true;
  });
}

export function closeAnsweredFollowups(c: Ctx, ids: readonly number[], now: number): number[] {
  const rows = T(c, "followups");
  const threads = T(c, "threads");
  const mine = own(c);
  const closed: number[] = [];
  for (const id of ids) {
    const r = rows.get(id);
    if (!r || r.kind !== "awaiting" || !live(r)) continue;
    const t = threads.get(r.thread_id);
    if (!t || !replied(c, mine, { accountId: t.account_id, threadId: r.thread_id, sentAt: r.sent_at, rfcMessageId: r.rfc_message_id ?? null })) continue;
    rows.update(r, { state: "done", closed_reason: "replied", closed_at: now, inbox_state: "none", revision: r.revision + 1 });
    closed.push(id);
  }
  return closed;
}

const snapshot = (r: R): FollowupSnapshot => ({ id: r.id, revision: r.revision, state: r.state, dueAt: r.due_at, inboxState: r.inbox_state, closedReason: r.closed_reason ?? null, closedAt: r.closed_at ?? null });

export function endFollowupTop(c: Ctx, threadIds: readonly number[]): FollowupSnapshot[] {
  const rows = T(c, "followups");
  const wanted = new Set(threadIds);
  const out: FollowupSnapshot[] = [];
  for (const r of rows.by("top", "onTop")) {
    if (!wanted.has(r.thread_id)) continue;
    out.push(snapshot(r));
    rows.update(r, { inbox_state: "seen", revision: r.revision + 1 });
  }
  return out;
}

export function updateFollowup(c: Ctx, id: number, revision: number, patch: Partial<Pick<FollowupRow, "state" | "dueAt" | "inboxState" | "closedReason" | "closedAt">>): FollowupSnapshot | null {
  const rows = T(c, "followups");
  const r = rows.get(id);
  if (!r || r.revision !== revision) return null;
  const before = snapshot(r);
  rows.update(r, { state: patch.state ?? r.state, due_at: patch.dueAt ?? r.due_at, inbox_state: patch.inboxState ?? r.inbox_state, closed_reason: patch.closedReason !== undefined ? patch.closedReason : (r.closed_reason ?? null), closed_at: patch.closedAt !== undefined ? patch.closedAt : (r.closed_at ?? null), revision: r.revision + 1 });
  return before;
}

export function restoreFollowups(c: Ctx, list: readonly { snapshot: FollowupSnapshot; expectRevision: number }[]): number {
  const rows = T(c, "followups");
  let n = 0;
  for (const { snapshot: s, expectRevision } of list) {
    const r = rows.get(s.id);
    if (!r || r.revision !== expectRevision) continue;
    rows.update(r, { state: s.state, due_at: s.dueAt, inbox_state: s.inboxState, closed_reason: s.closedReason, closed_at: s.closedAt, revision: r.revision + 1 });
    n++;
  }
  return n;
}

export function pruneFollowups(c: Ctx, now: number): number {
  const rows = T(c, "followups");
  const old = [...rows.by("state", "done"), ...rows.by("state", "dismissed")].filter((r) => r.closed_at < now - FOLLOWUP_CLOSED_KEEP_MS);
  for (const r of old) rows.deleteRow(r);
  return old.length;
}

export function clearFollowups(c: Ctx): void {
  const rows = T(c, "followups");
  for (const r of rows.all()) rows.deleteRow(r);
  const marks = T(c, "ai_sent_mail");
  for (const r of marks.all()) marks.deleteRow(r);
}
