/**
 * Plan 204 revision 12 at 50,000+ threads, on both stores: the whole of `today.list` and the sidebar's count, with the
 * dated set at its bound (1,000 open items, every one of them showing) and follow-ups on. It holds the time and the
 * longest the event loop goes without a turn. Nothing leaves this process.
 */
import "fake-indexeddb/auto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { IdbMailStore } from "@terno/idb";
import { demoRegistry } from "@terno/mail";
import { generateDataset } from "@terno/mock-data";
import type { MailStore } from "@terno/store";
import { seedDatedItems } from "@terno/store/conformance";
import { afterAll, describe, expect, it } from "vitest";
import { copyMailbox, LARGE_MAILBOX } from "../../db/src/test/perf-mailbox";
import { watchLoop } from "../../db/src/test/timing";
import { Backend, plaintextCipher } from "./backend";

const NOW = Date.UTC(2026, 10, 1, 12);
const DAY = 86_400_000;
const MULT = Number(process.env.PERF_BUDGET_MULTIPLIER ?? "1");
const dir = mkdtempSync(join(tmpdir(), "terno-today-perf-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const p95 = (times: number[]) => [...times].sort((a, b) => a - b)[Math.floor(times.length * 0.95) - 1]!;

async function run(kind: "SQLite" | "IndexedDB", budget: { spread: { listMs: number; addedMs: number }; bound: { listMs: number; addedMs: number }; busyMs: number }) {
  const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setImmediate(resolve)) };
  let store: MailStore | undefined;
  let accountId: number;
  const path = join(dir, `${kind}.db`);
  if (kind === "IndexedDB") {
    const idb = await IdbMailStore.open({ name: "today-perf", factory: indexedDB, instantSearch: false, platform });
    const seeded = await idb.dev.seed(generateDataset({ threads: 52_000, accounts: 2, seed: 204, now: NOW, bodyScale: 0.02 }), { now: NOW, categorizeRate: 0 });
    accountId = seeded.accountIds[0]!;
    store = idb;
  } else accountId = copyMailbox(LARGE_MAILBOX, path).accountIds[0]!;
  const clock = { now: NOW };
  const backend = new Backend({ dbPath: path, store, platform: store ? platform : undefined, version: "t", cipher: plaintextCipher, providers: demoRegistry, autoSync: false, demoAi: true, now: () => clock.now });
  await backend.store.ready;
  await backend.ready;
  try {
    const [c, s] = createMemoryTransportPair();
    backend.connect(s, { clientId: "r", origin: "renderer" });
    const client = new RpcClient(c);
    await client.call("settings.update", { ai: { provider: "fake" } });
    // seeded first: the reader, once on, would read (and drop) mail from before it went on
    await seedDatedItems({ store: backend.store, accountId, now: NOW, budget: MULT, log: () => {} });
    await client.call("settings.update", { dated: { enabled: true }, followups: { enabled: true } });
    // a turn between calls, as between two requests: the store answers synchronously on SQLite
    const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
    const measure = async (label: string, at: number, gate: { listMs: number; addedMs: number }) => {
      clock.now = at;
      backend.today.touched();
      const lists: number[] = [];
      const counts: number[] = [];
      // plan 145's own count, in the same turns: what this plan adds is the difference
      const needs: number[] = [];
      const loop = watchLoop(budget.busyMs * MULT);
      for (let i = 0; i < 20; i++) {
        await turn();
        let t = performance.now();
        await backend.today.list([]);
        lists.push(performance.now() - t);
        const raw = await backend.store.threads.counts(clock.now);
        await turn();
        t = performance.now();
        await backend.today.withCount(raw);
        counts.push(performance.now() - t);
        await turn();
        t = performance.now();
        await backend.store.today.needsCount(clock.now);
        needs.push(performance.now() - t);
      }
      const report = loop.stop();
      const added = p95(counts) - p95(needs);
      process.stderr.write(`[${kind}] ${label}: today.list p95 ${p95(lists).toFixed(1)} ms, count p95 ${p95(counts).toFixed(1)} ms (plan 145's ${p95(needs).toFixed(1)}, so ${added.toFixed(1)} added), longest busy ${report.longest.busy.toFixed(1)} ms\n`);
      expect(report.longest.busy).toBeLessThanOrEqual(budget.busyMs * MULT);
      expect(p95(lists)).toBeLessThanOrEqual(gate.listMs * MULT);
      expect(added).toBeLessThanOrEqual(gate.addedMs * MULT);
    };
    // as a mailbox has them: the items spread over the coming weeks, a few for today, the rest Coming up
    await measure("spread", NOW, budget.spread);
    // the bound: every item's time to act has come, and the list holds all 1,000
    clock.now = NOW + 2 * DAY;
    backend.today.touched();
    const all = await client.call("today.list", { heldIds: [] });
    expect(all.sections.reduce((n, x) => n + x.items.length, 0)).toBeGreaterThanOrEqual(1000);
    await measure("all showing", NOW + 2 * DAY, budget.bound);
  } finally {
    await backend.stop();
  }
}

describe("Today at 50k threads with 1,000 dated items (plan 204 revision 12)", () => {
  // the count is plan 145's walk and what this plan adds to it: at most 2 ms spread, 4 ms with a thousand threads to check
  it("SQLite", async () => run("SQLite", { spread: { listMs: 20, addedMs: 2 }, bound: { listMs: 30, addedMs: 4 }, busyMs: 60 }), 600_000);
  it("IndexedDB", async () => run("IndexedDB", { spread: { listMs: 20, addedMs: 2 }, bound: { listMs: 30, addedMs: 4 }, busyMs: 60 }), 900_000);
});
