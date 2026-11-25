import { addressKey, ANSWERED_KINDS, DATED_ACTIVE_MAX, DATED_CLOSED_KEEP_MS, parseHandedTo, readPartOfDay, DATED_MUTE_NAME_MAX, DATED_MUTE_PAIRS_MAX, DATED_MUTES_MAX, muteKey, pairOf, senderIsPerson, THREAD_SCOPED_KINDS, waitingCutoff, type DatedMute, type DatedMuteOn, type DatedRow } from "@terno/core";
import { DATED_MARK_MS, DATED_SCAN_MARK_MS, datedTab, NEW_MAIL_MS, readerIn, readNothingAsked, recipientList, WAITING_CLOSED, type ClosedAt, type DatedFinish, type DatedFinishOutcome, type DatedMuteAdded, type DatedMark, type DatedSnapshot, markPage, type MarkKey, type RawMark, type RawMarkKey, type DatedSource, type WaitingActState } from "@terno/store";
import { OWN_SENDER_SQL, RECEIVED_SQL } from "./ai-summaries";
import { ownAddresses, requeueSender } from "./facts";
import { remarkReplies } from "./followups";
import { proposedMove, scheduleFields, wallJson, wallOf } from "./schedule";
import type { Db } from "./sqlite";


/** Plan 204 on SQLite (v56, v57 admits `ask`): see packages/store/src/dated.ts. */

/** the sixth panel round: what the sender's mail may reach elsewhere (`THREAD_SCOPED_KINDS` only from their own conversation) */
const SENDER_REACHES_SQL = `kind NOT IN (${THREAD_SCOPED_KINDS.map((k) => `'${k}'`).join(", ")})`;

