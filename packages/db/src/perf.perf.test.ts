/**
 * Performance gate for the local store: 50k+ messages across 8 accounts with
 * realistic bodies. p95 latencies are asserted against the product targets
 * (docs/PLAN.md §11.6). Run with `pnpm test:perf`.
 */
import { generateDataset } from "@unica/mock-data";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyThreadAction } from "./actions";
import { openDatabase } from "./index";
import { getCounts, getThread, listThreads } from "./queries";
import { addThreadsToCategory, suggestSimilarForCategory } from "./repos";
import { findRuleMatches } from "./rules";
import { searchThreads } from "./search";
import { seedDataset } from "./seed";
import type { Db } from "./sqlite";
import { BUDGET_MULTIPLIER, measure, report, type Stat } from "./test/perf";

const NOW = Date.UTC(2026, 9, 22, 15, 30);
let db: Db;
let dir: string;
const stats: Stat[] = [];
const meta: Record<string, unknown> = {};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "unica-perf-"));
  db = openDatabase(join(dir, "perf.db"));
  const t0 = performance.now();
  const data = generateDataset({ threads: 29_500, accounts: 8, seed: 2026, now: NOW, bodyScale: 4 });
  const seeded = seedDataset(db, data, { now: NOW });
  meta.messages = seeded.messageCount;
  meta.threads = seeded.threadCount;
  meta.accounts = seeded.accountIds.length;
  meta.avgBodyBytes = Math.round(db.get<{ a: number }>("SELECT avg(length(body_text)) a FROM messages")!.a);
  meta.seedSeconds = ((performance.now() - t0) / 1000).toFixed(1);
  expect(seeded.messageCount).toBeGreaterThanOrEqual(50_000);
});

