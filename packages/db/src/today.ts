import { addressKey, isAcknowledgment, looksLikeAcknowledgment, parseRef, refKey, saysNoReplyNeeded, waitingCutoff, type DatedRow, type DigestItem, type FollowupRow, type ItemRef } from "@terno/core";
import { DATED_NOTHING_ASKED_SINCE, NEEDS_WALK, needsYou, summaryAsksNothing, type DigestFact, type DigestStored, type ItemChanges, type ItemSnapshots, type WaitingRow } from "@terno/store";
import { datedRow, mutedSenders, restoreDated, updateDated, type DatedRaw } from "./dated";
import { followupRow, restoreFollowups, updateFollowup, type FollowupRaw } from "./followups";
import { ownAddresses } from "./facts";
import { shownKeys } from "./shown-senders";
import { inboxHiding, shownSql } from "./queries";
import type { Db } from "./sqlite";

/** Plan 145 on SQLite (v54): see packages/store/src/today.ts. */

/** The newest waiting threads in date order: threads_waiting is in it, threads_waiting_inbox isn't (revision 11). */
function needsRows(db: Db, now: number): WaitingRow[] {
  const cutoff = waitingCutoff(now);
  const hiding = shownSql(inboxHiding(db));
  // plan 240: a sender said to be always shown outranks the Inbox's hiding (a Gmail tab kept apart, a hidden category)
  const shown = shownKeys(db);
  // (by the waiting message's sender, never the thread's last: a synced draft of yours on top is the last, Codex code review)
  const hidden = hiding.where && shown.size ? ` AND ((1${hiding.where}) OR EXISTS (SELECT 1 FROM messages m INDEXED BY messages_thread WHERE m.thread_id = threads.id AND m.date = threads.waiting_since AND m.is_draft = 0 AND m.is_sent = 0 AND terno_address_key(m.from_email) IN (SELECT key FROM shown_senders)))` : hiding.where;
  const rows = db.all<{ id: number; last_date: number; last_from_email: string; subject: string; has_sent: number; snippet: string | null; waiting_since: number }>(
    `SELECT id, last_date, last_from_email, subject, has_sent, snippet, waiting_since FROM threads INDEXED BY threads_waiting
     WHERE waiting_since IS NOT NULL AND last_date >= ? AND waiting_since >= ? AND in_inbox = 1${hidden}
     ORDER BY last_date DESC, id DESC LIMIT ?`,
    cutoff,
    cutoff,
    ...hiding.params,
    NEEDS_WALK,
  );
  const snippets = new Map(rows.map((r) => [r.id, r.snippet]));
  const isShown = (key: string) => shown.has(key);
  // plan 240 (Codex code review): who it waits on is the waiting message's sender; the thread's last is yours when a synced
  // draft is newest (asked only then, and only with a sender shown)
  const own = shown.size ? ownAddresses(db) : null;
  const waitingFrom = (r: { id: number; waiting_since: number; last_from_email: string }) =>
    own?.has(addressKey(r.last_from_email))
      ? (db.get<{ from_email: string }>("SELECT from_email FROM messages INDEXED BY messages_thread WHERE thread_id = ? AND date = ? AND is_draft = 0 AND is_sent = 0 ORDER BY id DESC LIMIT 1", r.id, r.waiting_since)?.from_email ?? r.last_from_email)
      : r.last_from_email;
  const waiting = rows.map((r) => ({ id: r.id, lastDate: r.last_date, waitingSince: r.waiting_since, from: waitingFrom(r), subject: r.subject, hasSent: r.has_sent === 1 }));
  // plan 290: who you've written to, for the walk's senders in one read (a statement each was 2,000 at Needs you's bound)
  const correspondents = new Map(
    db
      .all<{ email: string; written: number; own: number }>("SELECT email, written, own FROM correspondents WHERE email IN (SELECT value FROM json_each(?))", JSON.stringify([...new Set(waiting.map((r) => addressKey(r.from)))]))
      .map((c) => [c.email, c] as const),
  );
  const needs = needsYou(waiting, (key) => correspondents.get(key), isShown);
  // plan 210 (iteration 4): a muted sender's conversations aren't waiting on you in What matters, read once a walk; nothing
  // is recorded for them (`dated_nothing_asked`), so Unmute brings them back as they are
  const muted = mutedSenders(db);
  // plan 204, the second panel round (plan 145's rule, tighter): on what needsYou let in, never widening it
  const candidates = needs.filter((r) => !(muted.size && muted.has(addressKey(r.from))));
  const still = stillWaitingAmong(db, candidates.map((r) => ({ id: r.id, snippet: snippets.get(r.id) ?? null, shown: shown.size > 0 && isShown(addressKey(r.from)) })), now);
  return candidates.filter((r) => still.has(r.id));
}

