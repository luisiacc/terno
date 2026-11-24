import { registerBodyMatches } from "./body-parts";
import type { SqliteDriver } from "./connection";
import { migrate } from "./migrations";
import { flushSearchOutbox } from "./outbox";
import { registerFunctions } from "./rules";
import { Db, type OpenOptions } from "./sqlite";

export * from "./connection";
export * from "./sqlite";
export * from "./migrations";
export * from "./open-errors";
export * from "./ingest";
export * from "./queries";
export * from "./search";
export * from "./search-engine";
export * from "./search-docs";
export * from "./rules";
export * from "./actions";
export * from "./repos";
export * from "./seed";
export * from "./checkpoint";
export * from "./owner";
export * from "./categorize";
export * from "./categorize-bulk";
export * from "./outbox";
export * from "./restore";

/** Opens (and migrates, unless read-only) the Terno database on any driver. */
export function openDatabaseWith(driver: SqliteDriver, path: string, options: OpenOptions = {}): Db {
  const db = new Db(driver, path, options);
  try {
    registerFunctions(db);
    registerBodyMatches(db);
    if (!options.readonly) {
      migrate(db);
      db.onBeforeCommit(() => flushSearchOutbox(db, options.searchLogBytes));
      // no build survives a restart; writes made outside a transaction are batched now
      db.tx(() => db.run("DELETE FROM search_leases"));
    }
  } catch (error) {
    // plan 95: a mailbox that didn't open isn't left open (the window explains the error, a retry opens it again)
    try { db.close(); } catch { /* the open's error is the one that explains it */ }
    throw error;
  }
  return db;
}
export * from "./sql-store";
export * from "./sql-provider-store";
export * from "./page-cache";

export * from "./body-upgrade";
