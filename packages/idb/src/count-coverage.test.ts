import "fake-indexeddb/auto";
import { it } from "vitest";
import { checkCountCoverage } from "../../store/src/conformance/count-coverage.fixture";
import { IdbMailStore } from "./store";
it("counts saved unread conversations within local coverage", async () => {
  const store = await IdbMailStore.open({ name: "count-coverage", factory: indexedDB, platform: { uuid: () => crypto.randomUUID(), yield: () => Promise.resolve() }, instantSearch: false });
  try { await checkCountCoverage(store); } finally { await store.close(); }
});
