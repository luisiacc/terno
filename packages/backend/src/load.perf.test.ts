/**
 * Bulk work on a loaded machine: every store command the sliced paths run
 * burns twice its CPU time and waits 2–8 ms more (a slow fsync), while two
 * worker threads spin beside it. Slices must size themselves to the time
 * they actually take, so the event loop still never stalls past 50 ms and
 * lists keep answering within 50 ms.
 *
 * A stall is a gap between two 1 ms ticks during which the event loop was
 * busy, in wall-clock time: computing or blocked in a synchronous wait (both
 * are "active" in Node's event-loop utilization, and both are what a user
 * sees). Time the loop spent idle, waiting for work, isn't a stall even when
 * the OS delays an idle process's timers (macOS coalesces them by tens of ms).
 * The only excuse is narrow and explicit: a gap that is one store command
 * which by itself took longer than a slice's target (the OS held it, or it
 * ran on: no slicing decision could split it) may run over, at most twice
 * per stage, never past 250 ms, and each one is reported with its command.
 * A slicer that didn't adapt would run over on every slice and fail. The
 * other excuse is the machine's, and only on a busy machine (timing.ts): a
 * gap in which this thread was on a CPU for at most the budget, the OS
 * holding it for the rest, rarely (two per stage, or one a second of it).
 * Slices the OS held are excused the same way, and list calls lose the time
 * such a gap held them. The injected slowness is spun, on the CPU, so a
 * slicer that stopped adapting is never excused.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { seedDataset, sqlDb } from "@terno/db";
import { demoRegistry } from "@terno/mail";
import { generateDataset } from "@terno/mock-data";
import { afterAll, beforeAll, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { BUDGET_MULTIPLIER, report, type Stat } from "../../db/src/test/perf";
import { deschedulingAllowance, describeGap, machineBusy, sampleAsync, settle, threadCpuMs, watchLoop, type Gap } from "../../db/src/test/timing";

const NOW = Date.UTC(2026, 9, 22, 15, 30);
/** each slowed command burns this many times its own CPU time (I/O waits aren't multiplied)… */
const SLOWDOWN = 2;
/** …and then waits this long, like a commit on a busy disk */
const LATENCY_MS = [2, 8] as const;
const BUDGET = 50 * BUDGET_MULTIPLIER;
const HARD_LIMIT = 250 * BUDGET_MULTIPLIER;
/** what a slice aims at (slicer.ts): a single-item command over it can't be helped by slicing */
const SLICE_TARGET = 15;
const MAX_EXCUSED = 2;
const stats: Stat[] = [];

/** every slowed store command of the stage: when it ran, what, on how many items */
interface CommandRun {
  name: string;
  n: number | undefined;
  start: number;
  end: number;
  /** the command's own CPU time, before the injected slowness */
  cpu: number;
  /** the thread's CPU time over the whole run, the injected slowness included */
  spent: number;
}
let commands: CommandRun[] = [];
/** the longest garbage collection pause of the stage */
let longestGc = 0;
new PerformanceObserver((list) => {
  for (const e of list.getEntries()) longestGc = Math.max(longestGc, e.duration);
}).observe({ entryTypes: ["gc"] });
/** while set, store commands of the bulk paths also block on the OS for this long per item (a disk that turned slow) */
let blockPerItemMs = 0;
let dir: string;
let backend: Backend;
let client: RpcClient;
let workers: Worker[] = [];

/** Makes store commands slow, synchronously, as a slow disk or a busy CPU would (they block the loop). */
function slowDown(target: Record<string, unknown>, names: string[]) {
  for (const name of names) {
    const orig = target[name] as (...a: unknown[]) => Promise<unknown>;
    target[name] = async (...args: unknown[]) => {
      const start = performance.now();
      const startCpu = threadCpuMs();
      const cpu = process.threadCpuUsage();
      const r = await orig.apply(target, args);
      const used = process.threadCpuUsage(cpu);
      const n = (args.find((a) => Array.isArray(a)) as unknown[] | undefined)?.length ?? (args[0] as { threadIds?: unknown[] } | undefined)?.threadIds?.length;
      const end = performance.now() + ((used.user + used.system) / 1000) * (SLOWDOWN - 1) + LATENCY_MS[0] + Math.random() * (LATENCY_MS[1] - LATENCY_MS[0]);
      while (performance.now() < end) {
        /* the machine is busy */
      }
      // a synchronous wait: the event loop is blocked for exactly that long (spun, not Atomics.wait: a sleeping thread
      // can oversleep a 3 ms timeout by hundreds of ms under macOS timer coalescing, which would test the OS, not us)
      if (blockPerItemMs && n) {
        const until = performance.now() + blockPerItemMs * n;
        while (performance.now() < until) {
          /* the disk is slow */
        }
      }
      commands.push({ name, n, start, end: performance.now(), cpu: (used.user + used.system) / 1000, spent: threadCpuMs() - startCpu });
      return r;
    };
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "terno-loadperf-"));
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

