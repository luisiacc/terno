import "fake-indexeddb/auto";
import { defineVisibleStorePerf, defineVisibleUnknownPerf, defineVisibleInvalidPerf } from "../../mail/src/test/visible-store-perf";
import { IdbMailStore } from "./store";

const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setTimeout(resolve, 0)) };
for (const instantSearch of [false, true]) defineVisibleStorePerf(`IDB instant=${instantSearch}`, () => IdbMailStore.open({ name: `visible-perf-${crypto.randomUUID()}`, factory: indexedDB, platform, instantSearch }));

for (const instantSearch of [false, true]) {
  const open = () => IdbMailStore.open({ name: `visible-unknown-${crypto.randomUUID()}`, factory: indexedDB, platform, instantSearch });
  defineVisibleUnknownPerf(`IDB instant=${instantSearch}`, open);
  defineVisibleInvalidPerf(`IDB instant=${instantSearch}`, open);
}
