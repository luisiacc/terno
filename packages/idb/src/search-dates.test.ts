import { IDBFactory } from "fake-indexeddb";
import { expect } from "vitest";
import { defineDateSearch } from "../../db/src/test/search-dates";
import { IdbMailStore } from "./store";

for (const instant of [false, true]) {
  defineDateSearch(`IndexedDB (${instant ? "instant" : "fallback"})`, async (now) => {
    const store = await IdbMailStore.open({
      name: "synthetic-date-search", factory: new IDBFactory(), instantSearch: instant,
      platform: { uuid: () => crypto.randomUUID(), yield: () => new Promise((r) => setTimeout(r, 0)) },
    });
    return {
      store, instant, fallback: "scan",
      search: (query, cursor, limit = 100) => store.threads.searchText({ query, cursor, limit, now }),
      ready: async () => { if (instant) expect(await store.instant!.settled()).toBe(true); },
      close: () => store.close(),
    };
  });
}
