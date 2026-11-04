/** Plan 132 at 50,000 threads on IndexedDB (SQLite's ai-summaries.perf.test.ts; the workload: ai-summaries-perf.ts). */
import "fake-indexeddb/auto";
import { measureAiSummaries } from "@terno/store/conformance";
import { it } from "vitest";
import { IdbMailStore } from "./store";

it("summaries: marking a live slice and the worker's and reader's reads hold at 50,000 IndexedDB threads", async () => {
  const store = await IdbMailStore.open({ name: "summaries-perf-50k", factory: indexedDB, instantSearch: false, platform: { uuid: () => crypto.randomUUID(), yield: () => Promise.resolve() } });
  try {
    await measureAiSummaries(store, { now: Date.UTC(2026, 10, 1, 12), budget: Number(process.env.PERF_BUDGET_MULTIPLIER ?? "1"), log: (line) => process.stderr.write(`[50k IDB summaries] ${line}\n`) });
  } finally {
    await store.close();
  }
}, 600_000);
