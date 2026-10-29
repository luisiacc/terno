import "fake-indexeddb/auto";
import { generateDataset } from "@terno/mock-data";
import type { Platform } from "@terno/store";
import { afterAll, beforeAll, expect, it } from "vitest";
import { machineBusy, sampleAsync, sampleSync, settle, watchLoop, type Sample } from "../../db/src/test/timing";
import { confirmRebuilt, rebuildFolders } from "./folders";
import { IdbMailStore } from "./store";

/**
 * IndexedDB adapter gates at ~50k messages (fake-indexeddb in Node: the
 * adapter's own CPU and event-loop stalls; browser timings are web-perf's).
 * On a quiet machine every timing is wall clock and every count, walk and
 * bulk change is timed once, as ever. On a busy one (timing.ts) pages the
 * OS held count at their CPU time while that is rare in a walk; a single
 * timing leaves out the time the loop was busy with the thread off a CPU
 * (this store has no synchronous waits to hide: a browser's main thread
 * can't block, and fake-indexeddb is JS on this thread); warm reads are the
 * median of three, the dense/empty case runs three times, and rare stalls
 * the OS held are excused.
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
      const samples: Sample[] = [];
      const seen: number[] = [];
      for (let after = 0; ; ) {
        const s = await sampleAsync(() => store.threads.scopeIds({ ...scope, after, limit }));
        samples.push(s);
        seen.push(...s.result);
        if (s.result.length < limit) break;
        after = s.result[s.result.length - 1]!;
      }
      const pages = settle(samples).ms;
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

it("an account's own folders (plan 65) page from their members: big, sparse, empty, deep, filtered, select all and counts within a frame", async () => {
  const all = (await store.debug.snapshot()).threads;
  // the biggest account's every thread in one folder: the store's own membership writes (a label on each message)
  const byAccount = new Map<number, number>();
  for (const t of all) if (!t.inTrash && !t.inSpam) byAccount.set(t.accountId, (byAccount.get(t.accountId) ?? 0) + 1);
  const [account, size] = [...byAccount].sort((a, b) => b[1] - a[1])[0]!;
  const messages = (await store.debug.snapshot()).messages.filter((m) => m.accountId === account);
  for (let i = 0; i < messages.length; i += 2000) {
    await store.sync.updateFlags(account, messages.slice(i, i + 2000).map((m) => ({ messageId: m.id, flags: {}, gmailLabels: ["Label_everything"] })));
  }
  await store.folders.replace(account, [...(await store.folders.list()).filter((f) => f.accountId === account).map(({ key, path, selectable }) => ({ key, path, selectable })), { key: "Label_everything", path: ["Everything"], selectable: true }]);
  const folder = { view: "all" as const, accountId: account, folder: "Label_everything" };
  const first = await store.threads.list({ ...folder, limit: 100, now: NOW });
  expect(first.items.length).toBe(100);
  const pages: Sample[] = [];
  let cursor = first.nextCursor;
  let seen = first.items.length;
  while (cursor) {
    const s = await sampleAsync(() => store.threads.list({ ...folder, cursor: cursor!, limit: 100, now: NOW }));
    pages.push(s);
    seen += s.result.items.length;
    cursor = s.result.nextCursor;
  }
  const pageMs = settle(pages).ms.sort((a, b) => a - b);
  console.log(`folder of ${size}: ${pages.length + 1} pages, max ${pageMs.at(-1)!.toFixed(2)} ms`);
  expect(pageMs.at(-1)!, "a folder page").toBeLessThanOrEqual(FRAME * MULT);
  for (const [label, read] of [
    ["first page (warm)", () => store.threads.list({ ...folder, limit: 100, now: NOW })],
    ["unread only", () => store.threads.list({ ...folder, filter: "unread", limit: 100, now: NOW })],
    ["sparse folder", async () => store.threads.list({ view: "all", accountId: account, folder: (await store.folders.list()).find((f) => f.accountId === account && f.key !== "Label_everything")?.key ?? "Label_nothing", limit: 100, now: NOW })],
    ["empty folder", () => store.threads.list({ view: "all", accountId: account, folder: "Label_nothing", limit: 100, now: NOW })],
    ["count", () => store.threads.scopeCount({ ...folder, limit: 100_001 })],
    ["counts (sidebar)", () => store.threads.counts(NOW)],
  ] as const) {
    const r = await warm(read as () => Promise<unknown>);
    console.log(`folder ${label}: ${r.ms.toFixed(2)} ms`);
    expect(r.ms, `folder ${label}`).toBeLessThanOrEqual(FRAME * MULT);
  }
  // Codex R26: "Waiting" in a folder older than its window stops at once
  const expired = await warm(() => store.threads.list({ ...folder, filter: "waiting", limit: 100, now: NOW + 400 * 86_400_000 }));
  console.log(`folder waiting, all of it older than the window: ${expired.ms.toFixed(2)} ms`);
  expect(expired.result.items).toHaveLength(0);
  expect(expired.ms, "folder waiting, all of it older than the window").toBeLessThanOrEqual(0.25 * MULT);
  // Codex R11: "Unread" in a folder where everything is read walks only its (no) unread memberships, never the folder
  const tables = (store as unknown as { c: { db: { tx<T>(fn: () => T): T; table(name: string): { rows: Map<unknown, Record<string, unknown>>; put(row: Record<string, unknown>): unknown } } } }).c.db;
  const memberships = [...tables.table("thread_folders").rows.values()].filter((r) => r.account_id === account);
  const unreadThreads = [...tables.table("threads").rows.values()].filter((t) => t.account_id === account && (t.unread_count as number) > 0);
  tables.tx(() => {
    memberships.forEach((r) => tables.table("thread_folders").put({ ...r, unread: 0 }));
    unreadThreads.forEach((t) => tables.table("threads").put({ ...t, unread_count: 0 }));
  });
  const allRead = await warm(() => store.threads.list({ ...folder, filter: "unread", limit: 100, now: NOW }));
  console.log(`folder unread only, all of it read: ${allRead.ms.toFixed(2)} ms`);
  expect(allRead.ms, "folder unread only, all of it read").toBeLessThanOrEqual(0.25 * MULT);
  // Codex R12: and where all of it is unread, every page after the first reads the kept order (never a sort per page);
  // (the account's threads as they are now, all read: put back first, then the unread ones as they were)
  const accountThreads = [...tables.table("threads").rows.values()].filter((t) => t.account_id === account);
  tables.tx(() => {
    memberships.forEach((r) => tables.table("thread_folders").put({ ...r, unread: 1 }));
    accountThreads.forEach((t) => tables.table("threads").put({ ...t, unread_count: 1 }));
  });
  const dense: Sample[] = [];
  let denseSeen = 0;
  // the first page starts its order's build (in the background, Codex R49): the pages after it read the kept order
  const firstDense = await store.threads.list({ ...folder, filter: "unread", limit: 100, now: NOW });
  await new Promise((resolve) => setTimeout(resolve, 200));
  for (let at = firstDense; at.nextCursor; ) {
    const s = await sampleAsync(() => store.threads.list({ ...folder, filter: "unread", limit: 100, cursor: at.nextCursor!, now: NOW }));
    dense.push(s);
    denseSeen += s.result.items.length;
    at = s.result;
  }
  const denseMs = settle(dense).ms.sort((a, b) => a - b);
  console.log(`folder unread only, all of it unread: ${dense.length + 1} pages, worst after the first ${denseMs.at(-1)!.toFixed(2)} ms`);
  expect(denseSeen + 100).toBe(seen);
  expect(denseMs.at(-1)!, "folder unread only, all of it unread: a page").toBeLessThanOrEqual(1 * MULT);
  tables.tx(() => {
    memberships.forEach((r) => tables.table("thread_folders").put(r));
    accountThreads.forEach((t) => tables.table("threads").put(t));
    unreadThreads.forEach((t) => tables.table("threads").put(t));
  });
  // (orders the reads above asked for finish building in the background before anything else is timed)
  await new Promise((resolve) => setTimeout(resolve, 300));
  // Codex R14: a catalog of 10,000 folders 20 levels deep, one renamed: the differences written, never the catalog
  const listedBefore = (await store.folders.list()).filter((f) => f.accountId === account).map(({ key, path, selectable }) => ({ key, path, selectable }));
  const catalog = [...listedBefore, ...Array.from({ length: 10_000 }, (_, i) => ({ key: `Cat${i}`, path: Array.from({ length: 20 }, (_, j) => `Nivel ${j} de la carpeta ${i}`), selectable: true }))];
  await store.folders.replace(account, catalog);
  const renames: Sample[] = [];
  for (let i = 0; i < 5; i++) {
    const renamed = catalog.map((f) => (f.key === "Cat5000" ? { ...f, path: [...f.path.slice(0, -1), `Renombrada ${i}`] } : f));
    renames.push(await sampleAsync(() => store.folders.replace(account, renamed)));
  }
  const renameMs = settle(renames).ms.sort((a, b) => a - b);
  console.log(`rename one folder of 10,000: median ${renameMs[2]!.toFixed(2)} ms`);
  expect(renameMs[2]!, "rename one folder of 10,000").toBeLessThanOrEqual(FRAME * MULT);
  await store.folders.replace(account, listedBefore);
  // select all walks the folder's cached members: every page a seek
  const scope: Sample[] = [];
  const ids: number[] = [];
  for (let after = 0; ; ) {
    const s = await sampleAsync(() => store.threads.scopeIds({ ...folder, after, limit: 500 }));
    scope.push(s);
    ids.push(...s.result);
    if (s.result.length < 500) break;
    after = s.result.at(-1)!;
  }
  const scopeMs = settle(scope).ms;
  expect(ids.length).toBe(seen);
  expect(scopeMs.reduce((a, b) => a + b, 0), "select all: every page").toBeLessThanOrEqual(25 * MULT);
}, 900_000);

it("relisting a populated IMAP folder (plan 65, Codex R6): every rebuild slice within a frame, the folder's order sorted once", async () => {
  const snap = await store.debug.snapshot();
  const account = (await store.accounts.list()).find((a) => a.kind === "imap")!.id;
  const mine = snap.messages.filter((m) => m.accountId === account);
  // the folder's locations, written straight into the in-memory tables (setting them up isn't what's measured)
  const c = (store as unknown as { c: { db: { tx<T>(fn: () => T): T; table(name: string): { put(row: Record<string, unknown>): unknown } } } }).c;
  c.db.tx(() => mine.forEach((m, i) => c.db.table("message_locations").put({ message_id: m.id, account_id: account, mailbox: "Big", uidvalidity: 1, uid: i + 1, flags: "[]" })));
  // rows a past listing left (Codex R8): the rebuild's first phase has them all to delete, a slice at a time
  const threadsOf = [...new Set(mine.map((m) => m.threadId))];
  c.db.tx(() => threadsOf.forEach((t) => c.db.table("thread_folders").put({ thread_id: t, account_id: account, folder: "Big", last_date: 0, unread: 0 })));
  const listed = (await store.folders.list()).filter((f) => f.accountId === account).map(({ key, path, selectable }) => ({ key, path, selectable }));
  await store.folders.replace(account, listed.filter((f) => f.key !== "Big"));
  await store.folders.replace(account, [...listed.filter((f) => f.key !== "Big"), { key: "Big", path: ["Big"], selectable: true }]);
  // the store's own work a slice, gated; fake-indexeddb's persistence of each slice (on this thread in Node, off it in
  // a browser) grows with what the tests before wrote, so it's reported, not gated
  const slices: Sample[] = [];
  const mem = c as unknown as Parameters<typeof rebuildFolders>[0];
  for (let more = true; more; ) {
    let r = { more: false };
    slices.push(sampleSync(() => (r = c.db.tx(() => rebuildFolders(mem, 250)))));
    confirmRebuilt(mem);
    more = r.more;
  }
  // what the slices wrote, persisted once (a command with nothing left to rebuild)
  const p0 = performance.now();
  await store.folders.rebuild(250);
  console.log(`rebuild persisted at once: ${(performance.now() - p0).toFixed(0)} ms`);
  const ms = settle(slices).ms.sort((a, b) => a - b);
  console.log(`rebuild of ${mine.length} locations: ${slices.length} slices, max ${ms.at(-1)!.toFixed(2)} ms, total ${ms.reduce((a, b) => a + b, 0).toFixed(1)} ms`);
  expect(ms.at(-1)!, "a rebuild slice").toBeLessThanOrEqual(FRAME * MULT);
  expect((await store.threads.list({ view: "all", accountId: account, folder: "Big", limit: 10, now: NOW })).items.length).toBeGreaterThan(0);
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
    const samples: Sample[] = [];
    let seen = 0;
    let cursor: { lastDate: number; id: number } | undefined;
    do {
      const r = await sampleAsync(() => store.threads.list({ ...p, unreadOnly: true, limit: 100, cursor }));
      samples.push(r);
      seen += r.result.items.length;
      cursor = r.result.nextCursor ?? undefined;
    } while (cursor);
    const worst = Math.max(...settle(samples).ms);
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
      const samples: Sample[] = [];
      let cursor: { lastDate: number; id: number } | undefined;
      do {
        const r = await sampleAsync(() => store.threads.list({ ...p, filter, limit: 100, cursor }));
        samples.push(r);
        cursor = r.result.nextCursor ?? undefined;
      } while (cursor);
      const worst = Math.max(...settle(samples).ms);
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

it("People and Waiting (plan 17) page from their own orders: every page, counts and walks within a frame; dense, empty, every waiting date expired but twenty", async () => {
  const walkAll = async (p: { view: "inbox" | "archive" | "all" | "trash"; accountId?: number; filter: "people" | "waiting" }, label: string, dense = false) => {
    const samples: Sample[] = [];
    let cursor: { lastDate: number; id: number } | undefined;
    let n = 0;
    do {
      const r = await sampleAsync(() => store.threads.list({ ...p, now: NOW, limit: 100, cursor }));
      samples.push(r);
      n += r.result.items.length;
      cursor = r.result.nextCursor ?? undefined;
    } while (cursor);
    const ms = settle(samples).ms;
    // after a bulk change to every row the first page pays one re-sort of the filter's order (plan 15's dense starred case)
    expect(ms[0]!, `${label}: first page`).toBeLessThanOrEqual(2 * FRAME * MULT);
    const worst = Math.max(0, ...ms.slice(1));
    expect(worst, `${label}: one page`).toBeLessThanOrEqual(FRAME * MULT);
    const count = await warm(() => store.threads.scopeCount({ ...p, now: NOW, limit: 100_001 }));
    expect(count.result, `${label}: count`).toBe(n);
    // a mailbox where nearly every thread matches counts them all (plan 15's dense starred case: within a frame)
    expect(count.ms, `${label}: count`).toBeLessThanOrEqual((dense ? FRAME : 3) * MULT);
    const walk = await warm(async () => {
      let walked = 0;
      for (let after = 0; ; ) {
        const page = await store.threads.scopeIds({ ...p, now: NOW, after, limit: 500 });
        walked += page.length;
        if (page.length < 500) return walked;
        after = page[page.length - 1]!;
      }
    });
    expect(walk.result, `${label}: walk`).toBe(n);
    expect(walk.ms, `${label}: whole walk`).toBeLessThanOrEqual(FRAME * MULT);
    return { n, worst };
  };
  const all = (await store.debug.snapshot()).threads;
  for (const filter of ["people", "waiting"] as const) {
    const cold = await timed(() => store.threads.list({ view: "inbox", filter, now: NOW, limit: 100 }));
    expect(cold.ms, `${filter}: cold first page`).toBeLessThanOrEqual(FRAME * MULT);
    for (const [label, p] of [
      ["inbox", { view: "inbox" as const }],
      ["archive", { view: "archive" as const }],
      ["trash", { view: "trash" as const }],
      ["account", { view: "all" as const, accountId: all[0]!.accountId }],
    ] as const) {
      const r = await walkAll({ ...p, filter }, `${filter} ${label}`);
      console.log(`${filter} ${label}: ${r.n} threads, slowest page ${r.worst.toFixed(2)} ms`);
    }
  }
  const counts = await warm(() => store.threads.counts(NOW));
  expect(counts.result.inboxWaiting).toEqual(expect.any(Number));
  // every count of the sidebar, the waiting one with them: within a third of a frame (Codex review 1, #9)
  expect(counts.ms, "counts with waiting").toBeLessThanOrEqual(5 * MULT);
  // a search narrowed to People or Waiting: the instant index keeps those threads before paging
  // (on a freshly built index: after the earlier tests' bulk changes the running one reported 213 MiB, over the web's
  // 192 MiB cap, and turned itself off; a fresh build of the same mailbox stays under it)
  await store.close();
  store = await IdbMailStore.open({ name, factory: indexedDB, platform, instantSearch: { sliceMs: 4 } });
  await store.whenLoaded();
  expect(await store.instant!.settled(900_000)).toBe(true);
  for (const threadFilter of ["people", "waiting"] as const) {
    for (const query of ["hola", "factura", "in:all"]) {
      const first = await timed(() => store.threads.searchText({ query, threadFilter, limit: 100, now: NOW }));
      expect(first.result.strategy, `${threadFilter} "${query}"`).not.toBe("scan");
      expect(first.result.items.every((t) => (threadFilter === "people" ? t.person : t.waitingSince != null))).toBe(true);
      expect(first.ms, `search "${query}" from ${threadFilter}: first page`).toBeLessThanOrEqual(25 * MULT);
      if (first.result.nextCursor) {
        const next = await timed(() => store.threads.searchText({ query, threadFilter, limit: 100, now: NOW, cursor: first.result.nextCursor! }));
        expect(next.ms, `search "${query}" from ${threadFilter}: next page`).toBeLessThanOrEqual(25 * MULT);
      }
    }
  }
  // the rows themselves, as a bulk change would leave them (the orders follow row changes)
  const db = (store as unknown as { db: { tx(fn: () => void): void; takeCommit(): unknown; confirm(): void; table(n: string): { all(): Iterable<Record<string, unknown>>; update(r: Record<string, unknown>, p: Record<string, unknown>): void } } }).db;
  const keep = new Map(all.map((t) => [t.id, [t.person === null ? null : +t.person, t.waitingSince] as const]));
  const rewrite = (fn: (t: Record<string, unknown>) => Record<string, unknown>) => {
    db.tx(() => {
      const threads = db.table("threads");
      for (const t of threads.all()) threads.update(t, fn(t));
    });
    db.takeCommit();
    db.confirm();
  };
  rewrite((t) => ({ person: 1, waiting_since: t.last_date }));
  await walkAll({ view: "all", filter: "people" }, "people dense", true);
  await walkAll({ view: "all", filter: "waiting" }, "waiting dense", true);
  rewrite(() => ({ person: 0, waiting_since: null }));
  await walkAll({ view: "all", filter: "people" }, "people empty");
  await walkAll({ view: "all", filter: "waiting" }, "waiting empty");
  let current = 0;
  rewrite((t) => ({ waiting_since: (t.last_date as number) >= NOW - 10 * 86_400_000 && current++ < 20 ? t.last_date : NOW - 400 * 86_400_000 }));
  const sparse = await walkAll({ view: "all", filter: "waiting" }, "waiting expired but 20");
  expect(sparse.n).toBeLessThanOrEqual(20);
  rewrite((t) => ({ person: keep.get(t.id as number)![0], waiting_since: keep.get(t.id as number)![1] }));
}, 900_000);
