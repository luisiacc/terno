/**
 * Bulk work on a loaded machine: every store command the sliced paths run
 * burns twice its CPU time and waits 2–8 ms more (a slow fsync), while two
 * worker threads spin beside it. Slices must size themselves to the time
 * they actually take, so the event loop still never stalls past 50 ms and
 * lists keep flowing.
 *
 * A stall is a gap between two 1 ms ticks. It is held by the backend when
 * the event-loop thread was computing through it (its CPU time over the gap,
 * the injected slowdown included); a gap the thread spent waiting (a page
 * fault or a write the OS held, near-zero CPU) is reported, not gated: no
 * slice size can avoid it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import { createMemoryTransportPair, RpcClient } from "@unica/core/rpc";
import { seedDataset, sqlDb } from "@unica/db";
import { demoRegistry } from "@unica/mail";
import { generateDataset } from "@unica/mock-data";
import { afterAll, beforeAll, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { BUDGET_MULTIPLIER, report, type Stat } from "../../db/src/test/perf";

const NOW = Date.UTC(2026, 9, 22, 15, 30);
/** each slowed command burns this many times its own CPU time (I/O waits aren't multiplied)… */
const SLOWDOWN = 2;
/** …and then waits this long, like a commit on a busy disk */
const LATENCY_MS = [2, 8] as const;
const stats: Stat[] = [];
/** the longest single store command of the stage being measured (what a stall was, if one happens) */
let longest = { name: "", ms: 0 };
/** the longest garbage collection pause of the stage */
let longestGc = 0;
new PerformanceObserver((list) => {
  for (const e of list.getEntries()) longestGc = Math.max(longestGc, e.duration);
}).observe({ entryTypes: ["gc"] });
let dir: string;
let backend: Backend;
let client: RpcClient;
let workers: Worker[] = [];

/** Makes store commands slow, synchronously, as a slow disk or a busy CPU would (they block the loop). */
function slowDown(target: Record<string, unknown>, names: string[]) {
  for (const name of names) {
    const orig = target[name] as (...a: unknown[]) => Promise<unknown>;
    target[name] = async (...args: unknown[]) => {
      const t = performance.now();
      const cpu = process.threadCpuUsage();
      const r = await orig.apply(target, args);
      const used = process.threadCpuUsage(cpu);
      const end = performance.now() + ((used.user + used.system) / 1000) * (SLOWDOWN - 1) + LATENCY_MS[0] + Math.random() * (LATENCY_MS[1] - LATENCY_MS[0]);
      while (performance.now() < end) {
        /* the machine is busy */
      }
      const n = (args.find((a) => Array.isArray(a)) as unknown[] | undefined)?.length;
      if (performance.now() - t > longest.ms) longest = { name: `${name}${n === undefined ? "" : `(${n})`}, cpu ${((used.user + used.system) / 1000).toFixed(1)} ms`, ms: performance.now() - t };
      return r;
    };
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "unica-loadperf-"));
  backend = new Backend({ dbPath: join(dir, "load.db"), version: "perf", cipher: plaintextCipher, providers: demoRegistry, now: () => NOW, autoSync: false, instantSearch: false });
  seedDataset(sqlDb(backend.store), generateDataset({ threads: 20_000, accounts: 8, seed: 5, now: NOW, bodyScale: 3 }), { now: NOW });
  await backend.ready;
  // the seed leaves a WAL of hundreds of MB that a running app, checkpointing all along, never has
  sqlDb(backend.store).exec("PRAGMA wal_checkpoint(TRUNCATE)");
  await backend.categorizer.rebuildNow();
  slowDown(backend.store.threads as unknown as Record<string, unknown>, ["act", "restore", "scopeIds", "scopeCount"]);
  slowDown(backend.store.categories as unknown as Record<string, unknown>, ["add", "beginMove", "applyMoveSlice", "trainMoveSlice", "undoMoveBegin", "undoMoveSlice", "restoreMoveSlice", "undoBatchPart"]);
  const [c, srv] = createMemoryTransportPair();
  backend.connect(srv, { clientId: "load", origin: "renderer" });
  client = new RpcClient(c);
  // CPU contention beside the backend; the slowdown above is what slices must adapt to (oversubscribing every core
  // would measure the OS scheduler's preemption, which no slice size can avoid)
  workers = Array.from({ length: Number(process.env.LOAD_WORKERS ?? 2) }, () => new Worker("for (;;) Math.sqrt(Math.random());", { eval: true }));
}, 600_000);

afterAll(async () => {
  await Promise.all(workers.map((w) => w.terminate()));
  report("load.json", `Bulk work under load (commands ×${SLOWDOWN} CPU + ${LATENCY_MS[0]}–${LATENCY_MS[1]} ms, ${workers.length} busy workers)`, { threads: 20_000, accounts: 8 }, stats);
  await backend.stop();
  rmSync(dir, { recursive: true, force: true });
});

const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.max(0, Math.ceil(xs.length * 0.95) - 1)] ?? 0;

