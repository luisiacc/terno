import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { defineGmailRefreshConformance } from "../../store/src/conformance/gmail-refresh";
import { IdbMailStore } from "./store";
const factory = new IDBFactory();
const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setImmediate(resolve)) };
defineGmailRefreshConformance("IDB", {
  open: () => IdbMailStore.open({ name: crypto.randomUUID(), factory, platform, instantSearch: false }),
  async reopen(store) { const name = (store as IdbMailStore).name; await store.close(); return IdbMailStore.open({ name, factory, platform, instantSearch: false }); },
});
