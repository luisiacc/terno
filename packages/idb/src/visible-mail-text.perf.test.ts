import "fake-indexeddb/auto";
import { defineVisibleStorePerf } from "../../mail/src/test/visible-store-perf";
import { IdbMailStore } from "./store";

const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setTimeout(resolve, 0)) };
for (const instantSearch of [false, true]) defineVisibleStorePerf(`IDB instant=${instantSearch}`, () => IdbMailStore.open({ name: `visible-perf-${crypto.randomUUID()}`, factory: indexedDB, platform, instantSearch }));
