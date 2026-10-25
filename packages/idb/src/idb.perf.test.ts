import "fake-indexeddb/auto";
import { generateDataset } from "@terno/mock-data";
import type { Platform } from "@terno/store";
import { afterAll, beforeAll, expect, it } from "vitest";
import { machineBusy, sampleAsync, watchLoop } from "../../db/src/test/timing";
import { IdbMailStore } from "./store";

/**
 * IndexedDB adapter gates at ~50k messages (fake-indexeddb in Node: the
 * adapter's own CPU and event-loop stalls; browser timings are web-perf's).
 * On a quiet machine every timing is wall clock and every count, walk and
 * bulk change is timed once, as ever. On a busy one (timing.ts) a timing
 * leaves out the time the loop was busy with the thread off a CPU (all the
 * work here is JS on this thread, never a blocking system call), warm reads
 * are the median of three, the dense/empty case runs three times, and rare
 * stalls the OS held are excused.
 */
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const MULT = Number(env.PERF_BUDGET_MULTIPLIER ?? "1");
const FRAME = 16;
const NOW = Date.UTC(2026, 9, 22, 15, 30);
const platform: Pick<Platform, "uuid" | "yield"> = { uuid: () => crypto.randomUUID(), yield: () => new Promise((r) => setTimeout(r, 0)) };
const name = `perf-${Date.now()}`;
let messages = 0;

/** the longest the event loop was busy without running a 1 ms timer while `fn` ran (the OS's own holds excused while rare) */
async function stalls<T>(budgetMs: number, fn: () => Promise<T>): Promise<{ result: T; maxStall: number; ms: number; descheduled: number }> {
  const loop = watchLoop(budgetMs);
  const started = performance.now();
  let stopped = false;
  try {
    const result = await fn();
    const r = loop.stop();
    stopped = true;
    return { result, maxStall: r.stall, ms: performance.now() - started, descheduled: r.descheduled.length };
  } finally {
    if (!stopped) loop.stop();
  }
}

/** how long `fn` took (on a busy machine, less the time the OS held the thread while it ran) */
async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const s = await sampleAsync(fn);
  return { result: s.result, ms: machineBusy() ? s.cpu : s.wall };
}

/** a read timed once; on a busy machine three times, at the median (what it costs every time, not a moment the machine was busy) */
async function warm<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number; first: number }> {
  const first = await timed(fn);
  if (!machineBusy()) return { ...first, first: first.ms };
  const ms = [first.ms, (await timed(fn)).ms, (await timed(fn)).ms].sort((a, b) => a - b)[1]!;
  return { result: first.result, ms, first: first.ms };
}

/** the best of a few runs: a stall from our code repeats every time, preemption by other processes doesn't */
async function bestOf<T>(n: number, fn: () => Promise<{ maxStall: number } & T>): Promise<{ maxStall: number } & T> {
  let best: ({ maxStall: number } & T) | null = null;
  for (let i = 0; i < n; i++) {
    const r = await fn();
    if (!best || r.maxStall < best.maxStall) best = r;
    if (best.maxStall <= FRAME * MULT) break;
  }
  return best!;
}

let store: IdbMailStore;
beforeAll(async () => {
  store = await IdbMailStore.open({ name, factory: indexedDB, platform, instantSearch: false });
  const seeded = await store.dev.seed(generateDataset({ threads: 28_400, accounts: 8, seed: 42, now: NOW, bodyScale: 2 }), { now: NOW });
  messages = seeded.messageCount;
}, 900_000);
afterAll(async () => store?.close());

