/** Plan 65 (Codex R20): an ID-less message's twins, by exactly its envelope (the `twins` bucket), at 50,000 in a cohort. */
import "fake-indexeddb/auto";
import { twinLookupsMs } from "@terno/store/conformance";
import { IDBFactory } from "fake-indexeddb";
import { expect, it } from "vitest";
import { IdbMailStore } from "./store";

const MULT = Number(process.env.PERF_BUDGET_MULTIPLIER ?? "1");
const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setImmediate(resolve)) };

it("250 twin lookups among 50,000 ID-less messages of one sender, date and size: under 25 ms", { timeout: 600_000 }, async () => {
  const store = await IdbMailStore.open({ factory: new IDBFactory(), name: crypto.randomUUID(), instantSearch: false, platform });
  try {
    const ms = await twinLookupsMs(store);
    console.log(`250 twin lookups: ${ms.toFixed(2)} ms`);
    expect(ms).toBeLessThanOrEqual(25 * MULT);
  } finally {
    await store.close();
  }
});