async function underLoad(name: string, fn: () => Promise<unknown>) {
  const [c, srv] = createMemoryTransportPair();
  backend.connect(srv, { clientId: `probe-${Math.random()}`, origin: "renderer" });
  const probe = new RpcClient(c);
  let last = performance.now();
  let lastCpu = process.threadCpuUsage();
  let stall = 0;
  let held = 0;
  let waits = 0;
  const tick = setInterval(() => {
    const now = performance.now();
    const cpu = process.threadCpuUsage();
    const gap = now - last;
    const busy = (cpu.user - lastCpu.user + cpu.system - lastCpu.system) / 1000;
    stall = Math.max(stall, gap);
    held = Math.max(held, Math.min(gap, busy));
    if (gap > 50 && busy < gap / 2) waits++;
    last = now;
    lastCpu = cpu;
  }, 1);
  const list: number[] = [];
  let done = false;
  const lister = (async () => {
    while (!done) {
      const t = performance.now();
      await probe.call("threads.list", { view: "inbox" });
      list.push(performance.now() - t);
      await new Promise((r) => setTimeout(r, 2));
    }
  })();
  const started = performance.now();
  longest = { name: "", ms: 0 };
  longestGc = 0;
  try {
    await fn();
  } finally {
    done = true;
    await lister;
    await new Promise((r) => setTimeout(r, 5));
    clearInterval(tick);
  }
  const took = performance.now() - started;
  stats.push({
    name: `${name}: ${took.toFixed(0)} ms, longest stall held by the backend ${held.toFixed(1)} ms (wall ${stall.toFixed(1)} ms, ${waits} OS waits > 50 ms), list RPC p95 ${p95(list).toFixed(1)} ms (${list.length}); longest command ${longest.ms.toFixed(0)} ms: ${longest.name}; longest GC ${longestGc.toFixed(0)} ms`,
    budgetMs: 50,
    p50: held,
    p95: held,
    max: held,
    iterations: list.length,
  });
  expect(held, name).toBeLessThanOrEqual(50 * BUDGET_MULTIPLIER);
  expect(p95(list), name).toBeLessThanOrEqual(20 * BUDGET_MULTIPLIER);
}

it("a scope mark-read of an 18,000-thread category, and its undo", async () => {
  const db = sqlDb(backend.store);
  const cat = (await client.call("categories.create", { name: "Todo", color: "rose" })).id;
  db.run("INSERT INTO thread_categories (thread_id, category_id, added_by, added_at) SELECT id, ?, 'user', 0 FROM threads WHERE in_trash = 0 AND in_spam = 0", cat);
  const scope = { kind: "view" as const, view: "all" as const, categoryId: cat };
  let undoId: number | null = null;
  await underLoad("scope mark read of a category", async () => (undoId = (await client.call("threads.actScope", { scope, action: "markRead" })).undoId));
  await underLoad("its undo", () => client.call("threads.undo", { undoId: undoId! }));
  await client.call("categories.delete", { id: cat });
}, 600_000);

it("a scope archive of every thread, and its undo", async () => {
  let undoId: number | null = null;
  await underLoad("scope archive of «Todo el correo»", async () => (undoId = (await client.call("threads.actScope", { scope: { kind: "view", view: "all" }, action: "archive" })).undoId));
  await underLoad("its undo", () => client.call("threads.undo", { undoId: undoId! }));
}, 600_000);

it("an exclusive move of 5,000 threads filed in 20 categories each, and its undo", async () => {
  const db = sqlDb(backend.store);
  const sources: number[] = [];
  for (let k = 0; k < 20; k++) sources.push((await client.call("categories.create", { name: `Origen ${k}`, color: "slate" })).id);
  const to = (await client.call("categories.create", { name: "Destino", color: "cyan" })).id;
  const ids = db.all<{ id: number }>("SELECT id FROM threads WHERE in_trash = 0 AND in_spam = 0 ORDER BY id LIMIT 5000").map((r) => r.id);
  db.exec("BEGIN");
  for (const cat of sources) db.run("INSERT OR IGNORE INTO thread_categories (thread_id, category_id, added_by, added_at) SELECT value, ?, 'user', 1 FROM json_each(?)", cat, JSON.stringify(ids));
  db.exec("COMMIT");
  let batchId = 0;
  await underLoad("move 5,000 threads × 20 categories", async () => (batchId = (await client.call("categories.moveThreads", { to, threadIds: ids, source: "dnd" })).batchId));
  expect(db.get("SELECT count(*) AS c FROM thread_categories WHERE category_id = ?", to)).toEqual({ c: 5000 });
  await underLoad("its undo", () => client.call("categorize.undo", { batchId }));
  expect(db.get(`SELECT count(*) AS c FROM thread_categories WHERE category_id IN (${sources.join(",")})`)).toEqual({ c: 100_000 });
  for (const cat of [...sources, to]) await client.call("categories.delete", { id: cat });
}, 600_000);

it("filing every thread of a view into a category (select all N), and its undo", async () => {
  const cat = (await client.call("categories.create", { name: "Selección", color: "lime" })).id;
  let batchId: number | null = null;
  await underLoad("a scope into a category", async () => (batchId = (await client.call("categories.addScope", { categoryId: cat, scope: { kind: "view", view: "all" } })).batchId));
  await underLoad("its undo", () => client.call("categorize.undo", { batchId: batchId! }));
  await client.call("categories.delete", { id: cat });
}, 600_000);