it("the exact scan never stalls the event loop and lets commands through (field-only and body searches)", async () => {
  expect(messages).toBeGreaterThan(48_000);
  for (const query of ["subject:zzqxjv", "from:nadie-de-aqui", "presupuesto zzqxjv"]) {
    const r = await bestOf(3, async () => {
      let commandMs = Infinity;
      const run = await stalls(FRAME * MULT, async () => {
        const search = store.threads.searchText({ query, limit: 100, now: NOW });
        // a command issued while the scan runs answers without waiting for all of it
        commandMs = (await timed(() => store.settings.set("probe", performance.now()))).ms;
        return search;
      });
      return { ...run, commandMs };
    });
    console.log(`scan ${query}: ${Math.round(r.ms)} ms, max stall ${r.maxStall.toFixed(1)} ms, concurrent command ${r.commandMs.toFixed(1)} ms`);
    expect(r.result.items).toEqual([]);
    expect(r.result.strategy).toBe("scan");
    expect(r.maxStall, `${query}: max stall`).toBeLessThanOrEqual(FRAME * MULT);
    expect(r.commandMs, `${query}: a command during the scan`).toBeLessThanOrEqual(50 * MULT);
  }
}, 900_000);

it("an index rebuild reads the store once in order: bounded CPU, no stall", async () => {
  await store.close();
  const cpuUsage = (globalThis as unknown as { process: { cpuUsage(prev?: { user: number; system: number }): { user: number; system: number } } }).process.cpuUsage;
  // opening: memory is built in slices (fake-indexeddb's own getAll clones synchronously; Chromium does it off the main thread)
  const opened = await stalls(FRAME * 2 * MULT, async () => {
    store = await IdbMailStore.open({ name, factory: indexedDB, platform, instantSearch: { sliceMs: 4 } });
    await store.whenLoaded();
  });
  const cpu = cpuUsage();
  const r = await stalls(FRAME * 2 * MULT, async () => expect(await store.instant!.settled(900_000)).toBe(true));
  const used = cpuUsage(cpu);
  const cpuMs = (used.user + used.system) / 1000;
  console.log(`open at ${messages} messages: ${Math.round(opened.ms)} ms, max stall ${opened.maxStall.toFixed(1)} ms; rebuild: ${Math.round(r.ms)} ms wall, ${Math.round(cpuMs)} ms CPU, max stall ${r.maxStall.toFixed(1)} ms (${r.descheduled} descheduled)`);
  expect(r.maxStall, "rebuild max stall").toBeLessThanOrEqual(FRAME * 2 * MULT);
  // linear in the mailbox: one ordered enumeration, ~0.05 ms of CPU per message measured (the per-page key sort made it quadratic)
  expect(cpuMs / messages, "rebuild CPU per message").toBeLessThanOrEqual(0.1 * MULT);
}, 900_000);

it("select all N pages seek, never rescan: a 28,000-thread view, account and category page in bounded time", async () => {
  const all = (await store.debug.snapshot()).threads;
  const account = all[0]!.accountId;
  const cat = (await store.categories.create("Todo", "rose")).id;
  await store.categories.add({ categoryId: cat, threadIds: all.map((t) => t.id), addedBy: "filter", now: NOW });
  for (const [label, scope] of [
    ["all", { view: "all" as const }],
    ["account", { view: "all" as const, accountId: account }],
    ["category", { view: "all" as const, categoryId: cat }],
  ] as const) {
    for (const limit of [500, 100]) {
      const pages: number[] = [];
      const seen: number[] = [];
      for (let after = 0; ; ) {
        const { result: page, ms } = await timed(() => store.threads.scopeIds({ ...scope, after, limit }));
        pages.push(ms);
        seen.push(...page);
        if (page.length < limit) break;
        after = page[page.length - 1]!;
      }
      const sorted = [...pages].sort((a, b) => a - b);
      const total = pages.reduce((a, b) => a + b, 0);
      console.log(`scope ${label}, pages of ${limit}: ${seen.length} ids in ${pages.length} pages, ${total.toFixed(1)} ms in all, max ${sorted.at(-1)!.toFixed(2)} ms`);
      expect(seen.length).toBe(await store.threads.scopeCount({ ...scope, limit: 1_000_000 }));
      // a page is a seek and at most a page of rows (plus the ones the view filters out), never the whole mailbox:
      // walking all of it costs about one pass, whatever the page size (rescanning per page cost ~130 ms in pages of 100)
      expect(total, `${label} / ${limit}: all pages`).toBeLessThanOrEqual(25 * MULT);
      expect(sorted.at(-1)!, `${label} / ${limit}: one page`).toBeLessThanOrEqual(FRAME * MULT);
    }
  }
  await store.categories.delete(cat);
}, 900_000);

