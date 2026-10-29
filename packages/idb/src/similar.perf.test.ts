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
/** a second mailbox where one sender sent every received message */
let dominant: IdbMailStore;
let dominantThread: number;
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
  const bot = { name: "Bot", email: "bot@notify.example" };
  const all = { ...data, messages: data.messages.map((m) => (m.isSent ? m : { ...m, from: bot, listId: "all.notify.example" })) };
  dominant = await IdbMailStore.open({ name: `similar-perf-dominant-${Date.now()}`, factory: indexedDB, platform, instantSearch: false });
  await dominant.dev.seed(all, { now: NOW });
  dominantThread = (await dominant.threads.searchText({ query: `from:${bot.email}`, limit: 1, now: NOW })).items[0]!.id;
}, 900_000);
afterAll(async () => {
  await store?.close();
  await dominant?.close();
});

/** the median of a few warm runs: wall clock, the busy machine's holds excused as in idb.perf */
async function timed(fn: () => Promise<unknown>): Promise<number> {
  await fn();
  const samples = [];
  for (let i = 0; i < 9; i++) samples.push(await sampleAsync(fn));
  const { ms } = settle(samples);
  return [...ms].sort((a, b) => a - b)[Math.floor(ms.length / 2)]!;
}

it("offers for the busiest sender within a frame, for every action; a sweep's page within one too", async () => {
  for (const action of ["archive", "trash", "spam"] as const) {
    const ms = await timed(() => store.similar.offers([busiest.threadId], action));
    expect(ms, `offers ${action}: ${ms.toFixed(2)}ms`).toBeLessThanOrEqual(FRAME * MULT);
  }
  const ms = await timed(() => store.similar.resolvePage({ kind: "sender", email: busiest.email }, "spam", [], null, 2000));
  expect(ms, `resolve page: ${ms.toFixed(2)}ms`).toBeLessThanOrEqual(FRAME * MULT);
});

it("one sender sent everything: offers (dominant, nothing in place) and a sweep's pages (rare subject, dominant) within a frame", async () => {
  for (const action of ["archive", "spam"] as const) {
    const ms = await timed(() => dominant.similar.offers([dominantThread], action));
    expect(ms, `dominant offers ${action}: ${ms.toFixed(2)}ms`).toBeLessThanOrEqual(FRAME * MULT);
  }
  const rare = await timed(() => dominant.similar.resolvePage({ kind: "subject", email: "bot@notify.example", subject: "nothing has this subject" }, "spam", [], null, 2000));
  expect(rare, `rare subject page: ${rare.toFixed(2)}ms`).toBeLessThanOrEqual(FRAME * MULT);
  const page = await timed(() => dominant.similar.resolvePage({ kind: "sender", email: "bot@notify.example" }, "spam", [], null, 2000));
  expect(page, `dominant page: ${page.toFixed(2)}ms`).toBeLessThanOrEqual(FRAME * MULT);
  // every page of the whole sweep: a later one reads on from the last (no reread of the bucket), the last ones as quick as the first
  const pages: number[] = [];
  for (let cursor: number | null = null; ; ) {
    const s = await sampleAsync(() => dominant.similar.resolvePage({ kind: "sender", email: "bot@notify.example" }, "spam", [], cursor, 2000));
    pages.push(s.cpu);
    if (s.result.next === null) break;
    cursor = s.result.next;
  }
  expect(pages.length).toBeGreaterThan(15);
  const late = [...pages.slice(-5)].sort((a, b) => a - b);
  expect(late[2]!, `late pages ${pages.slice(-5).map((ms) => ms.toFixed(2)).join(", ")}`).toBeLessThanOrEqual(FRAME * MULT);
});