/** A thread's rows of one table, by thread. */
function byThread<T extends { thread_id: number }>(rows: readonly T[]): Map<number, T[]> {
  const out = new Map<number, T[]>();
  for (const r of rows) {
    const list = out.get(r.thread_id);
    if (list) list.push(r);
    else out.set(r.thread_id, [r]);
  }
  return out;
}

const inIds = (ids: readonly number[]) => JSON.stringify(ids);

/**
 * Of these threads, those still waiting on you: not read by the dated reader with nothing asked (plan 210), not handled,
 * not an acknowledgment, and no current summary that gives the reader nothing to do or answer (see
 * packages/store/src/today.ts). Handled (Codex code review): a dated item read from their latest message is done, not a
 * task, settled or put off till later; it's read from the item, so the item's Undo brings the conversation back as it was.
 *
 * Plan 290: each table is read once for the whole walk (`thread_id IN json_each`, on the index a thread's read used), then
 * each thread meets the same rules in the same order; a statement a thread was ~6 × 2,000 a walk at Needs you's bound.
 */
function stillWaitingAmong(db: Db, threads: readonly { id: number; snippet: string | null; shown: boolean }[], now: number): Set<number> {
  const still = new Set<number>();
  // the fourth panel read: they said no answer is needed ("No action needed!"), in its first words; plan 240: not for a
  // sender always shown (the user's word outranks a reading of their words, here and below: only what was handled counts)
  const rows = threads.filter((t) => t.shown || !saysNoReplyNeeded(t.snippet)).map((t) => ({ ...t, ack: !t.shown && looksLikeAcknowledgment(t.snippet) }));
  if (!rows.length) return still;
  const all = inIds(rows.map((r) => r.id));
  const unshown = rows.filter((r) => !r.shown).map((r) => r.id);
  // plan 210 (iteration 2, the owner: "only when something is asked"): the dated reader read their latest message and found
  // nothing asked of the reader. Mail it hasn't read (off, older, still queued) keeps plan 145's rule; newer mail isn't the one read
  const read = byThread(
    unshown.length
      ? db.all<{ thread_id: number; message_id: number }>("SELECT thread_id, message_id FROM dated_nothing_asked INDEXED BY dated_nothing_asked_thread WHERE thread_id IN (SELECT value FROM json_each(?)) AND prompt_version >= ?", inIds(unshown), DATED_NOTHING_ASKED_SINCE)
      : [],
  );
  // the threads' items (most have none): a dated item read from their latest message, handled
  const handled = byThread(db.all<{ thread_id: number; message_id: number }>("SELECT thread_id, message_id FROM dated_items INDEXED BY dated_thread WHERE thread_id IN (SELECT value FROM json_each(?)) AND (state IN ('done', 'dismissed', 'settled') OR deferred_until > ?)", all, now));
  // Codex code review (round 4): a promise of yours there closed (Done, Not a promise) since their latest message, with
  // none still open, is the row you handled; from the promises' states, so Undo brings the conversation back, and newer
  // mail from them too (a thread with none has no row: no close, nothing open or put off)
  const kept = new Map(
    db
      .all<{ thread_id: number; at: number | null; open: number; deferred: number }>(
        "SELECT thread_id, max(CASE WHEN state IN ('done', 'dismissed') THEN closed_at END) AS at, count(CASE WHEN state IN ('open', 'due') AND coalesce(deferred_until, 0) <= ? THEN 1 END) AS open, count(CASE WHEN state IN ('open', 'due') AND deferred_until > ? THEN 1 END) AS deferred FROM followups INDEXED BY followups_thread WHERE thread_id IN (SELECT value FROM json_each(?)) AND kind = 'promise' GROUP BY thread_id",
        now, now, all,
      )
      .map((k) => [k.thread_id, k]),
  );
  // their latest received message, for the threads a rule reads it in; its text only where the snippet starts like a thanks
  const wanted = rows.filter((r) => read.has(r.id) || handled.has(r.id) || (kept.get(r.id)?.at != null && kept.get(r.id)!.open === 0) || r.ack);
  const latest = new Map(
    wanted.length
      ? db
          .all<{ thread_id: number; id: number; date: number; text: string | null }>(
            `SELECT t.value AS thread_id, m.id, m.date,
               CASE WHEN t.value IN (SELECT value FROM json_each(?)) THEN (SELECT coalesce(b.body_text, b.body_preview) FROM message_bodies b WHERE b.message_id = m.id) END AS text
             FROM json_each(?) t JOIN messages m ON m.id = (SELECT l.id FROM messages l INDEXED BY messages_thread WHERE l.thread_id = t.value AND l.is_sent = 0 AND l.is_draft = 0 AND l.is_spam = 0 AND l.is_trash = 0 ORDER BY l.date DESC, l.id DESC LIMIT 1)`,
            inIds(wanted.filter((r) => r.ack).map((r) => r.id)),
            inIds(wanted.map((r) => r.id)),
          )
          .map((m) => [m.thread_id, m] as const)
      : [],
  );
  const summaries = new Map(
    unshown.length
      ? db
          .all<{ thread_id: number; state: string; prompt_version: number | null; body_json: string | null; generated_at: number | null }>("SELECT thread_id, state, prompt_version, body_json, generated_at FROM ai_summaries WHERE thread_id IN (SELECT value FROM json_each(?))", inIds(unshown))
          .map((s) => [s.thread_id, s] as const)
      : [],
  );
  // what a current summary that asks nothing leaves to the last check: anything the thread shows arrived after it
  const afterSummary: [number, number | null][] = [];
  for (const r of rows) {
    const last = latest.get(r.id) ?? null;
    if (read.get(r.id)?.some((x) => x.message_id === last?.id)) continue;
    if (handled.get(r.id)?.some((h) => h.message_id === last?.id)) continue;
    const k = kept.get(r.id);
    // plan 204 (the fifth panel round): its only open promises put off with Later, it waits for them (Undo brings it back)
    if (k && k.deferred > 0 && k.open === 0) continue;
    if (k?.at != null && k.open === 0 && last && k.at >= last.date) continue;
    if (r.ack && isAcknowledgment(last?.text)) continue;
    if (r.shown) {
      still.add(r.id);
      continue;
    }
    const summary = summaries.get(r.id);
    if (!summaryAsksNothing(summary)) still.add(r.id);
    else afterSummary.push([r.id, summary!.generated_at]);
  }
  if (afterSummary.length) {
    for (const { thread_id } of db.all<{ thread_id: number }>(
      `SELECT json_extract(p.value, '$[0]') AS thread_id FROM json_each(?) p
       WHERE EXISTS (SELECT 1 FROM messages INDEXED BY messages_thread WHERE thread_id = json_extract(p.value, '$[0]') AND created_at >= json_extract(p.value, '$[1]') AND is_draft = 0 AND is_spam = 0 AND is_trash = 0)`,
      JSON.stringify(afterSummary),
    ))
      still.add(thread_id);
  }
  return still;
}

