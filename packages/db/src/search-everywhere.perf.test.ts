/**
 * Plan 64: search looks everywhere (every account, category and place, Spam
 * and Trash too) and stays instant, at 57k threads / 100k+ messages with a fifth
 * of the threads in Spam and another in Trash. That's in:all's worst (what it
 * passes over), and "everywhere" passes over nothing, so as seeded adds no case:
 *
 *  - the instant index (the path a search takes once it's current) at its
 *    own budgets: a query ≤ 1 ms warm, a phrase ≤ 5 ms, a keystroke through
 *    the store (resolve + engine + rows) ≤ 5 ms;
 *  - the FTS path (while the index catches up) at the search budget, a first
 *    page and a page six pages in.
 *
 * Everywhere and in:all are both measured and both held to the budget: a
 * wider scope is never an excuse. Every case is measured before any is
 * asserted, so a run shows the whole picture. Run with `pnpm test:perf`.
 */
import { parseSearch, resolveSearch } from "@terno/core";
import type { Revision } from "@terno/store";
import type { InstantSearchEngine } from "@terno/store/instant";
import { loadavg } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nodePlatform, openDatabase } from "./index";
import { loadScope, searchThreadIds, searchThreads } from "./search";
import { SqlMailStore } from "./sql-store";
import { BUDGET_MULTIPLIER, measure, measureAsync, report, type Stat } from "./test/perf";
import { copyMailbox, LARGE_MAILBOX, MAILBOX_NOW as NOW, scratchDir } from "./test/perf-mailbox";

/**
 * The FTS path's budget at this size. It runs only while the instant index catches
 * up; perf.perf.test.ts holds it to 25 ms at 29.5k threads. A broad prefix ("pro")
 * matches tens of thousands of messages here, in any scope: scaled with the mailbox.
 */
const PAGE_MS = 35;
const scratch = scratchDir("search-everywhere");
let store: SqlMailStore;
const stats: Stat[] = [];
/** the misses of the running test (every case is measured before they're asserted) */
let over: string[] = [];
const meta: Record<string, unknown> = {};

beforeAll(async () => {
  const path = scratch.path("perf.db");
  const seeded = copyMailbox(LARGE_MAILBOX, path);
  meta.threads = seeded.threadCount;
  meta.messages = seeded.messageCount;
  expect(seeded.threadCount).toBeGreaterThanOrEqual(50_000);
  expect(seeded.messageCount).toBeGreaterThanOrEqual(100_000);
  // a fifth in Spam, another in Trash, moved by the store (an index built after it reads what the store left)
  const move = new SqlMailStore(openDatabase(path));
  const ids = move.db.all<{ id: number }>("SELECT id FROM threads ORDER BY id").map((r) => r.id);
  const spam = ids.filter((id) => id % 5 === 1);
  const trash = ids.filter((id) => id % 5 === 2);
  for (const [action, set] of [["spam", spam], ["trash", trash]] as const) {
    for (let i = 0; i < set.length; i += 2000) await move.threads.act({ threadIds: set.slice(i, i + 2000), action, signal: null, now: NOW });
  }
  move.db.exec("ANALYZE");
  meta.spamThreads = spam.length;
  meta.trashThreads = trash.length;
  await move.close();
  store = new SqlMailStore(openDatabase(path), { instantSearch: true, platform: nodePlatform });
  expect(await store.instant!.settled(600_000)).toBe(true);
}, 1_200_000);

afterAll(async () => {
  meta.load = loadavg()[0]!.toFixed(1);
  report("search-everywhere.json", "Search everywhere (plan 64, SQLite + instant index)", meta, stats);
  await store?.close();
  scratch.done();
});

function keep(s: Stat, note?: string): Stat {
  if (note) s.note = note;
  stats.push(s);
  if (s.p95 > s.budgetMs * BUDGET_MULTIPLIER) over.push(`${s.name}: p95 ${s.p95.toFixed(2)} ms > ${s.budgetMs} ms`);
  return s;
}

