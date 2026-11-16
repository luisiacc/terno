import { addressKey, ANSWERED_KINDS, DATED_ACTIVE_MAX, DATED_CLOSED_KEEP_MS, senderIsPerson, THREAD_SCOPED_KINDS, waitingCutoff, type DatedRow } from "@terno/core";
import { DATED_MARK_MS, DATED_SCAN_MARK_MS, datedTab, NEW_MAIL_MS, readerIn, readNothingAsked, recipientList, type ClosedAt, type DatedFinish, type DatedFinishOutcome, type DatedMark, type DatedSnapshot, type DatedSource } from "@terno/store";
import { received, receivedOwn } from "./ai-summaries";
import { remarkReplies } from "./followups";
import { T, type Ctx, type R } from "./mail";

/** Plan 204 on IndexedDB, like SQL's (packages/db/src/dated.ts). */

const toRow = (r: R): DatedRow => ({
  id: r.id, threadId: r.thread_id, messageId: r.message_id, item: r.item, kind: r.kind, text: r.text, quote: r.quote, senderKey: r.sender_key, dueDay: r.due_day, dueAt: r.due_at, timed: r.timed === 1, dated: r.dated === 1, actAt: r.act_at,
  deferredUntil: r.deferred_until ?? null, arrivedAt: r.arrived_at, state: r.state, closedReason: r.closed_reason ?? null, closedAt: r.closed_at ?? null, fromScan: r.from_scan === 1, revision: r.revision, model: r.model ?? null, provider: r.provider ?? null, createdAt: r.created_at,
  // plan 210 (iteration 2): a row stored before them has none
  early: r.early === 1, sameAs: r.same_as ?? null, detailOf: r.detail_of ?? null, lapses: r.lapses === 1,
});

const byAct = (a: R, b: R) => a.act_at - b.act_at || a.id - b.id;

/** As SQL's: a message reaches its thread's items, and its sender's elsewhere but for `THREAD_SCOPED_KINDS` (the sixth panel round). */
const reaches = (r: R, src: { threadId: number; senderKey: string }): boolean => r.thread_id === src.threadId || (r.sender_key === src.senderKey && !THREAD_SCOPED_KINDS.includes(r.kind));

/** Ingest's part (in its command): received live mail, by the new-mail rule, and since the feature went on. */
export function markDatedMail(c: Ctx, messageIds: readonly number[], now: number, since: number | null): void {
  if (!messageIds.length) return;
  const messages = T(c, "messages");
  const marks = T(c, "ai_dated_mail");
  const own = receivedOwn(c);
  const floor = since == null ? now - NEW_MAIL_MS : Math.max(now - NEW_MAIL_MS, since);
  for (const id of messageIds) {
    const m = messages.get(id);
    if (!m || !received(m, own) || m.date < floor || marks.has(id)) continue;
    marks.insert({ message_id: id, thread_id: m.thread_id, arrived_at: m.date, queued_at: now, source: "live" });
  }
}

/** A merge: the marks follow their messages, and the items their thread (a new revision: what was shown has moved). */
export function mergeDated(c: Ctx, into: number, from: number): void {
  const marks = T(c, "ai_dated_mail");
  for (const m of marks.by("thread", from)) marks.update(m, { thread_id: into });
  const read = T(c, "dated_nothing_asked");
  for (const r of read.by("thread", from)) read.update(r, { thread_id: into });
  const rows = T(c, "dated_items");
  for (const r of rows.by("fk_thread_id", from)) rows.update(r, { thread_id: into, revision: r.revision + 1 });
}

const toMark = (r: R): DatedMark => ({ messageId: r.message_id, threadId: r.thread_id, arrivedAt: r.arrived_at, queuedAt: r.queued_at, source: r.source });

export function datedMarkPage(c: Ctx, after: { arrivedAt: number; messageId: number } | null, limit: number): DatedMark[] {
  return [...T(c, "ai_dated_mail").all()]
    .filter((r) => !after || r.arrived_at > after.arrivedAt || (r.arrived_at === after.arrivedAt && r.message_id > after.messageId))
    .sort((a, b) => a.arrived_at - b.arrived_at || a.message_id - b.message_id)
    .slice(0, limit)
    .map(toMark);
}

export const datedMarkCount = (c: Ctx): number => T(c, "ai_dated_mail").size;

