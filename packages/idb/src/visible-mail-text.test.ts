import "fake-indexeddb/auto";
import { defineVisibleStore } from "../../mail/src/test/visible-store";
import { IdbMailStore } from "./store";

const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setTimeout(resolve, 0)) };
for (const instantSearch of [false, true]) defineVisibleStore(`IDB (instant=${instantSearch})`, {
  open: () => IdbMailStore.open({ name: `visible-${crypto.randomUUID()}`, factory: indexedDB, platform, instantSearch }),
  reopen: async (store) => { const name = (store as IdbMailStore).name; await store.close(); return IdbMailStore.open({ name, factory: indexedDB, platform, instantSearch }); },
});