interface StageResult {
  /** gaps over budget */
  gaps: Gap[];
  /** of which the machine's (timing.ts) */
  descheduled: Gap[];
  /** list calls: wall ms, and ms less the time the OS held the thread */
  lists: { start: number; end: number; ms: number; ours: number }[];
  commands: CommandRun[];
}

/** Runs `fn` while ticking every 1 ms (recording each gap over budget) and listing the inbox as a renderer would. */
async function measure(fn: () => Promise<unknown>): Promise<StageResult & { took: number; maxGap: Gap }> {
  const [c, srv] = createMemoryTransportPair();
  backend.connect(srv, { clientId: `probe-${Math.random()}`, origin: "renderer" });
  const probe = new RpcClient(c);
  const loop = watchLoop(BUDGET);
  const lists: StageResult["lists"] = [];
  let done = false;
  const lister = (async () => {
    while (!done) {
      const start = performance.now();
      const s = await sampleAsync(() => probe.call("threads.list", { view: "inbox" }));
      lists.push({ start, end: performance.now(), ms: s.wall, ours: s.cpu });
      await new Promise((r) => setTimeout(r, 2));
    }
  })();
  commands = [];
  longestGc = 0;
  const started = performance.now();
  let watched: ReturnType<typeof loop.stop>;
  try {
    await fn();
  } finally {
    done = true;
    await lister;
    watched = loop.stop();
  }
  return { gaps: watched.over, descheduled: watched.descheduled, lists, commands, took: performance.now() - started, maxGap: watched.longest };
}

/**
 * The narrow excuse: the gap is one store command (it covers at least 80% of
 * the gap) that took longer than a slice's target by itself.
 */
function excusedBy(gap: Gap, runs: readonly CommandRun[]): CommandRun | null {
  const inside = runs.filter((r) => r.start < gap.end && r.end > gap.start);
  if (inside.length !== 1) return null;
  const r = inside[0]!;
  const covered = Math.min(r.end, gap.end) - Math.max(r.start, gap.start);
  return r.end - r.start > SLICE_TARGET && covered >= gap.busy * 0.8 ? r : null;
}

/** List calls' times, those the OS held counted at what they took of this thread while they are rare (timing.ts). */
const listTimes = (lists: StageResult["lists"]) => settle(lists.map((l) => ({ wall: l.ms, cpu: l.ours }))).ms;

const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.max(0, Math.ceil(xs.length * 0.95) - 1)] ?? 0;
const runName = (r: CommandRun) => `${r.name}(${r.n ?? "-"}) ${(r.end - r.start).toFixed(0)} ms, cpu ${r.cpu.toFixed(1)} ms`;

