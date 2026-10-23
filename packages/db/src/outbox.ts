import { RevisionError, type IndexBatch, type IndexChange, type Revision, type SearchBuild, type SearchMessageDoc } from "@unica/store";
import { messageDocsAfter, threadDocsAfter } from "./search-docs";
import type { Db } from "./sqlite";

/** Batches kept for engines catching up; older ones are pruned (an engine behind them rebuilds). */
export const SEARCH_LOG_BYTES = 32 * 1024 * 1024;

/**
 * The stored form of a batch: a JSON array of compact entries, built by SQL
 * straight from the dirty ids (no rows materialized in JS, a fifth of the
 * bytes of keyed objects: a 5,000-thread move must stay inside its
 * interactive budget). changes() decodes them into IndexChanges.
 *   [0, {message doc}]  upsertMessage      [1, messageId]  removeMessage
 *   [2, threadId, accountId, lastDate, flags, unreadCount, [categoryIds]]  upsertThread
 *   [3, threadId]  removeThread
 * flags: inInbox 1, hasSent 2, inTrash 4, inSpam 8, isStarred 16.
 */
const BATCH_JSON = `SELECT '[' || coalesce(group_concat(c, ','), '') || ']' AS changes FROM (
  SELECT '[0,' || json_object(
    'messageId', m.id, 'threadId', m.thread_id, 'accountId', m.account_id, 'date', m.date, 'subject', m.subject,
    'fromText', m.from_name || ' ' || m.from_email, 'fromEmail', m.from_email, 'recipients', m.recipients_text,
    'body', coalesce(b.body_text, ''), 'hasAttachments', m.has_attachments, 'bodyState', m.body_state) || ']' AS c
  FROM search_dirty d JOIN messages m ON m.id = d.id LEFT JOIN message_bodies b ON b.message_id = m.id WHERE d.kind = 0
  UNION ALL
  SELECT '[1,' || d.id || ']' FROM search_dirty d WHERE d.kind = 0 AND NOT EXISTS (SELECT 1 FROM messages WHERE id = d.id)
  UNION ALL
  SELECT '[2,' || t.id || ',' || t.account_id || ',' || t.last_date || ',' ||
         (t.in_inbox + 2 * t.has_sent + 4 * t.in_trash + 8 * t.in_spam + 16 * t.is_starred) || ',' || t.unread_count || ',[' ||
         coalesce((SELECT group_concat(category_id) FROM (SELECT category_id FROM thread_categories WHERE thread_id = t.id ORDER BY category_id)), '') || ']]'
  FROM search_dirty d JOIN threads t ON t.id = d.id WHERE d.kind = 1
  UNION ALL
  SELECT '[3,' || d.id || ']' FROM search_dirty d WHERE d.kind = 1 AND NOT EXISTS (SELECT 1 FROM threads WHERE id = d.id)
)`;

type Entry = [0, Omit<SearchMessageDoc, "hasAttachments"> & { hasAttachments: number }] | [1, number] | [2, number, number, number, number, number, number[]] | [3, number];

function decode(changes: string): IndexChange[] {
  return (JSON.parse(changes) as Entry[]).map((e): IndexChange => {
    switch (e[0]) {
      case 0:
        return { kind: "upsertMessage", doc: { ...e[1], hasAttachments: e[1].hasAttachments === 1 } };
      case 1:
        return { kind: "removeMessage", messageId: e[1] };
      case 2: {
        const [, threadId, accountId, lastDate, flags, unreadCount, categoryIds] = e;
        return {
          kind: "upsertThread",
          doc: { threadId, accountId, lastDate, inInbox: (flags & 1) !== 0, hasSent: (flags & 2) !== 0, inTrash: (flags & 4) !== 0, inSpam: (flags & 8) !== 0, isStarred: (flags & 16) !== 0, unreadCount, categoryIds },
        };
      }
      case 3:
        return { kind: "removeThread", threadId: e[1] };
    }
  });
}

/**
 * The finalizer of every write transaction (Db's before-commit hook): turns
 * the message and thread ids the v7 triggers marked dirty into absolute
 * post-commit projections (or tombstones) and appends them as ONE revisioned
 * batch, inside the same transaction. A rollback takes the batch with it.
 */
