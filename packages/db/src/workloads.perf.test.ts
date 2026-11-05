/**
 * What follows one thread, one page or one slice rather than the mailbox, at 57,000 threads on SQLite, sharing a copy of
 * the large mailbox (test/perf-mailbox.ts) in an order where none leaves what another's timing would run under:
 * arrivals only reads; summaries wants no filters and is before forwards, which leaves two (Codex's revision 6; each
 * says what it needs before it times, conformance/perf.ts). The workloads are the same on both stores.
 *
 * A reopened mailbox ("closed"): these read and write from a fresh connection; what's written (6,000 look-alikes, slices
 * of live mail) goes through the store as before.
 */
import { measureAsk, measureAiSummaries, measureCategoryEvidence, measureForwards, measureWriting, type WorkloadMailbox } from "@terno/store/conformance";
import { REMINDERS_MAX, REMOVABLE_BUCKETS, storageCutoff } from "@terno/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase } from "./index";
import { SqlMailStore } from "./sql-store";
import { BUDGET_MULTIPLIER, measureAsync, report, type Stat } from "./test/perf";
import { copyMailbox, LARGE_MAILBOX, MAILBOX_NOW as NOW, PERF_MAILBOX, scratchDir } from "./test/perf-mailbox";

const scratch = scratchDir("workloads-perf");
const stats: Stat[] = [];
const meta: Record<string, unknown> = {};
afterAll(() => {
  report("workloads.json", "Workloads at 50k+ threads (SqlMailStore)", meta, stats);
  scratch.done();
});

/** 20 samples: a p95 past one outlier, a batch over budget measured again (measureAsync) */
async function gate(name: string, budgetMs: number, fn: (i: number) => Promise<unknown>, iterations = 20, between?: () => Promise<unknown>) {
  const s = await measureAsync(name, budgetMs, fn, iterations, 3, between);
  stats.push(s);
  expect(s.p95, `${name} p95 ${s.p95.toFixed(2)}ms > ${budgetMs}ms`).toBeLessThanOrEqual(budgetMs * BUDGET_MULTIPLIER);
}

describe("sharing a large mailbox", () => {
  let store: SqlMailStore;
  let mailbox: WorkloadMailbox;

  beforeAll(() => {
    const seeded = copyMailbox(LARGE_MAILBOX, scratch.path("shared.db"));
    expect(seeded.threadCount).toBeGreaterThanOrEqual(50_000);
    meta.threads = seeded.threadCount;
    store = new SqlMailStore(openDatabase(scratch.path("shared.db")));
    mailbox = { store, accountId: seeded.accountIds[0]!, now: NOW, budget: BUDGET_MULTIPLIER, log: (line) => process.stderr.write(`[50k SQL] ${line}\n`) };
  });
  afterAll(() => store.close());

  it("plan 41: sync.arrivals of 200 messages stays below 5 ms", async () => {
    const top = store.db.get<{ m: number }>("SELECT max(id) AS m FROM messages")!.m;
    await gate("sync.arrivals(200) at 50k threads", 5, async (i) => {
      const from = top - (i % 50) * 200;
      const ids = Array.from({ length: 200 }, (_, k) => from - k);
      expect((await store.sync.arrivals(ids)).length).toBe(200);
    });
  });
  it("plan 132: summaries: marking a live slice and the worker's and reader's reads hold", () => measureAiSummaries(mailbox));
  it("plan 141: a question's search and passages hold, wherever the word is", () => measureAsk(mailbox, { totalMs: 250, passagesMs: 100, stallMs: null }));
  it("plan 133: drafting's reads hold, with thousands of look-alikes in the way", () => measureWriting(mailbox));
  it("plan 134: categories: what the AI is told and an AI filing hold", () => measureCategoryEvidence(mailbox));
  it("plan 116: forwards: a live slice's planning and the queue's reads hold", () => measureForwards(mailbox));
});

describe("plan 69: the storage report and removal", () => {
  // its own copy: removal deletes what the others read, and as the desktop runs it: checkpoints on the worker, the backend settling between units
  let store: SqlMailStore;

  beforeAll(async () => {
    const seeded = copyMailbox(LARGE_MAILBOX, scratch.path("storage.db"));
    store = new SqlMailStore(openDatabase(scratch.path("storage.db")), { checkpointWorker: true });
    // synced accounts: a never-synced one keeps its mail
    for (const id of seeded.accountIds) await store.accounts.setSyncState(id, { lastSyncAt: NOW });
  });
  afterAll(() => store.close());

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
    let at = 0;
    let removed = 0;
    await gate("remove unit (≤30 messages)", 15, async () => {
      const pack = candidates.slice(at, at + 20);
      at += 20;
      removed += (await store.storage.remove({ threadIds: pack, buckets: [...REMOVABLE_BUCKETS], cutoff, maxMessages: 30 })).messages;
      // a write's tail is checkpoints: 60 samples, so a p95 isn't one or two of them
    }, 60, () => store.settle());
    expect(removed).toBeGreaterThan(1000);
  });

  it("one conversation of 20k messages: its report row is one aggregate, and removing it goes by units bounded by its recompute", async () => {
    const [acct] = store.db.all<{ id: number }>("SELECT id FROM accounts LIMIT 1");
    const t = store.db.get<{ id: number }>("SELECT thread_id AS id FROM messages WHERE account_id = ? GROUP BY thread_id ORDER BY count(*) DESC LIMIT 1", acct!.id)!.id;
    // every remaining message of the account joins one old Trash thread (no draft holds any of them)
    store.db.tx(() => {
      store.db.run("DELETE FROM drafts");
      store.db.run("UPDATE messages SET thread_id = ?, is_trash = 1, in_inbox = 0, is_starred = 0, is_sent = 0, date = 1 WHERE thread_id = ? OR id IN (SELECT id FROM messages WHERE account_id = ? LIMIT 20000)", t, t, acct!.id);
      store.db.run("UPDATE threads SET in_trash = 1, in_inbox = 0, is_starred = 0, has_sent = 0, last_date = 1 WHERE id = ?", t);
    });
    meta.bigThread = store.db.get<{ c: number }>("SELECT count(*) AS c FROM messages WHERE thread_id = ?", t)!.c;
    // one aggregate over the whole thread (sizes, holds): it grows with the thread, so a bound of its own
    await gate("report row of the big thread", 80, () => store.storage.threads(t - 1, 1), 10);
    // a unit's floor here is recomputing the thread from what is left of it (what one expunge in it already costs: the
    // store's thread aggregates) plus re-reading that none of it is held; both shrink as the thread does
    let removed = 0;
    await gate("remove unit of the big thread (30)", 130, async () => {
      removed += (await store.storage.remove({ threadIds: [t], buckets: ["trash"], cutoff: NOW, maxMessages: 30 })).messages;
    }, 10, () => store.settle());
    expect(removed).toBeGreaterThan(300);
  });
});

