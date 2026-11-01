import "fake-indexeddb/auto";
import { generateDataset } from "@terno/mock-data";
import type { FolderCountCursor, FolderExportCursor, Platform } from "@terno/store";
import { afterAll, beforeAll, expect, it } from "vitest";
import { machineBusy, sampleAsync, sampleSync, settle, watchLoop, type Sample } from "../../db/src/test/timing";
import { confirmRebuilt, countFolderMessages, rebuildFolders } from "./folders";
import { exportIds, pendingAfter, stretch } from "./folder-export";
import type { Ctx } from "./mail";
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

it("plan 107: an .mbox export's id stretches seek, never rescan: an account and a 28,000-thread folder (members in reverse) in bounded time (Codex code review #9)", async () => {
  const all = (await store.debug.snapshot()).threads;
  const account = all[0]!.accountId;
  // every thread a member, written newest id first (the index's order is the reverse of the ids')
  const c = (store as unknown as { c: { db: { tx<T>(fn: () => T): T; table(name: string): { put(row: Record<string, unknown>): unknown; deleteRow(row: Record<string, unknown>): void } } } }).c;
  const rows = [...all].sort((a, b) => b.id - a.id).map((t) => ({ thread_id: t.id, account_id: account, folder: "Export", last_date: 0, unread: 0 }));
  c.db.tx(() => rows.forEach((r) => c.db.table("thread_folders").put(r)));
  try {
    // a stretch's limit bounds threads visited and messages looked at together (Codex code review round 2 #6)
    const perThread = new Map<number, number>();
    for (const m of (await store.debug.snapshot()).messages) perThread.set(m.threadId, (perThread.get(m.threadId) ?? 0) + 1);
    const work = (threads: readonly { id: number }[]) => threads.reduce((n, t) => n + Math.max(1, perThread.get(t.id) ?? 0), 0);
    for (const [label, target, expected] of [
      ["folder", { accountId: account, folder: "Export" }, work(all)],
      ["account", { accountId: account, view: "archive" as const }, work(all.filter((t) => t.accountId === account))],
    ] as const) {
      for (const limit of [200, 5000]) {
        const samples: Sample[] = [];
        let reading = 0;
        for (let after: FolderExportCursor | null = null; ; ) {
          const s = await sampleAsync(() => store.folderExport.ids(target, after, limit));
          samples.push(s);
          if (s.result.next === null) break;
          if (s.result.next.thread < 0) reading++;
          after = s.result.next;
        }
        const pages = settle(samples).ms;
        const sorted = [...pages].sort((a, b) => a - b);
        const total = pages.reduce((a, b) => a + b, 0);
        console.log(`export ${label}, stretches of ${limit}: ${pages.length} stretches, ${total.toFixed(1)} ms in all, max ${sorted.at(-1)!.toFixed(2)} ms`);
        // a call that only read on in members whose order was still being built moves no stretch (Codex code review round 8 #5)
        expect(pages.length - reading).toBe(Math.floor(expected / limit) + 1);
        // rescanning every member per stretch cost ~12.5 million visits in stretches of 200 at 50,000
        expect(total, `${label} / ${limit}: all stretches`).toBeLessThanOrEqual(60 * MULT);
        expect(sorted.at(-1)!, `${label} / ${limit}: one stretch`).toBeLessThanOrEqual(FRAME * MULT);
      }
    }
  } finally {
    c.db.tx(() => rows.forEach((r) => c.db.table("thread_folders").deleteRow(r)));
  }
}, 900_000);

