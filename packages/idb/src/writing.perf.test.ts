/** Plan 133 at 50,000 threads on IndexedDB (SQLite's writing.perf.test.ts; the workload: writing-perf.ts). */
import "fake-indexeddb/auto";
import { measureWriting } from "@terno/store/conformance";
import { it } from "vitest";
import { IdbMailStore } from "./store";

it("drafting's reads hold at 50,000 IndexedDB threads, with thousands of look-alikes in the way", async () => {
  const store = await IdbMailStore.open({ name: "writing-perf-50k", factory: indexedDB, instantSearch: false, platform: { uuid: () => crypto.randomUUID(), yield: () => Promise.resolve() } });
  try {
    await measureWriting(store, { now: Date.UTC(2026, 10, 1, 12), budget: Number(process.env.PERF_BUDGET_MULTIPLIER ?? "1"), log: (line) => process.stderr.write(`[50k IDB writing] ${line}\n`) });
  } finally {
    await store.close();
  }
}, 600_000);
