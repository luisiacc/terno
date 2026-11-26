import { addressKey, type FollowupRow } from "@terno/core";
import { followupWorth, OWED_MARK_MS, OWED_REQUEUE_MAX, OWED_SCAN_MARK_MS, type FollowupFinishOutcome, type OwedFinish, type OwedMark, type OwedSource } from "@terno/store";
import { received, receivedOwn } from "./ai-summaries";
import { datedSource } from "./dated";
import { admitFollowup, followupRow, trustedSend } from "./followups";
import { T, type Ctx, type R } from "./mail";

/** Plan 280 on IndexedDB, like SQL's (packages/db/src/owed.ts). */

const toMark = (r: R): OwedMark => ({ messageId: r.message_id, threadId: r.thread_id, senderKey: r.sender_key, arrivedAt: r.arrived_at, queuedAt: r.queued_at, source: r.source === "scan" ? "scan" : "live" });
const live = (r: R) => r.state === "open" || r.state === "due";

function mark(c: Ctx, ids: readonly number[], now: number, since: number, source: "live" | "scan"): number {
  const messages = T(c, "messages");
  const marks = T(c, "ai_owed_mail");
  const own = receivedOwn(c);
  let n = 0;
  for (const id of ids) {
    const m = messages.get(id);
    if (!m || !received(m, own) || m.date < since || marks.has(id)) continue;
    marks.insert({ message_id: id, thread_id: m.thread_id, sender_key: addressKey(String(m.from_email ?? "")), arrived_at: m.date, queued_at: now, source });
    n++;
  }
  return n;
}

export function markOwedMail(c: Ctx, messageIds: readonly number[], now: number, since: number | null): void {
  mark(c, messageIds, now, since == null ? now - OWED_MARK_MS : Math.max(now - OWED_MARK_MS, since), "live");
}

export function owedMarkPage(c: Ctx, after: { arrivedAt: number; messageId: number } | null, limit: number): OwedMark[] {
  return [...T(c, "ai_owed_mail").all()]
    .filter((r) => !after || r.arrived_at > after.arrivedAt || (r.arrived_at === after.arrivedAt && r.message_id > after.messageId))
    .sort((a, b) => a.arrived_at - b.arrived_at || a.message_id - b.message_id)
    .slice(0, limit)
    .map(toMark);
}

export const owedMarkCount = (c: Ctx): number => [...T(c, "ai_owed_mail").all()].length;
export const queueOwedScan = (c: Ctx, messageIds: readonly number[], now: number): number => mark(c, messageIds, now, -Infinity, "scan");

export function requeueOwed(c: Ctx, personEmail: string, accountId: number, since: number, now: number): number {
  const key = addressKey(personEmail);
  const own = receivedOwn(c);
  const ids = [...T(c, "messages").by("from", personEmail), ...(personEmail.toLowerCase() !== personEmail ? T(c, "messages").by("from", personEmail.toLowerCase()) : [])]
    .filter((m) => m.account_id === accountId && m.date >= since && received(m, own) && addressKey(String(m.from_email)) === key)
    .sort((a, b) => b.date - a.date || b.id - a.id)
    .slice(0, OWED_REQUEUE_MAX)
    .map((m) => m.id as number);
  return mark(c, ids, now, since, "scan");
}

export function consumeOwedMark(c: Ctx, messageId: number): void {
  const marks = T(c, "ai_owed_mail");
  const m = marks.get(messageId);
  if (m) marks.deleteRow(m);
}

export function clearOwedMarks(c: Ctx): void {
  const marks = T(c, "ai_owed_mail");
  for (const r of marks.all()) marks.deleteRow(r);
}

export function pruneOwedMarks(c: Ctx, now: number): number {
  const marks = T(c, "ai_owed_mail");
  const old = [...marks.all()].filter((r) => r.queued_at < now - (r.source === "scan" ? OWED_SCAN_MARK_MS : OWED_MARK_MS));
  for (const r of old) marks.deleteRow(r);
  return old.length;
}

export function owedScanCandidates(c: Ctx, since: number, limit: number, accountId: number): number[] {
  const own = receivedOwn(c);
  const messages = T(c, "messages");
  const out: R[] = [];
  for (const t of T(c, "threads").by("fk_account_id", accountId)) {
    if (t.in_trash || t.in_spam || t.last_date < since) continue;
    for (const m of messages.by("fk_thread_id", t.id)) if (m.date >= since && received(m, own) && m.list_id == null && !m.is_bulk) out.push(m);
  }
  return out.sort((a, b) => b.date - a.date || b.id - a.id).slice(0, limit).map((m) => m.id);
}

