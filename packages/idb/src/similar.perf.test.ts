import "fake-indexeddb/auto";
import { generateDataset } from "@terno/mock-data";
import type { Platform } from "@terno/store";
import { afterAll, beforeAll, expect, it } from "vitest";
import { sampleAsync, settle } from "../../db/src/test/timing";
import { IdbMailStore } from "./store";

/**
 * Plan 63 on IndexedDB at ~50k messages: the offers the "… similar"
 * snackbar and submenu read (four index walks that stop at the count cap),
 * and a whole scope resolved for the sweep, each within a frame.
 */
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const MULT = Number(env.PERF_BUDGET_MULTIPLIER ?? "1");
const FRAME = 16;
const NOW = Date.UTC(2026, 9, 22, 15, 30);
const platform: Pick<Platform, "uuid" | "yield"> = { uuid: () => crypto.randomUUID(), yield: () => new Promise((r) => setTimeout(r, 0)) };

let store: IdbMailStore;
let busiest: { email: string; threadId: number };
beforeAll(async () => {
  const data = generateDataset({ threads: 28_400, accounts: 8, seed: 42, now: NOW, bodyScale: 2 });
  store = await IdbMailStore.open({ name: `similar-perf-${Date.now()}`, factory: indexedDB, platform, instantSearch: false });
  const seeded = await store.dev.seed(data, { now: NOW });
  expect(seeded.messageCount).toBeGreaterThanOrEqual(50_000);
  const counts = new Map<string, number>();
  for (const m of data.messages) if (!m.isSent) counts.set(m.from.email.toLowerCase(), (counts.get(m.from.email.toLowerCase()) ?? 0) + 1);
  const email = [...counts].sort((a, b) => b[1] - a[1])[0]![0];
  const page = await store.threads.searchText({ query: `from:${email}`, limit: 1, now: NOW });
  busiest = { email, threadId: page.items[0]!.id };
}, 900_000);
afterAll(async () => store?.close());

/** the median of a few warm runs: wall clock, the busy machine's holds excused as in idb.perf */
async function timed(fn: () => Promise<unknown>): Promise<number> {
  await fn();
  const samples = [];
  for (let i = 0; i < 9; i++) samples.push(await sampleAsync(fn));
  const { ms } = settle(samples);
  return [...ms].sort((a, b) => a - b)[Math.floor(ms.length / 2)]!;
}

it("offers for the busiest sender within a frame, for every action; a whole scope resolves within one too", async () => {
  for (const action of ["archive", "trash", "spam"] as const) {
    const ms = await timed(() => store.similar.offers([busiest.threadId], action));
    expect(ms, `offers ${action}: ${ms.toFixed(2)}ms`).toBeLessThanOrEqual(FRAME * MULT);
  }
  const ms = await timed(() => store.similar.resolve({ kind: "sender", email: busiest.email }, "spam", []));
  expect(ms, `resolve: ${ms.toFixed(2)}ms`).toBeLessThanOrEqual(FRAME * MULT);
});
