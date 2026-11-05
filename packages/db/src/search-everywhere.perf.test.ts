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
import { copyFileSync } from "node:fs";
import { loadavg } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nodePlatform, openDatabase } from "./index";
import { loadScope, searchThreadIds, searchThreads } from "./search";
import { SqlMailStore } from "./sql-store";
import { BUDGET_MULTIPLIER, measure, measureAsync, report, type Stat } from "./test/perf";
import { copyMailbox, kept, LARGE_MAILBOX, MAILBOX_NOW as NOW, scratchDir } from "./test/perf-mailbox";
import { msg } from "@terno/store/conformance";

/**
 * The FTS path's budget at this size. It runs only while the instant index catches
 * up; perf.perf.test.ts holds it to 25 ms at 29.5k threads. A broad prefix ("pro")
 * matches tens of thousands of messages here, in any scope: scaled with the mailbox.
 */
const PAGE_MS = 35;
/** Two phrases of frequent words that are rarely adjacent, with nothing to ask: verified doc by doc, twice plan 03's 22 ms for one. */
const NO_DOCLIST_MS = 60;
const scratch = scratchDir("search-everywhere");
let store: SqlMailStore;
const stats: Stat[] = [];
/** the misses of the running test (every case is measured before they're asserted) */
let over: string[] = [];
const meta: Record<string, unknown> = {};

