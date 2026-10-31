import "fake-indexeddb/auto";
import { REMINDERS_MAX } from "@terno/core";
import { generateDataset } from "@terno/mock-data";
import type { Platform } from "@terno/store";
import { afterAll, beforeAll, expect, it } from "vitest";
import { sampleAsync, settle } from "../../db/src/test/timing";
import { IdbMailStore } from "./store";

/**
 * Plan 87 on IndexedDB at ~50k messages: 1,000 "noReply" reminders (the cap)
 * on the longest conversations: the list, a backend slice of the answered
 * check and the summaries the Inbox's top and the Reminders list read.
 */
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const MULT = Number(env.PERF_BUDGET_MULTIPLIER ?? "1");
const FRAME = 16;
const NOW = Date.UTC(2026, 9, 22, 15, 30);
const platform: Pick<Platform, "uuid" | "yield"> = { uuid: () => crypto.randomUUID(), yield: () => new Promise((r) => setTimeout(r, 0)) };

let store: IdbMailStore;
beforeAll(async () => {
  const data = generateDataset({ threads: 28_400, accounts: 8, seed: 42, now: NOW, bodyScale: 2 });
  store = await IdbMailStore.open({ name: `reminders-perf-${Date.now()}`, factory: indexedDB, platform, instantSearch: false });
  const seeded = await store.dev.seed(data, { now: NOW });
  expect(seeded.messageCount).toBeGreaterThanOrEqual(50_000);
  const snapshot = await store.debug.snapshot();
  const ids = snapshot.threads.sort((a, b) => b.messageCount - a.messageCount || a.id - b.id).slice(0, REMINDERS_MAX).map((t) => t.id);
  // set before every message: each one's answered check reads the whole conversation
  expect((await store.reminders.put(ids.map((threadId) => ({ threadId, dueAt: NOW + 86_400_000, kind: "noReply" as const, setAt: 0 })), REMINDERS_MAX)).ok).toBe(true);
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

it("the list, a slice of the answered check and the 1,000 summaries each within a frame", async () => {
  const list = await store.reminders.list();
  expect(list).toHaveLength(REMINDERS_MAX);
  const checks: [string, number, () => Promise<unknown>][] = [
    ["list", FRAME, () => store.reminders.list()],
    ["answered, 64", 8, () => store.reminders.answered(list.slice(0, 64))],
    ["summaries", FRAME, () => store.threads.summaries(list.map((r) => r.threadId))],
  ];
  for (const [name, budget, fn] of checks) {
    const ms = await timed(fn);
    expect(ms, `${name}: ${ms.toFixed(2)}ms`).toBeLessThanOrEqual(budget * MULT);
  }
});