export function waitingPage(db: Db, o: { now: number; after: { lastDate: number; id: number } | null; limit: number }): { id: number; lastDate: number; hasSent: boolean; waitingSince: number }[] {
  const { after } = o;
  return needsRows(db, o.now)
    .filter((r) => !after || r.lastDate < after.lastDate || (r.lastDate === after.lastDate && r.id < after.id))
    .slice(0, o.limit)
    .map((r) => ({ id: r.id, lastDate: r.lastDate, hasSent: r.hasSent, waitingSince: r.waitingSince }));
}

export function waitingAmong(db: Db, threadIds: readonly number[], now: number): number[] {
  const wanted = new Set(threadIds);
  return needsRows(db, now).filter((r) => wanted.has(r.id)).map((r) => r.id);
}

/** Plan 210 (iteration 2): of these threads, those still here and in neither Spam nor Trash: one read. */
export function liveAmong(db: Db, threadIds: readonly number[]): Set<number> {
  if (!threadIds.length) return new Set();
  return new Set(db.all<{ id: number }>("SELECT id FROM threads WHERE id IN (SELECT value FROM json_each(?)) AND in_spam = 0 AND in_trash = 0", JSON.stringify([...new Set(threadIds)])).map((r) => r.id));
}

/** Plan 210 (iteration 2): the dated items and promises of these canonical items, any state: by id, and by `same_as`'s index. */
export function itemMembers(db: Db, keys: readonly string[]): { dated: DatedRow[]; promises: FollowupRow[] } {
  const refs = [...new Set(keys)].flatMap((key) => {
    const ref = parseRef(key);
    return ref ? [{ key, ref }] : [];
  });
  if (!refs.length) return { dated: [], promises: [] };
  const ids = (source: ItemRef["source"]) => JSON.stringify(refs.filter((r) => r.ref.source === source).map((r) => r.ref.id));
  const all = JSON.stringify(refs.map((r) => r.key));
  // whole rows in one read a table (Codex code review of iteration 3: a row each was a thousand reads for a thousand links)
  const dated = db.all<DatedRaw>("SELECT * FROM dated_items WHERE id IN (SELECT value FROM json_each(?) UNION SELECT id FROM dated_items INDEXED BY dated_same WHERE same_as IN (SELECT value FROM json_each(?))) ORDER BY id", ids("dated"), all);
  const promises = db.all<FollowupRaw>("SELECT * FROM followups WHERE kind = 'promise' AND id IN (SELECT value FROM json_each(?) UNION SELECT id FROM followups INDEXED BY followups_same WHERE same_as IN (SELECT value FROM json_each(?))) ORDER BY id", ids("promise"), all);
  return { dated: dated.map(datedRow), promises: promises.map(followupRow) };
}

