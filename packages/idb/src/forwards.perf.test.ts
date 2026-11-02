/** Plan 116 at 50,000 threads on IndexedDB (SQLite's forwards.perf.test.ts; the workload: forwards-perf.ts). */
import "fake-indexeddb/auto";
import { measureForwards } from "@terno/store/conformance";
import { it } from "vitest";
import { IdbMailStore } from "./store";

it("forwards: a live slice's planning and the queue's reads hold at 50,000 IndexedDB threads", async () => {
  const store = await IdbMailStore.open({ name: "forwards-perf-50k", factory: indexedDB, instantSearch: false, platform: { uuid: () => crypto.randomUUID(), yield: () => Promise.resolve() } });
  try {
    await measureForwards(store, { now: Date.UTC(2026, 10, 1, 12), budget: Number(process.env.PERF_BUDGET_MULTIPLIER ?? "1"), log: (line) => process.stderr.write(`[50k IDB forwards] ${line}\n`) });
  } finally {
    await store.close();
  }
}, 600_000);
