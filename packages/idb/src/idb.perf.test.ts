import "fake-indexeddb/auto";
import { generateDataset } from "@terno/mock-data";
import type { Platform } from "@terno/store";
import { afterAll, beforeAll, expect, it } from "vitest";
import { IdbMailStore } from "./store";

/**
 * IndexedDB adapter gates at ~50k messages (fake-indexeddb in Node: the
 * adapter's own CPU and event-loop stalls; browser timings are web-perf's).
 */
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const MULT = Number(env.PERF_BUDGET_MULTIPLIER ?? "1");
const FRAME = 16;
const NOW = Date.UTC(2026, 9, 22, 15, 30);
const platform: Pick<Platform, "uuid" | "yield"> = { uuid: () => crypto.randomUUID(), yield: () => new Promise((r) => setTimeout(r, 0)) };
const name = `perf-${Date.now()}`;
let messages = 0;

/** the longest the event loop went without running a 1 ms timer while `fn` ran */
async function stalls<T>(fn: () => Promise<T>): Promise<{ result: T; maxStall: number; ms: number }> {
  let last = performance.now();
  let maxStall = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxStall = Math.max(maxStall, now - last);
    last = now;
  }, 1);
  const started = performance.now();
  try {
    const result = await fn();
    return { result, maxStall: Math.max(maxStall, performance.now() - last), ms: performance.now() - started };
  } finally {
    clearInterval(timer);
  }
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
      const run = await stalls(async () => {
        const search = store.threads.searchText({ query, limit: 100, now: NOW });
        // a command issued while the scan runs answers without waiting for all of it
        const t = performance.now();
        await store.settings.set("probe", t);
        commandMs = performance.now() - t;
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
  const opened = await stalls(async () => {
    store = await IdbMailStore.open({ name, factory: indexedDB, platform, instantSearch: { sliceMs: 4 } });
    await store.whenLoaded();
  });
  const cpu = cpuUsage();
  const r = await stalls(async () => expect(await store.instant!.settled(900_000)).toBe(true));
  const used = cpuUsage(cpu);
  const cpuMs = (used.user + used.system) / 1000;
  console.log(`open at ${messages} messages: ${Math.round(opened.ms)} ms, max stall ${opened.maxStall.toFixed(1)} ms; rebuild: ${Math.round(r.ms)} ms wall, ${Math.round(cpuMs)} ms CPU, max stall ${r.maxStall.toFixed(1)} ms`);
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
        const t = performance.now();
        const page = await store.threads.scopeIds({ ...scope, after, limit });
        pages.push(performance.now() - t);
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
  const timed = async <T>(fn: () => Promise<T>) => {
    const t = performance.now();
    const result = await fn();
    return { result, ms: performance.now() - t };
  };
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
  const timed = async <T>(fn: () => Promise<T>) => {
    const t = performance.now();
    const result = await fn();
    return { result, ms: performance.now() - t };
  };
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
    const r = await count(view);
    let walked = 0;
    const walk = await timed(async () => {
      for (let after = 0; ; ) {
        const page = await store.threads.scopeIds({ view, unreadOnly: true, after, limit: 500 });
        walked += page.length;
        if (page.length < 500) return;
        after = page[page.length - 1]!;
      }
    });
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
