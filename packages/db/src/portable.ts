import type { SqliteDriver } from "./connection";
import { migrate } from "./migrations";
import { registerFunctions } from "./rules";
import { Db, type OpenOptions } from "./sqlite";

export * from "./connection";
export * from "./sqlite";
export * from "./migrations";
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

/** Opens (and migrates, unless read-only) the Única database on any driver. */
export function openDatabaseWith(driver: SqliteDriver, path: string, options: OpenOptions = {}): Db {
  const db = new Db(driver, path, options);
  registerFunctions(db);
  if (!options.readonly) migrate(db);
  return db;
}
export * from "./sql-store";
export * from "./sql-provider-store";
