import { RevisionError, type IndexBatch, type IndexChange, type Revision, type SearchBuild } from "@terno/store";
import { messageDocs, messageDocsAfter, threadDocs, threadDocsAfter } from "./search-docs";
import type { Db } from "./sqlite";

/** Batches kept for engines catching up; older ones are pruned (an engine behind them rebuilds). */
export const SEARCH_LOG_BYTES = 32 * 1024 * 1024;

/**
 * A stored batch is the ids it touched: [[messageIds], [threadIds]]. The
 * projections are read when the batch is served (changes()), so a commit
 * writes a few bytes per id instead of copying mail text into the log; the
 * docs served are the newest committed state of each id, never older than
 * the batch, and a later change to the same id always has a later batch, so
 * replaying converges on the store.
 */
const BATCH_IDS = `SELECT '[[' || coalesce((SELECT group_concat(id) FROM search_dirty WHERE kind = 0), '') || '],[' ||
  coalesce((SELECT group_concat(id) FROM search_dirty WHERE kind = 1), '') || ']]' AS changes`;

/** Absolute projections (or tombstones) of the given ids, read now. */
export function materializeChanges(db: Db, messageIds: readonly number[], threadIds: readonly number[]): IndexChange[] {
  const changes: IndexChange[] = [];
  if (messageIds.length) {
    const docs = new Map(messageDocs(db, messageIds).map((d) => [d.messageId, d]));
    for (const id of messageIds) {
      const doc = docs.get(id);
      changes.push(doc ? { kind: "upsertMessage", doc } : { kind: "removeMessage", messageId: id });
    }
  }
  if (threadIds.length) {
    const docs = new Map(threadDocs(db, threadIds).map((d) => [d.threadId, d]));
    for (const id of threadIds) {
      const doc = docs.get(id);
      changes.push(doc ? { kind: "upsertThread", doc } : { kind: "removeThread", threadId: id });
    }
  }
  return changes;
}

/**
 * The finalizer of every write transaction (Db's before-commit hook): appends
 * the message and thread ids the v7 triggers marked dirty as ONE revisioned
 * batch, inside the same transaction. A rollback takes the batch with it.
 */
export function flushSearchOutbox(db: Db, maxBytes = SEARCH_LOG_BYTES): void {
  if (db.get("SELECT 1 FROM search_dirty LIMIT 1") === undefined) return;
  const state = db.get<{ seq: number; bytes: number }>("SELECT seq, bytes FROM search_state WHERE id = 1")!;
  const seq = state.seq + 1;
  const added = db.get<{ bytes: number }>(
    `INSERT INTO search_outbox (seq, at, bytes, changes) SELECT ?, ?, length(CAST(changes AS BLOB)), changes FROM (${BATCH_IDS}) RETURNING bytes`,
    seq,
    Date.now(),
  )!.bytes;
  db.run("DELETE FROM search_dirty");
  let bytes = state.bytes + added;
  if (bytes > maxBytes) bytes -= pruneLog(db, bytes - maxBytes, seq);
  db.run("UPDATE search_state SET seq = ?, bytes = ? WHERE id = 1", seq, bytes);
}

/** Oldest batches looked at per prune step; a commit inspects at most PRUNE_PAGES of them. */
const PRUNE_PAGE = 256;
const PRUNE_PAGES = 4;

/**
 * Drops the oldest batches (never the newest, never past an active build's
 * start); returns the bytes freed. Bounded work per commit: what is still in
 * excess afterwards is freed by the next commits.
 */
function pruneLog(db: Db, excess: number, newest: number): number {
  const lease = db.get<{ s: number | null }>("SELECT min(from_seq) AS s FROM search_leases")!.s;
  const keepFrom = Math.min(newest, lease === null ? newest : lease + 1);
  let freed = 0;
  let last = 0;
  for (let page = 0; page < PRUNE_PAGES && freed < excess; page++) {
    const rows = db.all<{ seq: number; bytes: number }>("SELECT seq, bytes FROM search_outbox WHERE seq > ? AND seq < ? ORDER BY seq LIMIT ?", last, keepFrom, PRUNE_PAGE);
    for (const r of rows) {
      if (freed >= excess) break;
      freed += r.bytes;
      last = r.seq;
    }
    if (rows.length < PRUNE_PAGE) break;
  }
  if (last) db.run("DELETE FROM search_outbox WHERE seq <= ?", last);
  return freed;
}

export function searchHead(db: Db): Revision {
  const r = db.get<{ epoch: string; seq: number }>("SELECT epoch, seq FROM search_state WHERE id = 1")!;
  return { epoch: r.epoch, seq: r.seq };
}

export interface ChangeIds {
  from: Revision;
  to: Revision;
  messageIds: number[];
  threadIds: number[];
}

/** Committed batches in (after, through], oldest first. A gap (pruned log) or another epoch is refused: rebuild. */
export function searchChanges(db: Db, after: Revision, through: Revision, maxCommits: number): IndexBatch[] {
  return searchChangeIds(db, after, through, maxCommits).map((c) => ({ from: c.from, to: c.to, changes: materializeChanges(db, c.messageIds, c.threadIds) }));
}

/** The ids each committed batch in (after, through] touched, oldest first, without reading projections. */
export function searchChangeIds(db: Db, after: Revision, through: Revision, maxCommits: number): ChangeIds[] {
  const head = searchHead(db);
  if (after.epoch !== head.epoch || through.epoch !== head.epoch) throw new RevisionError("epoch", "the search log belongs to another database");
  if (after.seq > head.seq || through.seq > head.seq) throw new RevisionError("ahead", "that revision hasn't been committed");
  if (through.seq <= after.seq) return [];
  const oldest = db.get<{ s: number | null }>("SELECT min(seq) AS s FROM search_outbox")!.s;
  if (oldest === null || oldest > after.seq + 1) throw new RevisionError("gap", `the search log was pruned past revision ${after.seq}`);
  return db
    .all<{ seq: number; changes: string }>("SELECT seq, changes FROM search_outbox WHERE seq > ? AND seq <= ? ORDER BY seq LIMIT ?", after.seq, through.seq, maxCommits)
    .map((r) => {
      const [messageIds, threadIds] = JSON.parse(r.changes) as [number[], number[]];
      return { from: { epoch: head.epoch, seq: r.seq - 1 }, to: { epoch: head.epoch, seq: r.seq }, messageIds, threadIds };
    });
}

/** Holds the log from the current head while a rebuild scans in bounded chunks (a page of 500 reads in ~2 ms). */
export function beginSearchBuild(db: Db, chunk = 500): SearchBuild {
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