async function underLoad(name: string, fn: () => Promise<unknown>) {
  const m = await measure(fn);
  // the machine's gaps first; of the rest, the ones a single long command explains
  const ours = m.gaps.filter((g) => !m.descheduled.includes(g));
  const excused = ours.map((g) => ({ gap: g, by: excusedBy(g, m.commands) }));
  const longest = m.commands.reduce<CommandRun | null>((a, r) => (!a || r.end - r.start > a.end - a.start ? r : a), null);
  // a list call that ran into a gap a single command explains is excused with it; one that ran into a gap the OS held
  // loses only the time the thread was off a CPU in it (the rest of its wait is still its own)
  const excusedSpans = excused.filter((e) => e.by).map((e) => e.gap);
  const overlap = (l: { start: number; end: number }, g: Gap) => Math.max(0, Math.min(l.end, g.end) - Math.max(l.start, g.start));
  const listsHeld = m.lists
    .filter((l) => !excusedSpans.some((g) => overlap(l, g) > 0))
    .map((l) => {
      const held = m.descheduled.reduce((a, g) => a + Math.min(overlap(l, g), g.busy - g.cpu), 0);
      return { ...l, ms: l.ms - held, ours: Math.min(l.ours, l.ms - held) };
    });
  const listMax = Math.max(0, ...listTimes(listsHeld));
  // what ran during the worst gap (diagnostics)
  const during = m.commands.filter((r) => r.start < m.maxGap.end && r.end > m.maxGap.start).map(runName);
  stats.push({
    name:
      `${name}: ${m.took.toFixed(0)} ms, longest stall ${describeGap(m.maxGap)}, ` +
      `${excused.filter((e) => e.by).length} excused [${excused.flatMap((e) => (e.by ? [`${e.gap.busy.toFixed(0)} ms: ${runName(e.by)}`] : [])).join("; ")}], ` +
      `${m.descheduled.length} descheduled [${m.descheduled.map(describeGap).join("; ")}], ` +
      `list p95 ${p95(listTimes(m.lists)).toFixed(1)} ms, max ${listMax.toFixed(1)} ms (${m.lists.length}); longest command ${longest ? runName(longest) : "-"}; longest GC ${longestGc.toFixed(0)} ms; ` +
      `during the longest stall: ${during.join(", ") || "no store command"}`,
    budgetMs: 50,
    p50: m.maxGap.busy,
    p95: m.maxGap.busy,
    max: m.maxGap.busy,
    iterations: m.lists.length,
  });
  for (const e of excused) {
    expect(e.by, `${name}: a ${describeGap(e.gap)} stall no single-item command explains`).not.toBeNull();
    expect(e.gap.busy, `${name}: even an excused stall`).toBeLessThanOrEqual(HARD_LIMIT);
  }
  expect(excused.length, `${name}: excused stalls`).toBeLessThanOrEqual(MAX_EXCUSED);
  expect(listMax, `${name}: the slowest list call`).toBeLessThanOrEqual(BUDGET);
  expect(p95(listTimes(m.lists)), `${name}: list p95`).toBeLessThanOrEqual(20 * BUDGET_MULTIPLIER);
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

it("a disk that turns slow mid-job: one slice runs over, the next ones shrink back under budget", async () => {
  // grown slices meet a synchronous wait of 3 ms per item from the first one of 20–50 items on (60–150 ms for that one)
  let switchedAt = Infinity;
  const act = backend.store.threads.act.bind(backend.store.threads);
  backend.store.threads.act = (c) => {
    if (switchedAt === Infinity && c.threadIds.length >= 20 && c.threadIds.length <= 50) {
      switchedAt = performance.now();
      blockPerItemMs = 3;
    }
    return act(c);
  };
  try {
    const m = await measure(() => client.call("threads.actScope", { scope: { kind: "view", view: "all" }, action: "star" }));
    const over = m.gaps.filter((g) => g.end > switchedAt);
    const after = m.commands.filter((r) => r.name === "act" && r.start >= switchedAt);
    // a slice the OS held: off a CPU for most of it (the injected slowness is spun, so it never is)
    const held = (r: CommandRun) => r.end - r.start - r.spent > (r.end - r.start) / 2;
    stats.push({
      name: `slow disk mid-job: switched at a slice of ${after[0]?.n ?? "?"} items; stalls over budget after it: ${over.map((g) => `${describeGap(g)}${m.descheduled.includes(g) ? " descheduled" : ""}${m.commands.some((r) => r.start < g.end && r.end > g.start) ? "" : ", no command"}`).join(", ") || "none"}; slices after: ${after.slice(0, 8).map((r) => `${r.n}→${(r.end - r.start).toFixed(0)} ms`).join(", ")}; longest GC ${longestGc.toFixed(0)} ms`,
      budgetMs: 50,
      p50: m.maxGap.busy,
      p95: m.maxGap.busy,
      max: m.maxGap.busy,
      iterations: after.length,
    });
    expect(switchedAt, "the slices grew to 20 items before the disk turned slow").toBeLessThan(Infinity);
    expect(after[0]!.end - after[0]!.start, "the first slow slice ran over the budget").toBeGreaterThan(BUDGET);
    // that one overrun, then the slices are back within budget: past it, only the narrow excuses (the machine's, and a
    // single long command at most twice)
    const later = over.filter((g) => g.start > after[0]!.end && !m.descheduled.includes(g));
    for (const g of over.filter((x) => !m.descheduled.includes(x))) expect(g.busy).toBeLessThanOrEqual(HARD_LIMIT);
    for (const g of later) expect(excusedBy(g, m.commands), `a ${describeGap(g)} stall after the overrun`).not.toBeNull();
    expect(later.length, "stalls over budget after the overrun").toBeLessThanOrEqual(MAX_EXCUSED);
    const slow = after.slice(1).filter((r) => r.end - r.start > BUDGET);
    // on a busy machine, slices the OS held are excused while they are rare, as stalls are
    const heldSlow = slow.filter(held);
    const counted = machineBusy() && heldSlow.length <= deschedulingAllowance(m.took) ? slow.filter((r) => !held(r)) : slow;
    expect(counted.length, `slices over budget after the overrun: ${slow.map(runName).join("; ")}`).toBeLessThanOrEqual(MAX_EXCUSED);
  } finally {
    blockPerItemMs = 0;
    backend.store.threads.act = act;
  }
}, 600_000);
