import { addressKey, isAcknowledgment, looksLikeAcknowledgment, parseRef, refKey, saysNoReplyNeeded, waitingCutoff, type DatedRow, type DigestItem, type FollowupRow, type ItemRef } from "@terno/core";
import { DATED_NOTHING_ASKED_SINCE, NEEDS_WALK, needsYou, summaryAsksNothing, type DigestFact, type DigestStored, type ItemChanges, type ItemSnapshots, type WaitingRow } from "@terno/store";
import { datedRow, mutedSenders, restoreDated, updateDated, type DatedRaw } from "./dated";
import { followupRow, restoreFollowups, updateFollowup, type FollowupRaw } from "./followups";
import { inboxHiding, shownSql } from "./queries";
import type { Db } from "./sqlite";

/** Plan 145 on SQLite (v54): see packages/store/src/today.ts. */

/** The newest waiting threads in date order: threads_waiting is in it, threads_waiting_inbox isn't (revision 11). */
function needsRows(db: Db, now: number): WaitingRow[] {
  const cutoff = waitingCutoff(now);
  const hiding = shownSql(inboxHiding(db));
  const rows = db.all<{ id: number; last_date: number; last_from_email: string; subject: string; has_sent: number; snippet: string | null }>(
    `SELECT id, last_date, last_from_email, subject, has_sent, snippet FROM threads INDEXED BY threads_waiting
     WHERE waiting_since IS NOT NULL AND last_date >= ? AND waiting_since >= ? AND in_inbox = 1${hiding.where}
     ORDER BY last_date DESC, id DESC LIMIT ?`,
    cutoff,
    cutoff,
    ...hiding.params,
    NEEDS_WALK,
  );
  const snippets = new Map(rows.map((r) => [r.id, r.snippet]));
  const needs = needsYou(
    rows.map((r) => ({ id: r.id, lastDate: r.last_date, from: r.last_from_email, subject: r.subject, hasSent: r.has_sent === 1 })),
    (key) => db.get<{ written: number; own: number }>("SELECT written, own FROM correspondents WHERE email = ?", key),
  );
  // plan 210 (iteration 4): a muted sender's conversations aren't waiting on you in What matters, read once a walk; nothing
  // is recorded for them (`dated_nothing_asked`), so Unmute brings them back as they are
  const muted = mutedSenders(db);
  // plan 204, the second panel round (plan 145's rule, tighter): on what needsYou let in, never widening it
  return needs.filter((r) => !(muted.size && muted.has(addressKey(r.from))) && stillWaiting(db, r.id, snippets.get(r.id) ?? null, now));
}

/**
 * Not read by the dated reader with nothing asked (plan 210), not handled, not an acknowledgment, and no current summary that gives the reader nothing to do or answer (see
 * packages/store/src/today.ts). Handled (Codex code review): a dated item read from their latest message is done, not a
 * task, settled or put off till later; it's read from the item, so the item's Undo brings the conversation back as it was.
 */