it("the unread filter pages from its own order: a cold build, every page, and 5,000 reads at once each within a frame", async () => {
  const all = (await store.debug.snapshot()).threads;
  const unread = all.filter((t) => t.unreadCount > 0);
  console.log(`unread filter: ${unread.length} unread of ${all.length} threads`);
  // the first filtered page builds the order (a pass over the threads and a sort of the unread ones)
  const cold = await timed(() => store.threads.list({ view: "inbox", unreadOnly: true, limit: 100 }));
  console.log(`unread order, cold first page: ${cold.ms.toFixed(2)} ms`);
  expect(cold.ms, "cold first page").toBeLessThanOrEqual(FRAME * MULT);
  for (const [label, p] of [
    ["inbox", { view: "inbox" as const }],
    ["archive", { view: "archive" as const }],
    ["trash", { view: "trash" as const }],
    ["account", { view: "all" as const, accountId: all[0]!.accountId }],
  ] as const) {
    let worst = 0;
    let seen = 0;
    let cursor: { lastDate: number; id: number } | undefined;
    do {
      const r = await timed(() => store.threads.list({ ...p, unreadOnly: true, limit: 100, cursor }));
      worst = Math.max(worst, r.ms);
      seen += r.result.items.length;
      cursor = r.result.nextCursor ?? undefined;
    } while (cursor);
    console.log(`unread ${label}: ${seen} threads, worst page ${worst.toFixed(2)} ms`);
    expect(worst, `unread ${label}: one page`).toBeLessThanOrEqual(FRAME * MULT);
  }
  // 5,000 threads read at once re-sort the order once; the next page pays it
  const inbox = all.filter((t) => t.inInbox).slice(0, 5000).map((t) => t.id);
  await store.threads.act({ threadIds: inbox, action: "markRead", signal: null, now: NOW });
  const after = await timed(() => store.threads.list({ view: "all", unreadOnly: true, limit: 100 }));
  console.log(`unread page after 5,000 reads: ${after.ms.toFixed(2)} ms`);
  expect(after.ms, "page after a bulk read").toBeLessThanOrEqual(FRAME * MULT);
  expect(after.result.items.every((t) => t.unread && !inbox.includes(t.id))).toBe(true);
  await store.threads.act({ threadIds: inbox, action: "markUnread", signal: null, now: NOW });
  await store.debug.verify();
}, 900_000);

