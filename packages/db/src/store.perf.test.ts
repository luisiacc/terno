/**
 * The navigation and search gate again, through the MailStore boundary
 * (SqlMailStore on node:sqlite) at the same budgets as perf.perf.test.ts,
 * plus write latency and ingestion throughput of store commands.
 */
import { generateDataset } from "@unica/mock-data";
import type { IncomingMessage } from "@unica/store";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase } from "./index";
import { SqlMailStore } from "./sql-store";
import { BUDGET_MULTIPLIER, measureAsync, report, type Stat } from "./test/perf";

const NOW = Date.UTC(2026, 9, 22, 15, 30);
let store: SqlMailStore;
let dir: string;
let accountIds: number[];
const stats: Stat[] = [];
const meta: Record<string, unknown> = {};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "unica-store-perf-"));
  // like perf.perf.test.ts, SQLite's own autocheckpoints: right after a 50k seed the worker's WAL still holds the hot pages (read without mmap)
  store = new SqlMailStore(openDatabase(join(dir, "perf.db")));
  const seeded = await store.dev.seed(generateDataset({ threads: 29_500, accounts: 8, seed: 2026, now: NOW, bodyScale: 4 }), { now: NOW });
  accountIds = seeded.accountIds;
  meta.messages = seeded.messageCount;
  meta.threads = seeded.threadCount;
  expect(seeded.messageCount).toBeGreaterThanOrEqual(50_000);
});

