/**
 * "Select all N" on the 50k-message perf mailbox: a scope archive of every
 * thread in a view (thousands) and its undo run in slices while a renderer
 * keeps listing; the event loop never stalls long and lists stay fast.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@unica/core/rpc";
import { seedDataset, sqlDb, type SqlMailStore } from "@unica/db";
import { demoRegistry } from "@unica/mail";
import { generateDataset } from "@unica/mock-data";
import { afterAll, beforeAll, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { BUDGET_MULTIPLIER, report, type Stat } from "../../db/src/test/perf";

const NOW = Date.UTC(2026, 9, 22, 15, 30);
const stats: Stat[] = [];
let dir: string;
let backend: Backend;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "unica-scopeperf-"));
  backend = new Backend({ dbPath: join(dir, "perf.db"), version: "perf", cipher: plaintextCipher, providers: demoRegistry, now: () => NOW, autoSync: false, instantSearch: true });
  seedDataset(sqlDb(backend.store), generateDataset({ threads: 20_000, accounts: 8, seed: 5, now: NOW, bodyScale: 3 }), { now: NOW });
  // the seed leaves a WAL of hundreds of MB that a running app, checkpointing all along, never has
  sqlDb(backend.store).exec("PRAGMA wal_checkpoint(TRUNCATE)");
  expect(await (backend.store as SqlMailStore).instant!.settled()).toBe(true);
}, 600_000);

afterAll(async () => {
  report("scope.json", "Scope actions (select all N)", { threads: 20_000, accounts: 8 }, stats);
  await backend.stop();
  rmSync(dir, { recursive: true, force: true });
});

const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.max(0, Math.ceil(xs.length * 0.95) - 1)] ?? 0;

/** Runs fn while sampling the event loop (max gap between 1 ms ticks) and a renderer listing its view. */
async function underLoad(fn: () => Promise<unknown>, on: Backend = backend): Promise<{ stall: number; list: number[] }> {
  const [c, srv] = createMemoryTransportPair();
  on.connect(srv, { clientId: `load-${Math.random()}`, origin: "renderer" });
  const client = new RpcClient(c);
  let last = performance.now();
  let lastElu = performance.eventLoopUtilization();
  let stall = 0;
  // a stall is time the loop was busy (computing or blocked), not an idle loop whose timer the OS fired late
  const tick = setInterval(() => {
    const now = performance.now();
    const elu = performance.eventLoopUtilization();
    stall = Math.max(stall, Math.min(now - last, performance.eventLoopUtilization(elu, lastElu).active));
    last = now;
    lastElu = elu;
  }, 1);
  const list: number[] = [];
  let done = false;
  const probe = (async () => {
    while (!done) {
      const t = performance.now();
      await client.call("threads.list", { view: "inbox" });
      list.push(performance.now() - t);
      await new Promise((r) => setTimeout(r, 2));
    }
  })();
  try {
    await fn();
  } finally {
    done = true;
    await probe;
    await new Promise((r) => setTimeout(r, 5));
    clearInterval(tick);
  }
  return { stall, list };
}

it("archiving every thread of a view (≥ 5,000) and undoing it: no stall over 50 ms, threads.list p95 ≤ 20 ms", async () => {
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
  const out: { name: string; stall: number; list: number }[] = [];
  for (const [name, fn] of runs) {
    const started = performance.now();
    const { stall, list } = await underLoad(fn);
    const took = performance.now() - started;
    out.push({ name, stall, list: p95(list) });
    stats.push({ name: `${name}: ${took.toFixed(0)} ms, max event-loop stall ${stall.toFixed(1)} ms, list RPC p95 ${p95(list).toFixed(1)} ms (${list.length})`, budgetMs: 50, p50: stall, p95: stall, max: stall, iterations: list.length });
    if (name.startsWith("scope archive")) {
      expect(result.affected).toBeGreaterThanOrEqual(5000);
      expect(result.affected).toBe(inboxBefore);
      expect(db.get("SELECT count(*) AS c FROM threads WHERE in_inbox = 1")).toEqual({ c: 0 });
    }
    if (name === "its undo") expect(db.get("SELECT count(*) AS c FROM threads WHERE in_inbox = 1")).toEqual({ c: inboxBefore });
  }
  stats.push({ name: `threads archived by one scope action: ${result.affected}`, budgetMs: 0, p50: 0, p95: 0, max: 0, iterations: 1 });
  for (const r of out) {
    expect(r.stall, r.name).toBeLessThanOrEqual(50 * BUDGET_MULTIPLIER);
    expect(r.list, r.name).toBeLessThanOrEqual(20 * BUDGET_MULTIPLIER);
  }
}, 600_000);

it("a 50,000-thread category: counted in one indexed query, acted on with no stall over 50 ms", async () => {
  const dir50 = mkdtempSync(join(tmpdir(), "unica-scopeperf50-"));
  const big = new Backend({ dbPath: join(dir50, "big.db"), version: "perf", cipher: plaintextCipher, providers: demoRegistry, now: () => NOW, autoSync: false, instantSearch: false });
  try {
    const db = sqlDb(big.store);
    seedDataset(db, generateDataset({ threads: 50_000, accounts: 8, seed: 9, now: NOW, bodyScale: 0.2 }), { now: NOW });
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.run("INSERT INTO categories (name, color, position) VALUES ('Todo', 'rose', 99)");
    const cat = db.get<{ id: number }>("SELECT id FROM categories WHERE name = 'Todo'")!.id;
    db.run("INSERT INTO thread_categories (thread_id, category_id, added_by, added_at) SELECT id, ?, 'user', 0 FROM threads WHERE in_trash = 0 AND in_spam = 0", cat);
    const inCat = db.get<{ c: number }>("SELECT count(*) AS c FROM thread_categories WHERE category_id = ?", cat)!.c;
    expect(inCat).toBeGreaterThanOrEqual(45_000);
    const [c, srv] = createMemoryTransportPair();
    big.connect(srv, { clientId: "big", origin: "renderer" });
    const client = new RpcClient(c);
    const scope = { kind: "view" as const, view: "all" as const, categoryId: cat };
    const counts: number[] = [];
    for (let i = 0; i < 25; i++) {
      const t = performance.now();
      expect((await client.call("threads.scopeCount", { scope })).count).toBe(inCat);
      counts.push(performance.now() - t);
    }
    const sc = { name: `count a ${inCat}-thread category (RPC)`, budgetMs: 25, p50: [...counts].sort((a, b) => a - b)[12]!, p95: p95(counts), max: Math.max(...counts), iterations: counts.length };
    stats.push(sc);
    let result = { total: 0 };
    const { stall, list } = await underLoad(async () => (result = await client.call("threads.actScope", { scope, action: "markRead" })), big);
    stats.push({ name: `mark read a ${inCat}-thread category: max event-loop stall ${stall.toFixed(1)} ms, list RPC p95 ${p95(list).toFixed(1)} ms (${list.length})`, budgetMs: 50, p50: stall, p95: stall, max: stall, iterations: list.length });
    expect(result.total).toBe(inCat);
    expect(sc.p95).toBeLessThanOrEqual(25 * BUDGET_MULTIPLIER);
    expect(stall).toBeLessThanOrEqual(50 * BUDGET_MULTIPLIER);
    expect(p95(list)).toBeLessThanOrEqual(20 * BUDGET_MULTIPLIER);
  } finally {
    await big.stop();
    rmSync(dir50, { recursive: true, force: true });
  }
}, 900_000);