it("plan 107: while 300,000-member folders' orders are still being built, an export and a count read their members a bounded run a call, each once and in order (Codex code review round 8 #5)", () => {
  const c = (store as unknown as { c: Ctx & { db: { tx<T>(fn: () => T): T; table(name: string): { put(row: Record<string, unknown>): unknown; deleteRow(row: Record<string, unknown>): void } } } }).c;
  const account = 1;
  const N = 300_000;
  // empty threads (nothing to read in them): what's timed is the walk of the members, written in reverse
  const threads = Array.from({ length: N }, (_, i) => ({ id: 50_000_000 + N - i, account_id: account, last_date: 0, message_count: 0, unread_count: 0 }));
  // a folder each, so neither finds the other's order built
  const rows = ["Big", "Big2"].flatMap((folder) => threads.map((t) => ({ thread_id: t.id, account_id: account, folder, last_date: 0, unread: 0 })));
  c.db.tx(() => {
    threads.forEach((t) => c.db.table("threads").put(t));
    rows.forEach((r) => c.db.table("thread_folders").put(r));
  });
  try {
    for (const run of ["export", "count"] as const) {
      const samples: Sample[] = [];
      const seen: number[] = [];
      let pending = 0;
      if (run === "export") {
        // the stretches back to back, no turn between: the order's build gets no background time
        for (let after = 0; ; ) {
          let top: number[] | null = null;
          samples.push(sampleSync(() => (top = stretch(c, { accountId: account, folder: "Big" }, after, 200))));
          if (top === null) { pending++; after = pendingAfter(after); continue; }
          const got: number[] = top;
          seen.push(...got);
          if (got.length < 200) break;
          after = got.at(-1)!;
        }
        expect(seen.length).toBe(N);
        for (let i = 1; i < seen.length; i++) if (seen[i]! <= seen[i - 1]!) throw new Error(`out of order at ${i}`);
      } else {
        for (let at: FolderCountCursor | null = null; ; ) {
          let r!: { messages: number; next: FolderCountCursor | null };
          samples.push(sampleSync(() => (r = countFolderMessages(c, account, ["Big2"], at, 2000))));
          if (r.next && r.next.after[0]! < 0) pending++;
          if (!r.next) break;
          at = r.next;
        }
      }
      const ms = settle(samples).ms.sort((a, b) => a - b);
      console.log(`${run} while the order builds: ${samples.length} calls (${pending} reading members), max ${ms.at(-1)!.toFixed(2)} ms`);
      // before: the first call walked and sorted every member at once
      expect(ms.at(-1)!, `${run}: one call`).toBeLessThanOrEqual(FRAME * MULT);
      expect(pending, `${run}: read while the order was being built`).toBeGreaterThan(0);
    }
  } finally {
    c.db.tx(() => {
      rows.forEach((r) => c.db.table("thread_folders").deleteRow(r));
      threads.forEach((t) => c.db.table("threads").deleteRow(t));
    });
  }
}, 900_000);

