import { waitingCutoff, type DigestItem } from "@terno/core";
import { type DigestFact, type DigestStored } from "@terno/store";
import { inboxHiding, shownSql } from "./queries";
import type { Db } from "./sqlite";

/** Plan 145 on SQLite (v54): see packages/store/src/today.ts. */

export function waitingPage(db: Db, o: { now: number; after: { lastDate: number; id: number } | null; limit: number }): { id: number; lastDate: number }[] {
  const cutoff = waitingCutoff(o.now);
  const hiding = shownSql(inboxHiding(db));
  // threads_waiting is in date order; threads_waiting_inbox isn't (revision 11)
  return db
    .all<{ id: number; last_date: number }>(
      `SELECT id, last_date FROM threads INDEXED BY threads_waiting
       WHERE waiting_since IS NOT NULL AND last_date >= ? AND waiting_since >= ? AND in_inbox = 1${hiding.where}
         ${o.after ? "AND (last_date, id) < (?, ?)" : ""}
       ORDER BY last_date DESC, id DESC LIMIT ?`,
      cutoff,
      cutoff,
      ...hiding.params,
      ...(o.after ? [o.after.lastDate, o.after.id] : []),
      o.limit,
    )
    .map((r) => ({ id: r.id, lastDate: r.last_date }));
}

export function waitingAmong(db: Db, threadIds: readonly number[], now: number): number[] {
  const cutoff = waitingCutoff(now);
  const hiding = shownSql(inboxHiding(db));
  return db.all<{ id: number }>(`SELECT id FROM threads WHERE id IN (SELECT value FROM json_each(?)) AND waiting_since IS NOT NULL AND last_date >= ? AND waiting_since >= ? AND in_inbox = 1${hiding.where}`, JSON.stringify(threadIds), cutoff, cutoff, ...hiding.params).map((r) => r.id);
}

export function digestFacts(db: Db, messageIds: readonly number[]): { facts: DigestFact[]; oldest: number | null } {
  const ids = JSON.stringify(messageIds);
  const oldest = db.get<{ at: number | null }>("SELECT min(created_at) AS at FROM messages WHERE id IN (SELECT value FROM json_each(?))", ids)?.at ?? null;
  const facts = db
    .all<{ thread_id: number; message_id: number; created_at: number; last_date: number; message_count: number; from_name: string; from_email: string; subject: string; snippet: string }>(
      `SELECT t.id AS thread_id, m.id AS message_id, m.created_at, t.last_date, t.message_count, m.from_name, m.from_email, m.subject, m.snippet
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
    .map((r) => ({ threadId: r.thread_id, messageId: r.message_id, arrivedAt: r.created_at, lastDate: r.last_date, messageCount: r.message_count, from: r.from_name || r.from_email, subject: r.subject, snippet: r.snippet }));
  return { facts, oldest };
}

export function digestLive(db: Db, threadIds: readonly number[]): number[] {
  return db.all<{ id: number }>("SELECT id FROM threads WHERE id IN (SELECT value FROM json_each(?)) AND in_inbox = 1 AND unread_count > 0", JSON.stringify(threadIds)).map((r) => r.id);
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