function stillWaiting(db: Db, threadId: number, snippet: string | null, now: number): boolean {
  // the fourth panel read: they said no answer is needed ("No action needed!"), in its first words
  if (saysNoReplyNeeded(snippet)) return false;
  const ack = looksLikeAcknowledgment(snippet);
  // their latest message, looked up once and only when a rule below needs it; its text in the same statement when the
  // snippet starts like a thanks
  let latest: { id: number; date: number; text: string | null } | null | undefined;
  const last = () =>
    latest !== undefined
      ? latest
      : (latest =
          db.get<{ id: number; date: number; text: string | null }>(
            `SELECT m.id, m.date, CASE WHEN ? THEN (SELECT coalesce(b.body_text, b.body_preview) FROM message_bodies b WHERE b.message_id = m.id) END AS text
             FROM messages m INDEXED BY messages_thread WHERE m.thread_id = ? AND m.is_sent = 0 AND m.is_draft = 0 AND m.is_spam = 0 AND m.is_trash = 0 ORDER BY m.date DESC, m.id DESC LIMIT 1`,
            ack ? 1 : 0,
            threadId,
          ) ?? null);
  // plan 210 (iteration 2, the owner: "only when something is asked"): the dated reader read their latest message and found
  // nothing asked of the reader. Mail it hasn't read (off, older, still queued) keeps plan 145's rule; newer mail isn't the one read
  const read = db.all<{ message_id: number }>("SELECT message_id FROM dated_nothing_asked INDEXED BY dated_nothing_asked_thread WHERE thread_id = ? AND prompt_version >= ?", threadId, DATED_NOTHING_ASKED_SINCE);
  if (read.length && read.some((r) => r.message_id === last()?.id)) return false;
  // the thread's items (most have none): a dated item read from their latest message, handled
  const handled = db.all<{ message_id: number }>("SELECT message_id FROM dated_items INDEXED BY dated_thread WHERE thread_id = ? AND (state IN ('done', 'dismissed', 'settled') OR deferred_until > ?)", threadId, now);
  if (handled.length && handled.some((h) => h.message_id === last()?.id)) return false;
  // Codex code review (round 4): a promise of yours there closed (Done, Not a promise) since their latest message, with
  // none still open, is the row you handled; from the promises' states, so Undo brings the conversation back, and newer
  // mail from them too
  const kept = db.get<{ at: number | null; open: number; deferred: number }>(
    "SELECT max(CASE WHEN state IN ('done', 'dismissed') THEN closed_at END) AS at, count(CASE WHEN state IN ('open', 'due') AND coalesce(deferred_until, 0) <= ? THEN 1 END) AS open, count(CASE WHEN state IN ('open', 'due') AND deferred_until > ? THEN 1 END) AS deferred FROM followups INDEXED BY followups_thread WHERE thread_id = ? AND kind = 'promise'",
    now, now, threadId,
  );
  // plan 204 (the fifth panel round): its only open promises put off with Later, it waits for them (Undo brings it back)
  if (kept && kept.deferred > 0 && kept.open === 0) return false;
  if (kept?.at != null && kept.open === 0) {
    const m = last();
    if (m && kept.at >= m.date) return false;
  }
  if (ack && isAcknowledgment(last()?.text)) return false;
  const summary = db.get<{ state: string; prompt_version: number | null; body_json: string | null; generated_at: number | null }>("SELECT state, prompt_version, body_json, generated_at FROM ai_summaries WHERE thread_id = ?", threadId);
  if (!summaryAsksNothing(summary)) return true;
  // current: nothing the thread shows arrived after it was written
  return !!db.get("SELECT 1 FROM messages INDEXED BY messages_thread WHERE thread_id = ? AND created_at >= ? AND is_draft = 0 AND is_spam = 0 AND is_trash = 0 LIMIT 1", threadId, summary!.generated_at);
}

export function waitingPage(db: Db, o: { now: number; after: { lastDate: number; id: number } | null; limit: number }): { id: number; lastDate: number; hasSent: boolean }[] {
  const { after } = o;
  return needsRows(db, o.now)
    .filter((r) => !after || r.lastDate < after.lastDate || (r.lastDate === after.lastDate && r.id < after.id))
    .slice(0, o.limit)
    .map((r) => ({ id: r.id, lastDate: r.lastDate, hasSent: r.hasSent }));
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
    .all<{ thread_id: number; message_id: number; account_id: number; created_at: number; last_date: number; message_count: number; from_name: string; from_email: string; subject: string; snippet: string }>(
      `SELECT t.id AS thread_id, m.id AS message_id, t.account_id, m.created_at, t.last_date, t.message_count, m.from_name, m.from_email, m.subject, m.snippet
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
    .map((r) => ({ threadId: r.thread_id, messageId: r.message_id, accountId: r.account_id, arrivedAt: r.created_at, lastDate: r.last_date, messageCount: r.message_count, from: r.from_name || r.from_email, fromEmail: r.from_email, subject: r.subject, snippet: r.snippet }));
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
