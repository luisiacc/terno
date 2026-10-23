import { expect, it } from "vitest";
import { ingestMessages } from "./ingest";
import { adaptPageCache, btreeBytes, cacheBytesFor, hotBtrees, PAGE_CACHE } from "./page-cache";
import { msg, testDb, withAccounts } from "./test/helpers";

it("the hot set is messages, threads, memberships and the FTS index, never bodies", () => {
  const db = testDb();
  const hot = hotBtrees(db);
  expect(hot).toEqual(expect.arrayContaining(["messages", "threads", "thread_categories", "messages_fts_data", "messages_fts_idx", "threads_inbox"]));
  expect(hot).not.toContain("message_bodies");
  expect(hot).not.toContain("messages_fts");
});

it("sizes the cache to 1.3 × the hot b-trees, within [64, 192] MiB", async () => {
  const db = testDb();
  const [a] = withAccounts(db);
  ingestMessages(db, Array.from({ length: 300 }, () => msg({ accountId: a!, bodyText: "presupuesto ".repeat(400) })));
  expect(btreeBytes(db, "messages")).toBeGreaterThan(0);
  expect(btreeBytes(db, "message_bodies")).toBeGreaterThan(btreeBytes(db, "messages"));
  expect(cacheBytesFor(1)).toBe(PAGE_CACHE.minBytes);
  expect(cacheBytesFor(100 * 1024 * 1024)).toBe(130 * 1024 * 1024);
  expect(cacheBytesFor(10 ** 12)).toBe(PAGE_CACHE.maxBytes);
  const r = await adaptPageCache(db, async () => {});
  expect(r.hotBytes).toBe(hotBtrees(db).reduce((s, n) => s + btreeBytes(db, n), 0));
  expect(db.get("PRAGMA cache_size")).toEqual({ cache_size: -Math.ceil(r.cacheBytes / 1024) });
});