/** Plan 210 (iteration 3): a message of this conversation from before then still to be read. */
export const datedPendingOn = (c: Ctx, threadId: number, before: number): boolean => T(c, "ai_dated_mail").by("thread", threadId).some((m) => m.arrived_at < before);

/** Not marked, not read: what a check may still take. */
const unread = (c: Ctx, id: number): boolean => !T(c, "ai_dated_mail").has(id) && T(c, "dated_items").count("message", id) === 0;

export function queueDatedScan(c: Ctx, messageIds: readonly number[], now: number): number {
  const messages = T(c, "messages");
  const marks = T(c, "ai_dated_mail");
  const own = receivedOwn(c);
  let n = 0;
  for (const id of messageIds) {
    const m = messages.get(id);
    if (!m || !received(m, own) || !unread(c, id)) continue;
    marks.insert({ message_id: id, thread_id: m.thread_id, arrived_at: m.date, queued_at: now, source: "scan" });
    n++;
  }
  return n;
}

export function pruneDatedMarks(c: Ctx, now: number): number {
  const marks = T(c, "ai_dated_mail");
  const old = [...marks.all()].filter((r) => r.queued_at < now - (r.source === "scan" ? DATED_SCAN_MARK_MS : DATED_MARK_MS));
  for (const r of old) marks.deleteRow(r);
  return old.length;
}

export function datedScanCandidates(c: Ctx, since: number, limit: number): number[] {
  const own = receivedOwn(c);
  const out: R[] = [];
  for (const m of T(c, "messages").all()) if (m.date >= since && received(m, own) && unread(c, m.id)) out.push(m);
  return out.sort((a, b) => b.date - a.date || b.id - a.id).slice(0, limit).map((m) => m.id);
}

export function datedSource(c: Ctx, messageId: number): DatedSource | null {
  const messages = T(c, "messages");
  const m = messages.get(messageId);
  const thread = m && T(c, "threads").get(m.thread_id);
  if (!m || !thread) return null;
  const email = String(m.from_email ?? "");
  const people = (json: string) => {
    const list = recipientList(json);
    return list.addresses.map((address) => ({ name: list.names[address] ?? "", email: address }));
  };
  const to = people(m.to_json);
  const cc = people(m.cc_json);
  const mine = new Set<string>();
  for (const a of T(c, "accounts").all()) mine.add(addressKey(String(a.email)));
  for (const k of T(c, "correspondents").keysBy("own", 1)) mine.add(addressKey(String(k)));
  return {
    id: m.id, threadId: m.thread_id, accountId: m.account_id, subject: m.subject ?? "", date: m.date, fromName: m.from_name ?? "", fromEmail: email, senderKey: addressKey(email),
    to, cc, readerIn: readerIn(to, cc, mine),
    automated: !!m.is_bulk || m.list_id != null, tab: datedTab(Number(thread.tab ?? 0), m.category ?? null),
    person: senderIsPerson({ from_email: email, list_id: m.list_id ?? null, is_bulk: m.is_bulk ? 1 : 0, gmail_labels: m.gmail_labels ?? null, is_spam: m.is_spam ? 1 : 0 }, { written: (key) => T(c, "correspondents").get(key)?.written === 1 }),
    draft: !!m.is_draft, sent: !!m.is_sent, spam: !!m.is_spam, trash: !!m.is_trash, threadSpam: messages.by("fk_thread_id", m.thread_id).some((x) => !!x.is_spam), own: receivedOwn(c).has(email.toLowerCase()),
    bodyState: m.body_state, bodyUnavailable: m.attachments_captured === 2 && m.body_state !== "full",
  };
}

export function openDatedFor(c: Ctx, o: { threadId: number; senderKey: string; before: number; limit: number }): DatedRow[] {
  const rows = T(c, "dated_items");
  const found = new Map<number, R>();
  for (const r of rows.by("fk_thread_id", o.threadId)) if (r.state === "open") found.set(r.id, r);
  for (const r of rows.by("sender", o.senderKey)) if (r.state === "open" && reaches(r, o)) found.set(r.id, r);
  // Codex code review: an item whose conversation has anything in Spam is never material for a request (the owner's rule)
  const messages = T(c, "messages");
  const spam = new Map<number, boolean>();
  const inSpam = (threadId: number) => spam.get(threadId) ?? spam.set(threadId, messages.by("fk_thread_id", threadId).some((x) => !!x.is_spam)).get(threadId)!;
  return [...found.values()].filter((r) => r.arrived_at < o.before && !inSpam(r.thread_id)).sort((a, b) => b.arrived_at - a.arrived_at || b.id - a.id).slice(0, o.limit).map(toRow);
}

