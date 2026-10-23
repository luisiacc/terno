import type { SAHPoolUtil, Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import { openDatabaseWith, SqlMailStore, wasmSqliteDriver } from "@unica/db/wasm";
import { StoreRegistry, type StoreAdapter } from "@unica/store";
import { WEB_SEARCH_MEMORY } from "@unica/store/instant";

export const DEFAULT_MAILBOX = "unica";

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

  constructor(private readonly sqlite3: Sqlite3Static) {}

  private install(): Promise<SAHPoolUtil> {
    // installation failures (another tab still holds the handles, storage errors) surface to open(): never "unavailable"
    this.pool ??= this.sqlite3.installOpfsSAHPoolVfs({ name: "unica-sahpool", directory: ".unica-sahpool", initialCapacity: 8, preserveOnInitFailure: true }).catch((error) => {
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
    const pool = await this.install();
    // a main db, its journal and spare slots for a second mailbox (perf runs)
    await pool.reserveMinimumCapacity(8);
    const db = openDatabaseWith(wasmSqliteDriver(this.sqlite3, { pool }), `/${o.name}.db`, { uuid: () => o.platform.uuid() });
    return new SqlMailStore(db, { instantSearch: { memory: WEB_SEARCH_MEMORY }, platform: o.platform, log: o.log });
  }

  /** Releases every access handle (the database must be closed): another tab may open the mailbox now. */
  async release(): Promise<void> {
    const pool = await this.pool?.catch(() => null);
    if (pool && !pool.isPaused()) pool.pauseVfs();
  }
}

/** The adapters this browser build offers, in preference order. */
export function webStores(sqlite3: Sqlite3Static): { registry: StoreRegistry; release(): Promise<void> } {
  const opfs = new OpfsSqliteAdapter(sqlite3);
  const registry = new StoreRegistry().register(opfs);
  return { registry, release: () => opfs.release() };
}
