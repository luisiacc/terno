import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { expect } from "vitest";
import { defineAnyOfSearch } from "../../db/src/test/search-any-of";
import { IdbMailStore } from "./store";

for (const instant of [false, true]) {
  defineAnyOfSearch(`IndexedDB (${instant ? "instant" : "scan"})`, async () => {
    const store = await IdbMailStore.open({
      name: "synthetic-any-of", factory: new IDBFactory(), instantSearch: instant,
      platform: { uuid: () => crypto.randomUUID(), yield: () => new Promise((r) => setTimeout(r, 0)) },
    });
    return {
      store, captures: false,
      search: (query) => store.threads.searchText({ query, limit: 100, now: Date.now() }),
      ready: async () => { if (instant) expect(await store.instant!.settled()).toBe(true); },
      close: () => store.close(),
    };
  });
}
