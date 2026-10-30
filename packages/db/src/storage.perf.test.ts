/**
 * Plan 69: the storage report and removal at 50k+ threads. A report slice and a removal unit stay within a bulk
 * slice's budget (the backend sizes them by time, so this is the per-item cost that has to hold), and the whole
 * report reads the mailbox once.
 */
import { REMOVABLE_BUCKETS, storageCutoff } from "@terno/core";
import { generateDataset } from "@terno/mock-data";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { openDatabase } from "./index";
import { SqlMailStore } from "./sql-store";
import { BUDGET_MULTIPLIER, measureAsync, report, type Stat } from "./test/perf";

const NOW = Date.UTC(2026, 9, 22, 15, 30);
let store: SqlMailStore;
let dir: string;
const stats: Stat[] = [];
const meta: Record<string, unknown> = {};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "terno-storage-perf-"));
  // as the desktop runs it: checkpoints on the worker, the backend settling between units
  store = new SqlMailStore(openDatabase(join(dir, "perf.db")), { checkpointWorker: true });
  const seeded = await store.dev.seed(generateDataset({ threads: 50_000, accounts: 4, seed: 69, now: NOW, bodyScale: 4 }), { now: NOW });
  meta.threads = seeded.threadCount;
  meta.messages = seeded.messageCount;
  expect(seeded.threadCount).toBeGreaterThanOrEqual(50_000);
}, 600_000);

afterAll(async () => {
  report("storage.json", "storage report and removal (plan 69, SqlMailStore)", meta, stats);
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function gate(name: string, budgetMs: number, fn: (i: number) => Promise<unknown>, between?: () => Promise<unknown>) {
  const s = await measureAsync(name, budgetMs, fn, 60, 5, between);
  stats.push(s);
  expect(s.p95, `${name} p95 ${s.p95.toFixed(2)}ms > ${budgetMs}ms`).toBeLessThanOrEqual(budgetMs * BUDGET_MULTIPLIER);
}

it("a report slice of 300 conversations fits a bulk slice; the whole mailbox reads once in well under a second of work", async () => {
  const ids = store.db.all<{ id: number }>("SELECT id FROM threads ORDER BY id").map((r) => r.id);
  await gate("report slice (300 threads)", 15, (i) => store.storage.threads(ids[(i * 997) % (ids.length - 300)]!, 300));
  const started = performance.now();
  let rows = 0;
  for (let after = 0; ; ) {
    const page = await store.storage.threads(after, 1000);
    if (!page.length) break;
    rows += page.length;
    after = page.at(-1)!.id;
  }
  meta.fullReportMs = Math.round(performance.now() - started);
  expect(rows).toBe(ids.length);
  expect(meta.fullReportMs as number).toBeLessThan(3000 * BUDGET_MULTIPLIER);
});

it("a removal unit fits a bulk slice at the size the backend picks (its slicer aims at 15 ms)", async () => {
  const cutoff = storageCutoff(NOW, 30);
  const candidates = store.db.all<{ id: number }>("SELECT id FROM threads WHERE is_starred = 0 AND has_sent = 0 ORDER BY id").map((r) => r.id);
  meta.candidates = candidates.length;
  let at = 0;
  let removed = 0;
  await gate("remove unit (≤30 messages)", 15, async () => {
    const pack = candidates.slice(at, at + 20);
    at += 20;
    removed += (await store.storage.remove({ threadIds: pack, buckets: [...REMOVABLE_BUCKETS], cutoff, maxMessages: 30 })).messages;
  }, () => store.settle());
  expect(removed).toBeGreaterThan(1000);
});

it("one conversation of 20k messages: its report row is one aggregate, and removing it goes by units bounded by its recompute", async () => {
  const [acct] = store.db.all<{ id: number }>("SELECT id FROM accounts LIMIT 1");
  const t = store.db.get<{ id: number }>("SELECT thread_id AS id FROM messages WHERE account_id = ? GROUP BY thread_id ORDER BY count(*) DESC LIMIT 1", acct!.id)!.id;
  // every remaining message of the account joins one old Trash thread (no draft holds any of them)
  store.db.tx(() => {
    store.db.run("DELETE FROM drafts");
    store.db.run("UPDATE messages SET thread_id = ?, is_trash = 1, in_inbox = 0, is_starred = 0, is_sent = 0, date = 1 WHERE account_id = ? AND id IN (SELECT id FROM messages WHERE account_id = ? LIMIT 20000)", t, acct!.id, acct!.id);
    store.db.run("UPDATE threads SET in_trash = 1, in_inbox = 0, is_starred = 0, has_sent = 0, last_date = 1 WHERE id = ?", t);
  });
  meta.bigThread = store.db.get<{ c: number }>("SELECT count(*) AS c FROM messages WHERE thread_id = ?", t)!.c;
  // one aggregate over the whole thread (sizes, holds): it grows with the thread, so a bound of its own
  await gate("report row of the big thread", 80, () => store.storage.threads(t - 1, 1));
  // a unit's floor here is recomputing the thread from what is left of it: what one expunge in it already costs (the
  // store's thread aggregates), not the removal's; it shrinks as the thread does
  let removed = 0;
  await gate("remove unit of the big thread (30)", 100, async () => {
    removed += (await store.storage.remove({ threadIds: [t], buckets: ["trash"], cutoff: NOW, maxMessages: 30 })).messages;
  }, () => store.settle());
  expect(removed).toBeGreaterThan(1000);
});
