/** Plan 38: sync.arrivals on IndexedDB (SQLite's arrivals.perf.test.ts): 200 ids per read, under 5 ms at 50k+ threads. */
import "fake-indexeddb/auto";
import { generateDataset } from "@terno/mock-data";
import { expect, it } from "vitest";
import { IdbMailStore } from "./store";

it("sync.arrivals of 200 messages stays below 5 ms at 50,000 IndexedDB threads", async () => {
  const store = await IdbMailStore.open({ name: "arrivals-perf-50k", factory: indexedDB, instantSearch: false, platform: { uuid: () => crypto.randomUUID(), yield: () => Promise.resolve() } });
  try {
    const { threadCount } = await store.dev.seed(generateDataset({ threads: 50_000, accounts: 4, seed: 38, now: 0, bodyScale: 0.01 }), { now: 0, categorizeRate: 0 });
    expect(threadCount).toBeGreaterThanOrEqual(50_000);
    const ids = (await store.debug.snapshot()).messages.map((m) => m.id).sort((a, b) => b - a);
    const times: number[] = [];
    for (let i = 0; i < 100; i++) {
      const from = (i % 50) * 200;
      const start = performance.now();
      expect((await store.sync.arrivals(ids.slice(from, from + 200))).length).toBe(200);
      times.push(performance.now() - start);
    }
    const p95 = times.sort((a, b) => a - b)[94]!;
    expect(p95).toBeLessThanOrEqual(5);
    (globalThis as { process?: { stderr: { write(text: string): void } } }).process?.stderr.write(`[50k IDB arrivals(200)] p95 ${p95.toFixed(3)} ms\n`);
  } finally {
    await store.close();
  }
}, 600_000);
