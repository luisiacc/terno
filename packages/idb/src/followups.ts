import { addressKey, ANSWERED_KINDS, isFollowupKind, onTopEligible, parseHandedTo, readPartOfDay, refKey, replyAnswers, replyClosedReason, replyRecipients, type FollowupRow } from "@terno/core";
import { FOLLOWUP_CLOSED_KEEP_MS, FOLLOWUP_WORTH_KEPT, FOLLOWUPS_ACTIVE_MAX, followupWorth, recipientList, SCAN_MARK_MS, SENT_MARK_MS, type ClosedAt, type FollowupFinish, type FollowupFinishOutcome, type FollowupSnapshot, type FollowupSource, type SentMark } from "@terno/store";
import { T, type Ctx, type R } from "./mail";
import { scheduleFields } from "./schedule";

/** Plan 142 on IndexedDB, like SQL's (packages/db/src/followups.ts). */

const toRow = (r: R): FollowupRow => ({ id: r.id, threadId: r.thread_id, messageId: r.message_id, rfcMessageId: r.rfc_message_id ?? null, item: r.item, kind: r.kind, text: r.text, quote: r.quote ?? null, personName: r.person_name ?? null, personEmail: r.person_email ?? null, sentAt: r.sent_at, dueAt: r.due_at, dated: r.dated === 1, deferredUntil: r.deferred_until ?? null, state: r.state, inboxState: r.inbox_state, closedReason: r.closed_reason ?? null, closedAt: r.closed_at ?? null, notifiedAt: r.notified_at ?? null, fromScan: r.from_scan === 1, revision: r.revision, model: r.model ?? null, provider: r.provider ?? null, createdAt: r.created_at, sameAs: r.same_as ?? null, brokenDueAt: r.broken_due_at ?? null, timed: r.timed === 1, answers: r.answers ?? null, ...scheduleFields(r), handedTo: parseHandedTo(r.handed_to), settledBy: r.settled_by ?? null, settledAt: r.settled_at ?? null, before: r.before_day ?? null, holds: r.holds ?? null, partOfDay: readPartOfDay(r.part_of_day), firm: r.firm !== 0, dueDay: r.due_day ?? null, personKey: r.person_key ?? null, arrivedHint: r.arrived_hint ?? null, movedAt: r.moved_at ?? null });

export function own(c: Ctx): Set<string> {
  const out = new Set<string>();
  for (const a of T(c, "accounts").all()) out.add(addressKey(String(a.email)));
  for (const k of T(c, "correspondents").keysBy("own", 1)) out.add(addressKey(String(k)));
  return out;
}

const live = (r: R) => r.state === "open" || r.state === "due";
/** Plan 280: a kind the app doesn't know is read as unknown and never shown */
const known = (r: R) => isFollowupKind(r.kind);
const activeCount = (c: Ctx) => T(c, "followups").by("state", "open").length + T(c, "followups").by("state", "due").length;

/** As SQL's `admitFollowup` (plan 280, revision 9). */
export function admitFollowup(c: Ctx, worth: number): boolean {
  if (activeCount(c) < FOLLOWUPS_ACTIVE_MAX) return true;
  if (worth <= 0) return false;
  const rows = T(c, "followups");
  let best: { r: R; worth: number } | null = null;
  for (const v of [...rows.by("state", "open"), ...rows.by("state", "due")].filter((x) => x.kind !== "promise").sort((a, b) => a.sent_at - b.sent_at || a.id - b.id)) {
    const w = known(v) ? followupWorth({ kind: v.kind, dated: v.dated, firm: v.firm ?? 1 }) : -1;
    if (w >= worth || w >= FOLLOWUP_WORTH_KEPT) continue;
    if (!best || w < best.worth) best = { r: v, worth: w };
  }
  if (!best) return false;
  rows.deleteRow(best.r);
  return true;
}
const unconfirmed = (m: R) => String(m.provider_msg_id ?? "local:").startsWith("local:");