/** every strategy: free text (common, rare, prefix, phrase), sender, dates, operators only (the walk), empty intersections */
const QUERIES = [
  "factura",
  "hola",
  "reunión",
  "tokio",
  "pro",
  "fa",
  "propuesta pre",
  "zzqxjv",
  "from:crew@morningbrew.com",
  "from:lucia factura",
  "factura -uber",
  "-factura",
  "factura from:crew@morningbrew.com",
  "is:unread",
  "is:starred",
  "has:attachment",
  "is:unread has:attachment",
  "is:starred has:attachment is:unread",
  "has:attachment after:180d",
  "before:2025-03-01",
  "after:2026-01-01 before:2026-02-01",
  "category:facturas uber",
  "account:acme propuesta",
  "subject:invitación",
];
const PHRASES = ['"darse de baja"', '"de la"', '"propuesta de presupuesto"'];
const SCOPES = [
  ["everywhere", (q: string) => q],
  ["in:all", (q: string) => `in:all ${q}`],
] as const;

let engine: InstantSearchEngine;
let head: Revision;
const instantQuery = (text: string) => engine.search({ search: resolveSearch(parseSearch(text, NOW), text, {}, loadScope(store.db)), limit: 100 }, head);

async function measureAll(label: string) {
  over = [];
  head = await store.feed.head();
  engine = store.instant!.at(head)!;
  expect(engine, "the index is current").toBeTruthy();
  for (const [scope, q] of SCOPES) {
    for (const query of QUERIES) {
      keep(measure(`${label} · instant · ${scope} · ${query}`, 1, () => instantQuery(q(query)), 20), engine.lastStrategy);
      let first: ReturnType<typeof searchThreads> | null = null;
      keep(measure(`${label} · fts · ${scope} · ${query}: first page`, PAGE_MS, () => (first = searchThreads(store.db, { query: q(query), limit: 100, now: NOW })), 10), `${first!.items.length} results, ${first!.strategy}`);
      let page = first!;
      for (let i = 0; i < 4 && page.nextCursor; i++) page = searchThreads(store.db, { query: q(query), limit: 100, now: NOW, cursor: page.nextCursor });
      const cursor = page.nextCursor;
      if (cursor) keep(measure(`${label} · fts · ${scope} · ${query}: page 6`, PAGE_MS, () => searchThreads(store.db, { query: q(query), limit: 100, now: NOW, cursor }), 10));
    }
    for (const phrase of PHRASES) keep(measure(`${label} · instant · ${scope} · phrase ${phrase}`, 5, () => instantQuery(q(phrase)), 20), engine.lastStrategy);
    // the whole path a keystroke takes (resolve, engine, rows), the index current
    const typed = "presupuesto";
    for (let i = 1; i <= typed.length; i++) {
      const text = q(typed.slice(0, i));
      const s = keep(await measureAsync(`${label} · store keystroke · ${scope} · "${text}"`, 5, () => store.threads.searchText({ query: text, limit: 100, now: NOW }), 20));
      const r = await store.threads.searchText({ query: text, limit: 100, now: NOW });
      expect(r.strategy, text).toMatch(/^instant/);
      s.note = `${r.items.length} rows`;
    }
  }
}

describe("search everywhere at 57k threads", () => {
  it("the instant index and the FTS path within their budgets, everywhere and in:all", async () => {
    expect(store.db.get<{ c: number }>("SELECT count(*) AS c FROM threads WHERE in_spam = 1 OR in_trash = 1")!.c).toBeGreaterThan(20_000);
    await measureAll("spam+trash heavy");
    expect(over).toEqual([]);
  }, 600_000);

  it("select all N over a broad search: every id once, within a budget a click can wait for", () => {
    over = [];
    for (const query of ["factura", "is:unread", "has:attachment", "before:2026-01-01"]) {
      let n = 0;
      keep(measure(`select all · ${query}`, 120, () => (n = searchThreadIds(store.db, { query, now: NOW }).ids.length), 8), "");
      stats[stats.length - 1]!.note = `${n} threads`;
    }
    expect(over).toEqual([]);
  });
});