beforeAll(async () => {
  const path = scratch.path("perf.db");
  // a fifth in Spam, another in Trash, moved by the store (an index built after it reads what the store left), and kept
  const moved = await kept("large-spam-trash", async (at) => {
    const seeded = copyMailbox(LARGE_MAILBOX, join(at, "m.db"));
    expect(seeded.threadCount).toBeGreaterThanOrEqual(50_000);
    expect(seeded.messageCount).toBeGreaterThanOrEqual(100_000);
    const move = new SqlMailStore(openDatabase(join(at, "m.db")));
    const ids = move.db.all<{ id: number }>("SELECT id FROM threads ORDER BY id").map((r) => r.id);
    for (const [action, set] of [["spam", ids.filter((id) => id % 5 === 1)], ["trash", ids.filter((id) => id % 5 === 2)]] as const) {
      for (let i = 0; i < set.length; i += 2000) await move.threads.act({ threadIds: set.slice(i, i + 2000), action, signal: null, now: NOW });
    }
    move.db.exec("ANALYZE");
    await move.close();
  });
  copyFileSync(join(moved, "m.db"), path);
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

/** Plan 140's queries, with addresses this mailbox really has: its own (on nearly all its mail, the FTS narrowing's worst), a busy sender and a rare one. */
function anyOfQueries() {
  const own = store.db.get<{ email: string }>("SELECT email FROM accounts ORDER BY id LIMIT 1")!.email;
  const senders = store.db.all<{ from_email: string }>("SELECT from_email FROM messages GROUP BY from_email ORDER BY count(*) DESC").map((r) => r.from_email);
  const [busy, rare] = [senders[0]!, senders.at(-1)!];
  return {
    own, busy, rare,
    queries: [
      "factura,uber ", "tokio,zzqxjv ", "zzqxjv,yyqxjv ", "pro,pre", "factura,uber is:unread", "factura,uber has:attachment", "reunión factura,uber",
      `${own} `, `${busy} `, `${rare} `, "nobody@nowhere.example ",
      `${rare} ${busy} nobody@nowhere.example `, `${rare},${busy} is:unread `, `${busy} factura `, `${own} factura `, `${busy},factura `, `from:${busy},${rare} `,
    ],
    phrases: ['"darse de baja","propuesta de presupuesto"', 'darse.de.baja,morning.brew ', '"hola equipo","baja darse"', 'factura "hola equipo","baja darse"'],
    typed: [`darse.de.baja,morning.brew`, `${rare},${busy}`, `${own}`],
  };
}

async function measureAnyOf(label: string) {
  head = await store.feed.head();
  engine = store.instant!.at(head)!;
  expect(engine, "the index is current").toBeTruthy();
  const { queries, phrases, typed } = anyOfQueries();
  for (const [scope, q] of SCOPES) {
    for (const query of queries) {
      keep(measure(`${label} · instant · ${scope} · ${query}`, 1, () => instantQuery(q(query)), 20), engine.lastStrategy);
      let first: ReturnType<typeof searchThreads> | null = null;
      keep(measure(`${label} · fts · ${scope} · ${query}: first page`, PAGE_MS, () => (first = searchThreads(store.db, { query: q(query), limit: 100, now: NOW })), 10), `${first!.items.length} results, ${first!.strategy}`);
      let page = first!;
      for (let i = 0; i < 4 && page.nextCursor; i++) page = searchThreads(store.db, { query: q(query), limit: 100, now: NOW, cursor: page.nextCursor });
      const cursor = page.nextCursor;
      if (cursor) keep(measure(`${label} · fts · ${scope} · ${query}: page 6`, PAGE_MS, () => searchThreads(store.db, { query: q(query), limit: 100, now: NOW, cursor }), 10));
    }
    for (const phrase of phrases) {
      keep(measure(`${label} · instant · ${scope} · phrases ${phrase}`, 5, () => instantQuery(q(phrase)), 20), engine.lastStrategy);
      let first: ReturnType<typeof searchThreads> | null = null;
      keep(measure(`${label} · fts · ${scope} · phrases ${phrase}: first page`, PAGE_MS, () => (first = searchThreads(store.db, { query: q(phrase), limit: 100, now: NOW })), 10), `${first!.items.length} results, ${first!.strategy}`);
    }
    // the web's engine has no FTS5 to ask: frequent words rarely adjacent are verified doc by doc (plan 03 §6 accepts it until a positional sidecar)
    const options = (engine as unknown as { o: { phrases?: unknown } }).o;
    const doclist = options.phrases;
    options.phrases = undefined;
    for (const phrase of phrases) keep(measure(`${label} · instant, no doclist · ${scope} · phrases ${phrase}`, NO_DOCLIST_MS, () => instantQuery(q(phrase)), 10), engine.lastStrategy);
    options.phrases = doclist;
    // every keystroke through the store: the whole path, a comma and an address being typed
    for (const text of typed) {
      for (let i = 1; i <= text.length; i++) {
        const query = q(text.slice(0, i));
        const s = keep(await measureAsync(`${label} · store keystroke · ${scope} · "${query}"`, 5, () => store.threads.searchText({ query, limit: 100, now: NOW }), 10));
        const r = await store.threads.searchText({ query, limit: 100, now: NOW });
        expect(r.strategy, query).toMatch(/^instant/);
        s.note = `${r.items.length} rows`;
      }
    }
    // the same, cold: every set built again, as on the first search after a change
    const cache = (engine as unknown as { cache: Map<string, Uint32Array> }).cache;
    for (const text of typed) {
      for (let i = 1; i <= text.length; i++) {
        const query = q(text.slice(0, i));
        keep(measure(`${label} · instant cold · ${scope} · "${query}"`, 5, () => { cache.clear(); return instantQuery(query); }, 8), engine.lastStrategy);
      }
    }
  }
}

describe("search everywhere at 57k threads", () => {
  it("any of and addresses (plan 140): the instant index and the FTS path within the same budgets", async () => {
    over = [];
    const { own, busy, rare } = anyOfQueries();
    const count = (email: string) => store.db.get<{ c: number }>("SELECT count(*) AS c FROM messages m WHERE instr(' ' || m.from_email || ' ' || m.recipients_norm || ' ', ?) > 0", ` ${email} `)!.c;
    meta.addresses = { own: count(own), busy: count(busy), rare: count(rare) };
    await measureAnyOf("any of");
    expect(over).toEqual([]);
  }, 600_000);


  it("the instant index and the FTS path within their budgets, everywhere and in:all", async () => {
    expect(store.db.get<{ c: number }>("SELECT count(*) AS c FROM threads WHERE in_spam = 1 OR in_trash = 1")!.c).toBeGreaterThan(20_000);
    await measureAll("spam+trash heavy");
    expect(over).toEqual([]);
  }, 600_000);

  it("any of and addresses, on a mailbox with captured bodies: the FTS path's form real mailboxes use, within the same budget", async () => {
    over = [];
    const { own, busy, rare } = anyOfQueries();
    const path = scratch.path("segmented.db");
    copyFileSync(scratch.path("perf.db"), path);
    const segmented = new SqlMailStore(openDatabase(path), { instantSearch: false, platform: nodePlatform });
    try {
      const account = segmented.db.get<{ id: number }>("SELECT id FROM accounts ORDER BY id LIMIT 1")!.id;
      await segmented.sync.ingest([msg({ accountId: account, bodyText: "unrelated large body ".repeat(5000), isTrash: true, inInbox: false })], { now: NOW, classifier: null, applyFilters: false });
      expect(segmented.db.get("SELECT 1 FROM body_heads LIMIT 1")).toBeTruthy();
      for (const query of ["factura", "tokio", "zzqxjv", "pro", "factura,uber ", "tokio,zzqxjv ", "zzqxjv,yyqxjv ", `${own} `, `${busy} `, `${rare} `, "nobody@nowhere.example ", `${rare},${busy} `, `${own} factura `, `${rare} factura `, `${own},factura `, `${rare},zzqxjv `, 'darse.de.baja,morning.brew ']) {
        let strategy = "";
        keep(await measureAsync(`segmented · fts · ${query}`, PAGE_MS, async () => (strategy = (await segmented.threads.searchText({ query, limit: 100, now: NOW })).strategy), 8), strategy);
      }
    } finally {
      await segmented.close();
    }
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
