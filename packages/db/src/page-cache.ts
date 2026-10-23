import type { Db } from "./sqlite";

const MiB = 1024 * 1024;

/**
 * Plan 04 §2: on OPFS the cliff is the page cache, not the VFS. A search
 * reads the FTS index, messages and threads; when those don't fit, every
 * query re-reads pages through the access handle (50k messages: 64 MB of
 * cache answers in 10–13 ms, 32 MB in 556 ms). So the cache follows the hot
 * set: 1.3 × the pages of everything but bodies, within [64 MiB, 192 MiB].
 */
export const PAGE_CACHE = { minBytes: 64 * MiB, maxBytes: 192 * MiB, factor: 1.3 };

/** Tables and indexes that lists and searches read: all but message bodies, drafts and logs. */
export function hotBtrees(db: Db): string[] {
  return db
    .all<{ name: string }>(
      `SELECT name FROM sqlite_schema
        WHERE type IN ('table', 'index') AND rootpage > 0
          AND (tbl_name IN ('messages', 'threads', 'thread_categories', 'categories', 'accounts') OR name LIKE 'messages!_fts!_%' ESCAPE '!')`,
    )
    .map((r) => r.name);
}

/** Bytes of one table or index (dbstat walks only that b-tree). */
export function btreeBytes(db: Db, name: string): number {
  return db.get<{ b: number }>("SELECT coalesce(sum(pgsize), 0) AS b FROM dbstat WHERE name = ? AND aggregate = TRUE", name)!.b;
}

export function databaseBytes(db: Db): number {
  const pages = db.get<{ page_count: number }>("PRAGMA page_count")!.page_count;
  const size = db.get<{ page_size: number }>("PRAGMA page_size")!.page_size;
  return pages * size;
}

export function cacheBytesFor(hotBytes: number): number {
  return Math.round(Math.min(PAGE_CACHE.maxBytes, Math.max(PAGE_CACHE.minBytes, hotBytes * PAGE_CACHE.factor)));
}

export function setCacheBytes(db: Db, bytes: number): void {
  db.exec(`PRAGMA cache_size = -${Math.ceil(bytes / 1024)}`);
}

/**
 * Sizes the cache to the hot set without stalling: first to the whole file
 * (never smaller than what's hot, so nothing thrashes meanwhile), then one
 * b-tree per slice, then to 1.3 × what is hot. Measuring reads those pages,
 * which also warms the cache for the first searches. Re-run after imports.
 */
export async function adaptPageCache(db: Db, yieldTo: () => Promise<void>): Promise<{ hotBytes: number; cacheBytes: number }> {
  setCacheBytes(db, cacheBytesFor(databaseBytes(db)));
  let hot = 0;
  for (const name of hotBtrees(db)) {
    await yieldTo();
    if (!db.isOpen) break;
    hot += btreeBytes(db, name);
  }
  const cacheBytes = cacheBytesFor(hot);
  if (db.isOpen) setCacheBytes(db, cacheBytes);
  return { hotBytes: hot, cacheBytes };
}
