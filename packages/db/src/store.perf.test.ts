/**
 * The navigation and search gate again, through the MailStore boundary
 * (SqlMailStore on node:sqlite) at the same budgets as perf.perf.test.ts,
 * plus write latency and ingestion throughput of store commands.
 */
import { generateDataset } from "@terno/mock-data";
import { markOrder, type IncomingMessage } from "@terno/store";
import { msg } from "@terno/store/conformance";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase } from "./index";
import { recomputeThreads } from "./ingest";
import { SqlMailStore } from "./sql-store";
import { BUDGET_MULTIPLIER, measureAsync, report, type Stat } from "./test/perf";
import { copyMailbox, MAILBOX_NOW as NOW, PERF_MAILBOX } from "./test/perf-mailbox";

let store: SqlMailStore;
let dir: string;
let accountIds: number[];
const stats: Stat[] = [];
const meta: Record<string, unknown> = {};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "terno-store-perf-"));
  // like perf.perf.test.ts, SQLite's own autocheckpoints: right after a 50k seed the worker's WAL still holds the hot pages (read without mmap)
  const seeded = copyMailbox(PERF_MAILBOX, join(dir, "perf.db"), "wal");
  store = new SqlMailStore(openDatabase(join(dir, "perf.db")));
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

/** 20 samples, as perf.perf: what the store adds (hydrating rows, the revision) shows in every one */
async function gate(name: string, budgetMs: number, fn: (i: number) => Promise<unknown>, iterations = 20) {
  const s = await measureAsync(name, budgetMs, fn, iterations);
  stats.push(s);
  expect(s.p95, `${name} p95 ${s.p95.toFixed(2)}ms > ${budgetMs}ms`).toBeLessThanOrEqual(budgetMs * BUDGET_MULTIPLIER);
  return s;
}

describe("plan 239: the dated reader's queue", () => {
  // plan 239 (the Codex code review): days of new mail while a provider was down: the reader reads the queue a chunk at a
  // time and orders it in one linear step, each within the slice's budget
  it("a queue of 12,000 marks (a third live): a chunk of 1,000 read, and the whole ordered, each within the slice's budget", async () => {
    store.db.run(
      `INSERT INTO ai_dated_mail (message_id, thread_id, arrived_at, queued_at, source)
       SELECT id, thread_id, date, ?, CASE WHEN id % 3 = 0 THEN 'live' ELSE 'scan' END FROM messages WHERE is_sent = 0 AND is_draft = 0 ORDER BY id LIMIT 12000`,
      NOW,
    );
    try {
      const raw = await store.dated.marks.raw(null, Infinity);
      expect(raw.length).toBeGreaterThan(10_000);
      const mid = raw[Math.floor(raw.length / 2)]!;
      await gate("dated marks: a chunk of 1,000 from the middle of 12,000", 8, () => store.dated.marks.raw({ arrivedAt: mid.arrivedAt, messageId: mid.messageId }, 1000));
      await gate("dated marks: 12,000 in reading order (markOrder)", 8, async () => markOrder(raw));
    } finally {
      store.db.run("DELETE FROM ai_dated_mail");
    }
  });
});

describe("reads", () => {
  it("lists, pages, counts and opens within the navigation budgets", async () => {
    await gate("list inbox, first page (100)", 5, () => store.threads.list({ view: "inbox", limit: 100 }));
    const deep = store.db.get<{ last_date: number; id: number }>(
      "SELECT last_date, id FROM threads WHERE in_trash = 0 AND in_spam = 0 ORDER BY last_date DESC, id DESC LIMIT 1 OFFSET 15000",
    )!;
    await gate("list all mail, page at thread #15,000", 5, () => store.threads.list({ view: "all", limit: 100, cursor: { lastDate: deep.last_date, id: deep.id } }));
    const largest = store.db.get<{ category_id: number }>("SELECT category_id FROM thread_categories GROUP BY 1 ORDER BY count(*) DESC LIMIT 1")!;
    await gate("list largest category", 5, () => store.threads.list({ view: "all", categoryId: largest.category_id, limit: 100 }));
    await gate("sidebar unread counts", 5, () => store.threads.counts(NOW));
    const ids = store.db.all<{ id: number }>("SELECT id FROM threads ORDER BY random() LIMIT 60").map((r) => r.id);
    await gate("open random thread (with categorization)", 5, (i) => store.threads.get(ids[i % ids.length]!));
  });

  // perf.perf holds every strategy on the query itself; what the store adds is the same for each: a free text and an operator
  it.each([
    ["common word", "factura"],
    ["old mail by date", "before:2025-03-01"],
  ])("search %s", async (label, query) => {
    await gate(`search: ${label} — ${query}`, 25, () => store.threads.searchText({ query, limit: 100, now: NOW }));
  });
});

