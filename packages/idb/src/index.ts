import type { StoreAdapter } from "@unica/store";
import { IdbMailStore } from "./store";

export { IdbMailStore, type IdbMailStoreOptions } from "./store";
export { databaseName, IDB_VERSION, LOGICAL_SCHEMA } from "./schema";

/**
 * The registry entry for IndexedDB. Not automatic until it has passed
 * conformance and the browser perf gate (then hosts flip `automatic`):
 * reachable by explicit choice (`?storage=idb`) or for a mailbox that
 * already lives here.
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