interface Raw {
  id: number; thread_id: number; message_id: number; item: number; kind: DatedRow["kind"]; text: string; quote: string; sender_key: string; due_day: string; due_at: number; timed: number; dated: number; act_at: number;
  deferred_until: number | null; arrived_at: number; state: DatedRow["state"]; closed_reason: string | null; closed_at: number | null; from_scan: number; revision: number; model: string | null; provider: string | null; created_at: number;
  early: number; same_as: string | null; detail_of: number | null; lapses: number; settled_by: number | null; settled_at: number | null;
  changed_at: number | null; changed_from: string | null; proposal: string | null;
  handed_to?: string | null;
  before_day: string | null; confirms: number | null; wall: string | null;
  part_of_day: string | null;
}
const toRow = (r: Raw): DatedRow => ({
  id: r.id, threadId: r.thread_id, messageId: r.message_id, item: r.item, kind: r.kind, text: r.text, quote: r.quote, senderKey: r.sender_key, dueDay: r.due_day, dueAt: r.due_at, timed: r.timed === 1, dated: r.dated === 1, actAt: r.act_at,
  deferredUntil: r.deferred_until, arrivedAt: r.arrived_at, state: r.state, closedReason: r.closed_reason, closedAt: r.closed_at, fromScan: r.from_scan === 1, revision: r.revision, model: r.model, provider: r.provider, createdAt: r.created_at,
  early: r.early === 1, sameAs: r.same_as ?? null, detailOf: r.detail_of ?? null, lapses: r.lapses === 1, ...scheduleFields(r), settledBy: r.settled_by ?? null, settledAt: r.settled_at ?? null,
  handedTo: parseHandedTo(r.handed_to),
  before: r.before_day ?? null, confirms: r.confirms ?? null, wall: wallOf(r.wall),
  partOfDay: readPartOfDay(r.part_of_day),
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

/** Plan 239: the marks with their senders, oldest first by the date index, strictly after a key (`marks.raw`). */
export function datedMarksRaw(db: Db, after: RawMarkKey | null, limit: number): RawMark[] {
  const from = after ? " WHERE d.arrived_at > ? OR (d.arrived_at = ? AND d.message_id > ?)" : "";
  return db
    .all<{ message_id: number; thread_id: number; arrived_at: number; queued_at: number; source: "live" | "scan"; from_email: string | null }>(
      `SELECT d.message_id, d.thread_id, d.arrived_at, d.queued_at, d.source, m.from_email FROM ai_dated_mail d INDEXED BY ai_dated_mail_order LEFT JOIN messages m ON m.id = d.message_id${from} ORDER BY d.arrived_at, d.message_id LIMIT ?`,
      ...(after ? [after.arrivedAt, after.arrivedAt, after.messageId] : []),
      Number.isFinite(limit) ? limit : -1,
    )
    .map((r) => ({ messageId: r.message_id, threadId: r.thread_id, arrivedAt: r.arrived_at, queuedAt: r.queued_at, source: r.source, fromEmail: r.from_email }));
}

/** Plan 239: ordered by `markPage` (one rule for both stores). */
export function datedMarkPage(db: Db, after: MarkKey | null, limit: number): DatedMark[] {
  return markPage(datedMarksRaw(db, null, Infinity), after, limit);
}

export const datedMarkCount = (db: Db): number => db.get<{ n: number }>("SELECT COUNT(*) AS n FROM ai_dated_mail")!.n;

/** Plan 210 (iteration 3): a message of this conversation from before then still to be read (the marks are few: no index). */
export const datedPendingOn = (db: Db, threadId: number, before: number): boolean => !!db.get("SELECT 1 FROM ai_dated_mail WHERE thread_id = ? AND arrived_at < ? LIMIT 1", threadId, before);

/** Plan 273: of these messages, those still marked (by the key). */
export function datedMarksAmong(db: Db, messageIds: readonly number[]): Set<number> {
  if (!messageIds.length) return new Set();
  return new Set(db.all<{ message_id: number }>("SELECT message_id FROM ai_dated_mail WHERE message_id IN (SELECT value FROM json_each(?))", JSON.stringify(messageIds)).map((r) => r.message_id));
}

/** Plan 210 (iteration 5, revision 3): the second look's one claim, in one statement (a mark claimed or gone changes nothing). */
export const claimDatedLook = (db: Db, messageId: number, now: number): boolean => Number(db.run("UPDATE ai_dated_mail SET looked_at = ? WHERE message_id = ? AND looked_at IS NULL", now, messageId).changes) === 1;

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

/**
 * Plan 211 (revision 11, Codex code review 5): one account's, never another's mail: its conversations active since then
 * (`threads_acct_all`: the account, by last date) and their messages since then (`messages_thread`), only those sorted. Not
 * read, but what's marked stays in (Codex code review 1): a check made again after a crash picks the same messages, which a
 * queue ignores, never the next ones.
 */
export function datedScanCandidates(db: Db, since: number, limit: number, accountId: number): number[] {
  return db.all<{ id: number }>(
    `SELECT m.id FROM threads t INDEXED BY threads_acct_all JOIN messages m INDEXED BY messages_thread ON m.thread_id = t.id AND m.date >= ?
     WHERE t.account_id = ? AND t.in_trash = 0 AND t.in_spam = 0 AND t.last_date >= ? AND ${RECEIVED_SQL} AND NOT EXISTS (SELECT 1 FROM dated_items i WHERE i.message_id = m.id)
     ORDER BY m.date DESC, m.id DESC LIMIT ?`,
    since,
    accountId,
    since,
    limit,
  ).map((r) => r.id);
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

export function openDatedFor(db: Db, o: { threadId: number; senderKey: string; before: number; limit: number; excludeAccounts?: readonly number[] }): DatedRow[] {
  const excluded = o.excludeAccounts?.length ? JSON.stringify(o.excludeAccounts) : null;
  return db.all<Raw>(
    `SELECT * FROM dated_items WHERE id IN (SELECT id FROM dated_items INDEXED BY dated_thread WHERE thread_id = ? AND state = 'open' UNION SELECT id FROM dated_items INDEXED BY dated_sender WHERE sender_key = ? AND state = 'open' AND ${SENDER_REACHES_SQL})
       AND arrived_at < ?
       AND NOT EXISTS (SELECT 1 FROM messages x INDEXED BY messages_thread WHERE x.thread_id = dated_items.thread_id AND x.is_spam = 1)${excluded ? "\n       AND (SELECT t.account_id FROM threads t WHERE t.id = dated_items.thread_id) NOT IN (SELECT value FROM json_each(?))" : ""}
     ORDER BY arrived_at DESC, id DESC LIMIT ?`,
    o.threadId, o.senderKey, o.before, ...(excluded ? [excluded] : []), o.limit,
  ).map(toRow);
}

// ─── plan 210 (iteration 4, revision 2): what the reader muted ───

const toMute = (r: { target: DatedMuteOn; key: string; name: string; created_at: number }): DatedMute => ({ on: r.target, key: r.key, name: r.name, at: r.created_at });

// iteration 5: the pairs (`dated_mute_pairs`, v72) read as mutes of their own target, keyed as `pairKey` writes them
const ALL_MUTES_SQL = "SELECT target, key, name, created_at FROM dated_mutes UNION ALL SELECT 'pair', kind || '|' || sender_key, name, created_at FROM dated_mute_pairs";

export const datedMutes = (db: Db): DatedMute[] => db.all<Parameters<typeof toMute>[0]>(`${ALL_MUTES_SQL} ORDER BY created_at DESC, target, key`).map(toMute);

/** Normalized as `muteKey` says (a key it refuses throws); at the bound, refused, never one dropped for it. */
export function addDatedMute(db: Db, m: DatedMute): DatedMuteAdded {
  const key = muteKey(m.on, m.key);
  if (key === null) throw new TypeError("not a sender, a kind or a pair");
  const name = m.on === "kind" ? "" : m.name.trim().slice(0, DATED_MUTE_NAME_MAX);
  return db.tx(() => {
    if (m.on === "pair") {
      const { kind, sender } = pairOf(key)!;
      if (db.get("SELECT 1 FROM dated_mute_pairs WHERE sender_key = ? AND kind = ?", sender, kind)) return "already";
      if (db.get<{ n: number }>("SELECT count(*) AS n FROM dated_mute_pairs")!.n >= DATED_MUTE_PAIRS_MAX) return "full";
      db.run("INSERT INTO dated_mute_pairs (sender_key, kind, name, created_at) VALUES (?, ?, ?, ?)", sender, kind, name, m.at);
      return "added";
    }
    if (db.get("SELECT 1 FROM dated_mutes WHERE target = ? AND key = ?", m.on, key)) return "already";
    if (db.get<{ n: number }>("SELECT count(*) AS n FROM dated_mutes")!.n >= DATED_MUTES_MAX) return "full";
    db.run("INSERT INTO dated_mutes (target, key, name, created_at) VALUES (?, ?, ?, ?)", m.on, key, name, m.at);
    // plan 240: one sender is never both hidden and always shown: their mute ends their Show, here (Codex code review)
    if (m.on === "sender" && db.run("DELETE FROM shown_senders WHERE key = ?", key).changes) requeueSender(db, key);
    return "added";
  });
}

export function removeDatedMute(db: Db, on: DatedMuteOn, key: string): DatedMute | null {
  const k = muteKey(on, key);
  if (k === null) return null;
  return db.tx(() => {
    if (on === "pair") {
      const { kind, sender } = pairOf(k)!;
      const r = db.get<{ name: string; created_at: number }>("SELECT name, created_at FROM dated_mute_pairs WHERE sender_key = ? AND kind = ?", sender, kind);
      if (r) db.run("DELETE FROM dated_mute_pairs WHERE sender_key = ? AND kind = ?", sender, kind);
      return r ? { on, key: k, name: r.name, at: r.created_at } : null;
    }
    const r = db.get<Parameters<typeof toMute>[0]>("SELECT * FROM dated_mutes WHERE target = ? AND key = ?", on, k);
    if (r) db.run("DELETE FROM dated_mutes WHERE target = ? AND key = ?", on, k);
    return r ? toMute(r) : null;
  });
}

/** The muted senders' keys: one read of a table bounded at 200 (Needs you's walk reads it once; pairs never reach it). */
export const mutedSenders = (db: Db): Set<string> => new Set(db.all<{ key: string }>("SELECT key FROM dated_mutes WHERE target = 'sender'").map((r) => r.key));

export function finishDated(db: Db, w: DatedFinish): DatedFinishOutcome {
  return db.tx(() => {
    if (!db.get("SELECT 1 FROM ai_dated_mail WHERE message_id = ?", w.messageId)) return "gone";
    const src = datedSource(db, w.messageId);
    // plan 210 (iteration 4): a sender muted while it was read: nothing it read is kept, and it isn't read again
    if (!src || src.spam || src.trash || src.draft || src.threadSpam || db.get("SELECT 1 FROM dated_mutes WHERE target = 'sender' AND key = ?", src.senderKey)) {
      db.run("DELETE FROM ai_dated_mail WHERE message_id = ?", w.messageId);
      return "gone";
    }
    // a merge since it was read: the mark stays, and the worker reads it again on its thread
    if (src.threadId !== w.threadId) return "moved";
    let open = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM dated_items INDEXED BY dated_open WHERE state = 'open'")!.n;
    // plan 210 (iteration 4): a muted kind's new items aren't stored; its settlements and moves below still are
    // (iteration 5) nor are a kind's muted for this sender alone (its pairs, by the key's prefix): the rest of their mail is
    const kinds = new Set(db.all<{ key: string }>("SELECT key FROM dated_mutes WHERE target = 'kind' UNION ALL SELECT kind FROM dated_mute_pairs WHERE sender_key = ?", src.senderKey).map((r) => r.key));
    // plan 215: their message marked as needing no reply, or put off with Later on its waiting row: a request read from it
    // follows that choice (stored closed, or put off to the same moment), so the same request never comes back as a task;
    // plan 216: a Remove took the row off What matters alone, and its requests are stored as any message's
    const waiting = db.get<{ state: WaitingActState; until: number | null }>("SELECT state, until FROM waiting_acts WHERE message_id = ?", w.messageId);
    for (const r of w.rows) {
      if (kinds.has(r.kind)) continue;
      if (db.get("SELECT 1 FROM dated_items WHERE message_id = ? AND item = ?", w.messageId, r.item)) continue;
      const asked = waiting !== undefined && ANSWERED_KINDS.includes(r.kind);
      if (asked && waiting.state === "done") {
        db.run(
          `INSERT OR IGNORE INTO dated_items (thread_id, message_id, item, kind, text, quote, sender_key, due_day, due_at, timed, dated, act_at, deferred_until, arrived_at, state, closed_reason, closed_at, from_scan, revision, model, provider, prompt_version, created_at, early, lapses, before_day, wall, part_of_day)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'dismissed', ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          src.threadId, w.messageId, r.item, r.kind, r.text, r.quote, src.senderKey, r.dueDay, r.dueAt, r.timed ? 1 : 0, r.dated ? 1 : 0, r.actAt, src.date, WAITING_CLOSED, w.now, w.fromScan ? 1 : 0, w.model, w.provider, w.promptVersion, w.now, r.early ? 1 : 0, r.lapses ? 1 : 0, r.before ?? null, wallJson(r.wall), r.partOfDay ?? null,
        );
        continue;
      }
      // plan 210 (iteration 3): a request read after your reply is stored open like any other: only a reply's verdict settles it
      if (open >= DATED_ACTIVE_MAX) {
        // the bound keeps the soonest: the furthest of them all isn't added
        const furthest = db.get<{ id: number; act_at: number }>("SELECT id, act_at FROM dated_items INDEXED BY dated_open WHERE state = 'open' ORDER BY act_at DESC, id DESC LIMIT 1");
        if (!furthest || furthest.act_at <= r.actAt) continue;
        db.run("DELETE FROM dated_items WHERE id = ?", furthest.id);
        open--;
      }
      open += Number(db.run(
        `INSERT OR IGNORE INTO dated_items (thread_id, message_id, item, kind, text, quote, sender_key, due_day, due_at, timed, dated, act_at, deferred_until, arrived_at, state, from_scan, revision, model, provider, prompt_version, created_at, early, lapses, before_day, wall, part_of_day)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        src.threadId, w.messageId, r.item, r.kind, r.text, r.quote, src.senderKey, r.dueDay, r.dueAt, r.timed ? 1 : 0, r.dated ? 1 : 0, r.actAt, asked && waiting.until !== null && waiting.until > w.now ? waiting.until : null, src.date, w.fromScan ? 1 : 0, w.model, w.provider, w.promptVersion, w.now, r.early ? 1 : 0, r.lapses ? 1 : 0, r.before ?? null, wallJson(r.wall), r.partOfDay ?? null,
      ).changes);
    }
    // plan 210 (iteration 4, revision 11): an ask that confirms an event of this message, linked to that event's row
    for (const r of w.rows) {
      if (r.confirmsItem === undefined) continue;
      const event = db.get<{ id: number }>("SELECT id FROM dated_items WHERE message_id = ? AND item = ? AND kind = 'event'", w.messageId, r.confirmsItem);
      if (event) db.run("UPDATE dated_items SET confirms = ? WHERE message_id = ? AND item = ? AND kind = 'ask' AND confirms IS NULL", event.id, w.messageId, r.item);
    }
    for (const s of w.settled) {
      db.run(
        // plan 210 (iteration 4, revision 7): the settling mail and its date beside the closing
        `UPDATE dated_items SET state = 'settled', closed_reason = ?, closed_at = ?, settled_by = ?, settled_at = ?, revision = revision + 1 WHERE id = ? AND revision = ? AND state = 'open' AND (thread_id = ? OR (sender_key = ? AND ${SENDER_REACHES_SQL}))`,
        s.how ?? "settled", w.now, w.messageId, src.date, s.id, s.revision, src.threadId, src.senderKey,
      );
    }
    // plan 210 (iteration 3, revision 4): a promise its person replaced, closed with the request that replaces it
    for (const r of w.replaced ?? []) {
      if (!db.get("SELECT 1 FROM dated_items WHERE message_id = ? AND item = ?", w.messageId, r.item)) continue;
      const p = db.get<{ person_email: string | null; sent_at: number }>("SELECT person_email, sent_at FROM followups WHERE id = ? AND revision = ? AND thread_id = ? AND kind = 'promise' AND state IN ('open','due')", r.id, r.revision, src.threadId);
      if (!p?.person_email || addressKey(p.person_email) !== src.senderKey || p.sent_at >= src.date) continue;
      db.run("UPDATE followups SET state = 'dismissed', closed_reason = 'replaced', closed_at = ?, settled_by = ?, settled_at = ?, inbox_state = 'none', revision = revision + 1 WHERE id = ?", w.now, w.messageId, src.date, r.id);
    }
    for (const m of w.movedPromises ?? []) {
      // plan 210 (iteration 4): a promise whose day the user chose keeps it; the move is kept for them to take or leave
      if (proposedMove(db, "followups", { id: m.id, revision: m.revision, threadId: src.threadId }, { dueAt: m.dueAt, timed: m.timed ?? false, before: m.before ?? null, partOfDay: m.partOfDay ?? null }, src, w)) continue;
      db.run(
        // plan 210 (iteration 2): its first broken day kept (a second move after another broken day keeps the first), and
        // whether its new moment is a stated time (absent: as it was)
        // plan 210 (iteration 4): the day its person asked for it before, or none; iteration 5, the part of its new day, or none
        "UPDATE followups SET due_at = ?, dated = 1, state = CASE WHEN ? > ? THEN 'open' ELSE state END, inbox_state = 'none', broken_due_at = coalesce(broken_due_at, ?), timed = coalesce(?, timed), before_day = ?, part_of_day = ?, revision = revision + 1 WHERE id = ? AND revision = ? AND thread_id = ? AND kind = 'promise' AND state IN ('open','due')",
        m.dueAt, m.dueAt, w.now, m.brokenDueAt ?? null, m.timed === undefined ? null : m.timed ? 1 : 0, m.before ?? null, m.partOfDay ?? null, m.id, m.revision, src.threadId,
      );
    }
    for (const m of w.moved ?? []) {
      // plan 210 (iteration 4): likewise an item whose day the user chose: the mail's day (and words) wait as a proposal
      if (proposedMove(db, "dated_items", { id: m.id, threadId: src.threadId, senderKey: src.senderKey, reaches: SENDER_REACHES_SQL }, { dueDay: m.dueDay, dueAt: m.dueAt, timed: m.timed, actAt: m.actAt, ...(m.text ? { text: m.text } : {}), before: m.before ?? null, wall: m.wall ?? null, partOfDay: m.partOfDay ?? null }, src, w)) continue;
      db.run(
        // the revision stays: a Later just before stays undoable, and the move changes no choice of the user's (Codex review);
        // its new words, if it gives some, in the same write (the fifth panel round)
        // plan 210 (iteration 4): and the day it's asked before and the mail's own clock at its new moment, or none; iteration
        // 5, the part of its new day, or none
        `UPDATE dated_items SET due_day = ?, due_at = ?, timed = ?, dated = 1, act_at = ?, text = coalesce(?, text), before_day = ?, wall = ?, part_of_day = ? WHERE id = ? AND state = 'open' AND (thread_id = ? OR (sender_key = ? AND ${SENDER_REACHES_SQL}))`,
        m.dueDay, m.dueAt, m.timed ? 1 : 0, m.actAt, m.text ?? null, m.before ?? null, wallJson(m.wall), m.partOfDay ?? null, m.id, src.threadId, src.senderKey,
      );
    }
    // plan 210 (iteration 3): a request a reply of yours already followed goes to the follow-ups reader with that reply again, for its verdict
    if (w.replies && w.rows.some((r) => ANSWERED_KINDS.includes(r.kind) && !kinds.has(r.kind))) remarkReplies(db, src.threadId, src.date, w.replies.since, w.now);
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

/** Plan 210 (iteration 3, Codex code review): a whole row as read, for a batch read elsewhere (`itemMembers`). */
export { toRow as datedRow, type Raw as DatedRaw };

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
    // plan 210 (iteration 3): never a request an open promise of yours answers (the projection reads its state)
    Number(db.run("DELETE FROM dated_items WHERE state != 'open' AND coalesce(closed_at, created_at) < ? AND NOT EXISTS (SELECT 1 FROM followups f INDEXED BY followups_answers WHERE f.answers = dated_items.id AND f.state IN ('open','due'))", now - DATED_CLOSED_KEEP_MS).changes) +
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
