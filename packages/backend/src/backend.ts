import { lookup as dnsLookup } from "node:dns/promises";
import { nodePlatform, openDatabase, SqlMailStore } from "@terno/db";
import type { MailStore } from "@terno/store";
import { BackendCore, type BackendCoreOptions } from "./core";
import type { LookupAll } from "./net-policy";

export * from "./core";

export interface BackendOptions extends Omit<BackendCoreOptions, "store" | "platform"> {
  /** opened as a SqlMailStore on node:sqlite unless `store` is given */
  dbPath?: string;
  store?: MailStore;
  /** ids, event-loop yields and files (defaults to Node's) */
  platform?: BackendCoreOptions["platform"];
  /** searches answer from the in-memory instant index when it is current (FTS5 otherwise); with dbPath, on by default */
  instantSearch?: boolean;
}

const nodeLookup: LookupAll = (host) => dnsLookup(host, { all: true });

/**
 * The backend on Node (Electron's utility process, backend-dev, tests):
 * node:sqlite with WAL checkpoints on a worker and the instant index,
 * Node's platform, and real DNS for the network policy (loopback AI pinned
 * to the address it checked).
 */
export class Backend extends BackendCore {
  constructor(options: BackendOptions) {
    const platform = options.platform ?? nodePlatform;
    let store = options.store;
    if (!store) {
      if (!options.dbPath) throw new Error("Backend needs a store or a dbPath");
      store = new SqlMailStore(openDatabase(options.dbPath, { uuid: () => platform.uuid() }), {
        checkpointWorker: true,
        instantSearch: options.instantSearch ?? true,
        platform,
        log: (level, message, extra) => options.log?.(level, message, extra),
      });
    }
    super({ ...options, store, platform, lookup: options.lookup ?? nodeLookup });
  }
}
