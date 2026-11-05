/**
 * "Select all N": a scope archive of every thread in a view (thousands) and its
 * undo, and a whole category acted on, run in slices while a renderer keeps
 * listing, the search index following along; the event loop never stalls long
 * and lists stay fast. Acting is a slice's bound, measured at the size that holds
 * it (SLICE_MAILBOX); what a scope reads, its count and its ids, holds at 50k+.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { sqlDb, type SqlMailStore } from "@terno/db";
import { demoRegistry } from "@terno/mail";
import { afterAll, beforeAll, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { resolveThreadScope } from "./scope";
import { SLICE_MAILBOX } from "./test/slice-mailbox";
import { BUDGET_MULTIPLIER, report, type Stat } from "../../db/src/test/perf";
import { copyMailbox, LARGE_MAILBOX } from "../../db/src/test/perf-mailbox";
import { sampleAsync, settle, watchLoop, type LoopReport, type Sample } from "../../db/src/test/timing";

const NOW = Date.UTC(2026, 9, 22, 15, 30);
const stats: Stat[] = [];
let dir: string;
let backend: Backend;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "terno-scopeperf-"));
  copyMailbox(SLICE_MAILBOX, join(dir, "perf.db"));
  backend = new Backend({ dbPath: join(dir, "perf.db"), version: "perf", cipher: plaintextCipher, providers: demoRegistry, now: () => NOW, autoSync: false, instantSearch: true });
  await backend.store.ready;
  expect(await (backend.store as SqlMailStore).instant!.settled()).toBe(true);
}, 600_000);

afterAll(async () => {
  report("scope.json", "Scope actions (select all N)", { threads: SLICE_MAILBOX.dataset.threads, accounts: SLICE_MAILBOX.dataset.accounts }, stats);
  await backend.stop();
  rmSync(dir, { recursive: true, force: true });
});

const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.max(0, Math.ceil(xs.length * 0.95) - 1)] ?? 0;

/** Runs fn while sampling the event loop (max gap between 1 ms ticks) and a renderer listing its view. */
async function underLoad(fn: () => Promise<unknown>, on: Backend = backend): Promise<{ stall: number; cpu: number; list: number[]; descheduled: number }> {
  const [c, srv] = createMemoryTransportPair();
  on.connect(srv, { clientId: `load-${Math.random()}`, origin: "renderer" });
  const client = new RpcClient(c);
  const loop = watchLoop(50 * BUDGET_MULTIPLIER);
  const list: Sample[] = [];
  let done = false;
  const probe = (async () => {
    while (!done) {
      list.push(await sampleAsync(() => client.call("threads.list", { view: "inbox" })));
      await new Promise((r) => setTimeout(r, 2));
    }
  })();
  let watched: LoopReport;
  try {
    await fn();
  } finally {
    done = true;
    await probe;
    watched = loop.stop();
  }
  return { stall: watched.stall, cpu: watched.longest.cpu, list: settle(list).ms, descheduled: watched.descheduled.length };
}

