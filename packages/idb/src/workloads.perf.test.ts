/**
 * The IndexedDB gates on a mailbox of 57,000 threads and 100k+ messages. fake-indexeddb can't be copied, so what can
 * share one seeded store does, in an order where none leaves what another's timing would run under:
 *
 *  1. plan 64: search looks everywhere: the shipping web configuration, the index current at the web's cap (a cold-start
 *     workload: it's first, on the store as seeded). A whole search through the store within 5 ms, everywhere and in:all.
 *  2. Then the store reopened without the index: the exact scan (no index yet) never stalls a frame and finishes in its
 *     budget, for every strategy; a free-text scan reads every body, once with nothing left out and once by category
 *     (idb.perf holds the same stalls at 50k messages for three more).
 *  3. The workloads the stores share (conformance/*-perf.ts): arrivals only reads; summaries wants no filters, so it's
 *     before forwards; each says what it needs before it times.
 *  4. Plan 69's storage perf last: its removal deletes bodies, and nothing after it reads them.
 *
 * Timings are medians of warm runs; on a busy machine, CPU time (as idb.perf).
 */
import { nodeBodyPreparationFactory } from "../../db/src/node-driver";
import "fake-indexeddb/auto";
import { REMOVABLE_BUCKETS, storageCutoff } from "@terno/core";
import { generateDataset } from "@terno/mock-data";
import type { Platform } from "@terno/store";
import { measureActionWalk, measureFollowups, measureAsk, measureAiSummaries, measureCategoryEvidence, measureForwards, measureWriting, type WorkloadMailbox } from "@terno/store/conformance";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { machineBusy, sampleAsync, settle, watchLoop } from "../../db/src/test/timing";
import { mkdirSync, writeFileSync } from "node:fs";
import { IdbMailStore } from "./store";

/** what each case measured, kept in test-results/perf (a passing test's console isn't shown) */
const lines: string[] = [];
const log = (line: string) => lines.push(line);

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const MULT = Number(env.PERF_BUDGET_MULTIPLIER ?? "1");
const FRAME = 16;
const SLICE = 15;
const NOW = Date.UTC(2026, 9, 22, 15, 30);
const platform: Pick<Platform, "uuid" | "yield" | "bodyPreparation"> = { uuid: () => crypto.randomUUID(), yield: () => new Promise((r) => setTimeout(r, 0)), bodyPreparation: nodeBodyPreparationFactory };
const name = `workloads-${Date.now()}`;
let store: IdbMailStore;
let accountIds: number[];

const QUERIES = [
  "factura",
  "hola",
  "pro",
  "propuesta pre",
  "zzqxjv",
  "from:crew@morningbrew.com",
  "factura -uber",
  "is:unread",
  "is:unread has:attachment",
  "has:attachment after:180d",
  "before:2025-03-01",
  "after:2026-01-01 before:2026-02-01",
  "category:facturas uber",
  "subject:invitación",
];
/**
 * What the exact scan may take to finish (no index: it's building, or over its cap). What the
 * thread rows or one field decide (operators, a sender, dates, a subject) reads no bodies: well
 * under a second. Free text reads every body: seconds at this size (measured 3.5–6.7 s), bounded
 * here so a slower scan fails; this is the fallback, not the instant path (plan 64).
 */
const scanBudget = (query: string) => (/^(is:|has:|before:|after:|from:\S+@|subject:)/.test(query) ? 500 : 10_000);
const SCOPES = [
  ["everywhere", (q: string) => q],
  ["in:all", (q: string) => `in:all ${q}`],
] as const;

beforeAll(async () => {
  // the shipping web configuration (WEB_SEARCH_MEMORY): the index must be current at this size (~123 MiB at 100k messages)
  store = await IdbMailStore.open({ name, factory: indexedDB, platform, instantSearch: true });
  const seeded = await store.dev.seed(generateDataset({ threads: 57_000, accounts: 8, seed: 64, now: NOW, bodyScale: 2 }), { now: NOW });
  expect(seeded.threadCount).toBeGreaterThanOrEqual(50_000);
  expect(seeded.messageCount).toBeGreaterThanOrEqual(100_000);
  accountIds = seeded.accountIds;
  const settled = await store.instant!.settled(900_000);
  log(`instant index: ${JSON.stringify(store.instant!.report)}`);
  expect(settled, "the index is current at the web's cap").toBe(true);
}, 1_800_000);
afterAll(async () => {
  mkdirSync("test-results/perf", { recursive: true });
  writeFileSync("test-results/perf/idb-search-everywhere.txt", `${lines.join("\n")}\n`);
  await store?.close();
});