it("the unread filter's counts and select-all walks read the unread threads only: none in the view, a few, or a read crossing at a time", async () => {
  const count = (view: "inbox" | "archive" | "trash" | "all") => timed(() => store.threads.scopeCount({ view, unreadOnly: true, limit: 100_001 }));
  // first use builds the ascending unread ids once
  const cold = await count("trash");
  console.log(`unread scope, cold count (trash): ${cold.ms.toFixed(2)} ms`);
  expect(cold.ms, "cold count").toBeLessThanOrEqual(FRAME * MULT);
  // against the walk of every thread id (what an unread count of an empty view did before it had its own ids)
  const best = async (fn: () => Promise<unknown>) => {
    let min = Infinity;
    for (let i = 0; i < 7; i++) min = Math.min(min, (await timed(fn)).ms);
    return min;
  };
  const whole = await best(() => store.threads.scopeCount({ view: "trash", limit: 100_001 }));
  const filtered = await best(() => store.threads.scopeCount({ view: "trash", unreadOnly: true, limit: 100_001 }));
  console.log(`trash count: every id ${whole.toFixed(2)} ms, the unread ids ${filtered.toFixed(2)} ms`);
  expect(filtered, "an empty unread count walks the unread ids, not the mailbox").toBeLessThanOrEqual(whole / 2);
  for (const view of ["trash", "archive", "inbox", "all"] as const) {
    // warm: the cold count built the ids above
    const r = await warm(() => store.threads.scopeCount({ view, unreadOnly: true, limit: 100_001 }));
    const walk = await warm(async () => {
      let walked = 0;
      for (let after = 0; ; ) {
        const page = await store.threads.scopeIds({ view, unreadOnly: true, after, limit: 500 });
        walked += page.length;
        if (page.length < 500) return walked;
        after = page[page.length - 1]!;
      }
    });
    const walked = walk.result;
    console.log(`unread scope ${view}: ${r.result} counted in ${r.ms.toFixed(2)} ms, walked in ${walk.ms.toFixed(2)} ms`);
    expect(walked).toBe(r.result);
    // a pass over the unread threads, not the 28,400 of the mailbox (that was ~3 ms per count)
    expect(r.ms, `${view}: count`).toBeLessThanOrEqual(1.5 * MULT);
    expect(walk.ms, `${view}: whole walk`).toBeLessThanOrEqual(FRAME * MULT);
  }
  // reads one at a time (the dwell) keep the ids by binary search: the next count stays cheap
  const unread = (await store.threads.scopeIds({ view: "all", unreadOnly: true, limit: 20 }));
  const worst: number[] = [];
  for (const id of unread) {
    await store.threads.act({ threadIds: [id], action: "markRead", signal: null, now: NOW });
    worst.push((await count("all")).ms);
  }
  console.log(`unread scope count after a single read: worst ${Math.max(...worst).toFixed(2)} ms`);
  expect(Math.max(...worst), "count after a read").toBeLessThanOrEqual(1.5 * MULT);
  await store.threads.act({ threadIds: unread, action: "markUnread", signal: null, now: NOW });
  await store.debug.verify();
}, 900_000);