export function flushSearchOutbox(db: Db, maxBytes = SEARCH_LOG_BYTES): void {
  if (db.get("SELECT 1 FROM search_dirty LIMIT 1") === undefined) return;
  const state = db.get<{ seq: number; bytes: number }>("SELECT seq, bytes FROM search_state WHERE id = 1")!;
  const seq = state.seq + 1;
  const added = db.get<{ bytes: number }>(
    `INSERT INTO search_outbox (seq, at, bytes, changes) SELECT ?, ?, length(changes), changes FROM (${BATCH_JSON}) RETURNING bytes`,
    seq,
    Date.now(),
  )!.bytes;
  db.run("DELETE FROM search_dirty");
  let bytes = state.bytes + added;
  if (bytes > maxBytes) bytes -= pruneLog(db, bytes - maxBytes, seq);
  db.run("UPDATE search_state SET seq = ?, bytes = ? WHERE id = 1", seq, bytes);
}

/** Drops the oldest batches (never the newest, never past an active build's start); returns the bytes freed. */
function pruneLog(db: Db, excess: number, newest: number): number {
  const lease = db.get<{ s: number | null }>("SELECT min(from_seq) AS s FROM search_leases")!.s;
  const keepFrom = Math.min(newest, lease === null ? newest : lease + 1);
  let freed = 0;
  let last = 0;
  for (const r of db.all<{ seq: number; bytes: number }>("SELECT seq, bytes FROM search_outbox WHERE seq < ? ORDER BY seq", keepFrom)) {
    if (freed >= excess) break;
    freed += r.bytes;
    last = r.seq;
  }
  if (last) db.run("DELETE FROM search_outbox WHERE seq <= ?", last);
  return freed;
}

export function searchHead(db: Db): Revision {
  const r = db.get<{ epoch: string; seq: number }>("SELECT epoch, seq FROM search_state WHERE id = 1")!;
  return { epoch: r.epoch, seq: r.seq };
}

/** Committed batches in (after, through], oldest first. A gap (pruned log) or another epoch is refused: rebuild. */
export function searchChanges(db: Db, after: Revision, through: Revision, maxCommits: number): IndexBatch[] {
  const head = searchHead(db);
  if (after.epoch !== head.epoch || through.epoch !== head.epoch) throw new RevisionError("epoch", "the search log belongs to another database");
  if (after.seq > head.seq || through.seq > head.seq) throw new RevisionError("ahead", "that revision hasn't been committed");
  if (through.seq <= after.seq) return [];
  const oldest = db.get<{ s: number | null }>("SELECT min(seq) AS s FROM search_outbox")!.s;
  if (oldest === null || oldest > after.seq + 1) throw new RevisionError("gap", `the search log was pruned past revision ${after.seq}`);
  return db
    .all<{ seq: number; changes: string }>("SELECT seq, changes FROM search_outbox WHERE seq > ? AND seq <= ? ORDER BY seq LIMIT ?", after.seq, through.seq, maxCommits)
    .map((r) => ({ from: { epoch: head.epoch, seq: r.seq - 1 }, to: { epoch: head.epoch, seq: r.seq }, changes: decode(r.changes) }));
}

/** Holds the log from the current head while a rebuild scans in bounded chunks. */
export function beginSearchBuild(db: Db, chunk = 2000): SearchBuild {
  const { from, lease } = db.tx(() => {
    const from = searchHead(db);
    return { from, lease: db.run("INSERT INTO search_leases (from_seq, created_at) VALUES (?, ?)", from.seq, Date.now()).lastInsertRowid };
  });
  return {
    from,
    async *messages() {
      for (let after = 0; ; ) {
        const page = messageDocsAfter(db, after, chunk);
        if (page.length === 0) return;
        yield page;
        after = page[page.length - 1]!.messageId;
      }
    },
    async *threads() {
      for (let after = 0; ; ) {
        const page = threadDocsAfter(db, after, chunk);
        if (page.length === 0) return;
        yield page;
        after = page[page.length - 1]!.threadId;
      }
    },
    release: async () => {
      if (db.isOpen) db.run("DELETE FROM search_leases WHERE id = ?", lease);
    },
  };
}
