import { lookup as dnsLookup } from "node:dns/promises";
import { nodePlatform, openDatabase, SqlMailStore } from "@terno/db";
import type { MailStore } from "@terno/store";
import { BackendCore, type BackendCoreOptions } from "./core";
import type { LookupAll } from "./net-policy";
import { nodeIconTransport } from "./icons/node-transport";
import { createNodeIncomingProcessor } from "./incoming-worker";

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

/** where Node's fetch finds its dispatcher (npm undici's setGlobalDispatcher writes the same slot) */
const DISPATCHER = Symbol.for("undici.globalDispatcher.1");

/**
 * Plan 20: Node's fetch (undici) keeps pooled keep-alive sockets that a network change killed
 * silently (a server can stretch their life to 10 minutes). New requests get a fresh dispatcher;
 * the old one is closed: its idle sockets go now, requests still in flight (a send) finish on it.
 */
export function resetFetchSockets(): void {
  const slot = globalThis as unknown as Record<symbol, { close?: () => Promise<void> } | undefined>;
  const old = slot[DISPATCHER];
  // nothing fetched yet: no pool to drop
  if (!old || typeof old.close !== "function") return;
  try {
    slot[DISPATCHER] = new (old.constructor as new () => { close(): Promise<void> })();
  } catch {
    return;
  }
  void old.close().catch(() => {});
}

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
    // plan 22: website icons over node:https (public addresses only) unless the host says otherwise (null: none)
    const iconTransport = options.iconTransport === undefined ? nodeIconTransport() : options.iconTransport;
    super({ ...options, store, platform, lookup: options.lookup ?? nodeLookup, onNetworkReset: options.onNetworkReset ?? resetFetchSockets, iconTransport, incomingProcessor: options.incomingProcessor ?? createNodeIncomingProcessor() });
  }
}
