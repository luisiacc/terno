import "fake-indexeddb/auto";
import { REMOVABLE_BUCKETS, storageCutoff } from "@terno/core";
import { generateDataset } from "@terno/mock-data";
import type { Platform } from "@terno/store";
import { afterAll, beforeAll, expect, it } from "vitest";
import { sampleAsync, settle } from "../../db/src/test/timing";
import { IdbMailStore } from "./store";

/**
 * Plan 69 on IndexedDB at 50k threads: a storage report slice and a removal unit within a bulk slice (the backend
 * sizes both by time), and the whole report reads every conversation once, never rescanning per slice.
 */
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const MULT = Number(env.PERF_BUDGET_MULTIPLIER ?? "1");
const SLICE = 15;
const NOW = Date.UTC(2026, 9, 22, 15, 30);
const platform: Pick<Platform, "uuid" | "yield"> = { uuid: () => crypto.randomUUID(), yield: () => new Promise((r) => setTimeout(r, 0)) };

let store: IdbMailStore;
beforeAll(async () => {
  store = await IdbMailStore.open({ name: `storage-perf-${Date.now()}`, factory: indexedDB, platform, instantSearch: false });
  const seeded = await store.dev.seed(generateDataset({ threads: 50_000, accounts: 4, seed: 69, now: NOW, bodyScale: 2 }), { now: NOW });
  expect(seeded.threadCount).toBeGreaterThanOrEqual(50_000);
  // synced accounts: a never-synced one keeps its mail
  for (const id of seeded.accountIds) await store.accounts.setSyncState(id, { lastSyncAt: NOW });
}, 900_000);
afterAll(async () => {
  await store?.close();
});

/** the median of a few warm runs: wall clock, the busy machine's holds excused as in idb.perf */
async function timed(fn: () => Promise<unknown>): Promise<number> {
  await fn();
  const samples = [];
  for (let i = 0; i < 9; i++) samples.push(await sampleAsync(fn));
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
