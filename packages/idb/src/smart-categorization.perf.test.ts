/** Plan 134 at 50,000 threads on IndexedDB (SQLite's smart-categorization.perf.test.ts; the workload: smart-categorization-perf.ts). */
import "fake-indexeddb/auto";
import { measureCategoryEvidence } from "@terno/store/conformance";
import { it } from "vitest";
import { IdbMailStore } from "./store";

it("categories: what the AI is told and an AI filing hold at 50,000 IndexedDB threads", async () => {
  const store = await IdbMailStore.open({ name: "evidence-perf-50k", factory: indexedDB, instantSearch: false, platform: { uuid: () => crypto.randomUUID(), yield: () => Promise.resolve() } });
  try {
    await measureCategoryEvidence(store, { now: Date.UTC(2026, 10, 1, 12), budget: Number(process.env.PERF_BUDGET_MULTIPLIER ?? "1"), log: (line) => process.stderr.write(`[50k IDB evidence] ${line}\n`) });
  } finally {
    await store.close();
  }
}, 600_000);