export function finishDated(c: Ctx, w: DatedFinish): DatedFinishOutcome {
  const marks = T(c, "ai_dated_mail");
  const mark = marks.get(w.messageId);
  if (!mark) return "gone";
  const src = datedSource(c, w.messageId);
  if (!src || src.spam || src.trash || src.draft || src.threadSpam) {
    marks.deleteRow(mark);
    return "gone";
  }
  // a merge since it was read: the mark stays, and the worker reads it again on its thread
  if (src.threadId !== w.threadId) return "moved";
  const rows = T(c, "dated_items");
  let open = rows.count("state", "open");
  for (const r of w.rows) {
    if (rows.by("identity", w.messageId, r.item).length) continue;
    // plan 210 (iteration 3): a request read after your reply is stored open like any other: only a reply's verdict settles it
    if (open >= DATED_ACTIVE_MAX) {
      // the bound keeps the soonest: the furthest of them all isn't added
      let furthest: R | undefined;
      for (const x of rows.by("state", "open")) if (!furthest || byAct(x, furthest) > 0) furthest = x;
      if (!furthest || furthest.act_at <= r.actAt) continue;
      rows.deleteRow(furthest);
      open--;
    }
    rows.put({
      thread_id: src.threadId, message_id: w.messageId, item: r.item, kind: r.kind, text: r.text, quote: r.quote, sender_key: src.senderKey, due_day: r.dueDay, due_at: r.dueAt, timed: r.timed ? 1 : 0, dated: r.dated ? 1 : 0, act_at: r.actAt,
      deferred_until: null, arrived_at: src.date, state: "open", closed_reason: null, closed_at: null, from_scan: w.fromScan ? 1 : 0, revision: 0, model: w.model, provider: w.provider, prompt_version: w.promptVersion, created_at: w.now, early: r.early ? 1 : 0, lapses: r.lapses ? 1 : 0,
    });
    open++;
  }
  for (const s of w.settled) {
    const r = rows.get(s.id);
    if (r && r.revision === s.revision && r.state === "open" && reaches(r, src)) rows.update(r, { state: "settled", closed_reason: "settled", closed_at: w.now, revision: r.revision + 1 });
  }
  const followups = T(c, "followups");
  // plan 210 (iteration 3, revision 4): as SQL's, a promise its person replaced, closed with the request that replaces it
  for (const r of w.replaced ?? []) {
    if (!rows.by("identity", w.messageId, r.item).length) continue;
    const p = followups.get(r.id);
    if (!p || p.revision !== r.revision || p.thread_id !== src.threadId || p.kind !== "promise" || (p.state !== "open" && p.state !== "due")) continue;
    if (!p.person_email || addressKey(String(p.person_email)) !== src.senderKey || p.sent_at >= src.date) continue;
    followups.update(p, { state: "dismissed", closed_reason: "replaced", closed_at: w.now, inbox_state: "none", revision: p.revision + 1 });
  }
  for (const m of w.movedPromises ?? []) {
    const p = followups.get(m.id);
    if (!p || p.revision !== m.revision || p.thread_id !== src.threadId || p.kind !== "promise" || (p.state !== "open" && p.state !== "due")) continue;
    // plan 210 (iteration 2): its first broken day kept, and whether its new moment is a stated time (absent: as it was)
    followups.update(p, { due_at: m.dueAt, dated: 1, state: m.dueAt > w.now ? "open" : p.state, inbox_state: "none", broken_due_at: p.broken_due_at ?? m.brokenDueAt ?? null, ...(m.timed !== undefined ? { timed: m.timed ? 1 : 0 } : {}), revision: p.revision + 1 });
  }
  for (const m of w.moved ?? []) {
    const r = rows.get(m.id);
    // its new words, if it gives some, in the same write (the fifth panel round)
    if (r && r.state === "open" && reaches(r, src)) rows.update(r, { due_day: m.dueDay, due_at: m.dueAt, timed: m.timed ? 1 : 0, dated: 1, act_at: m.actAt, ...(m.text ? { text: m.text } : {}) });
  }
  // plan 210 (iteration 3): as SQL's, a request a reply of yours already followed goes to the follow-ups reader with it again
  if (w.replies && w.rows.some((r) => ANSWERED_KINDS.includes(r.kind))) remarkReplies(c, src.threadId, src.date, w.replies.since, w.now);
  // plan 210 (iteration 2): as SQL's, in the same command
  const read = T(c, "dated_nothing_asked");
  if (readNothingAsked(w)) read.put({ message_id: w.messageId, thread_id: src.threadId, arrived_at: src.date, prompt_version: w.promptVersion });
  else read.delete(w.messageId);
  marks.deleteRow(mark);
  return "written";
}