it("archiving every thread of a view (thousands) and undoing it, and a category marked read: no stall over 50 ms, threads.list p95 ≤ 20 ms", async () => {
  const [c, srv] = createMemoryTransportPair();
  backend.connect(srv, { clientId: "sweep", origin: "renderer" });
  const client = new RpcClient(c);
  const db = sqlDb(backend.store);
  let result = { undoId: null as number | null, affected: 0, total: 0 };
  let inboxBefore = 0;
  const runs: [string, () => Promise<unknown>][] = [
    // first a sweep the other way, so the inbox holds well over 5,000 threads
    ["scope restore of «Archivo» to Entrada", () => client.call("threads.actScope", { scope: { kind: "view", view: "archive" }, action: "moveToInbox" })],
    [
      "scope archive of «Entrada»",
      async () => {
        inboxBefore = db.get<{ c: number }>("SELECT count(*) AS c FROM threads WHERE in_inbox = 1")!.c;
        result = await client.call("threads.actScope", { scope: { kind: "view", view: "inbox" }, action: "archive", jobId: "perf" });
      },
    ],
    ["its undo", () => client.call("threads.undo", { undoId: result.undoId! })],
    ["scope mark read of «Todo el correo»", () => client.call("threads.actScope", { scope: { kind: "view", view: "all" }, action: "markRead" })],
  ];
  const out: { name: string; stall: number; cpu: number; list: number }[] = [];
  const stage = async (name: string, fn: () => Promise<unknown>) => {
    const started = performance.now();
    const { stall, cpu, list } = await underLoad(fn);
    const took = performance.now() - started;
    out.push({ name, stall, cpu, list: p95(list) });
    stats.push({ name: `${name}: ${took.toFixed(0)} ms, max event-loop stall ${stall.toFixed(1)} ms (cpu ${cpu.toFixed(1)}), list RPC p95 ${p95(list).toFixed(1)} ms (${list.length})`, budgetMs: 50, p50: stall, p95: stall, max: stall, iterations: list.length });
    if (name.startsWith("scope archive")) {
      // dozens of slices
      expect(result.affected).toBeGreaterThanOrEqual(2000);
      expect(result.affected).toBe(inboxBefore);
      expect(db.get("SELECT count(*) AS c FROM threads WHERE in_inbox = 1")).toEqual({ c: 0 });
    }
    if (name === "its undo") expect(db.get("SELECT count(*) AS c FROM threads WHERE in_inbox = 1")).toEqual({ c: inboxBefore });
  };
  for (const [name, fn] of runs) await stage(name, fn);
  // last: filed like this, these threads leave the Inbox
  const category = (await client.call("categories.create", { name: "Todo", color: "rose" })).id;
  db.run("INSERT INTO thread_categories (thread_id, category_id, added_by, added_at) SELECT id, ?, 'user', 0 FROM threads WHERE in_trash = 0 AND in_spam = 0", category);
  const inCategory = db.get<{ c: number }>("SELECT count(*) AS c FROM thread_categories WHERE category_id = ?", category)!.c;
  let categoryTotal = 0;
  await stage("scope star of a whole category", async () => (categoryTotal = (await client.call("threads.actScope", { scope: { kind: "view", view: "all", categoryId: category }, action: "star" })).total));
  stats.push({ name: `threads archived by one scope action: ${result.affected}`, budgetMs: 0, p50: 0, p95: 0, max: 0, iterations: 1 });
  expect(categoryTotal).toBe(inCategory);
  for (const r of out) {
    expect(r.stall, `${r.name} (cpu ${r.cpu.toFixed(1)} ms of it)`).toBeLessThanOrEqual(50 * BUDGET_MULTIPLIER);
    expect(r.list, r.name).toBeLessThanOrEqual(20 * BUDGET_MULTIPLIER);
  }
}, 600_000);

it("a 50,000-thread category: counted in one indexed query, its ids read with no stall over 50 ms", async () => {
  const dir50 = mkdtempSync(join(tmpdir(), "terno-scopeperf50-"));
  copyMailbox(LARGE_MAILBOX, join(dir50, "big.db"));
  const big = new Backend({ dbPath: join(dir50, "big.db"), version: "perf", cipher: plaintextCipher, providers: demoRegistry, now: () => NOW, autoSync: false, instantSearch: false });
  try {
    await big.store.ready;
    const db = sqlDb(big.store);
    const [c, srv] = createMemoryTransportPair();
    big.connect(srv, { clientId: "big", origin: "renderer" });
    const client = new RpcClient(c);
    const cat = (await client.call("categories.create", { name: "Todo", color: "rose" })).id;
    db.run("INSERT INTO thread_categories (thread_id, category_id, added_by, added_at) SELECT id, ?, 'user', 0 FROM threads WHERE in_trash = 0 AND in_spam = 0", cat);
    const inCat = db.get<{ c: number }>("SELECT count(*) AS c FROM thread_categories WHERE category_id = ?", cat)!.c;
    expect(inCat).toBeGreaterThanOrEqual(45_000);
    const scope = { kind: "view" as const, view: "all" as const, categoryId: cat };
    const counts: number[] = [];
    for (let i = 0; i < 25; i++) {
      const t = performance.now();
      expect((await client.call("threads.scopeCount", { scope })).count).toBe(inCat);
      counts.push(performance.now() - t);
    }
    const sc = { name: `count a ${inCat}-thread category (RPC)`, budgetMs: 25, p50: [...counts].sort((a, b) => a - b)[12]!, p95: p95(counts), max: Math.max(...counts), iterations: counts.length };
    stats.push(sc);
    let ids = 0;
    const { stall, cpu, list } = await underLoad(async () => (ids = (await resolveThreadScope(big, scope)).ids.length), big);
    stats.push({ name: `read the ids of a ${inCat}-thread category: max event-loop stall ${stall.toFixed(1)} ms (cpu ${cpu.toFixed(1)}), list RPC p95 ${p95(list).toFixed(1)} ms (${list.length})`, budgetMs: 50, p50: stall, p95: stall, max: stall, iterations: list.length });
    expect(ids).toBe(inCat);
    expect(sc.p95).toBeLessThanOrEqual(25 * BUDGET_MULTIPLIER);
    expect(stall, `cpu ${cpu.toFixed(1)} ms of it`).toBeLessThanOrEqual(50 * BUDGET_MULTIPLIER);
    expect(p95(list)).toBeLessThanOrEqual(20 * BUDGET_MULTIPLIER);
  } finally {
    await big.stop();
    rmSync(dir50, { recursive: true, force: true });
  }
}, 900_000);