describe("the perf mailbox of 51k messages", () => {
  // reminders only read beside its own table, then similar rewrites every sender: a copy of its own for each isn't needed
  let store: SqlMailStore;
  let busiest: { email: string; threadId: number };

  beforeAll(() => {
    const seeded = copyMailbox(PERF_MAILBOX, scratch.path("perf.db"));
    expect(seeded.messageCount).toBeGreaterThanOrEqual(50_000);
    store = new SqlMailStore(openDatabase(scratch.path("perf.db")));
    busiest = store.db.get<{ email: string; threadId: number }>("SELECT from_email AS email, max(thread_id) AS threadId FROM messages WHERE is_sent = 0 GROUP BY from_email ORDER BY count(*) DESC LIMIT 1")!;
  });
  afterAll(() => store.close());

  it("plan 87: 1,000 reminders on the longest conversations: the list, a slice of the answered check and the summaries each within a frame", async () => {
    const ids = store.db.all<{ id: number }>("SELECT id FROM threads ORDER BY message_count DESC, id LIMIT ?", REMINDERS_MAX).map((r) => r.id);
    // set before every message: each one's answered check reads the whole conversation
    const r = await store.reminders.put(ids.map((threadId) => ({ threadId, dueAt: NOW + 86_400_000, kind: "noReply" as const, setAt: 0 })), REMINDERS_MAX);
    expect(r.ok).toBe(true);
    const list = await store.reminders.list();
    expect(list).toHaveLength(REMINDERS_MAX);
    await gate("list", 16, () => store.reminders.list());
    // the backend's first slice (BULK_SLICE's initial size); answered, since every reminder predates its mail
    await gate("answered, 64", 8, () => store.reminders.answered(list.slice(0, 64)));
    await gate("summaries", 16, () => store.threads.summaries(list.map((x) => x.threadId)));
    await store.reminders.delete(ids);
  });

  it("plan 63: offers for the busiest sender (all four scopes, capped counts) within a frame, for every action", async () => {
    const busiestMessages = store.db.get<{ c: number }>("SELECT count(*) AS c FROM messages WHERE from_email = ?", busiest.email)!.c;
    expect(busiestMessages).toBeGreaterThan(1000);
    for (const action of ["archive", "trash", "spam"] as const) {
      await gate(`offers ${action}`, 16, () => store.similar.offers([busiest.threadId], action));
    }
  });

  it("plan 63: one sender sent everything: offers stay within a frame (dominant, rare subject, nothing in place), a sweep's pages within a slice", async () => {
    // every received message from one sender and one domain: each scope is the whole mailbox
    store.db.run("UPDATE messages SET from_email = 'bot@notify.example', from_domain = 'notify.example', list_id = 'all.notify.example' WHERE is_sent = 0");
    expect(store.db.get<{ c: number }>("SELECT count(*) AS c FROM messages WHERE from_email = 'bot@notify.example'")!.c).toBeGreaterThan(40_000);
    for (const action of ["archive", "spam"] as const) await gate(`offers dominant ${action}`, 16, () => store.similar.offers([busiest.threadId], action));
    const rare = { kind: "subject", email: "bot@notify.example", subject: "nothing has this subject" } as const;
    await gate("resolve page, rare subject", 8, () => store.similar.resolvePage(rare, "spam", [], null, 2000));
    await gate("resolve page, dominant sender", 8, () => store.similar.resolvePage({ kind: "sender", email: "bot@notify.example" }, "spam", [], null, 2000));
    // every page of the whole sweep, the last ones too: each seeks its cursor, none rereads what came before
    const pages: number[] = [];
    for (let cursor: number | null = null; ; ) {
      const started = performance.now();
      const p = await store.similar.resolvePage({ kind: "sender", email: "bot@notify.example" }, "spam", [], cursor, 2000);
      pages.push(performance.now() - started);
      if (p.next === null) break;
      cursor = p.next;
    }
    expect(pages.length).toBeGreaterThan(15);
    const late = pages.slice(-5);
    expect(Math.max(...late), `late pages ${late.map((ms) => ms.toFixed(2)).join(", ")}`).toBeLessThanOrEqual(8 * BUDGET_MULTIPLIER);
    store.db.run("UPDATE threads SET in_inbox = 0");
    await gate("offers dominant, nothing in the inbox", 16, () => store.similar.offers([busiest.threadId], "archive"));
  });
});
