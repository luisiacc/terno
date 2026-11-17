import { addressKey, ANSWERED_KINDS, parseHandedTo, readPartOfDay, refKey, replyAnswers, replyClosedReason, replyRecipients, type FollowupRow } from "@terno/core";
import { FOLLOWUP_CLOSED_KEEP_MS, FOLLOWUPS_ACTIVE_MAX, recipientList, SCAN_MARK_MS, SENT_MARK_MS, type ClosedAt, type FollowupFinish, type FollowupFinishOutcome, type FollowupSnapshot, type FollowupSource, type SentMark } from "@terno/store";
import { ownAddresses } from "./facts";
import { scheduleFields } from "./schedule";
import type { Db } from "./sqlite";

/** Plan 142 on SQLite (v52; v58 a promise's Later): see packages/store/src/followups.ts. */

interface Raw {
  id: number; thread_id: number; message_id: number; rfc_message_id: string | null; item: number; kind: FollowupRow["kind"]; text: string; quote: string | null; person_name: string | null; person_email: string | null;
  sent_at: number; due_at: number; dated: number; deferred_until: number | null; state: FollowupRow["state"]; inbox_state: FollowupRow["inboxState"]; closed_reason: string | null; closed_at: number | null; notified_at: number | null; from_scan: number; revision: number; model: string | null; provider: string | null; created_at: number;
  same_as: string | null; broken_due_at: number | null; timed: number; answers: number | null; settled_by: number | null; settled_at: number | null; before_day: string | null; holds: number | null; part_of_day: string | null;
  changed_at: number | null; changed_from: string | null; proposal: string | null;
  handed_to?: string | null;
}
const toRow = (r: Raw): FollowupRow => ({ id: r.id, threadId: r.thread_id, messageId: r.message_id, rfcMessageId: r.rfc_message_id, item: r.item, kind: r.kind, text: r.text, quote: r.quote, personName: r.person_name, personEmail: r.person_email, sentAt: r.sent_at, dueAt: r.due_at, dated: r.dated === 1, deferredUntil: r.deferred_until ?? null, state: r.state, inboxState: r.inbox_state, closedReason: r.closed_reason, closedAt: r.closed_at, notifiedAt: r.notified_at, fromScan: r.from_scan === 1, revision: r.revision, model: r.model, provider: r.provider, createdAt: r.created_at, sameAs: r.same_as ?? null, brokenDueAt: r.broken_due_at ?? null, timed: r.timed === 1, answers: r.answers ?? null, ...scheduleFields(r), handedTo: parseHandedTo(r.handed_to), settledBy: r.settled_by ?? null, settledAt: r.settled_at ?? null, before: r.before_day ?? null, holds: r.holds ?? null, partOfDay: readPartOfDay(r.part_of_day) });

/** Yours and for someone else: mail only to your own addresses says nothing to anyone. */
function toSomeoneElse(db: Db, to: string, cc: string): boolean {
  const own = ownAddresses(db);
  return [...recipientList(to).addresses, ...recipientList(cc).addresses].some((a) => !own.has(addressKey(a)));
}

/**
 * Codex code review of plan 204's fixes: mail that is yours for certain, not only by its From (IMAP sets `is_sent` for any
 * message claiming your address, in any folder, and the store doesn't keep which folder is Sent): Gmail's SENT label. Never
 * a local copy not confirmed yet. Plan 210 (iteration 3): only such a reply's verdict, or Terno's own confirmed send's
 * (`sent_confirmed`, v64: durable, so a request read later can be answered by it too; a mark's `confirmed` from before it),
 * settles or links a request; one sent from another IMAP client leaves it for the user's Done.
 */
export const TRUSTED_SENT = "is_sent = 1 AND is_draft = 0 AND is_spam = 0 AND is_trash = 0 AND (sent_confirmed = 1 OR (coalesce(provider_msg_id, 'local:') NOT LIKE 'local:%' AND gmail_labels LIKE '%\"SENT\"%'))";

