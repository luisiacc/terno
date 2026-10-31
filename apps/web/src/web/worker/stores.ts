import { BrowserBodyUpgrades } from "./body-upgrade";
import { RpcError } from "@terno/core/rpc";
import { L } from "@terno/i18n";
import type { SAHPoolUtil, Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import { openDatabaseWith, SqlMailStore, wasmSqliteDriver } from "@terno/db/wasm";
import { idbAdapter } from "@terno/idb";
import { StoreRegistry, type StoreAdapter } from "@terno/store";
import { WEB_SEARCH_MEMORY } from "@terno/store/instant";

export const DEFAULT_MAILBOX = "terno";

/** OPFS's synchronous access handles exist only in dedicated workers (Chrome 108+, Safari 16.4+, Firefox 111+). */
const hasSyncHandles = () => typeof FileSystemFileHandle !== "undefined" && "createSyncAccessHandle" in FileSystemFileHandle.prototype;

/**
 * SQLite-WASM on OPFS (sahpool VFS): the web's default. The same SQL,
 * migrations, FTS5 and instant index as desktop, synchronous in this worker.
 * The pool holds an access handle per file for as long as it is installed,
 * so one tab at a time (Web Locks) and `release()` before handing over.
 */
export class OpfsSqliteAdapter implements StoreAdapter {
  readonly id = "opfs-sqlite";
  readonly label = "SQLite (OPFS)";
  readonly automatic = true;
  private pool: Promise<SAHPoolUtil> | null = null;
  private activeStores = 0;
  private opening = false;

  constructor(private readonly sqlite3: Sqlite3Static, private readonly upgrades = new BrowserBodyUpgrades()) {}

  /** The pool (installed once). Failures (another tab still holds the handles, storage errors) surface to open(): never "unavailable". */
  install(): Promise<SAHPoolUtil> {
    this.pool ??= this.sqlite3.installOpfsSAHPoolVfs({ name: "terno-sahpool", directory: ".terno-sahpool", initialCapacity: 8, preserveOnInitFailure: true }).catch((error) => {
      this.pool = null;
      throw error;
    });
    return this.pool;
  }

  async available(): Promise<boolean> {
    return hasSyncHandles();
  }

  async exists(name: string): Promise<boolean> {
    return (await this.install()).getFileNames().includes(`/${name}.db`);
  }

  async open(o: Parameters<StoreAdapter["open"]>[0]): Promise<SqlMailStore> {
    if (this.opening) throw new RpcError("UNAVAILABLE", L("errors.mail.processingBusy"));
    this.opening = true;
    try {
    this.upgrades.signal.throwIfAborted();
    const pool = await this.install();
    if (pool.isPaused()) await pool.unpauseVfs();
    this.upgrades.signal.throwIfAborted();
    if (pool.getFileNames().includes(`/${o.name}.db`)) {
      if (this.activeStores) throw new RpcError("UNAVAILABLE", L("errors.mail.processingBusy"));
      pool.pauseVfs();
      await this.upgrades.run("opfs", o.name);
      this.upgrades.signal.throwIfAborted();
      await pool.unpauseVfs();
    }
    // a main db, its journal and spare slots for a second mailbox (perf runs)
    await pool.reserveMinimumCapacity(8);
    this.upgrades.signal.throwIfAborted();
    const db = openDatabaseWith(wasmSqliteDriver(this.sqlite3, { pool, bodyPreparation: o.platform.bodyPreparation }), `/${o.name}.db`, { uuid: () => o.platform.uuid() });
    const store = new SqlMailStore(db, { instantSearch: o.instantSearch === false ? false : { memory: WEB_SEARCH_MEMORY }, platform: o.platform, log: o.log });
    this.activeStores++;
    const close = store.close.bind(store);
    let closed: Promise<void> | undefined;
    store.close = () => closed ??= close().finally(() => { this.activeStores--; });
    return store;
    } finally { this.opening = false; }
  }

  /** Releases every access handle (the database must be closed): another tab may open the mailbox now. */
  async release(): Promise<void> {
    await this.upgrades.close();
    const pool = await this.pool?.catch(() => null);
    if (pool && !pool.isPaused()) pool.pauseVfs();
  }
}

/**
 * The adapters this browser build offers, in preference order (see
 * docs/STORAGE.md): SQLite on OPFS by default; IndexedDB by `?storage=idb`,
 * for a mailbox that already lives there, and automatically only where OPFS
 * sync handles are missing (it passed conformance in Node and Chromium and
 * the web-perf budgets at 10k and 50k before becoming automatic).
 */
export function webStores(sqlite3: Sqlite3Static): { registry: StoreRegistry; release(): Promise<void>; pool(): Promise<SAHPoolUtil> } {
  const upgrades = new BrowserBodyUpgrades();
  const opfs = new OpfsSqliteAdapter(sqlite3, upgrades);
  const registry = new StoreRegistry().register(opfs).register(idbAdapter(indexedDB, { automatic: true, signal: upgrades.signal, legacyUpgrade: (name) => upgrades.run("idb", name) }));
  return { registry, release: () => opfs.release(), pool: () => opfs.install() };
}