describe("writes", () => {
  it("commits a triage action with its op in well under a frame", async () => {
    const ids = store.db.all<{ id: number }>("SELECT id FROM threads WHERE in_inbox = 1 LIMIT 200").map((r) => r.id);
    // a write's tail is checkpoints: 60 samples, so a p95 isn't one or two of them
    const WRITES = 60;
    await gate("act: archive / restore one thread (+ op)", 5, (i) =>
      store.threads.act({ threadIds: [ids[i % ids.length]!], action: i % 2 ? "moveToInbox" : "archive", signal: null, now: NOW }),
    WRITES);
    const last = store.db.get<{ bytes: number }>("SELECT bytes FROM search_outbox ORDER BY seq DESC LIMIT 1")!.bytes;
    stats.push({ name: `outbox: one triage action appends a ${last}-byte batch`, budgetMs: 0, p50: last, p95: last, max: last, iterations: 1 });
    const category = store.db.get<{ id: number }>("SELECT id FROM categories LIMIT 1")!.id;
    await gate("categories.add one thread (+ example)", 5, (i) => store.categories.add({ categoryId: category, threadIds: [ids[(i * 7) % ids.length]!], addedBy: "user", now: NOW }), WRITES);
    const pending = store.db.all<{ id: number }>("SELECT id FROM messages ORDER BY random() LIMIT 80").map((r) => r.id);
    await gate("sync.setBody (reindex + aggregates)", 5, (i) => store.sync.setBody(pending[i % pending.length]!, `Cuerpo nuevo ${i} con la factura`, null, { now: NOW, classifier: null }), WRITES);
  });

  it("ingests new mail in slices at ≥ 1k msgs/s", async () => {
    const extra: IncomingMessage[] = generateDataset({ threads: 1_500, accounts: 8, seed: 77, now: NOW, bodyScale: 4 }).messages.map((m) => ({
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

describe("People and Waiting (plan 17)", () => {
  /** every page of a filtered view (the slowest gated), the first page by p95, then its count and its whole id walk */
  async function walk(label: string, p: { view: "inbox" | "archive" | "all" | "trash"; accountId?: number; filter: "people" | "waiting" }) {
    const pages: number[] = [];
    let cursor: { lastDate: number; id: number } | undefined;
    let n = 0;
    do {
      const t = performance.now();
      const page = await store.threads.list({ ...p, now: NOW, limit: 100, cursor });
      pages.push(performance.now() - t);
      n += page.items.length;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    await gate(`${label}: first filtered page (of ${pages.length}, ${n} threads)`, 5, () => store.threads.list({ ...p, now: NOW, limit: 100 }));
    const worst = Math.max(...pages);
    stats.push({ name: `${label}: every page (${pages.length}), the slowest`, budgetMs: 16, p50: worst, p95: worst, max: worst, iterations: pages.length });
    expect(worst, `${label}: slowest page`).toBeLessThanOrEqual(16 * BUDGET_MULTIPLIER);
    await gate(`${label}: scope count`, 5, () => store.threads.scopeCount({ ...p, now: NOW, limit: 100_001 }));
    // the whole id walk ("select all N"), timed (Codex review 1, #9)
    const walk = await measureAsync(`${label}: the whole id walk`, 32, async () => {
      let walked = 0;
      for (let after = 0; ; ) {
        const page = await store.threads.scopeIds({ ...p, now: NOW, after, limit: 500 });
        walked += page.length;
        if (page.length < 500) return walked;
        after = page[page.length - 1]!;
      }
    }, 10, 1);
    stats.push(walk);
    expect(walk.p95, `${label}: whole walk`).toBeLessThanOrEqual(32 * BUDGET_MULTIPLIER);
    let walked = 0;
    for (let after = 0; ; ) {
      const page = await store.threads.scopeIds({ ...p, now: NOW, after, limit: 500 });
      walked += page.length;
      if (page.length < 500) break;
      after = page[page.length - 1]!;
    }
    expect(walked).toBe(n);
  }

  it("pages, counts and scopes from their own indexes: as seeded, dense, empty, and every waiting date expired but twenty", async () => {
    meta.people = store.db.get<{ c: number }>("SELECT count(*) AS c FROM threads WHERE person = 1")!.c;
    meta.waiting = store.db.get<{ c: number }>("SELECT count(*) AS c FROM threads WHERE waiting_since IS NOT NULL")!.c;
    expect(meta.people as number).toBeGreaterThan(1000);
    for (const filter of ["people", "waiting"] as const) {
      for (const [label, p] of [
        ["inbox", { view: "inbox" as const }],
        ["archive", { view: "archive" as const }],
        ["trash", { view: "trash" as const }],
        ["an account", { view: "all" as const, accountId: accountIds[0]! }],
      ] as const)
        await walk(`${filter} ${label}`, { ...p, filter });
    }
    await gate("counts with the waiting count", 5, () => store.threads.counts(NOW));
    const keep = store.db.all<{ id: number; person: number | null; waiting_since: number | null }>("SELECT id, person, waiting_since FROM threads");
    // dense: everyone a person, every thread waiting since its newest message (the window keeps the last 30 days)
    store.db.tx(() => store.db.run("UPDATE threads SET person = 1, waiting_since = last_date"));
    await walk("people dense", { view: "all", filter: "people" });
    await walk("waiting dense", { view: "all", filter: "waiting" });
    store.db.tx(() => store.db.run("UPDATE threads SET person = 0, waiting_since = NULL"));
    await walk("people empty", { view: "all", filter: "people" });
    await walk("waiting empty", { view: "all", filter: "waiting" });
    // Codex R9: dense expired, sparse current; the window bounds the walk, not the threads that ever waited
    store.db.tx(() => {
      store.db.run("UPDATE threads SET waiting_since = ?", NOW - 400 * 86_400_000);
      store.db.run("UPDATE threads SET waiting_since = last_date WHERE id IN (SELECT id FROM threads WHERE last_date >= ? ORDER BY id LIMIT 20)", NOW - 10 * 86_400_000);
    });
    await walk("waiting expired but 20", { view: "all", filter: "waiting" });
    await gate("counts, every waiting date expired but 20", 5, () => store.threads.counts(NOW));
    store.db.tx(() => {
      for (const r of keep) store.db.run("UPDATE threads SET person = ?, waiting_since = ? WHERE id = ?", r.person, r.waiting_since, r.id);
    });
  });
});

it("cached refresh keyset queries stay within the 50k store read budget", async () => {
  await gate("cached refresh page (50)", 5, async (i) => {
    const page = await store.providerStore(accountIds[i % accountIds.length]!).syncedMessagePage(i % 2 ? "m" : undefined);
    expect(page.items.length).toBeLessThanOrEqual(50);
  });
});

describe("Gmail's tabs out of the Inbox (plan 86)", () => {
  it("60% of the Inbox in tabs, a sparse Social: Inbox pages, the unread filter, counts and a tab's pages within the navigation budgets", async () => {
    const gmail = store.db.get<{ id: number }>("SELECT id FROM accounts WHERE kind = 'gmail' ORDER BY id LIMIT 1")!.id;
    const inbox = store.db.all<{ id: number; account_id: number }>("SELECT id, account_id FROM threads WHERE in_inbox = 1 ORDER BY id");
    // the stored tab is what the stores fold, set as Gmail would have it (the Inbox's test is the column alone: the gate is the walk)
    const tabbed = inbox.filter((_, i) => i % 5 < 3).map((t) => t.id);
    const social = inbox.filter((t, i) => i % 5 === 3 && i % 100 === 3 && t.account_id === gmail).map((t) => t.id);
    store.db.tx(() => {
      for (const id of tabbed) store.db.run("UPDATE threads SET tab = 1 WHERE id = ?", id);
      for (const id of social) store.db.run("UPDATE threads SET tab = 2 WHERE id = ?", id);
    });
    meta.gmailTabs = `${tabbed.length} of ${inbox.length} in Promotions, ${social.length} in Social`;
    try {
      const page = await store.threads.list({ view: "inbox", limit: 100 });
      expect(page.items.length).toBeGreaterThan(0);
      expect(page.items.every((t) => !t.tab)).toBe(true);
      await gate("tabs 60%: list inbox, first page (100)", 5, () => store.threads.list({ view: "inbox", limit: 100 }));
      await gate("tabs 60%: list inbox, next page", 5, () => store.threads.list({ view: "inbox", limit: 100, cursor: page.nextCursor ?? undefined }));
      await gate("tabs 60%: inbox unread filter, first page", 5, () => store.threads.list({ view: "inbox", filter: "unread", limit: 100 }));
      await gate("tabs 60%: sidebar counts", 5, () => store.threads.counts(NOW));
      await gate("tabs 60%: Promotions, first page (100)", 5, () => store.threads.list({ view: "inbox", accountId: gmail, tab: "promotions", limit: 100 }));
      await gate("tabs 60%: Promotions unread filter", 5, () => store.threads.list({ view: "inbox", accountId: gmail, tab: "promotions", filter: "unread", limit: 100 }));
      await gate("tabs sparse: Social, first page", 5, () => store.threads.list({ view: "inbox", accountId: gmail, tab: "social", limit: 100 }));
      await gate("tabs 60%: select all in Promotions (count)", 10, () => store.threads.scopeCount({ view: "inbox", accountId: gmail, tab: "promotions", limit: 100_000 }));
    } finally {
      store.db.tx(() => store.db.run("UPDATE threads SET tab = 0 WHERE tab != 0"));
    }
  });
});

describe("Outlook's Other out of the Inbox (plan 275)", () => {
  it("60% of an Outlook account's Inbox in Other, and a sparse Other: Inbox pages, counts and Other's pages within the navigation budgets", async () => {
    const [dense, sparse] = store.db.all<{ id: number; kind: string }>("SELECT id, kind FROM accounts WHERE kind != 'gmail' ORDER BY id LIMIT 2");
    const kinds = [dense!, sparse ?? dense!];
    const inbox = (accountId: number) => store.db.all<{ id: number }>("SELECT id FROM threads WHERE in_inbox = 1 AND account_id = ? ORDER BY id", accountId).map((r) => r.id);
    store.db.tx(() => {
      for (const a of kinds) store.db.run("UPDATE accounts SET kind = 'outlook' WHERE id = ?", a.id);
      for (const id of inbox(dense!.id).filter((_, i) => i % 5 < 3)) store.db.run("UPDATE threads SET tab = 3 WHERE id = ?", id);
      if (sparse) for (const id of inbox(sparse.id).filter((_, i) => i % 100 === 3)) store.db.run("UPDATE threads SET tab = 3 WHERE id = ?", id);
    });
    try {
      const page = await store.threads.list({ view: "inbox", limit: 100 });
      expect(page.items.every((t) => !t.tab)).toBe(true);
      await gate("Other 60%: list inbox, first page (100)", 5, () => store.threads.list({ view: "inbox", limit: 100 }));
      await gate("Other 60%: the account's inbox, first page", 5, () => store.threads.list({ view: "inbox", accountId: dense!.id, limit: 100 }));
      await gate("Other 60%: sidebar counts", 5, () => store.threads.counts(NOW));
      await gate("Other 60%: Other, first page (100)", 5, () => store.threads.list({ view: "inbox", accountId: dense!.id, tab: "other", limit: 100 }));
      if (sparse) await gate("Other sparse: Other, first page", 5, () => store.threads.list({ view: "inbox", accountId: sparse.id, tab: "other", limit: 100 }));
      await gate("Other 60%: select all in Other (count)", 10, () => store.threads.scopeCount({ view: "inbox", accountId: dense!.id, tab: "other", limit: 100_000 }));
    } finally {
      store.db.tx(() => {
        store.db.run("UPDATE threads SET tab = 0 WHERE tab = 3");
        for (const a of kinds) store.db.run("UPDATE accounts SET kind = ? WHERE id = ?", a.kind, a.id);
      });
    }
  });
});

describe("a category hidden from the Inbox (plan 83)", () => {
  it("hiding the seed's largest category: Inbox pages, the unread filter and counts within the navigation budgets", async () => {
    const largest = store.db.get<{ category_id: number }>("SELECT category_id FROM thread_categories GROUP BY 1 ORDER BY count(*) DESC LIMIT 1")!.category_id;
    await store.categories.update(largest, { showInInbox: false });
    try {
      await gate("hidden largest category: list inbox, first page (100)", 5, () => store.threads.list({ view: "inbox", limit: 100 }));
      await gate("hidden largest category: inbox unread filter, first page", 5, () => store.threads.list({ view: "inbox", filter: "unread", limit: 100 }));
      await gate("hidden largest category: sidebar counts", 5, () => store.threads.counts(NOW));
    } finally {
      await store.categories.update(largest, { showInInbox: true });
    }
  });

  it("holding 95% of the Inbox, with a second hidden one: pages walk past them within budget; counts cost what the memberships do", async () => {
    const inbox = store.db.all<{ id: number }>("SELECT id FROM threads WHERE in_inbox = 1 ORDER BY id").map((r) => r.id);
    const hide = inbox.filter((_, i) => i % 20 !== 0);
    const big = (await store.categories.create("Hidden big", "slate")).id;
    const small = (await store.categories.create("Hidden small", "rose")).id;
    for (let i = 0; i < hide.length; i += 2000) await store.categories.add({ categoryId: big, threadIds: hide.slice(i, i + 2000), addedBy: "filter", now: NOW });
    await store.categories.add({ categoryId: small, threadIds: inbox.filter((_, i) => i % 7 === 0), addedBy: "filter", now: NOW });
    meta.hiddenInbox = `${hide.length} of ${inbox.length}`;
    try {
      // the same memberships, nothing hidden: the category counts grow with what was filed; hiding itself adds the difference
      const control = await measureAsync("hidden 95% control (filed, shown): sidebar counts", 10, () => store.threads.counts(NOW));
      stats.push(control);
      await store.categories.update(big, { showInInbox: false });
      await store.categories.update(small, { showInInbox: false });
      const page = await store.threads.list({ view: "inbox", limit: 100 });
      expect(page.items.length).toBeGreaterThan(0);
      await gate("hidden 95%: list inbox, first page (100)", 5, () => store.threads.list({ view: "inbox", limit: 100 }));
      await gate("hidden 95%: list inbox, next page", 5, () => store.threads.list({ view: "inbox", limit: 100, cursor: page.nextCursor ?? undefined }));
      await gate("hidden 95%: inbox unread filter, first page", 5, () => store.threads.list({ view: "inbox", filter: "unread", limit: 100 }));
      await gate("hidden 95%: select all in the Inbox (count)", 10, () => store.threads.scopeCount({ view: "inbox", limit: 100_000 }));
      const counts = await gate("hidden 95%: sidebar counts", 10, () => store.threads.counts(NOW));
      // medians: two p95s of separate batches differ by whatever the machine did meanwhile
      expect(counts.p50 - control.p50, `hiding adds ${(counts.p50 - control.p50).toFixed(2)} ms to the counts`).toBeLessThanOrEqual(1 * BUDGET_MULTIPLIER);
    } finally {
      await store.categories.delete(big);
      await store.categories.delete(small);
    }
  });
});

describe("an account's Mark all as read (plan 106)", () => {
  it("its Inbox's unread scope walks within budget when another account's unread fills the mailbox and it has none or ten", async () => {
    const sparse = accountIds[0]!;
    // (not put back: of what's after this, the delete's count reads no unread)
    // Codex R4: the scope walks the global unread index testing account and place: the worst case is every other thread unread
    store.db.run("UPDATE threads SET unread_count = max(unread_count, 1) WHERE account_id != ?", sparse);
    store.db.run("UPDATE threads SET unread_count = 0 WHERE account_id = ?", sparse);
    meta.markAllRead = `${store.db.get<{ c: number }>("SELECT count(*) AS c FROM threads WHERE unread_count > 0")!.c} unread elsewhere`;
    const scope = { view: "inbox" as const, accountId: sparse, filter: "unread" as const, now: NOW };
    const walk = async () => {
      const ids: number[] = [];
      for (let after = 0; ; ) {
        const page = await store.threads.scopeIds({ ...scope, after, limit: 500 });
        ids.push(...page);
        if (page.length < 500) return ids;
        after = page[page.length - 1]!;
      }
    };
    {
      expect(await walk()).toEqual([]);
      await gate("mark all read, account with none unread: the whole id walk", 16, walk, 20);
      await gate("mark all read, account with none unread: count", 16, () => store.threads.scopeCount({ ...scope, limit: 100_001 }), 20);
      const ten = store.db.all<{ id: number }>("SELECT id FROM threads WHERE account_id = ? AND in_inbox = 1 AND tab = 0 ORDER BY id LIMIT 10", sparse).map((r) => r.id);
      for (const id of ten) store.db.run("UPDATE threads SET unread_count = 1 WHERE id = ?", id);
      expect((await walk()).length).toBeLessThanOrEqual(10);
      await gate("mark all read, account with ten unread: the whole id walk", 16, walk, 20);
    }
  });
});

describe("a delete's count (plan 107)", () => {
  it("100 overlapping sublabels on one 50,000-message conversation: each slice within a frame, each message looked at once (Codex code review round 4 #3)", async () => {
    const keys = Array.from({ length: 100 }, (_, i) => `Label_p107_${i}`);
    const seed = store.db.get<{ id: number; thread_id: number; account_id: number }>("SELECT id, thread_id, account_id FROM messages WHERE is_trash = 0 AND is_spam = 0 LIMIT 1")!;
    const columns = (table: string) => store.db.all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name).filter((c) => c !== "id");
    // a copy of a thread, then 50,000 copies of one message in it, every one in all 100 (written here: ingesting a
    // 50,000-message reply chain is minutes)
    const tc = columns("threads");
    const thread = store.db.get<{ id: number }>(`INSERT INTO threads (${tc.join(", ")}) SELECT ${tc.map((c) => (c === "provider_thread_id" ? "'p107-count'" : c)).join(", ")} FROM threads WHERE id = ? RETURNING id`, seed.thread_id)!.id;
    const mc = columns("messages");
    const n = 50_000;
    store.db.run(
      `WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < ?)
       INSERT INTO messages (${mc.join(", ")}) SELECT ${mc.map((c) => (c === "thread_id" ? "?" : c === "provider_msg_id" ? "'p107-count-' || k.i" : c === "gmail_labels" ? "?" : c === "rfc_message_id" ? "NULL" : c)).join(", ")} FROM messages, k WHERE messages.id = ?`,
      n, thread, JSON.stringify(keys), seed.id,
    );
    for (const key of keys) store.db.run("INSERT INTO thread_folders (thread_id, account_id, folder, last_date, unread) VALUES (?, ?, ?, 0, 0)", thread, seed.account_id, key);
    // (the file's last test: nothing reads this mailbox after it, so it isn't taken out again)
    const limit = 1000;
    const ms: number[] = [];
    let messages = 0;
    for (let after: Parameters<typeof store.folders.count>[2] = null; ; ) {
      const started = performance.now();
      const r = await store.folders.count(seed.account_id, keys, after, limit);
      ms.push(performance.now() - started);
      messages += r.messages;
      if (!r.next) break;
      after = r.next;
    }
    const total = ms.reduce((a, b) => a + b, 0);
    meta.folderCount = `${ms.length} slices, ${total.toFixed(1)} ms in all, max ${Math.max(...ms).toFixed(2)} ms`;
    console.log(`count over 100 sublabels of ${n}: ${meta.folderCount}`);
    expect(Math.max(...ms), `one slice (${meta.folderCount})`).toBeLessThanOrEqual(16 * BUDGET_MULTIPLIER);
    expect(messages).toBe(n);
    // the conversation once (100 reads of it were five million visits), a slice of rows at a time
    expect(ms.length).toBeLessThanOrEqual(Math.ceil((n + 2 * keys.length) / limit) + keys.length + 2);
  });
});

describe("an account out of the all-accounts Inbox (plan 238)", () => {
  it("holding the newest 95% of the Inbox, or all of it: pages, filters, scopes and counts within the navigation budgets", async () => {
    const inbox = store.db.all<{ id: number; account_id: number; provider_thread_id: string | null }>("SELECT id, account_id, provider_thread_id FROM threads WHERE in_inbox = 1 ORDER BY last_date DESC, id DESC");
    const out = accountIds[0]!;
    // the worst case for a page: everything newest is the hidden account's, so the walk passes all of it first
    const top = inbox.slice(0, Math.floor(inbox.length * 0.95)).map((r) => r.id);
    const rest = inbox.slice(top.length).filter((r) => r.account_id === out).map((r) => r.id);
    const other = accountIds.find((id) => id !== out)!;
    // a provider's thread id is unique within its account: a moved thread wears its own key meanwhile
    const move = (ids: number[], to: number) => {
      for (let i = 0; i < ids.length; i += 500) store.db.run(`UPDATE threads SET account_id = ?, provider_thread_id = 'p238:' || id WHERE id IN (${ids.slice(i, i + 500).join()})`, to);
    };
    move(top, out);
    move(rest, other);
    meta.accountOutOfInbox = `${top.length} of ${inbox.length}`;
    try {
      const control = await measureAsync("account out control (shown): sidebar counts", 10, () => store.threads.counts(NOW));
      stats.push(control);
      await store.accounts.update(out, { unified: false });
      const page = await store.threads.list({ view: "inbox", limit: 100 });
      expect(page.items.length).toBeGreaterThan(0);
      expect(page.items.every((t) => t.accountId !== out)).toBe(true);
      await gate("account out 95%: list inbox, first page (100)", 5, () => store.threads.list({ view: "inbox", limit: 100 }));
      await gate("account out 95%: list inbox, next page", 5, () => store.threads.list({ view: "inbox", limit: 100, cursor: page.nextCursor ?? undefined }));
      await gate("account out 95%: inbox unread filter, first page", 5, () => store.threads.list({ view: "inbox", filter: "unread", limit: 100 }));
      await gate("account out 95%: select all in the Inbox (ids, first page)", 10, () => store.threads.scopeIds({ view: "inbox", limit: 500 }));
      await gate("account out 95%: select all in the Inbox (count)", 10, () => store.threads.scopeCount({ view: "inbox", limit: 100_000 }));
      const counts = await gate("account out 95%: sidebar counts", 5, () => store.threads.counts(NOW));
      expect(counts.p50 - control.p50, `the account test adds ${(counts.p50 - control.p50).toFixed(2)} ms to the counts`).toBeLessThanOrEqual(1 * BUDGET_MULTIPLIER);
      // its own Inbox is as it was
      await gate("account out 95%: its own Inbox, first page (100)", 5, () => store.threads.list({ view: "inbox", accountId: out, limit: 100 }));
      for (const id of accountIds) await store.accounts.update(id, { unified: false });
      expect((await store.threads.list({ view: "inbox", limit: 100 })).items).toEqual([]);
      await gate("every account out: list inbox, first page (empty)", 5, () => store.threads.list({ view: "inbox", limit: 100 }));
      await gate("every account out: inbox unread filter (empty)", 5, () => store.threads.list({ view: "inbox", filter: "unread", limit: 100 }));
    } finally {
      for (const id of accountIds) await store.accounts.update(id, { unified: true });
      store.db.tx(() => {
        for (const r of inbox) store.db.run("UPDATE threads SET account_id = ?, provider_thread_id = ? WHERE id = ?", r.account_id, r.provider_thread_id, r.id);
      });
    }
  });
});

describe("Outlook's one folder a message (plan 259)", () => {
  it("50,000 messages in 250 folders, 25,000 in one: triage beside them, the folder's pages, a delta read moving 200, and its count and export a slice at a time, within budget", async () => {
    const o = (await store.accounts.create({ kind: "outlook", email: "me@outlook.example", displayName: "Outlook", color: "brown", now: NOW })).account.id;
    const columns = (table: string) => store.db.all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name).filter((c) => c !== "id");
    const seed = store.db.get<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages WHERE is_trash = 0 AND is_spam = 0 AND is_draft = 0 AND is_sent = 0 LIMIT 1")!;
    // 10,000 conversations of 5 (copies, written here: ingesting 50,000 is minutes), the first 5,000's in "Big", the rest
    // over 250 folders; a third read
    const THREADS = 10_000;
    const PER = 5;
    const tc = columns("threads");
    const mc = columns("messages");
    const base = store.db.get<{ id: number }>("SELECT max(id) AS id FROM threads")!.id;
    store.db.tx(() => {
      store.db.run(
        `WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < ?)
         INSERT INTO threads (id, ${tc.join(", ")}) SELECT ${base} + k.i, ${tc.map((c) => (c === "account_id" ? String(o) : c === "provider_thread_id" ? "'o259-' || k.i" : c)).join(", ")} FROM threads, k WHERE threads.id = ?`,
        THREADS, seed.thread_id,
      );
      store.db.run(
        `WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < ?)
         INSERT INTO messages (${mc.join(", ")}) SELECT ${mc.map((c) => (c === "thread_id" ? `${base} + 1 + (k.i - 1) / ${PER}` : c === "account_id" ? String(o) : c === "provider_msg_id" ? "'o259-' || k.i" : c === "rfc_message_id" ? "NULL" : c === "gmail_labels" ? "NULL" : c === "in_inbox" ? "0" : c === "is_read" ? "k.i % 3 = 0" : c === "date" ? "date + k.i * 1000" : c)).join(", ")} FROM messages, k WHERE messages.id = ?`,
        THREADS * PER, seed.id,
      );
      store.db.run("INSERT INTO message_folders (message_id, account_id, folder) SELECT id, account_id, CASE WHEN thread_id <= ? THEN 'Big' ELSE 'F' || (id % 250) END FROM messages WHERE account_id = ?", base + THREADS / 2, o);
    });
    const threads = Array.from({ length: THREADS }, (_, i) => base + 1 + i);
    // their membership, as ingest's recompute writes it (500 conversations a slice)
    const recompute: number[] = [];
    for (let i = 0; i < threads.length; i += 500) {
      const t = performance.now();
      store.db.tx(() => recomputeThreads(store.db, threads.slice(i, i + 500)));
      recompute.push(performance.now() - t);
    }
    await store.folders.replace(o, [{ key: "Big", path: ["Big"], selectable: true }, ...Array.from({ length: 250 }, (_, i) => ({ key: `F${i}`, path: [`F${i}`], selectable: true }))]);
    const big = store.db.get<{ n: number }>("SELECT count(*) AS n FROM message_folders WHERE account_id = ? AND folder = 'Big'", o)!.n;
    expect(big).toBe((THREADS / 2) * PER);
    meta.outlook = `${THREADS * PER} messages, ${big} in one folder; recompute of 500 conversations max ${Math.max(...recompute).toFixed(1)} ms`;
    // 2,500 messages' membership at once, over twice an ingest slice (Codex code review #8)
    expect(Math.max(...recompute), `recompute of 500 Outlook conversations (${meta.outlook})`).toBeLessThanOrEqual(100 * BUDGET_MULTIPLIER);

    // the folder's pages and the sidebar, as any folder's
    const folder = { view: "all" as const, accountId: o, folder: "Big", now: NOW };
    const first = await store.threads.list({ ...folder, limit: 100 });
    expect(first.items).toHaveLength(100);
    await gate("Outlook: list a 25,000-message folder, first page (100)", 5, () => store.threads.list({ ...folder, limit: 100 }));
    // (the folder's own 2,500th, never the account's: Codex code review #6)
    const deep = store.db.get<{ last_date: number; id: number }>("SELECT last_date, thread_id AS id FROM thread_folders WHERE account_id = ? AND folder = 'Big' ORDER BY last_date DESC, thread_id DESC LIMIT 1 OFFSET 2500", o)!;
    const deepPage = await store.threads.list({ ...folder, limit: 100, cursor: { lastDate: deep.last_date, id: deep.id } });
    expect(deepPage.items).toHaveLength(100);
    expect(deepPage.items[0]!.id).not.toBe(first.items[0]!.id);
    await gate("Outlook: list a 25,000-message folder, page at conversation #2,500", 5, () => store.threads.list({ ...folder, limit: 100, cursor: { lastDate: deep.last_date, id: deep.id } }));
    await gate("Outlook: sidebar unread counts with 251 folders", 5, () => store.threads.counts(NOW));

    // triage: an Outlook conversation's, and another account's with Outlook's folders populated (membership reads them)
    const others = store.db.all<{ id: number }>("SELECT id FROM threads WHERE in_inbox = 1 AND account_id != ? LIMIT 200", o).map((r) => r.id);
    // each pair of samples one thread's change and its undoing, so none is a no-op (Codex code review round 2 #6)
    const inbox = (id: number) => store.db.get<{ in_inbox: number }>("SELECT in_inbox FROM threads WHERE id = ?", id)!.in_inbox;
    const unreadOf = (id: number) => store.db.get<{ unread_count: number }>("SELECT unread_count FROM threads WHERE id = ?", id)!.unread_count;
    expect(others.every((id) => inbox(id) === 1)).toBe(true);
    await gate("Outlook: archive / restore one conversation of another account (+ op)", 5, (i) => store.threads.act({ threadIds: [others[Math.floor(i / 2) % others.length]!], action: i % 2 ? "moveToInbox" : "archive", signal: null, now: NOW }), 60);
    expect(others.every((id) => inbox(id) === 1)).toBe(true);
    store.db.run(`UPDATE messages SET is_read = 0 WHERE thread_id IN (${threads.slice(0, 30).join()})`);
    store.db.tx(() => recomputeThreads(store.db, threads.slice(0, 30)));
    await gate("Outlook: mark read / unread one conversation in a folder (+ op)", 5, async (i) => {
      const id = threads[Math.floor(i / 2) % 30]!;
      await store.threads.act({ threadIds: [id], action: i % 2 ? "markUnread" : "markRead", signal: null, now: NOW });
      expect(unreadOf(id) > 0).toBe(i % 2 === 1);
    }, 60);
    // the exact undo (plan 259): 50 conversations of the folder to the Inbox, then undone back to it, the same 50 each
    // time with every earlier pair's ops still queued, so each message's place replays them all, and each restore's
    // filing carries 250 messages' journal (Codex code review #9)
    let undo: Awaited<ReturnType<typeof store.threads.act>>["before"] = [];
    let calls = 0;
    const slice = threads.slice(1000, 1050);
    await gate("Outlook: Move to Inbox 50 conversations of a folder, then undo it, the queue growing (+ ops)", 40, async () => {
      const i = calls++;
      if (i % 2 === 0) undo = (await store.threads.act({ threadIds: slice, action: "moveToInbox", signal: null, now: NOW })).before;
      else {
        const r = await store.threads.restore({ messages: undo, now: NOW });
        expect(r.opIds).toHaveLength(1);
      }
    }, 20);
    if (calls % 2) await store.threads.restore({ messages: undo, now: NOW });
    expect(store.db.get<{ n: number }>(`SELECT count(*) AS n FROM thread_folders WHERE folder = 'Big' AND thread_id IN (${slice.join()})`)!.n).toBe(50);
    // ten times the targets (one undo's filing carries 2,500 messages' journal), the queue growing the same way (round 2 #7)
    const many = threads.slice(2000, 2500);
    calls = 0;
    await gate("Outlook: Move to Inbox 500 conversations of a folder, then undo it, the queue growing (+ ops)", 300, async () => {
      const i = calls++;
      if (i % 2 === 0) undo = (await store.threads.act({ threadIds: many, action: "moveToInbox", signal: null, now: NOW })).before;
      else await store.threads.restore({ messages: undo, now: NOW });
    }, 6);
    if (calls % 2) await store.threads.restore({ messages: undo, now: NOW });
    expect(store.db.get<{ n: number }>(`SELECT count(*) AS n FROM thread_folders WHERE folder = 'Big' AND thread_id IN (${many.join()})`)!.n).toBe(500);

    // a delta read that saw 200 move out of Big: one slice, as ingest's (≥ 1k msgs/s)
    const moved = store.db.all<{ provider_msg_id: string }>("SELECT provider_msg_id FROM messages INDEXED BY messages_thread WHERE thread_id > ? AND thread_id <= ? ORDER BY thread_id LIMIT 200", base + 200, base + THREADS / 2);
    const delta = (to: string) => moved.map((m) => msg({ accountId: o, providerMsgId: m.provider_msg_id, inInbox: false, isRead: true, folder: to }));
    await gate("Outlook: a delta read moving 200 messages between folders", 200, (i) => store.sync.ingest(delta(i % 2 ? "Big" : "F7"), { applyFilters: false, now: NOW, classifier: null }), 10);

    // a delete's count of the folder, a slice at a time: each within a frame, each message looked at once
    const limit = 1000;
    const ms: number[] = [];
    let counted = 0;
    for (let after: Parameters<typeof store.folders.count>[2] = null; ; ) {
      const started = performance.now();
      const r = await store.folders.count(o, ["Big", "F7", "Big"], after, limit);
      ms.push(performance.now() - started);
      counted += r.messages;
      if (!r.next) break;
      after = r.next;
    }
    meta.outlookCount = `${ms.length} slices, ${ms.reduce((a, b) => a + b, 0).toFixed(1)} ms in all, max ${Math.max(...ms).toFixed(2)} ms`;
    expect(counted).toBe(store.db.get<{ n: number }>("SELECT count(*) AS n FROM message_folders WHERE account_id = ? AND folder IN ('Big', 'F7')", o)!.n);
    expect(Math.max(...ms), `one count slice (${meta.outlookCount})`).toBeLessThanOrEqual(16 * BUDGET_MULTIPLIER);
    expect(ms.length).toBeLessThanOrEqual(Math.ceil(counted / limit) + 3);
    // a subtree of 10,000 folders, each named once: every slice within a frame (Codex code review #4: each key searched
    // the keys before it, ~270 ms a call)
    const subtree = [...Array.from({ length: 10_000 }, (_, i) => `Empty${i}`), "F7"];
    const wide: number[] = [];
    let inWide = 0;
    for (let after: Parameters<typeof store.folders.count>[2] = null; ; ) {
      const started = performance.now();
      const r = await store.folders.count(o, subtree, after, limit);
      wide.push(performance.now() - started);
      inWide += r.messages;
      if (!r.next) break;
      after = r.next;
    }
    meta.outlookWideCount = `${wide.length} slices, max ${Math.max(...wide).toFixed(2)} ms`;
    expect(inWide).toBe(store.db.get<{ n: number }>("SELECT count(*) AS n FROM message_folders WHERE account_id = ? AND folder = 'F7'", o)!.n);
    expect(Math.max(...wide), `one count slice over 10,000 folders (${meta.outlookWideCount})`).toBeLessThanOrEqual(16 * BUDGET_MULTIPLIER);

    // its export's ids, a stretch at a time
    const stretches: number[] = [];
    let exported = 0;
    for (let after: Parameters<typeof store.folderExport.ids>[1] = null; ; ) {
      const started = performance.now();
      const r = await store.folderExport.ids({ accountId: o, folder: "Big" }, after, limit);
      stretches.push(performance.now() - started);
      exported += r.messages.length;
      if (!r.next) break;
      after = r.next;
    }
    meta.outlookExport = `${stretches.length} stretches, max ${Math.max(...stretches).toFixed(2)} ms`;
    expect(exported).toBe(store.db.get<{ n: number }>("SELECT count(*) AS n FROM message_folders WHERE account_id = ? AND folder = 'Big'", o)!.n);
    expect(Math.max(...stretches), `one export stretch (${meta.outlookExport})`).toBeLessThanOrEqual(16 * BUDGET_MULTIPLIER);
  });
});