it("an account's own folders (plan 68) page from their members: big, sparse, empty, deep, filtered, select all and counts within a frame", async () => {
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

it("relisting a populated IMAP folder (plan 68, Codex R6): every rebuild slice within a frame, the folder's order sorted once", async () => {
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

it("plan 106: an account's Mark all as read walks its Inbox's unread within a frame when every other thread is unread and it has none or ten", async () => {
  const all = (await store.debug.snapshot()).threads;
  const sparse = all[0]!.accountId;
  // Codex R4: the scope walks the unread ids testing account and place: the worst case is every other thread unread
  const wereRead = all.filter((t) => t.accountId !== sparse && t.unreadCount === 0).map((t) => t.id);
  const wereUnread = all.filter((t) => t.accountId === sparse && t.unreadCount > 0).map((t) => t.id);
  for (let i = 0; i < wereRead.length; i += 5000) await store.threads.act({ threadIds: wereRead.slice(i, i + 5000), action: "markUnread", signal: null, now: NOW });
  for (let i = 0; i < wereUnread.length; i += 5000) await store.threads.act({ threadIds: wereUnread.slice(i, i + 5000), action: "markRead", signal: null, now: NOW });
  const scope = { view: "inbox" as const, accountId: sparse, filter: "unread" as const };
  const walk = async () => {
    const ids: number[] = [];
    for (let after = 0; ; ) {
      const page = await store.threads.scopeIds({ ...scope, after, limit: 500 });
      ids.push(...page);
      if (page.length < 500) return ids;
      after = page[page.length - 1]!;
    }
  };
  const ten = all.filter((t) => t.accountId === sparse && t.inInbox).slice(0, 10).map((t) => t.id);
  try {
    const none = await warm(walk);
    const count = await warm(() => store.threads.scopeCount({ ...scope, limit: 100_001 }));
    expect(none.result).toEqual([]);
    expect(count.result).toBe(0);
    await store.threads.act({ threadIds: ten, action: "markUnread", signal: null, now: NOW });
    const some = await warm(walk);
    expect(some.result.length).toBeGreaterThan(0);
    expect(some.result.length).toBeLessThanOrEqual(10);
    console.log(`mark all read of a sparse account (${all.length - wereUnread.length} unread elsewhere): none ${none.ms.toFixed(2)} ms, count ${count.ms.toFixed(2)} ms, ten ${some.ms.toFixed(2)} ms`);
    expect(none.ms, "none unread: whole walk").toBeLessThanOrEqual(FRAME * MULT);
    expect(count.ms, "none unread: count").toBeLessThanOrEqual(FRAME * MULT);
    expect(some.ms, "ten unread: whole walk").toBeLessThanOrEqual(FRAME * MULT);
  } finally {
    await store.threads.act({ threadIds: ten, action: "markRead", signal: null, now: NOW });
    for (let i = 0; i < wereRead.length; i += 5000) await store.threads.act({ threadIds: wereRead.slice(i, i + 5000), action: "markRead", signal: null, now: NOW });
    for (let i = 0; i < wereUnread.length; i += 5000) await store.threads.act({ threadIds: wereUnread.slice(i, i + 5000), action: "markUnread", signal: null, now: NOW });
  }
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

it("cached refresh keyset traversal at 50k never stalls a frame", async () => {
  const accounts = await store.accounts.list();
  let count = 0;
  const result = await stalls(FRAME, async () => {
    for (const account of accounts) {
      let after: string | undefined;
      while (true) {
        const page = await store.providerStore(account.id).syncedMessagePage(after);
        expect(page.items.length).toBeLessThanOrEqual(50);
        count += page.items.length;
        if (!page.next) break;
        after = page.next;
      }
    }
  });
  expect(count).toBeGreaterThanOrEqual(50_000);
  expect(result.maxStall).toBeLessThanOrEqual(FRAME * MULT);
});

it("plan 83: a category hidden from the Inbox holding 95% of it: Inbox pages, unread, select all and counts within a frame, a membership change after too", async () => {
  const inbox = await store.threads.scopeIds({ view: "inbox", limit: 1_000_000 });
  const hide = inbox.filter((_, i) => i % 20 !== 0);
  const big = (await store.categories.create("Hidden big", "slate")).id;
  const small = (await store.categories.create("Hidden small", "rose")).id;
  await store.categories.add({ categoryId: big, threadIds: hide, addedBy: "filter", now: NOW });
  await store.categories.add({ categoryId: small, threadIds: inbox.filter((_, i) => i % 7 === 0), addedBy: "filter", now: NOW });
  await store.categories.update(big, { showInInbox: false });
  await store.categories.update(small, { showInInbox: false });
  try {
    const reads: Record<string, () => Promise<unknown>> = {
      "inbox page": () => store.threads.list({ view: "inbox", limit: 100 }),
      "unread page": () => store.threads.list({ view: "inbox", filter: "unread", limit: 100 }),
      counts: () => store.threads.counts(NOW),
      "select all": () => store.threads.scopeCount({ view: "inbox", limit: 1_000_000 }),
    };
    for (const [label, read] of Object.entries(reads)) {
      const r = await warm(read);
      // a membership changes (Codex review: it used to make the next read rebuild a hidden category's member list)
      await store.categories.add({ categoryId: big, threadIds: [inbox[0]!], addedBy: "filter", now: NOW });
      await store.categories.remove({ categoryId: big, threadIds: [inbox[0]!], reason: "undo", now: NOW });
      const after = await timed(read);
      console.log(`hidden 95%: ${label} ${r.ms.toFixed(1)} ms, after a membership change ${after.ms.toFixed(1)} ms`);
      expect(r.ms, label).toBeLessThanOrEqual(FRAME * MULT);
      expect(after.ms, `${label} after a membership change`).toBeLessThanOrEqual(FRAME * MULT);
    }
  } finally {
    await store.categories.delete(big);
    await store.categories.delete(small);
  }
}, 900_000);

it("plan 107: a renamed folder's threads carried to its new key a slice at a time: every slice within a frame, the whole folder once (Codex code review round 3 #5)", async () => {
  const all = (await store.debug.snapshot()).threads;
  const byAccount = new Map<number, number>();
  for (const t of all) if (!t.inTrash && !t.inSpam) byAccount.set(t.accountId, (byAccount.get(t.accountId) ?? 0) + 1);
  const [account, size] = [...byAccount].sort((a, b) => b[1] - a[1])[0]!;
  const messages = (await store.debug.snapshot()).messages.filter((m) => m.accountId === account);
  for (let i = 0; i < messages.length; i += 2000) {
    await store.sync.updateFlags(account, messages.slice(i, i + 2000).map((m) => ({ messageId: m.id, flags: {}, gmailLabels: ["Label_carry"] })));
  }
  await store.folders.replace(account, [...(await store.folders.list()).filter((f) => f.accountId === account).map(({ key, path, selectable }) => ({ key, path, selectable })), { key: "Label_carry", path: ["Carry"], selectable: true }]);
  const slices: Sample[] = [];
  for (let after: number | null = 0; after !== null; ) {
    const from: number = after;
    const s = await sampleAsync(() => store.folders.carry(account, "Label_carry", "Label_carried", from, 500));
    slices.push(s);
    after = s.result.next;
  }
  const ms = settle(slices).ms;
  const total = ms.reduce((a, b) => a + b, 0);
  console.log(`carry of ${size} threads: ${slices.length} slices, ${total.toFixed(1)} ms in all, max ${Math.max(...ms).toFixed(2)} ms`);
  expect(slices.length).toBe(Math.floor(size / 500) + 1);
  expect(Math.max(...ms), "one slice").toBeLessThanOrEqual(FRAME * MULT);
  // one pass over the folder in all, linear in its threads (a full scan and sort per slice grew with the folder)
  expect(total / size, "per thread").toBeLessThanOrEqual(0.03 * MULT);
  // what it left under the carried key cleared before another rename's carry, a slice at a time (Codex code review round 14 #2)
  const cleared: Sample[] = [];
  for (let more = true; more; ) {
    const s = await sampleAsync(() => store.folders.clear(account, "Label_carried", 500));
    cleared.push(s);
    more = s.result.more;
  }
  const clearMs = settle(cleared).ms;
  console.log(`clear of ${size} rows: ${cleared.length} slices, max ${Math.max(...clearMs).toFixed(2)} ms`);
  expect(cleared.length).toBe(Math.floor(size / 500) + 1);
  expect(Math.max(...clearMs), "one clear slice").toBeLessThanOrEqual(FRAME * MULT);
}, 900_000);

it("plan 107: a delete's count over 100 overlapping sublabels on one 50,000-message conversation: each slice within a frame, each message looked at once (Codex code review round 4 #3)", async () => {
  type Table = { all(): Iterable<Record<string, unknown>>; get(id: unknown): Record<string, unknown> | undefined; allocateId(): number; put(row: Record<string, unknown>): unknown; deleteRow(row: Record<string, unknown>): void };
  const c = (store as unknown as { c: { db: { tx<T>(fn: () => T): T; table(name: string): Table } } }).c;
  const [messagesT, threadsT, membershipsT] = [c.db.table("messages"), c.db.table("threads"), c.db.table("thread_folders")];
  const keys = Array.from({ length: 100 }, (_, i) => `Label_p107_${i}`);
  const seed = [...messagesT.all()].find((m) => !m.is_trash && !m.is_spam)!;
  // a copy of its thread, then 50,000 copies of the message in it, every one in all 100 (ingesting a 50,000-message
  // reply chain is minutes)
  const n = 50_000;
  const thread = { ...threadsT.get(seed.thread_id)!, id: threadsT.allocateId(), provider_thread_id: "p107-count" };
  const copies = Array.from({ length: n }, (_, i) => ({ ...seed, id: messagesT.allocateId(), thread_id: thread.id, provider_msg_id: `p107-count-${i}`, rfc_message_id: null, gmail_labels: JSON.stringify(keys) }));
  const rows = keys.map((folder) => ({ thread_id: thread.id, account_id: seed.account_id, folder, last_date: 0, unread: 0 }));
  c.db.tx(() => { threadsT.put(thread); copies.forEach((m) => messagesT.put(m)); rows.forEach((r) => membershipsT.put(r)); });
  try {
    const limit = 1000;
    type Counted = Awaited<ReturnType<typeof store.folders.count>>;
    const slices: (Sample & { result: Counted })[] = [];
    let counted = 0;
    for (let after: Parameters<typeof store.folders.count>[2] = null; ; ) {
      const from = after;
      const s: Sample & { result: Counted } = await sampleAsync(() => store.folders.count(seed.account_id as number, keys, from, limit));
      slices.push(s);
      counted += s.result.messages;
      if (!s.result.next) break;
      after = s.result.next;
    }
    const ms = settle(slices).ms;
    const total = ms.reduce((a, b) => a + b, 0);
    console.log(`count over 100 sublabels of ${n}: ${slices.length} slices, ${total.toFixed(1)} ms in all, max ${Math.max(...ms).toFixed(2)} ms`);
    expect(Math.max(...ms), `one slice (${slices.length} slices, ${total.toFixed(1)} ms in all)`).toBeLessThanOrEqual(FRAME * MULT);
    expect(counted).toBe(n);
    // the conversation once (100 reads of it were five million visits), a slice of rows at a time
    expect(slices.length).toBeLessThanOrEqual(Math.ceil((n + 2 * keys.length) / limit) + keys.length + 2);
  } finally {
    c.db.tx(() => { rows.forEach((r) => membershipsT.deleteRow(r)); copies.forEach((m) => messagesT.deleteRow(m)); threadsT.deleteRow(thread); });
  }
}, 900_000);

it("plan 107: a delete's count over a 50,000-location mailbox walks it once across its slices, never again each slice (Codex code review round 5 #4)", async () => {
  type Table = { all(): Iterable<Record<string, unknown>>; get(id: unknown): Record<string, unknown> | undefined; allocateId(): number; put(row: Record<string, unknown>): unknown; deleteRow(row: Record<string, unknown>): void };
  const c = (store as unknown as { c: { db: { tx<T>(fn: () => T): T; table(name: string): Table } } }).c;
  const mem = c as unknown as Parameters<typeof countFolderMessages>[0];
  const [messagesT, threadsT, locationsT] = [c.db.table("messages"), c.db.table("threads"), c.db.table("message_locations")];
  const seed = [...messagesT.all()].find((m) => !m.is_trash && !m.is_spam)!;
  const account = seed.account_id as number;
  // 50,000 messages (copies, in a thread of their own) each placed in the mailbox, written straight into the tables
  const n = 50_000;
  const thread = { ...threadsT.get(seed.thread_id)!, id: threadsT.allocateId(), provider_thread_id: "p107-places" };
  const copies = Array.from({ length: n }, (_, i) => ({ ...seed, id: messagesT.allocateId(), thread_id: thread.id, provider_msg_id: `p107-places-${i}`, rfc_message_id: null }));
  const rows = copies.map((m, i) => ({ message_id: m.id, account_id: account, mailbox: "P107Places", uidvalidity: 1, uid: i + 1, flags: "[]" }));
  c.db.tx(() => { threadsT.put(thread); copies.forEach((m) => messagesT.put(m)); rows.forEach((r) => locationsT.put(r)); });
  try {
    const slices: Sample[] = [];
    let counted = 0;
    for (let after: Parameters<typeof countFolderMessages>[3] = null; ; ) {
      const from = after;
      let r!: ReturnType<typeof countFolderMessages>;
      slices.push(sampleSync(() => (r = countFolderMessages(mem, account, ["P107Places"], from, 100))));
      counted += r.messages;
      if (!r.next) break;
      after = r.next;
    }
    const ms = settle(slices).ms;
    const total = ms.reduce((a, b) => a + b, 0);
    console.log(`count of ${n} places: ${slices.length} slices, ${total.toFixed(1)} ms in all, max ${Math.max(...ms).toFixed(2)} ms`);
    expect(counted).toBe(n);
    expect(slices.length).toBeLessThanOrEqual(Math.ceil(n / 100) + 2);
    // the mailbox once in all (each slice walking and sorting all of it was 50,000 visits a slice)
    expect(total / n, `per place (${total.toFixed(1)} ms in all)`).toBeLessThanOrEqual(0.005 * MULT);
  } finally {
    c.db.tx(() => { rows.forEach((r) => locationsT.deleteRow(r)); copies.forEach((m) => messagesT.deleteRow(m)); threadsT.deleteRow(thread); });
  }
}, 900_000);

it("plan 107: a standard view's export for an account beside another's 1,000,000 threads walks them a bounded stretch a call (Codex code review round 9 #3)", async () => {
  // a store of its own: a million rows written and let go would leave the shared one's writes behind for the others
  const own = await IdbMailStore.open({ name: `${name}-view-export`, factory: indexedDB, platform, instantSearch: false });
  try {
    const c = (own as unknown as { c: Ctx & { db: { tx<T>(fn: () => T): T; table(name: string): { put(row: Record<string, unknown>): unknown } } } }).c;
    const { account } = await own.accounts.create({ kind: "gmail", email: "big@example.com", displayName: "Big", color: "indigo", now: 0 });
    const { account: empty } = await own.accounts.create({ kind: "gmail", email: "empty@example.com", displayName: "Empty", color: "indigo", now: 0 });
    const N = 1_000_000;
    c.db.tx(() => { for (let i = 0; i < N; i++) c.db.table("threads").put({ id: 60_000_000 + i, account_id: account.id, last_date: 0, message_count: 0, unread_count: 0 }); });
    const samples: Sample[] = [];
    // an account with nothing here: none of the threads walked is its
    let after: FolderExportCursor | null = null;
    let calls = 0;
    for (;;) {
      let r!: ReturnType<typeof exportIds>;
      samples.push(sampleSync(() => (r = exportIds(c, { accountId: empty.id, view: "inbox" }, after, 1000))));
      calls++;
      expect(r.messages).toEqual([]);
      if (!r.next) break;
      after = r.next;
    }
    const ms = settle(samples).ms.sort((a, b) => a - b);
    console.log(`an empty account's Inbox export beside ${N} threads: ${calls} calls, max ${ms.at(-1)!.toFixed(2)} ms`);
    // before: one call walked every thread (~57 ms); now it reads only its own account's threads (round 13 #2)
    expect(calls).toBe(1);
    expect(ms.at(-1)!).toBeLessThanOrEqual(FRAME * MULT);
  } finally {
    await own.close();
  }
}, 900_000);

it("plan 107: a standard view's export of a 1,000,000-thread account reads its threads a bounded run a call, from a store just opened and after arrivals (Codex code review round 13 #2)", async () => {
  // a store of its own: a million rows written and let go would leave the shared one's writes behind for the others
  const own = await IdbMailStore.open({ name: `${name}-view-cold`, factory: indexedDB, platform, instantSearch: false });
  try {
    const c = (own as unknown as { c: Ctx & { db: { tx<T>(fn: () => T): T; table(name: string): { put(row: Record<string, unknown>): unknown } } } }).c;
    const { account } = await own.accounts.create({ kind: "gmail", email: "many@example.com", displayName: "Many", color: "indigo", now: 0 });
    const N = 1_000_000;
    const ARRIVALS = 100;
    // empty threads, written in reverse (the index holds them newest first): what's timed is the walk of the account's threads
    const put = (from: number, n: number) => c.db.tx(() => { for (let i = n - 1; i >= 0; i--) c.db.table("threads").put({ id: from + i, account_id: account.id, last_date: 0, message_count: 0, unread_count: 0 }); });
    put(90_000_000, N);
    const limit = 2000;
    const exportAll = (label: string, expected: number) => {
      const samples: Sample[] = [];
      let pending = 0;
      for (let after: FolderExportCursor | null = null; ; ) {
        let r!: ReturnType<typeof exportIds>;
        const from = after;
        samples.push(sampleSync(() => (r = exportIds(c, { accountId: account.id, view: "inbox" }, from, limit))));
        if (!r.next) break;
        if (r.next.thread < 0) pending++;
        after = r.next;
      }
      const ms = settle(samples).ms.sort((a, b) => a - b);
      console.log(`Inbox export of ${expected} threads, ${label}: ${samples.length} calls (${pending} reading), max ${ms.at(-1)!.toFixed(2)} ms`);
      // every thread visited once, in stretches of `limit`
      expect(samples.length - pending, `${label}: stretches`).toBe(Math.floor(expected / limit) + 1);
      // before: the first call collected and sorted every thread of the store (~100 ms at a million)
      expect(ms.at(-1)!, `${label}: one call`).toBeLessThanOrEqual(FRAME * MULT);
    };
    // nothing has read the store's threads since it opened
    exportAll("cold", N);
    // new mail: threads in, every kept order of the store's threads let go
    put(90_000_000 + N, ARRIVALS);
    exportAll("after arrivals", N + ARRIVALS);
  } finally {
    await own.close();
  }
}, 900_000);

it("plan 107: a standard view's export whose account's threads go between its calls looks at a bounded stretch of the gone ones a call (Codex code review round 15 #3)", async () => {
  // a store of its own: a million rows written and let go would leave the shared one's writes behind for the others
  const own = await IdbMailStore.open({ name: `${name}-view-gone`, factory: indexedDB, platform, instantSearch: false });
  try {
    const c = (own as unknown as { c: Ctx & { db: { tx<T>(fn: () => T): T; table(name: string): { put(row: Record<string, unknown>): unknown; delete(id: number): unknown } } } }).c;
    const { account } = await own.accounts.create({ kind: "gmail", email: "gone@example.com", displayName: "Gone", color: "indigo", now: 0 });
    const N = 1_000_000;
    const first = 95_000_000;
    c.db.tx(() => { for (let i = N - 1; i >= 0; i--) c.db.table("threads").put({ id: first + i, account_id: account.id, last_date: 0, message_count: 0, unread_count: 0 }); });
    const limit = 2000;
    const samples: Sample[] = [];
    let stretches = 0;
    let deleted = false;
    for (let after: FolderExportCursor | null = null; ; ) {
      let r!: ReturnType<typeof exportIds>;
      const from = after;
      samples.push(sampleSync(() => (r = exportIds(c, { accountId: account.id, view: "inbox" }, from, limit))));
      if (!r.next) break;
      after = r.next;
      if (r.next.thread < 0 || deleted) continue;
      // the first stretch is out: the account's mail goes before the next call, its runs still kept
      stretches++;
      deleted = true;
      c.db.tx(() => { for (let i = 0; i < N; i++) c.db.table("threads").delete(first + i); });
    }
    expect(stretches).toBe(1);
    const ms = settle(samples).ms.sort((a, b) => a - b);
    console.log(`Inbox export of ${N} threads gone after its first stretch: ${samples.length} calls, max ${ms.at(-1)!.toFixed(2)} ms`);
    // before: the call after the deletion looked at every gone id (~1,000,000) in one go
    expect(ms.at(-1)!).toBeLessThanOrEqual(FRAME * MULT);
  } finally {
    await own.close();
  }
}, 900_000);

it("plan 107: an export and a count of a 1,000,000-message conversation read it a bounded stretch a call, its order kept across them and read again when it changes (Codex code review round 10 #3)", async () => {
  // a store of its own: a million rows written and let go would leave the shared one's writes behind for the others
  const own = await IdbMailStore.open({ name: `${name}-long-thread`, factory: indexedDB, platform, instantSearch: false });
  try {
    const c = (own as unknown as { c: Ctx & { db: { tx<T>(fn: () => T): T; table(name: string): { put(row: Record<string, unknown>): unknown } } } }).c;
    const { account } = await own.accounts.create({ kind: "gmail", email: "long@example.com", displayName: "Long", color: "indigo", now: 0 });
    const N = 1_000_000;
    const thread = 70_000_000;
    // written in reverse: the index holds them newest first, so nothing's in order by luck
    const message = (id: number) => ({ id, account_id: account.id, thread_id: thread, provider_msg_id: `long-${id}`, date: id, is_draft: 0, is_trash: 0, is_spam: 0, gmail_labels: '["Label_long"]' });
    c.db.tx(() => {
      c.db.table("threads").put({ id: thread, account_id: account.id, last_date: 0, message_count: N, unread_count: 0 });
      c.db.table("thread_folders").put({ thread_id: thread, account_id: account.id, folder: "Label_long", last_date: 0, unread: 0 });
      for (let i = N; i >= 1; i--) c.db.table("messages").put(message(80_000_000 + i));
    });
    const limit = 2000;
    // the export, with a message added to the conversation halfway: its order is read again, and the new one comes
    const samples: Sample[] = [];
    const seen: number[] = [];
    let added = false;
    for (let after: FolderExportCursor | null = null; ; ) {
      let r!: ReturnType<typeof exportIds>;
      const from = after;
      samples.push(sampleSync(() => (r = exportIds(c, { accountId: account.id, folder: "Label_long" }, from, limit))));
      for (const m of r.messages) seen.push(m.id);
      if (!r.next) break;
      after = r.next;
      if (!added && seen.length >= N / 2) { added = true; c.db.tx(() => c.db.table("messages").put(message(80_000_000 + N + 1))); }
    }
    expect(seen.length).toBe(N + 1);
    for (let i = 1; i < seen.length; i++) if (seen[i]! <= seen[i - 1]!) throw new Error(`out of order at ${i}`);
    // the count
    const counts: Sample[] = [];
    let counted = 0;
    for (let at: FolderCountCursor | null = null; ; ) {
      let r!: ReturnType<typeof countFolderMessages>;
      const from = at;
      counts.push(sampleSync(() => (r = countFolderMessages(c, account.id, ["Label_long"], from, limit))));
      counted += r.messages;
      if (!r.next) break;
      at = r.next;
    }
    expect(counted).toBe(N + 1);
    for (const [run, s] of [["export", samples], ["count", counts]] as const) {
      const ms = settle(s).ms.sort((a, b) => a - b);
      const total = ms.reduce((a, b) => a + b, 0);
      console.log(`${run} of a ${N}-message conversation: ${s.length} calls, ${total.toFixed(1)} ms in all, max ${ms.at(-1)!.toFixed(2)} ms`);
      // before: every call read and sorted all of it (~55 ms a call)
      expect(ms.at(-1)!, `${run}: one call`).toBeLessThanOrEqual(FRAME * MULT);
      expect(s.length, `${run}: calls`).toBeLessThanOrEqual(Math.ceil((N + 1) / limit) + 2 * Math.ceil((N + 1) / 16_384) + 4);
    }
  } finally {
    await own.close();
  }
}, 900_000);