/**
 * As SQL's `TRUSTED_SENT` (packages/db/src/followups.ts): mail that is yours for certain, never a forged From nor a local
 * copy not confirmed; Terno's own confirmed send (`sent_confirmed`, absent on older records: not confirmed here) too.
 */
export const trustedSend = (m: R): boolean => !!m.is_sent && !m.is_draft && !m.is_spam && !m.is_trash && (m.sent_confirmed === 1 || (!String(m.provider_msg_id ?? "local:").startsWith("local:") && String(m.gmail_labels ?? "").includes('"SENT"')));

/** `confirmed`: Terno's own send, confirmed (plan 210, iteration 3): yours for certain without Gmail's label. */
function markSent(c: Ctx, messageId: number, now: number, source: "live" | "scan", since?: number | null, confirmed = false): void {
  const m = T(c, "messages").get(messageId);
  if (!m || !m.is_sent || m.is_draft || (since != null && m.date < since)) return;
  const mine = own(c);
  if (![...recipientList(m.to_json).addresses, ...recipientList(m.cc_json).addresses].some((a) => !mine.has(addressKey(a)))) return;
  const marks = T(c, "ai_sent_mail");
  if (!marks.has(messageId)) marks.insert({ message_id: messageId, thread_id: m.thread_id, sent_at: m.date, queued_at: now, source, confirmed: confirmed ? 1 : 0 });
}

/** As SQL's: how many of your replies after a request read late are read again for their verdict on it. */
const REMARKED_REPLIES = 3;

/** As SQL's (`remarkReplies`): in the dated reader's finish. */
export function remarkReplies(c: Ctx, threadId: number, after: number, since: number | null, now: number): void {
  const marks = T(c, "ai_sent_mail");
  const replies = T(c, "messages").by("fk_thread_id", threadId).filter((m) => m.date > after && m.date >= (since ?? 0) && trustedSend(m) && !marks.has(m.id)).sort((a, b) => a.date - b.date || a.id - b.id).slice(0, REMARKED_REPLIES);
  for (const m of replies) markSent(c, m.id, now, "live", since);
}

function closeWaitsBefore(c: Ctx, messageId: number, now: number): void {
  const m = T(c, "messages").get(messageId);
  if (!m) return;
  const rows = T(c, "followups");
  for (const r of rows.by("fk_thread_id", m.thread_id)) if (r.kind === "awaiting" && live(r) && r.sent_at < m.date) rows.update(r, { state: "done", closed_reason: "superseded", closed_at: now, inbox_state: "none", revision: r.revision + 1 });
}