/** Each table's name and its open rows, as SQL. */
const TABLE = { dated: "dated_items", promise: "followups" } as const;
const OPEN = { dated: "state = 'open'", promise: "kind = 'promise' AND state IN ('open','due')" } as const;

/**
 * Plan 210 (iteration 2): membership as the backend's matcher found it, on open rows, never over one already set, never a
 * chain (the target is a canonical, and an item others are the same as isn't made anyone's). It's no choice of the user's,
 * so no revision moves: an Undo taken before it still applies.
 */
export function linkItems(db: Db, o: { same: readonly { item: ItemRef; sameAs: string }[]; details: readonly { id: number; detailOf: number }[] }): number {
  return db.tx(() => {
    let n = 0;
    for (const { item, sameAs } of o.same) {
      const target = parseRef(sameAs);
      if (!target || sameAs === refKey(item)) continue;
      const canonical = db.get<{ same_as: string | null }>(`SELECT same_as FROM ${TABLE[target.source]} WHERE id = ?${target.source === "promise" ? " AND kind = 'promise'" : ""}`, target.id);
      if (!canonical || canonical.same_as !== null) continue;
      if (db.get("SELECT 1 FROM dated_items INDEXED BY dated_same WHERE same_as = ? UNION ALL SELECT 1 FROM followups INDEXED BY followups_same WHERE same_as = ? LIMIT 1", refKey(item), refKey(item))) continue;
      n += Number(db.run(`UPDATE ${TABLE[item.source]} SET same_as = ? WHERE id = ? AND same_as IS NULL AND ${OPEN[item.source]}`, sameAs, item.id).changes);
    }
    for (const d of o.details) {
      if (d.id === d.detailOf || !db.get("SELECT 1 FROM dated_items WHERE id = ?", d.detailOf)) continue;
      n += Number(db.run("UPDATE dated_items SET detail_of = ? WHERE id = ? AND detail_of IS NULL AND state = 'open'", d.detailOf, d.id).changes);
    }
    return n;
  });
}