/** `confirmed`: Terno's own send, confirmed (plan 210, iteration 3): yours for certain without Gmail's label. */
function markSent(db: Db, messageId: number, now: number, source: "live" | "scan", since?: number | null, confirmed = false): void {
  const m = db.get<{ thread_id: number; date: number; to_json: string; cc_json: string; is_sent: number; is_draft: number }>("SELECT thread_id, date, to_json, cc_json, is_sent, is_draft FROM messages WHERE id = ?", messageId);
  if (!m || m.is_sent !== 1 || m.is_draft === 1 || (since != null && m.date < since) || !toSomeoneElse(db, m.to_json, m.cc_json)) return;
  db.run("INSERT OR IGNORE INTO ai_sent_mail (message_id, thread_id, sent_at, queued_at, source, confirmed) VALUES (?, ?, ?, ?, ?, ?)", messageId, m.thread_id, m.date, now, source, confirmed ? 1 : 0);
}

/** How many of your replies after a request read late are read again for their verdict on it. */
const REMARKED_REPLIES = 3;

/**
 * Plan 210 (iteration 3): a request read after replies of yours that followed it (the dated reader behind, or its 14-day
 * check): the first few of those replies, yours for certain, sent since follow-ups went on and not marked now, are marked
 * again, so the follow-ups reader gives its verdict on it. In the dated reader's finish.
 */
export function remarkReplies(db: Db, threadId: number, after: number, since: number | null, now: number): void {
  const replies = db.all<{ id: number }>(`SELECT id FROM messages INDEXED BY messages_thread WHERE thread_id = ? AND date > ? AND date >= ? AND ${TRUSTED_SENT} AND NOT EXISTS (SELECT 1 FROM ai_sent_mail s WHERE s.message_id = messages.id) ORDER BY date, id LIMIT ?`, threadId, after, since ?? 0, REMARKED_REPLIES);
  for (const r of replies) markSent(db, r.id, now, "live", since);
}

/** Your own message reached the server: it ends the waits before it on this thread, and the worker decides afresh (revision 3). */
function closeWaitsBefore(db: Db, messageId: number, now: number): void {
  const m = db.get<{ thread_id: number; date: number }>("SELECT thread_id, date FROM messages WHERE id = ?", messageId);
  if (!m) return;
  db.run("UPDATE followups SET state = 'done', closed_reason = 'superseded', closed_at = ?, inbox_state = 'none', revision = revision + 1 WHERE thread_id = ? AND kind = 'awaiting' AND state IN ('open','due') AND sent_at < ?", now, m.thread_id, m.date);
}