async function median(fn: () => Promise<unknown>, n = 5): Promise<number> {
  await fn();
  const ms: number[] = [];
  for (let i = 0; i < n; i++) {
    const s = await sampleAsync(fn);
    ms.push(machineBusy() ? s.cpu : s.wall);
  }
  return ms.sort((a, b) => a - b)[Math.floor(n / 2)]!;
}

it("plan 64: the instant index: every search through the store within 5 ms, everywhere and in:all", async () => {
  const over: string[] = [];
  for (const [scope, q] of SCOPES) {
    for (const query of QUERIES) {
      const page = await store.threads.searchText({ query: q(query), limit: 100, now: NOW });
      expect(page.strategy, query).toMatch(/^instant/);
      const ms = await median(() => store.threads.searchText({ query: q(query), limit: 100, now: NOW }));
      log(`instant ${scope} "${query}": ${ms.toFixed(2)} ms, ${page.items.length} rows`);
      if (ms > 5 * MULT) over.push(`${scope} "${query}": ${ms.toFixed(2)} ms`);
    }
  }
  expect(over).toEqual([]);
}, 600_000);

/** a free-text scan reads every body, the same pass with a different test: "everywhere" reads the most of them, so it holds the budget for the rest */
const SCANNED: readonly (readonly [string, (q: string) => string, string])[] = [
  ...QUERIES.filter((q) => scanBudget(q) < 10_000).flatMap((q) => SCOPES.map(([s, f]) => [s, f, q] as const)),
  ["everywhere", SCOPES[0][1], "zzqxjv"],
  ["everywhere", SCOPES[0][1], "category:facturas uber"],
];

it("plan 64: the exact scan (no index yet): never stalls a frame, and finishes within its budget", async () => {
  await store.close();
  store = await IdbMailStore.open({ name, factory: indexedDB, platform, instantSearch: false });
  await store.whenLoaded();
  const over: string[] = [];
  for (const [scope, q, query] of SCANNED) {
    // the best of three: a stall our code causes repeats, the OS preempting this process doesn't
    let best: { stall: number; ms: number; n: number } | null = null;
    for (let i = 0; i < 3; i++) {
      const loop = watchLoop(FRAME * MULT);
      const t = performance.now();
      const page = await store.threads.searchText({ query: q(query), limit: 100, now: NOW });
      const ms = performance.now() - t;
      const r = loop.stop();
      if (!best || r.stall < best.stall) best = { stall: r.stall, ms, n: page.items.length };
      if (best.stall <= FRAME * MULT) break;
    }
    log(`scan ${scope} "${query}": ${best!.ms.toFixed(0)} ms, max stall ${best!.stall.toFixed(1)} ms, ${best!.n} rows`);
    if (best!.stall > FRAME * MULT) over.push(`${scope} "${query}": stall ${best!.stall.toFixed(1)} ms`);
    const budget = scanBudget(query);
    if (best!.ms > budget * MULT) over.push(`${scope} "${query}": ${best!.ms.toFixed(0)} ms > ${budget} ms`);
  }
  expect(over).toEqual([]);
}, 1_800_000);