export function owedSource(c: Ctx, messageId: number): OwedSource | null {
  const base = datedSource(c, messageId);
  if (!base) return null;
  const messages = T(c, "messages");
  const m = messages.get(messageId)!;
  // revision 4: only a trusted send of yours on this account and conversation
  const answering = m.in_reply_to ? messages.by("rfc", base.accountId, m.in_reply_to).find((x) => x.id !== messageId && x.thread_id === base.threadId && trustedSend(x)) : undefined;
  return {
    ...base,
    rfcMessageId: m.rfc_message_id ?? null,
    attachments: T(c, "attachments").by("fk_message_id", messageId).sort((a, b) => a.id - b.id).slice(0, 10).map((a) => a.filename as string),
    answering: answering ? { id: answering.id, bodyState: answering.body_state, bodyUnavailable: answering.attachments_captured === 2 && answering.body_state !== "full" } : null,
  };
}

export function openOwedFor(c: Ctx, o: { threadId: number; accountId: number; senderKey: string; before: number; limit: number }): FollowupRow[] {
  const rows = T(c, "followups");
  const threads = T(c, "threads");
  const found = new Map<number, R>();
  for (const r of rows.by("fk_thread_id", o.threadId)) if (r.kind === "theirs" && live(r)) found.set(r.id, r);
  for (const r of rows.by("owed", o.senderKey)) found.set(r.id, r);
  return [...found.values()]
    .filter((r) => {
      const t = threads.get(r.thread_id);
      return r.sent_at < o.before && t && t.account_id === o.accountId && !t.in_trash && !t.in_spam;
    })
    .sort((a, b) => b.sent_at - a.sent_at || b.id - a.id)
    .slice(0, o.limit)
    .map(followupRow);
}

export function finishOwed(c: Ctx, w: OwedFinish): FollowupFinishOutcome {
  const marks = T(c, "ai_owed_mail");
  const mk = marks.get(w.messageId);
  if (!mk) return "gone";
  const src = datedSource(c, w.messageId);
  if (!src || src.threadId !== w.threadId || src.spam || src.trash || src.draft || src.threadSpam || src.own || src.sent) {
    marks.deleteRow(mk);
    return "gone";
  }
  const rows = T(c, "followups");
  const threads = T(c, "threads");
  const rfc = T(c, "messages").get(w.messageId)?.rfc_message_id ?? null;
  for (const r of w.rows) {
    if (addressKey(r.personEmail) !== src.senderKey) continue;
    if (rows.by("identity", w.messageId, r.item).length) continue;
    if (!admitFollowup(c, followupWorth({ kind: "theirs", dated: r.dated, firm: r.firm }))) continue;
    rows.put({ thread_id: src.threadId, message_id: w.messageId, rfc_message_id: rfc, item: r.item, kind: "theirs", text: r.text, quote: r.quote, person_name: r.personName, person_email: r.personEmail, person_key: src.senderKey, sent_at: src.date, due_at: r.dueAt, dated: r.dated ? 1 : 0, due_day: r.dueDay, firm: r.firm ? 1 : 0, deferred_until: null, state: "open", inbox_state: "none", closed_reason: null, closed_at: null, notified_at: null, from_scan: w.fromScan ? 1 : 0, revision: 0, model: w.model, provider: w.provider, prompt_version: w.promptVersion, created_at: w.now, timed: r.timed ? 1 : 0, part_of_day: r.partOfDay ?? null, arrived_hint: null });
  }
  // as SQL's: only the debtor's own mail, in this account, after the promise, at the revision shown
  const mine = (ref: { id: number; revision: number }, debtor = true): R | null => {
    const r = rows.get(ref.id);
    if (!r || r.kind !== "theirs" || !live(r) || r.revision !== ref.revision || r.sent_at >= src.date || (debtor && r.person_key !== src.senderKey)) return null;
    return threads.get(r.thread_id)?.account_id === src.accountId ? r : null;
  };
  const closed = new Set<number>();
  for (const k of w.kept) {
    const r = mine(k);
    if (!r) continue;
    rows.update(r, { state: "done", closed_reason: "kept", closed_at: w.now, settled_by: w.messageId, settled_at: src.date, inbox_state: "none", revision: r.revision + 1 });
    closed.add(r.id);
  }
  for (const k of w.withdrawn) {
    const r = closed.has(k.id) ? null : mine(k);
    if (!r) continue;
    rows.update(r, { state: "dismissed", closed_reason: "withdrawn", closed_at: w.now, settled_by: w.messageId, settled_at: src.date, inbox_state: "none", revision: r.revision + 1 });
    closed.add(r.id);
  }
  for (const m of w.moved) {
    const r = closed.has(m.id) ? null : mine(m);
    if (!r) continue;
    const ahead = m.dueAt > w.now;
    rows.update(r, { due_at: m.dueAt, due_day: m.dueDay, dated: 1, timed: m.timed ? 1 : 0, part_of_day: m.partOfDay ?? null, state: ahead ? "open" : r.state, inbox_state: ahead ? "none" : r.inbox_state, notified_at: null, revision: r.revision + 1 });
  }
  for (const h of w.hints) {
    const r = closed.has(h.id) ? null : mine(h, false);
    if (r) rows.update(r, { arrived_hint: w.messageId, revision: r.revision + 1 });
  }
  marks.deleteRow(mk);
  return "written";
}