/** In the commit that records a send as done. `wanted`: the feature is on for this account. */
export function followupSendConfirmed(db: Db, messageId: number, now: number, wanted: boolean, since?: number | null): void {
  // plan 210 (iteration 3, Codex code review): yours for certain for good, not only while its mark waits to be read
  db.run("UPDATE messages SET sent_confirmed = 1 WHERE id = ? AND is_sent = 1", messageId);
  closeWaitsBefore(db, messageId, now);
  // what you sent before you turned it on is read only with a yes
  if (wanted) markSent(db, messageId, now, "live", since, true);
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

/**
 * Plan 210 (iteration 3): an open request of this reply's conversation from before it: what its verdict may reach. Round 16:
 * or a bill from someone the reply writes to (`replyAnswers`), read from the reply's own row, never the reader's word.
 */
function answerable(db: Db, id: number, src: { threadId: number; date: number; to: readonly { email: string }[]; cc: readonly { email: string }[] }): { id: number; revision: number; kind: string } | null {
  const r = db.get<{ id: number; revision: number; kind: string; state: string; thread_id: number; arrived_at: number; sender_key: string }>("SELECT id, revision, kind, state, thread_id, arrived_at, sender_key FROM dated_items WHERE id = ?", id);
  return r && r.state === "open" && replyAnswers({ kind: r.kind, senderKey: r.sender_key }, replyRecipients(src)) && r.thread_id === src.threadId && r.arrived_at < src.date ? r : null;
}

/**
 * Plan 210 (iteration 3, Codex code review): a promise its reply's verdict links to a request (`answers`) is that request's
 * by the link, never one item with it. The matcher may have made them one by their words before the verdict came (follow-ups
 * read first, the request later): undone in the verdict's commit, so Remove and Later stay the promise's alone. The promise
 * joined to the request's item leaves it; a promise that's the item's canonical keeps the rest, and the request with the
 * requests one with it (its readings) become their own item, the request their canonical. As `link`, no revision moves.
 * The code review's second round: the reply's other readings go with the promise. Its open promises the matcher made one
 * item with the request or with the promise (the same promise read twice, "scan both papers" and "email both papers")
 * answer the request too, and leave the request's item together, so no reading left behind brings it back after a start.
 */
function apart(db: Db, promiseId: number, requestId: number): void {
  const key = (id: number) => refKey({ source: "promise", id });
  const [promise, request] = [key(promiseId), refKey({ source: "dated", id: requestId })];
  const p = db.get<{ message_id: number; same_as: string | null }>("SELECT message_id, same_as FROM followups WHERE id = ?", promiseId)!;
  const r = db.get<{ same_as: string | null }>("SELECT same_as FROM dated_items WHERE id = ?", requestId)!;
  const [item, mine] = [r.same_as ?? request, p.same_as ?? promise];
  const canonical = (x: { id: number; same_as: string | null }) => x.same_as ?? key(x.id);
  const readings = db
    .all<{ id: number; same_as: string | null }>("SELECT id, same_as FROM followups WHERE message_id = ? AND kind = 'promise' AND state IN ('open','due')", p.message_id)
    .filter((x) => x.id === promiseId || canonical(x) === item || canonical(x) === mine);
  for (const x of readings) if (x.id !== promiseId) db.run("UPDATE followups SET answers = ? WHERE id = ? AND answers IS NULL", requestId, x.id);
  if (!readings.some((x) => canonical(x) === item)) return;
  if (readings.some((x) => key(x.id) === item)) {
    // a reading leads the request's item: the request and its own readings leave it, the request theirs; a reading on its
    // own (no item of its own) joins the one its twin leads
    db.run("UPDATE dated_items SET same_as = NULL WHERE id = ?", requestId);
    db.run(`UPDATE dated_items SET same_as = ? WHERE id IN (SELECT id FROM dated_items INDEXED BY dated_same WHERE same_as = ?) AND kind IN (${ANSWERED_KINDS.map((k) => `'${k}'`).join(", ")})`, request, item);
    for (const x of readings) {
      const leads = db.get("SELECT 1 FROM followups INDEXED BY followups_same WHERE same_as = ?1 UNION ALL SELECT 1 FROM dated_items INDEXED BY dated_same WHERE same_as = ?1 LIMIT 1", key(x.id));
      if (x.same_as === null && key(x.id) !== item && !leads) db.run("UPDATE followups SET same_as = ? WHERE id = ?", item, x.id);
    }
    return;
  }
  // something else leads it: the readings in it leave together, for the promise's item (the promise's own, if it was in it)
  const lead = mine === item ? promise : mine;
  for (const x of readings) if (x.same_as === item) db.run("UPDATE followups SET same_as = ? WHERE id = ?", key(x.id) === lead ? null : lead, x.id);
}

export function finishFollowups(db: Db, w: FollowupFinish): FollowupFinishOutcome {
  return db.tx(() => {
    const mark = db.get<{ confirmed: number }>("SELECT confirmed FROM ai_sent_mail WHERE message_id = ?", w.messageId);
    const src = followupSource(db, w.messageId);
    if (!mark) return "gone";
    if (!src || src.trash || src.spam || src.draft) {
      db.run("DELETE FROM ai_sent_mail WHERE message_id = ?", w.messageId);
      return "gone";
    }
    const own = ownAddresses(db);
    let active = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM followups WHERE state IN ('open','due')")!.n;
    const add = (r: FollowupFinish["rows"][number]) => db.run(
      `INSERT OR IGNORE INTO followups (thread_id, message_id, rfc_message_id, item, kind, text, quote, person_name, person_email, sent_at, due_at, dated, state, inbox_state, from_scan, model, provider, prompt_version, created_at, timed, part_of_day)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 'none', ?, ?, ?, ?, ?, ?, ?)`,
      src.threadId, w.messageId, src.rfcMessageId, r.item, r.kind, r.text, r.quote, r.personName, r.personEmail, src.date, r.dueAt, r.dated ? 1 : 0, w.fromScan ? 1 : 0, w.model, w.provider, w.promptVersion, w.now, r.timed ? 1 : 0, r.partOfDay ?? null,
    ).changes;
    const later = db.get("SELECT 1 FROM messages INDEXED BY messages_thread WHERE thread_id = ? AND date > ? AND is_sent = 1 AND is_draft = 0 AND is_trash = 0 AND is_spam = 0 AND provider_msg_id NOT LIKE 'local:%' LIMIT 1", src.threadId, src.date);
    // plan 210 (round 14's faults, the second morning): a promise said again is the older's (`FollowupWrite.renews`): each
    // such item and the row that took it
    const renewed = new Map<number, number>();
    const renew = (r: FollowupFinish["rows"][number], to: NonNullable<FollowupFinish["rows"][number]["renews"]>): boolean => {
      // (one promise read twice from this reply: the first moved it, the other is it all the same)
      const again = [...renewed.values()].includes(to.id);
      const older = again ? null : db.get<{ dated: number }>("SELECT dated FROM followups WHERE id = ? AND revision = ? AND thread_id = ? AND kind = 'promise' AND state IN ('open','due')", to.id, to.revision, src.threadId);
      if (!again && !older) return false;
      if (older && (r.dated || older.dated === 0)) {
        db.run(
          "UPDATE followups SET due_at = ?, dated = ?, state = CASE WHEN ? > ? THEN 'open' ELSE state END, inbox_state = 'none', broken_due_at = coalesce(broken_due_at, ?), timed = ?, before_day = NULL, part_of_day = ?, revision = revision + 1 WHERE id = ?",
          r.dueAt, r.dated ? 1 : 0, r.dueAt, w.now, to.brokenDueAt, r.timed ? 1 : 0, r.partOfDay ?? null, to.id,
        );
      }
      renewed.set(r.item, to.id);
      return true;
    };
    for (const r of w.rows) {
      if (r.kind === "awaiting" && (later || replied(db, own, { accountId: src.accountId, threadId: src.threadId, sentAt: src.date, rfcMessageId: src.rfcMessageId }))) continue;
      // a reply read again (a re-mark) keeps the rows it wrote, and never takes a wait's place for one (Codex code review of
      // plan 210's iteration 3; IndexedDB's order)
      if (db.get("SELECT 1 FROM followups WHERE message_id = ? AND item = ?", w.messageId, r.item)) continue;
      if (r.kind === "promise" && r.renews && renew(r, r.renews)) continue;
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
    // plan 210 (iteration 3): only a reply that's yours for certain decides anything about a request
    const yours = mark.confirmed === 1 || !!db.get(`SELECT 1 FROM messages WHERE id = ? AND ${TRUSTED_SENT}`, w.messageId);
    // plan 210 (iteration 4, revision 7): the reply that settled it and its date beside the closing; round 16: a bill it
    // settled is paid (`settled`, as by mail: Earlier's "Paid"), never "Answered"
    const settle = (r: { id: number; revision: number; kind: string }) => db.run("UPDATE dated_items SET state = 'settled', closed_reason = ?, closed_at = ?, settled_by = ?, settled_at = ?, revision = revision + 1 WHERE id = ? AND revision = ? AND state = 'open'", replyClosedReason(r.kind), w.now, w.messageId, src.date, r.id, r.revision);
    for (const v of yours ? (w.verdicts ?? []) : []) {
      const r = answerable(db, v.request.id, src);
      // either verdict only on the request as it was shown: one put off (Later) or moved meanwhile isn't decided by it
      if (!r || r.revision !== v.request.revision) continue;
      if (v.verdict === "fulfilled") {
        // the second morning (Diego's adjustments) and its code review: the promises of yours that answer it are kept with
        // it, only once the verdict has passed the request's revision
        if (settle(r).changes) {
          db.run("UPDATE followups SET state = 'done', closed_reason = 'kept', closed_at = ?, settled_by = ?, settled_at = ?, inbox_state = 'none', revision = revision + 1 WHERE thread_id = ? AND answers = ? AND kind = 'promise' AND state IN ('open','due') AND sent_at < ? AND message_id <> ?", w.now, w.messageId, src.date, src.threadId, r.id, src.date, w.messageId);
        }
        continue;
      }
      // round 16's code review: a bill is only ever paid by a reply, never folded into a promise to pay it (its row, day,
      // amount and counts stay its own until it's paid)
      if (!(ANSWERED_KINDS as readonly string[]).includes(r.kind)) continue;
      // the promise this reply made (its own row, or the older one it said again), an open one, linked once
      const p = db.get<{ id: number }>("SELECT id FROM followups WHERE ((message_id = ? AND item = ?) OR id = ?) AND kind = 'promise' AND state IN ('open','due') AND answers IS NULL AND holds IS NULL", w.messageId, v.item, renewed.get(v.item) ?? -1);
      if (!p) continue;
      // plan 210 (iteration 4): a promise that only holds it is stored with it, once (as a link, no revision moves)
      if (v.verdict === "holding") {
        db.run("UPDATE followups SET holds = ? WHERE id = ?", r.id, p.id);
        continue;
      }
      db.run("UPDATE followups SET answers = ? WHERE id = ?", r.id, p.id);
      apart(db, p.id, r.id);
    }
    for (const k of w.kept) {
      const kept = db.run("UPDATE followups SET state = 'done', closed_reason = 'kept', closed_at = ?, settled_by = ?, settled_at = ?, inbox_state = 'none', revision = revision + 1 WHERE id = ? AND revision = ? AND thread_id = ? AND kind = 'promise' AND state IN ('open','due')", w.now, w.messageId, src.date, k.id, k.revision, src.threadId).changes;
      // plan 210 (iteration 3): what it promised to a request is sent: the request is answered with it
      const answers = kept && yours ? db.get<{ answers: number | null }>("SELECT answers FROM followups WHERE id = ?", k.id)?.answers : null;
      const r = answers == null ? null : answerable(db, answers, src);
      if (r) settle(r);
    }
    db.run("DELETE FROM ai_sent_mail WHERE message_id = ?", w.messageId);
    return "written";
  });
}

export const activeFollowups = (db: Db): FollowupRow[] => db.all<Raw>("SELECT * FROM followups INDEXED BY followups_active WHERE state IN ('open','due') ORDER BY due_at, id LIMIT ?", FOLLOWUPS_ACTIVE_MAX).map(toRow);
export const threadFollowups = (db: Db, threadId: number): FollowupRow[] => db.all<Raw>("SELECT * FROM followups WHERE thread_id = ? AND state IN ('open','due') ORDER BY due_at, id", threadId).map(toRow);
/** Plan 210: your closed promises by closing time (`followups_closed`), strictly after `after`, newest first. */
export function closedFollowupPage(db: Db, o: { since: number; after: ClosedAt | null; limit: number }): FollowupRow[] {
  const { after } = o;
  return db
    .all<Raw>(
      `SELECT * FROM followups INDEXED BY followups_closed WHERE kind = 'promise' AND state IN ('done','dismissed') AND closed_at >= ?${after ? " AND (closed_at, id) < (?, ?)" : ""} ORDER BY closed_at DESC, id DESC LIMIT ?`,
      o.since,
      ...(after ? [after.at, after.id] : []),
      o.limit,
    )
    .map(toRow);
}

/** Plan 210 (iteration 3, Codex code review): a whole row as read, for a batch read elsewhere (`itemMembers`). */
export { toRow as followupRow, type Raw as FollowupRaw };

export function getFollowup(db: Db, id: number): FollowupRow | null {
  const r = db.get<Raw>("SELECT * FROM followups WHERE id = ?", id);
  return r ? toRow(r) : null;
}
/** `followupWakeAt` in SQL: a promise's Later, if later than its moment. Over the open rows (the active bound, 1,000). */
const WAKE = "max(due_at, coalesce(deferred_until, due_at))";
export const nextFollowupDue = (db: Db): number | null => db.get<{ at: number | null }>(`SELECT min(${WAKE}) AS at FROM followups WHERE state = 'open'`)?.at ?? null;

export function makeFollowupsDue(db: Db, now: number): FollowupRow[] {
  return db.tx(() => {
    const rows = db.all<Raw>(`SELECT * FROM followups WHERE state = 'open' AND ${WAKE} <= ?`, now);
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

const snapshot = (r: Raw): FollowupSnapshot => ({ id: r.id, revision: r.revision, state: r.state, dueAt: r.due_at, deferredUntil: r.deferred_until ?? null, inboxState: r.inbox_state, closedReason: r.closed_reason, closedAt: r.closed_at });

export function endFollowupTop(db: Db, threadIds: readonly number[]): FollowupSnapshot[] {
  if (!threadIds.length) return [];
  return db.tx(() => {
    const rows = db.all<Raw>("SELECT * FROM followups WHERE inbox_state = 'onTop' AND thread_id IN (SELECT value FROM json_each(?))", JSON.stringify(threadIds));
    for (const r of rows) db.run("UPDATE followups SET inbox_state = 'seen', revision = revision + 1 WHERE id = ?", r.id);
    return rows.map(snapshot);
  });
}

export function updateFollowup(db: Db, id: number, revision: number, patch: Partial<Pick<FollowupRow, "state" | "dueAt" | "deferredUntil" | "inboxState" | "closedReason" | "closedAt">>): FollowupSnapshot | null {
  return db.tx(() => {
    const r = db.get<Raw>("SELECT * FROM followups WHERE id = ? AND revision = ?", id, revision);
    if (!r) return null;
    db.run(
      "UPDATE followups SET state = ?, due_at = ?, deferred_until = ?, inbox_state = ?, closed_reason = ?, closed_at = ?, revision = revision + 1 WHERE id = ?",
      patch.state ?? r.state, patch.dueAt ?? r.due_at, patch.deferredUntil !== undefined ? patch.deferredUntil : r.deferred_until, patch.inboxState ?? r.inbox_state, patch.closedReason !== undefined ? patch.closedReason : r.closed_reason, patch.closedAt !== undefined ? patch.closedAt : r.closed_at, id,
    );
    return snapshot(r);
  });
}

export function restoreFollowups(db: Db, rows: readonly { snapshot: FollowupSnapshot; expectRevision: number }[]): number {
  return db.tx(() => {
    let n = 0;
    // the deferral as it was, null too (a journal written before v58 has none)
    for (const { snapshot: s, expectRevision } of rows) n += Number(db.run("UPDATE followups SET state = ?, due_at = ?, deferred_until = ?, inbox_state = ?, closed_reason = ?, closed_at = ?, revision = revision + 1 WHERE id = ? AND revision = ?", s.state, s.dueAt, s.deferredUntil ?? null, s.inboxState, s.closedReason, s.closedAt, s.id, expectRevision).changes);
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