describe("the workloads the stores share", () => {
  const mailbox = (): WorkloadMailbox => ({ store, accountId: accountIds[0]!, now: NOW, budget: MULT, log: (line) => process.stderr.write(`[50k IDB] ${line}\n`) });

  it("plan 41: sync.arrivals of 200 messages stays below 5 ms", async () => {
    const rows = (store as unknown as { db: { table(n: string): { rows: Map<number, unknown> } } }).db.table("messages").rows;
    const ids = [...rows.keys()].sort((a, b) => b - a);
    const times: number[] = [];
    for (let i = 0; i < 100; i++) {
      const from = (i % 50) * 200;
      const start = performance.now();
      expect((await store.sync.arrivals(ids.slice(from, from + 200))).length).toBe(200);
      times.push(performance.now() - start);
    }
    const p95 = times.sort((a, b) => a - b)[94]!;
    expect(p95).toBeLessThanOrEqual(5);
    log(`arrivals(200): p95 ${p95.toFixed(3)} ms`);
  }, 600_000);
  it("plan 132: summaries: marking a live slice and the worker's and reader's reads hold", () => measureAiSummaries(mailbox()), 600_000);
  it("plan 142: follow-ups' reads hold at the cap", () => measureFollowups(mailbox()), 600_000);
  it("plan 143: a sentence's walk holds, sparse and dense, with a pattern and without", () => measureActionWalk(mailbox(), { stepMs: 400, totalMs: 15_000 }), 600_000);
  it("plan 141: a question's search and passages hold, wherever the word is", () => measureAsk(mailbox(), { totalMs: 3 * scanBudget("factura"), passagesMs: 500, stallMs: 32 }), 600_000);
  it("plan 133: drafting's reads hold, with thousands of look-alikes in the way", () => measureWriting(mailbox()), 600_000);
  it("plan 134: categories: what the AI is told and an AI filing hold", () => measureCategoryEvidence(mailbox()), 600_000);
  it("plan 116: forwards: a live slice's planning and the queue's reads hold", () => measureForwards(mailbox()), 600_000);
});

describe("plan 69: the storage report and removal", () => {
  beforeAll(async () => {
    // synced accounts: a never-synced one keeps its mail
    for (const id of accountIds) await store.accounts.setSyncState(id, { lastSyncAt: NOW });
  });

  /** the median of a few warm runs: wall clock, the busy machine's holds excused as in idb.perf */
  async function timed(fn: () => Promise<unknown>): Promise<number> {
    await fn();
    const samples = [];
    for (let i = 0; i < 5; i++) samples.push(await sampleAsync(fn));
    const { ms } = settle(samples);
    return [...ms].sort((a, b) => a - b)[Math.floor(ms.length / 2)]!;
  }

  it("a report slice of 300 conversations fits a bulk slice, deep in the mailbox as at its start; the whole report reads once", async () => {
    const first = await store.storage.threads(0, 1);
    const deep = (await store.storage.threads(first[0]!.id + 45_000, 1))[0]!.id;
    for (const after of [0, deep]) {
      const ms = await timed(() => store.storage.threads(after, 300));
      expect(ms, `report slice after ${after}: ${ms.toFixed(2)}ms`).toBeLessThanOrEqual(SLICE * MULT);
    }
    const started = performance.now();
    let rows = 0;
    for (let after = 0; ; ) {
      const page = await store.storage.threads(after, 1000);
      if (!page.length) break;
      rows += page.length;
      after = page.at(-1)!.id;
    }
    const total = performance.now() - started;
    expect(rows).toBeGreaterThanOrEqual(50_000);
    expect(total, `whole report: ${total.toFixed(0)}ms`).toBeLessThan(3000 * MULT);
  });

  it("a removal unit's synchronous part fits a bulk slice (its IndexedDB write is asynchronous)", async () => {
    const rows = (await store.storage.threads(0, 5000)).filter((r) => !r.kept);
    const cutoff = storageCutoff(NOW, 30);
    const cpu: number[] = [];
    let removed = 0;
    for (let i = 0; i < 40; i++) {
      const pack = rows.slice(i * 20, i * 20 + 20).map((r) => r.id);
      const s = await sampleAsync(() => store.storage.remove({ threadIds: pack, buckets: [...REMOVABLE_BUCKETS], cutoff, maxMessages: 30 }));
      removed += s.result.messages;
      cpu.push(s.cpu);
    }
    expect(removed).toBeGreaterThan(500);
    const median = [...cpu].sort((a, b) => a - b)[cpu.length >> 1]!;
    expect(median, `remove unit cpu median ${median.toFixed(2)}ms`).toBeLessThanOrEqual(SLICE * MULT);
  });
});