export const activeDated = (c: Ctx): DatedRow[] => T(c, "dated_items").by("state", "open").sort(byAct).slice(0, DATED_ACTIVE_MAX).map(toRow);
export const datedWritten = (c: Ctx, keys: readonly string[]): Set<string> => {
  const correspondents = T(c, "correspondents");
  return new Set([...new Set(keys)].filter((key) => correspondents.get(key)?.written === 1));
};
/** Plan 210: closed rows newest first by `(closed_at, id)`, strictly after `after`, by the closing-time order. */
export function closedDatedPage(c: Ctx, o: { since: number; after: ClosedAt | null; limit: number }): DatedRow[] {
  return c.closedOrders.dated.page(T(c, "dated_items"), o).map(toRow);
}


export const threadDated = (c: Ctx, threadId: number): DatedRow[] => T(c, "dated_items").by("fk_thread_id", threadId).filter((r) => r.state === "open").sort(byAct).map(toRow);
export function getDated(c: Ctx, id: number): DatedRow | null {
  const r = T(c, "dated_items").get(id);
  return r ? toRow(r) : null;
}

const snapshot = (r: R): DatedSnapshot => ({ id: r.id, revision: r.revision, state: r.state, deferredUntil: r.deferred_until ?? null, closedReason: r.closed_reason ?? null, closedAt: r.closed_at ?? null });

export function updateDated(c: Ctx, id: number, revision: number, patch: Partial<Pick<DatedRow, "state" | "deferredUntil" | "closedReason" | "closedAt">>, schedule?: { dueDay: string; dueAt: number }): DatedSnapshot | null {
  const rows = T(c, "dated_items");
  const r = rows.get(id);
  if (!r || r.revision !== revision || (schedule && (r.due_day !== schedule.dueDay || r.due_at !== schedule.dueAt))) return null;
  const before = snapshot(r);
  rows.update(r, {
    state: patch.state ?? r.state, deferred_until: patch.deferredUntil !== undefined ? patch.deferredUntil : before.deferredUntil, closed_reason: patch.closedReason !== undefined ? patch.closedReason : before.closedReason, closed_at: patch.closedAt !== undefined ? patch.closedAt : before.closedAt, revision: r.revision + 1,
  });
  return before;
}

export function restoreDated(c: Ctx, list: readonly { snapshot: DatedSnapshot; expectRevision: number }[]): number {
  const rows = T(c, "dated_items");
  let n = 0;
  for (const { snapshot: s, expectRevision } of list) {
    const r = rows.get(s.id);
    if (!r || r.revision !== expectRevision) continue;
    rows.update(r, { state: s.state, deferred_until: s.deferredUntil, closed_reason: s.closedReason, closed_at: s.closedAt, revision: r.revision + 1 });
    n++;
  }
  return n;
}

export function pruneDated(c: Ctx, now: number): number {
  const rows = T(c, "dated_items");
  // plan 210 (iteration 3): never a request an open promise of yours answers
  const followups = T(c, "followups");
  const answered = (id: number) => followups.by("answers", id).some((f) => f.state === "open" || f.state === "due");
  const old = [...rows.by("state", "done"), ...rows.by("state", "dismissed"), ...rows.by("state", "settled")].filter((r) => (r.closed_at ?? r.created_at) < now - DATED_CLOSED_KEEP_MS && !answered(r.id));
  for (const r of old) rows.deleteRow(r);
  // past the waiting window, no conversation it's the latest of is waiting
  const read = T(c, "dated_nothing_asked");
  const past = [...read.all()].filter((r) => r.arrived_at < waitingCutoff(now));
  for (const r of past) read.deleteRow(r);
  return old.length + past.length;
}

export function clearDated(c: Ctx): void {
  const rows = T(c, "dated_items");
  for (const r of rows.all()) rows.deleteRow(r);
  const marks = T(c, "ai_dated_mail");
  for (const r of marks.all()) marks.deleteRow(r);
  const read = T(c, "dated_nothing_asked");
  for (const r of read.all()) read.deleteRow(r);
}