export function followupSendConfirmed(c: Ctx, messageId: number, now: number, wanted: boolean, since?: number | null): void {
  // as SQL's: yours for certain for good, not only while its mark waits to be read
  const messages = T(c, "messages");
  const m = messages.get(messageId);
  if (m?.is_sent) messages.update(m, { sent_confirmed: 1 });
  closeWaitsBefore(c, messageId, now);
  // what you sent before you turned it on is read only with a yes
  if (wanted) markSent(c, messageId, now, "live", since, true);
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
  const owed = T(c, "ai_owed_mail");
  for (const m of owed.by("thread", from)) owed.update(m, { thread_id: into });
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

/**
 * Plan 211 (revision 11, Codex code review 6): one account's, never another's mail: its sent mail (the `sent` index, fewer
 * than its conversations), the window's taken as it's walked, what's tracked asked of its conversation's rows (an index),
 * only the window's sorted.
 */
export function followupScanCandidates(c: Ctx, since: number, limit: number, accountId: number): number[] {
  const followups = T(c, "followups");
  // once a conversation (Codex code review, round 2: a long one's rows were read again for each message you sent in it)
  const tracked = new Map<number, Set<number>>();
  const trackedIn = (threadId: number) => tracked.get(threadId) ?? tracked.set(threadId, new Set(followups.by("fk_thread_id", threadId).map((r) => r.message_id as number))).get(threadId)!;
  const out: R[] = [];
  for (const m of T(c, "messages").by("sent", accountId)) {
    if (m.is_spam || m.is_trash || m.date < since || m.list_id != null || m.is_bulk || unconfirmed(m)) continue;
    if (!trackedIn(m.thread_id).has(m.id)) out.push(m);
  }
  return out.sort((a, b) => b.date - a.date || b.id - a.id).slice(0, limit).map((m) => m.id);
}

export function followupSource(c: Ctx, messageId: number): FollowupSource | null {
  const messages = T(c, "messages");
  const m = messages.get(messageId);
  if (!m) return null;
  const mine = own(c);
  // what it answers: the message it says it answers; only with none, the newest before it from someone else
  const target = m.in_reply_to ? messages.by("rfc", m.account_id, m.in_reply_to).find((x) => x.id !== m.id && !x.is_draft && !x.is_spam && !x.is_trash) : undefined;
  // it names one we can't use (gone, or your own): nothing, rather than a message it isn't answering
  const before = m.in_reply_to ? (target && !mine.has(addressKey(String(target.from_email))) ? target : undefined) : messages.by("fk_thread_id", m.thread_id)
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
    // plan 280 (the Fable review): as SQL's
    trusted: trustedSend(m) || T(c, "ai_sent_mail").get(messageId)?.confirmed === 1,
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

/** Plan 210 (iteration 3), as SQL's: an open request of this reply's conversation from before it (round 16: or a bill from someone it writes to). */
function answerable(c: Ctx, id: number, src: { threadId: number; date: number; to: readonly { email: string }[]; cc: readonly { email: string }[] }): R | null {
  const r = T(c, "dated_items").get(id);
  return r && r.state === "open" && replyAnswers({ kind: String(r.kind), senderKey: String(r.sender_key ?? "") }, replyRecipients(src)) && r.thread_id === src.threadId && r.arrived_at < src.date ? r : null;
}

/**
 * As SQL's (`apart`): a promise its verdict links to a request is never one item with it, nor are the reply's other readings
 * of it (the code review's second round), which answer the request too; no revision moves.
 */
function apart(c: Ctx, promiseId: number, requestId: number): void {
  const key = (id: number) => refKey({ source: "promise", id });
  const [promise, request] = [key(promiseId), refKey({ source: "dated", id: requestId })];
  const followups = T(c, "followups");
  const dated = T(c, "dated_items");
  const p = followups.get(promiseId)!;
  const r = dated.get(requestId)!;
  const [item, mine] = [r.same_as ?? request, p.same_as ?? promise];
  const canonical = (x: R) => x.same_as ?? key(x.id);
  const readings = followups
    .by("fk_thread_id", p.thread_id)
    .filter((x) => x.message_id === p.message_id && x.kind === "promise" && live(x) && (x.id === promiseId || canonical(x) === item || canonical(x) === mine))
    .map((x) => (x.id !== promiseId && x.answers == null ? followups.update(x, { answers: requestId }) : x));
  if (!readings.some((x) => canonical(x) === item)) return;
  if (readings.some((x) => key(x.id) === item)) {
    dated.update(r, { same_as: null });
    for (const x of dated.by("same", item)) if ((ANSWERED_KINDS as readonly string[]).includes(x.kind)) dated.update(x, { same_as: request });
    for (const x of readings) if (x.same_as == null && key(x.id) !== item && !followups.count("same", key(x.id)) && !dated.count("same", key(x.id))) followups.update(x, { same_as: item });
    return;
  }
  const lead = mine === item ? promise : mine;
  for (const x of readings) if (x.same_as === item) followups.update(x, { same_as: key(x.id) === lead ? null : lead });
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
  // as SQL's: only a reply that's yours for certain decides a request, or records or closes a promise of theirs (plan 280)
  const yours = mark.confirmed === 1 || trustedSend(T(c, "messages").get(w.messageId) ?? {});
  const later = T(c, "messages").by("fk_thread_id", src.threadId).some((m) => m.date > src.date && m.is_sent && !m.is_draft && !m.is_trash && !m.is_spam && !String(m.provider_msg_id ?? "").startsWith("local:"));
  // as SQL's (plan 210, round 14's faults, the second morning): a promise said again is the older's
  const renewed = new Map<number, number>();
  const renew = (r: FollowupFinish["rows"][number], to: NonNullable<FollowupFinish["rows"][number]["renews"]>): boolean => {
    const again = [...renewed.values()].includes(to.id);
    const p = again ? undefined : rows.get(to.id);
    const older = p && p.revision === to.revision && p.thread_id === src.threadId && p.kind === "promise" && live(p) ? p : null;
    if (!again && !older) return false;
    if (older && (r.dated || older.dated === 0)) {
      rows.update(older, { due_at: r.dueAt, dated: r.dated ? 1 : 0, state: r.dueAt > w.now ? "open" : older.state, inbox_state: "none", broken_due_at: older.broken_due_at ?? to.brokenDueAt, timed: r.timed ? 1 : 0, before_day: null, part_of_day: r.partOfDay ?? null, revision: older.revision + 1 });
    }
    renewed.set(r.item, to.id);
    return true;
  };
  for (const r of w.rows) {
    if (r.kind === "awaiting" && (later || replied(c, mine, { accountId: src.accountId, threadId: src.threadId, sentAt: src.date, rfcMessageId: src.rfcMessageId }))) continue;
    if (rows.by("identity", w.messageId, r.item).length) continue;
    if (r.kind === "promise" && r.renews && renew(r, r.renews)) continue;
    if (r.kind === "theirs" && (!yours || !r.personEmail)) continue;
    // plan 280 (revision 9): one admission rule for every row that becomes active
    if (!admitFollowup(c, followupWorth(r))) continue;
    rows.put({ thread_id: src.threadId, message_id: w.messageId, rfc_message_id: src.rfcMessageId, item: r.item, kind: r.kind, text: r.text, quote: r.quote, person_name: r.personName, person_email: r.personEmail, sent_at: src.date, due_at: r.dueAt, dated: r.dated ? 1 : 0, deferred_until: null, state: "open", inbox_state: "none", closed_reason: null, closed_at: null, notified_at: null, from_scan: w.fromScan ? 1 : 0, revision: 0, model: w.model, provider: w.provider, prompt_version: w.promptVersion, created_at: w.now, timed: r.timed ? 1 : 0, part_of_day: r.partOfDay ?? null, firm: r.firm === false ? 0 : 1, due_day: r.kind === "theirs" ? (r.dueDay ?? null) : null, person_key: r.kind === "theirs" && r.personEmail ? addressKey(r.personEmail) : null, arrived_hint: null });
  }
  const dated = T(c, "dated_items");
  const settle = (r: R, revision: number): boolean => {
    if (r.revision !== revision || r.state !== "open") return false;
    dated.update(r, { state: "settled", closed_reason: replyClosedReason(r.kind), closed_at: w.now, settled_by: w.messageId, settled_at: src.date, revision: r.revision + 1 });
    return true;
  };
  for (const v of yours ? (w.verdicts ?? []) : []) {
    const r = answerable(c, v.request.id, src);
    // as SQL's: either verdict only on the request as it was shown
    if (!r || r.revision !== v.request.revision) continue;
    if (v.verdict === "fulfilled") {
      // as SQL's (the second morning and its code review): the promises that answer it kept with it, once the verdict passed
      if (settle(r, r.revision)) {
        for (const p of rows.by("fk_thread_id", src.threadId)) {
          if (p.answers === r.id && p.kind === "promise" && live(p) && p.sent_at < src.date && p.message_id !== w.messageId) rows.update(p, { state: "done", closed_reason: "kept", closed_at: w.now, settled_by: w.messageId, settled_at: src.date, inbox_state: "none", revision: p.revision + 1 });
        }
      }
      continue;
    }
    // as SQL's (round 16's code review): a bill is only ever paid by a reply, never linked to a promise or held by one
    if (!(ANSWERED_KINDS as readonly string[]).includes(r.kind)) continue;
    // plan 210 (iteration 4): a promise that only holds it is stored with it, once (no revision moves)
    // (its own row, or the older one it said again)
    const renewedRow = renewed.has(v.item) ? rows.get(renewed.get(v.item)!) : undefined;
    const p = [...rows.by("identity", w.messageId, v.item), ...(renewedRow ? [renewedRow] : [])].find((x) => x.kind === "promise" && live(x) && x.answers == null && x.holds == null);
    if (v.verdict === "holding") {
      if (p) rows.update(p, { holds: r.id });
      continue;
    }
    // the promise this reply made (its own row, an open one), linked once
    if (!p) continue;
    rows.update(p, { answers: r.id });
    apart(c, p.id, r.id);
  }
  for (const k of w.kept) {
    const r = rows.get(k.id);
    if (r && r.revision === k.revision && r.thread_id === src.threadId && r.kind === "promise" && live(r)) {
      rows.update(r, { state: "done", closed_reason: "kept", closed_at: w.now, settled_by: w.messageId, settled_at: src.date, inbox_state: "none", revision: r.revision + 1 });
      // plan 210 (iteration 3): what it promised to a request is sent: the request is answered with it
      const request = yours && r.answers != null ? answerable(c, r.answers, src) : null;
      if (request) settle(request, request.revision);
    }
  }
  // plan 280 (§3): your words say a promise of theirs arrived: this conversation's, at the revision shown
  for (const k of yours ? (w.owedKept ?? []) : []) {
    const r = rows.get(k.id);
    if (r && r.revision === k.revision && r.thread_id === src.threadId && r.kind === "theirs" && live(r) && r.sent_at < src.date && (r.moved_at ?? r.sent_at) < src.date) rows.update(r, { state: "done", closed_reason: "kept", closed_at: w.now, settled_by: w.messageId, settled_at: src.date, inbox_state: "none", revision: r.revision + 1 });
  }
  marks.deleteRow(mark);
  return "written";
}

const byDue = (a: R, b: R) => a.due_at - b.due_at || a.id - b.id;
/** `followupWakeAt`: a promise's Later, if later than its moment (a row stored before it has none) */
const wakeAt = (r: R): number => Math.max(r.due_at, r.deferred_until ?? r.due_at);

export function activeFollowups(c: Ctx): FollowupRow[] {
  const rows = T(c, "followups");
  return [...rows.by("state", "open"), ...rows.by("state", "due")].sort(byDue).slice(0, FOLLOWUPS_ACTIVE_MAX).filter(known).map(toRow);
}
/** Plan 210: your closed promises newest first by `(closed_at, id)`, strictly after `after` (SQLite's `followups_closed`). */
export function closedFollowupPage(c: Ctx, o: { since: number; after: ClosedAt | null; limit: number }): FollowupRow[] {
  return c.closedOrders.followups.page(T(c, "followups"), o).map(toRow);
}

export const threadFollowups = (c: Ctx, threadId: number): FollowupRow[] => T(c, "followups").by("fk_thread_id", threadId).filter((r) => live(r) && known(r)).sort(byDue).map(toRow);
/** As SQL's: a whole row as stored, for a batch read elsewhere (`itemMembers`). */
export { toRow as followupRow };

export function getFollowup(c: Ctx, id: number): FollowupRow | null {
  const r = T(c, "followups").get(id);
  return r && known(r) ? toRow(r) : null;
}
export function nextFollowupDue(c: Ctx): number | null {
  let at: number | null = null;
  // (as SQL's: only kinds the app knows)
  for (const r of T(c, "followups").by("state", "open")) if (known(r) && (at === null || wakeAt(r) < at)) at = wakeAt(r);
  return at;
}

export function makeFollowupsDue(c: Ctx, now: number): FollowupRow[] {
  const rows = T(c, "followups");
  const out: FollowupRow[] = [];
  for (const r of rows.by("state", "open")) {
    if (wakeAt(r) > now || !known(r)) continue;
    // plan 280 (revision 11): as SQL's, one rule for the top
    out.push(toRow(rows.update(r, { state: "due", inbox_state: onTopEligible(toRow(r)) ? "onTop" : "none", revision: r.revision + 1 })));
  }
  return out;
}

export function claimFollowupNotice(c: Ctx, ids: readonly number[], now: number): number[] {
  const rows = T(c, "followups");
  return ids.filter((id) => {
    const r = rows.get(id);
    // (plan 218: never a closed one: Done or Dismiss may have closed it since the look that's saying it)
    if (!r || r.notified_at != null || !live(r)) return false;
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

const snapshot = (r: R): FollowupSnapshot => ({ id: r.id, revision: r.revision, state: r.state, dueAt: r.due_at, deferredUntil: r.deferred_until ?? null, inboxState: r.inbox_state, closedReason: r.closed_reason ?? null, closedAt: r.closed_at ?? null });

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

/** As SQL's `followupsInTrashOrSpam`: the thread records only. */
export function followupsInTrashOrSpam(c: Ctx, threadIds: readonly number[]): Set<number> {
  const threads = T(c, "threads");
  const out = new Set<number>();
  for (const id of new Set(threadIds)) {
    const t = threads.get(id);
    if (t && (t.in_trash || t.in_spam)) out.add(id);
  }
  return out;
}

export function updateFollowup(c: Ctx, id: number, revision: number, patch: Partial<Pick<FollowupRow, "state" | "dueAt" | "deferredUntil" | "inboxState" | "closedReason" | "closedAt">>): FollowupSnapshot | null {
  const rows = T(c, "followups");
  const r = rows.get(id);
  if (!r || r.revision !== revision) return null;
  const before = snapshot(r);
  rows.update(r, { state: patch.state ?? r.state, due_at: patch.dueAt ?? r.due_at, deferred_until: patch.deferredUntil !== undefined ? patch.deferredUntil : (r.deferred_until ?? null), inbox_state: patch.inboxState ?? r.inbox_state, closed_reason: patch.closedReason !== undefined ? patch.closedReason : (r.closed_reason ?? null), closed_at: patch.closedAt !== undefined ? patch.closedAt : (r.closed_at ?? null), revision: r.revision + 1 });
  return before;
}

export function restoreFollowups(c: Ctx, list: readonly { snapshot: FollowupSnapshot; expectRevision: number }[]): number {
  const rows = T(c, "followups");
  let n = 0;
  for (const { snapshot: s, expectRevision } of list) {
    const r = rows.get(s.id);
    if (!r || r.revision !== expectRevision) continue;
    // plan 280 (revision 9, the code review): as SQL's, admitted as a new row is
    if (!live(r) && (s.state === "open" || s.state === "due") && !admitFollowup(c, followupWorth({ kind: r.kind, dated: r.dated, firm: r.firm ?? 1 }))) continue;
    // the deferral as it was, null too (a journal from before it has none)
    rows.update(r, { state: s.state, due_at: s.dueAt, deferred_until: s.deferredUntil ?? null, inbox_state: s.inboxState, closed_reason: s.closedReason, closed_at: s.closedAt, revision: r.revision + 1 });
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
  const owed = T(c, "ai_owed_mail");
  for (const r of owed.all()) owed.deleteRow(r);
}