afterAll(async () => {
  report("store.json", "MailStore (SqlMailStore, node:sqlite)", meta, stats);
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function gate(name: string, budgetMs: number, fn: (i: number) => Promise<unknown>, iterations?: number) {
  const s = await measureAsync(name, budgetMs, fn, iterations);
  stats.push(s);
  expect(s.p95, `${name} p95 ${s.p95.toFixed(2)}ms > ${budgetMs}ms`).toBeLessThanOrEqual(budgetMs * BUDGET_MULTIPLIER);
  return s;
}

describe("reads", () => {
  it("lists, pages, counts and opens within the navigation budgets", async () => {
    await gate("list inbox, first page (100)", 5, () => store.threads.list({ view: "inbox", limit: 100 }));
    await gate("list inbox per account", 5, (i) => store.threads.list({ view: "inbox", accountId: accountIds[i % accountIds.length]!, limit: 100 }));
    const deep = store.db.get<{ last_date: number; id: number }>(
      "SELECT last_date, id FROM threads WHERE in_trash = 0 AND in_spam = 0 ORDER BY last_date DESC, id DESC LIMIT 1 OFFSET 15000",
    )!;
    await gate("list all mail, page at thread #15,000", 5, () => store.threads.list({ view: "all", limit: 100, cursor: { lastDate: deep.last_date, id: deep.id } }));
    const largest = store.db.get<{ category_id: number }>("SELECT category_id FROM thread_categories GROUP BY 1 ORDER BY count(*) DESC LIMIT 1")!;
    await gate("list largest category", 5, () => store.threads.list({ view: "all", categoryId: largest.category_id, limit: 100 }));
    await gate("sidebar unread counts", 5, () => store.threads.counts());
    const ids = store.db.all<{ id: number }>("SELECT id FROM threads ORDER BY random() LIMIT 60").map((r) => r.id);
    await gate("open random thread (with categorization)", 5, (i) => store.threads.get(ids[i % ids.length]!));
  });

  it.each([
    ["common word", "factura"],
    ["prefix while typing (2 chars)", "fa"],
    ["phrase", '"darse de baja"'],
    ["sender address", "from:crew@morningbrew.com"],
    ["negation only", "-factura"],
    ["old mail by date", "before:2025-03-01"],
    ["category + text", "category:facturas uber"],
  ])("search %s", async (label, query) => {
    await gate(`search: ${label} — ${query}`, 25, () => store.threads.searchText({ query, limit: 100, now: NOW }));
  });
});

describe("writes", () => {
  it("commits a triage action with its op in well under a frame", async () => {
    const ids = store.db.all<{ id: number }>("SELECT id FROM threads WHERE in_inbox = 1 LIMIT 200").map((r) => r.id);
    await gate("act: archive / restore one thread (+ op)", 5, (i) =>
      store.threads.act({ threadIds: [ids[i % ids.length]!], action: i % 2 ? "moveToInbox" : "archive", signal: null, now: NOW }),
    );
    const last = store.db.get<{ bytes: number }>("SELECT bytes FROM search_outbox ORDER BY seq DESC LIMIT 1")!.bytes;
    stats.push({ name: `outbox: one triage action appends a ${last}-byte batch`, budgetMs: 0, p50: last, p95: last, max: last, iterations: 1 });
    const category = store.db.get<{ id: number }>("SELECT id FROM categories LIMIT 1")!.id;
    await gate("categories.add one thread (+ example)", 5, (i) => store.categories.add({ categoryId: category, threadIds: [ids[(i * 7) % ids.length]!], addedBy: "user", now: NOW }));
    const pending = store.db.all<{ id: number }>("SELECT id FROM messages ORDER BY random() LIMIT 80").map((r) => r.id);
    await gate("sync.setBody (reindex + aggregates)", 5, (i) => store.sync.setBody(pending[i % pending.length]!, `Cuerpo nuevo ${i} con la factura`, null, { now: NOW, classifier: null }));
  });

  it("ingests new mail in slices at ≥ 1k msgs/s", async () => {
    const extra: IncomingMessage[] = generateDataset({ threads: 3_000, accounts: 8, seed: 77, now: NOW, bodyScale: 4 }).messages.map((m) => ({
      ...m,
      providerMsgId: `x-${m.providerMsgId}`,
      rfcMessageId: `x-${m.rfcMessageId}`,
      references: m.references.map((r) => `x-${r}`),
      inReplyTo: m.inReplyTo ? `x-${m.inReplyTo}` : null,
      accountId: accountIds[m.accountIndex]!,
    }));
    const slices: number[] = [];
    const logBefore = store.db.get<{ b: number; s: number }>("SELECT total(bytes) AS b, max(seq) AS s FROM search_outbox")!;
    const started = performance.now();
    for (let i = 0; i < extra.length; i += 200) {
      const t = performance.now();
      await store.sync.ingest(extra.slice(i, i + 200), { applyFilters: true, now: NOW, classifier: null });
      slices.push(performance.now() - t);
    }
    const seconds = (performance.now() - started) / 1000;
    const rate = extra.length / seconds;
    slices.sort((a, b) => a - b);
    stats.push({ name: `ingest ${extra.length} msgs in 200-msg slices: ${Math.round(rate)} msgs/s`, budgetMs: 0, p50: slices[Math.floor(slices.length / 2)]!, p95: slices[Math.ceil(slices.length * 0.95) - 1]!, max: slices.at(-1)!, iterations: slices.length });
    expect(rate).toBeGreaterThanOrEqual(1000 / BUDGET_MULTIPLIER);
    // write amplification of the search outbox: what one import writes into the log vs the mail itself
    const log = store.db.get<{ b: number; n: number }>("SELECT total(bytes) AS b, count(*) AS n FROM search_outbox WHERE seq > ?", logBefore.s ?? 0)!;
    const mail = extra.reduce((n, m) => n + (m.bodyText?.length ?? 0) + (m.bodyHtml?.length ?? 0) + m.subject.length + m.from.email.length + m.from.name.length, 0);
    stats.push({ name: `outbox: ${log.n} batches, ${(log.b / 1e6).toFixed(1)} MB for ${(mail / 1e6).toFixed(1)} MB of mail (${(log.b / mail).toFixed(2)}×)`, budgetMs: 0, p50: log.b / mail, p95: log.b / mail, max: log.b / mail, iterations: log.n });
  });
});
