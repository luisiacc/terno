import type { StoreAdapter } from "@unica/store";
import { IdbMailStore } from "./store";

export { IdbMailStore, type IdbMailStoreOptions } from "./store";
export { databaseName, IDB_VERSION, LOGICAL_SCHEMA } from "./schema";

/**
 * The registry entry for IndexedDB. Hosts make it automatic only once it
 * has passed conformance and their perf gate (the web does, registered
 * after OPFS SQLite: the fallback where OPFS sync handles are missing);
 * otherwise it is reachable by explicit choice (`?storage=idb`) or for a
 * mailbox that already lives here.
 */
export function idbAdapter(factory: IDBFactory, o: { automatic?: boolean } = {}): StoreAdapter {
  return {
    id: "idb",
    label: "IndexedDB",
    automatic: o.automatic ?? false,
    available: async () => typeof factory?.open === "function",
    exists: (name) => IdbMailStore.exists(factory, name),
    open: (opts) => IdbMailStore.open({ name: opts.name, factory, platform: opts.platform, instantSearch: opts.instantSearch, log: opts.log }),
  };
}