afterAll(() => {
  report("db.json", "SQLite performance gate", meta, stats);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function gate(name: string, budgetMs: number, fn: (i: number) => unknown, iterations?: number) {
  const s = measure(name, budgetMs, fn, iterations);
  stats.push(s);
  expect(s.p95, `${name} p95 ${s.p95.toFixed(2)}ms > ${budgetMs}ms`).toBeLessThanOrEqual(budgetMs * BUDGET_MULTIPLIER);
}

describe("navigation", () => {
  it("lists views", () => {
    gate("list inbox, first page (100)", 5, () => listThreads(db, { view: "inbox", limit: 100 }));
    gate("list all mail, first page", 5, () => listThreads(db, { view: "all", limit: 100 }));
    gate("list archive, first page", 5, () => listThreads(db, { view: "archive", limit: 100 }));
    gate("list starred", 5, () => listThreads(db, { view: "starred", limit: 100 }));
    gate("list sent", 5, () => listThreads(db, { view: "sent", limit: 100 }));
    const accounts = db.all<{ id: number }>("SELECT id FROM accounts").map((a) => a.id);
    gate("list inbox per account (8 accounts)", 5, (i) => listThreads(db, { view: "inbox", accountId: accounts[i % accounts.length]!, limit: 100 }));
  });

  it("pages deep with keyset cursors", () => {
    const deep = db.get<{ last_date: number; id: number }>(
      "SELECT last_date, id FROM threads WHERE in_trash = 0 AND in_spam = 0 ORDER BY last_date DESC, id DESC LIMIT 1 OFFSET 15000",
    )!;
    gate("list all mail, page at thread #15,000", 5, () =>
      listThreads(db, { view: "all", limit: 100, cursor: { lastDate: deep.last_date, id: deep.id } }),
    );
  });

  it("filters by category", () => {
    const largest = db.get<{ category_id: number; c: number }>(
      "SELECT category_id, count(*) c FROM thread_categories GROUP BY 1 ORDER BY 2 DESC LIMIT 1",
    )!;
    meta.largestCategoryThreads = largest.c;
    gate(`list largest category (${largest.c} threads)`, 5, () => listThreads(db, { view: "all", categoryId: largest.category_id, limit: 100 }));
    gate("list category ∩ inbox", 5, () => listThreads(db, { view: "inbox", categoryId: largest.category_id, limit: 100 }));
  });

  it("computes sidebar counts", () => {
    gate("sidebar unread counts (accounts + categories)", 5, () => getCounts(db));
  });

  it("opens threads", () => {
    const ids = db.all<{ id: number }>("SELECT id FROM threads ORDER BY random() LIMIT 60").map((r) => r.id);
    const longest = db.get<{ id: number; message_count: number }>("SELECT id, message_count FROM threads ORDER BY message_count DESC LIMIT 1")!;
    meta.longestThread = longest.message_count;
    gate("open random thread (messages + bodies)", 5, (i) => getThread(db, ids[i % ids.length]!));
    gate(`open longest thread (${longest.message_count} messages)`, 5, () => getThread(db, longest.id));
  });

  it("applies triage actions", () => {
    const ids = db.all<{ id: number }>("SELECT id FROM threads WHERE in_inbox = 1 LIMIT 200").map((r) => r.id);
    gate("archive one thread (optimistic, incl. aggregates)", 5, (i) => applyThreadAction(db, [ids[i % ids.length]!], i % 2 ? "moveToInbox" : "archive"));
  });
});

describe("search", () => {
  const queries: [string, string][] = [
    ["common word", "factura"],
    ["very common word", "hola"],
    ["accented word", "reunión"],
    ["rare word", "tokio"],
    ["prefix while typing (3 chars)", "pro"],
    ["prefix while typing (2 chars)", "fa"],
    ["phrase", '"darse de baja"'],
    ["two words", "propuesta presupuesto"],
    ["zero results", "zzqxjv"],
    ["sender address", "from:crew@morningbrew.com"],
    ["sender name + text", "from:lucia factura"],
    ["text + negation", "factura -uber"],
    ["negation only", "-factura"],
    ["zero-result intersection", "factura from:crew@morningbrew.com"],
    ["text in inbox, unread", "in:inbox is:unread pedido"],
    ["has attachment + date range", "has:attachment after:180d"],
    ["old mail by date", "before:2025-03-01"],
    ["category + text", "category:facturas uber"],
    ["account + text", "account:acme propuesta"],
    ["subject operator", "subject:invitación"],
  ];
  it.each(queries)("%s", (label, query) => {
    let total = 0;
    gate(`search: ${label} — ${query}`, 25, () => {
      total = searchThreads(db, { query, limit: 100, now: NOW }).items.length;
    });
    stats[stats.length - 1]!.note = `${total} results`;
  });

  it("type-ahead: every keystroke of a query stays within budget", () => {
    const typed = "presupuesto";
    for (let i = 2; i <= typed.length; i++) {
      gate(`type-ahead "${typed.slice(0, i)}"`, 25, () => searchThreads(db, { query: typed.slice(0, i), limit: 100, now: NOW }), 30);
    }
  });
});

describe("filters & suggestions", () => {
  it("previews filters over all mail", () => {
    const rules = [
      { match: "all", conditions: [{ field: "fromDomain", op: "equals", value: "uber.com" }], actions: [{ type: "archive" }] },
      { match: "all", conditions: [{ field: "subject", op: "contains", value: "factura" }], actions: [{ type: "archive" }] },
      { match: "any", conditions: [{ field: "listId", op: "contains", value: "github" }, { field: "from", op: "contains", value: "linear" }], actions: [{ type: "archive" }] },
      { match: "all", conditions: [{ field: "body", op: "contains", value: "darse de baja" }, { field: "ageDays", op: "gt", value: 30 }], actions: [{ type: "trash" }] },
      { match: "all", conditions: [{ field: "body", op: "endsWith", value: "saludos" }], actions: [{ type: "star" }] },
    ] as const;
    rules.forEach((rule, i) => gate(`filter preview #${i + 1} (${rule.conditions.map((c) => c.field).join("+")})`, 50, () => findRuleMatches(db, rule as never, NOW), 30));
  });

  it("suggests similar threads for a category", () => {
    const category = db.get<{ id: number }>("SELECT id FROM categories WHERE name = 'Facturas'")!.id;
    const thread = db.get<{ id: number }>(
      "SELECT t.id FROM threads t JOIN messages m ON m.thread_id = t.id WHERE m.from_email = 'uber.receipts@uber.com' LIMIT 1",
    )!.id;
    addThreadsToCategory(db, category, [thread], "user");
    gate("category suggestions (same sender)", 10, () => suggestSimilarForCategory(db, category, thread));
  });
});