const atRevision = (db: Db, table: string, id: number, revision: number): boolean => !!db.get(`SELECT 1 FROM ${table} WHERE id = ? AND revision = ?`, id, revision);

/** Plan 210 (iteration 2): one act on every item a row is, each at the revision it was seen at, or on none. */
export function actOnItems(db: Db, changes: ItemChanges): ItemSnapshots | null {
  return db.tx(() => {
    if (!changes.dated.every((c) => atRevision(db, "dated_items", c.id, c.revision)) || !changes.promises.every((c) => atRevision(db, "followups", c.id, c.revision))) return null;
    return { dated: changes.dated.map((c) => updateDated(db, c.id, c.revision, c.patch)!), promises: changes.promises.map((c) => updateFollowup(db, c.id, c.revision, c.patch)!) };
  });
}

/** Its Undo: every row still at the revision the act left, or none restored. */
export function restoreItems(db: Db, s: ItemSnapshots): boolean {
  return db.tx(() => {
    if (!s.dated.every((r) => atRevision(db, "dated_items", r.id, r.revision + 1)) || !s.promises.every((r) => atRevision(db, "followups", r.id, r.revision + 1))) return false;
    restoreDated(db, s.dated.map((snapshot) => ({ snapshot, expectRevision: snapshot.revision + 1 })));
    restoreFollowups(db, s.promises.map((snapshot) => ({ snapshot, expectRevision: snapshot.revision + 1 })));
    return true;
  });
}

export function needsCount(db: Db, now: number): number {
  return needsRows(db, now).length;
}

export function digestFacts(db: Db, messageIds: readonly number[]): { facts: DigestFact[]; oldest: number | null } {
  const ids = JSON.stringify(messageIds);
  const oldest = db.get<{ at: number | null }>("SELECT min(created_at) AS at FROM messages WHERE id IN (SELECT value FROM json_each(?))", ids)?.at ?? null;
  const facts = db
    .all<{ thread_id: number; message_id: number; account_id: number; created_at: number; last_date: number; message_count: number; from_name: string; from_email: string; subject: string; snippet: string; code: string | null }>(
      `SELECT t.id AS thread_id, m.id AS message_id, t.account_id, m.created_at, t.last_date, t.message_count, m.from_name, m.from_email, m.subject, m.snippet, m.code
       FROM messages m JOIN threads t ON t.id = m.thread_id
       WHERE m.id IN (SELECT value FROM json_each(?))
         AND m.is_read = 0 AND m.is_sent = 0 AND m.is_draft = 0 AND m.is_spam = 0 AND m.is_trash = 0
         AND (m.list_id IS NOT NULL OR m.is_bulk = 1)
         AND m.date = t.last_date
         AND t.in_inbox = 1 AND t.tab != 2 AND t.person = 0 AND t.is_starred = 0 AND t.has_sent = 0 AND t.in_spam = 0 AND t.in_trash = 0
         AND (m.gmail_labels IS NULL OR m.gmail_labels NOT LIKE '%CATEGORY_UPDATES%')
       ORDER BY m.id DESC`,
      ids,
    )
    .map((r) => ({ threadId: r.thread_id, messageId: r.message_id, accountId: r.account_id, arrivedAt: r.created_at, lastDate: r.last_date, messageCount: r.message_count, from: r.from_name || r.from_email, fromEmail: r.from_email, subject: r.subject, snippet: r.snippet, code: r.code }));
  return { facts, oldest };
}