it("the quick filters (plan 15) page from their own orders: with attachments and starred, cold, every page, counts and walks within a frame; 5,000 stars at once", async () => {
  const all = (await store.debug.snapshot()).threads;
  for (const filter of ["attachments", "starred"] as const) {
    const keeps = all.filter((t) => (filter === "attachments" ? t.hasAttachments : t.isStarred)).length;
    // the first filtered page builds the filter's order (a pass over the threads and a sort of the ones it keeps)
    const cold = await timed(() => store.threads.list({ view: "inbox", filter, limit: 100 }));
    console.log(`${filter}: ${keeps} of ${all.length} threads; cold first page ${cold.ms.toFixed(2)} ms`);
    expect(cold.ms, `${filter}: cold first page`).toBeLessThanOrEqual(FRAME * MULT);
    for (const [label, p] of [
      ["inbox", { view: "inbox" as const }],
      ["archive", { view: "archive" as const }],
      ["trash", { view: "trash" as const }],
      ["account", { view: "all" as const, accountId: all[0]!.accountId }],
    ] as const) {
      let worst = 0;
      let cursor: { lastDate: number; id: number } | undefined;
      do {
        const r = await timed(() => store.threads.list({ ...p, filter, limit: 100, cursor }));
        worst = Math.max(worst, r.ms);
        cursor = r.result.nextCursor ?? undefined;
      } while (cursor);
      expect(worst, `${filter} ${label}: one page`).toBeLessThanOrEqual(FRAME * MULT);
      const count = await warm(() => store.threads.scopeCount({ ...p, filter, limit: 100_001 }));
      const walk = await warm(async () => {
        let walked = 0;
        for (let after = 0; ; ) {
          const page = await store.threads.scopeIds({ ...p, filter, after, limit: 500 });
          walked += page.length;
          if (page.length < 500) return walked;
          after = page[page.length - 1]!;
        }
      });
      expect(walk.result).toBe(count.result);
      // a count walks the filter's own ascending ids (a few thousand at most here), never the whole mailbox; the first
      // one of a filter (inbox) builds those ids, and is held to the same budget on its own
      if (label === "inbox") expect(count.first, `${filter}: first count (builds the ids)`).toBeLessThanOrEqual(3 * MULT);
      expect(count.ms, `${filter} ${label}: count`).toBeLessThanOrEqual(3 * MULT);
      expect(walk.ms, `${filter} ${label}: whole walk`).toBeLessThanOrEqual(FRAME * MULT);
    }
  }
  // a search narrowed to conversations with attachments: the instant index keeps them before paging (codex review, plan 15)
  expect(await store.instant!.settled(120_000)).toBe(true);
  for (const query of ["hola", "factura", "in:all"]) {
    const first = await timed(() => store.threads.searchText({ query, threadAttachments: true, limit: 100, now: NOW }));
    expect(first.result.strategy).not.toBe("scan");
    expect(first.result.items.every((t) => t.hasAttachments)).toBe(true);
    expect(first.ms, `search "${query}" with attachments: first page`).toBeLessThanOrEqual(25 * MULT);
    if (first.result.nextCursor) {
      const next = await timed(() => store.threads.searchText({ query, threadAttachments: true, limit: 100, now: NOW, cursor: first.result.nextCursor! }));
      expect(next.ms, `search "${query}" with attachments: next page`).toBeLessThanOrEqual(25 * MULT);
    }
  }
  // dense and empty: every thread starred, then none; on a busy machine three times over, each measure at its median
  // (each is the first read after a bulk change, so it can only be repeated with the change)
  const everyone = all.map((t) => t.id);
  const runs: { dense: number; denseCount: number; empty: number; emptyCount: number }[] = [];
  for (let k = 0, n = machineBusy() ? 3 : 1; k < n; k++) {
    await store.threads.act({ threadIds: everyone, action: "star", signal: null, now: NOW });
    const dense = await timed(() => store.threads.list({ view: "all", filter: "starred", limit: 100 }));
    const denseCount = await timed(() => store.threads.scopeCount({ view: "all", filter: "starred", limit: 100_001 }));
    await store.threads.act({ threadIds: everyone, action: "unstar", signal: null, now: NOW });
    const empty = await timed(() => store.threads.list({ view: "all", filter: "starred", limit: 100 }));
    const emptyCount = await timed(() => store.threads.scopeCount({ view: "all", filter: "starred", limit: 100_001 }));
    expect(empty.result.items).toEqual([]);
    runs.push({ dense: dense.ms, denseCount: denseCount.ms, empty: empty.ms, emptyCount: emptyCount.ms });
  }
  const mid = (k: keyof (typeof runs)[number]) => runs.map((r) => r[k]).sort((a, b) => a - b)[(runs.length - 1) >> 1]!;
  // the first page after starring all 28,400 at once pays one re-sort of the whole order
  expect(mid("dense"), "every thread starred: first page").toBeLessThanOrEqual(2 * FRAME * MULT);
  expect(mid("denseCount"), "every thread starred: count").toBeLessThanOrEqual(FRAME * MULT);
  expect(mid("empty"), "nothing starred: first page").toBeLessThanOrEqual(FRAME * MULT);
  expect(mid("emptyCount"), "nothing starred: count").toBeLessThanOrEqual(1.5 * MULT);
  const starredBefore = all.filter((t) => t.isStarred).map((t) => t.id);
  if (starredBefore.length) await store.threads.act({ threadIds: starredBefore, action: "star", signal: null, now: NOW });
  // 5,000 threads starred at once re-sort the starred order once: a dense starred mailbox, the next page pays it
  const ids = all.filter((t) => !t.isStarred).slice(0, 5000).map((t) => t.id);
  await store.threads.act({ threadIds: ids, action: "star", signal: null, now: NOW });
  const after = await timed(() => store.threads.list({ view: "all", filter: "starred", limit: 100 }));
  expect(after.ms, "page after a bulk star").toBeLessThanOrEqual(FRAME * MULT);
  expect(after.result.items.every((t) => t.starred)).toBe(true);
  await store.threads.act({ threadIds: ids, action: "unstar", signal: null, now: NOW });
  await store.debug.verify();
}, 900_000);