export const messagesHere = (db: Db, ids: readonly number[]): number[] => db.all<{ id: number }>("SELECT id FROM messages WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(ids)).map((r) => r.id);

export const senders = (db: Db, ids: readonly number[]): Map<number, string> =>
  new Map(db.all<{ id: number; from_email: string }>("SELECT id, from_email FROM messages WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(ids)).map((r) => [r.id, r.from_email]));

/** Plan 210 (iteration 3): see the store's `fromOf`. */
export const fromOf = (db: Db, ids: readonly number[]): Map<number, { name: string; email: string }> =>
  new Map(db.all<{ id: number; from_name: string | null; from_email: string | null }>("SELECT id, from_name, from_email FROM messages WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(ids)).map((r) => [r.id, { name: r.from_name ?? "", email: r.from_email ?? "" }]));

export function digestLive(db: Db, threadIds: readonly number[]): number[] {
  return db.all<{ id: number }>("SELECT id FROM threads WHERE id IN (SELECT value FROM json_each(?)) AND in_inbox = 1 AND unread_count > 0", JSON.stringify(threadIds)).map((r) => r.id);
}

export function digestRead(db: Db, threadIds: readonly number[]): number[] {
  return db.all<{ id: number }>("SELECT id FROM threads WHERE id IN (SELECT value FROM json_each(?)) AND in_inbox = 1 AND unread_count = 0", JSON.stringify(threadIds)).map((r) => r.id);
}

interface Raw {
  day: string;
  state: DigestStored["state"];
  body_json: string | null;
  attempts: number;
  error_kind: string | null;
  watermark_at: number;
  watermark_id: number;
  model: string | null;
  provider: string | null;
  prompt_version: number | null;
  generated_at: number | null;
}

const stored = (r: Raw): DigestStored => {
  const body = r.body_json ? (JSON.parse(r.body_json) as { items: DigestItem[]; pending: DigestItem[] }) : { items: [], pending: [] };
  return { day: r.day, state: r.state, items: body.items, pending: body.pending, attempts: r.attempts, errorKind: r.error_kind, watermark: { at: r.watermark_at, id: r.watermark_id }, model: r.model, provider: r.provider, promptVersion: r.prompt_version, generatedAt: r.generated_at };
};

export const getDigest = (db: Db, day: string): DigestStored | null => {
  const r = db.get<Raw>("SELECT * FROM ai_digests WHERE day = ?", day);
  return r ? stored(r) : null;
};

export const latestDigest = (db: Db, day: string): DigestStored | null => {
  const r = db.get<Raw>("SELECT * FROM ai_digests WHERE day <= ? ORDER BY day DESC LIMIT 1", day);
  return r ? stored(r) : null;
};

export function beginDigest(db: Db, day: string, watermark: { at: number; id: number }, pending: readonly DigestItem[]): boolean {
  const r = db.run("INSERT OR IGNORE INTO ai_digests (day, state, body_json, watermark_at, watermark_id) VALUES (?, 'pending', ?, ?, ?)", day, JSON.stringify({ items: [], pending }), watermark.at, watermark.id);
  return Number(r.changes) > 0;
}

export function writeDigest(db: Db, w: DigestStored): void {
  db.run(
    `UPDATE ai_digests SET state = ?, body_json = ?, attempts = ?, error_kind = ?, model = ?, provider = ?, prompt_version = ?, generated_at = ? WHERE day = ?`,
    w.state, JSON.stringify({ items: w.items, pending: w.pending }), w.attempts, w.errorKind, w.model, w.provider, w.promptVersion, w.generatedAt, w.day,
  );
}

export const allDigests = (db: Db): DigestStored[] => db.all<Raw>("SELECT * FROM ai_digests ORDER BY day").map(stored);
export const pendingDigestDays = (db: Db): string[] => db.all<{ day: string }>("SELECT day FROM ai_digests WHERE state = 'pending' ORDER BY day").map((r) => r.day);
export const pruneDigests = (db: Db, keepFrom: string): void => void db.run("DELETE FROM ai_digests WHERE day < ?", keepFrom);
export const clearDigests = (db: Db): void => void db.run("DELETE FROM ai_digests");
