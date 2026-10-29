import { nodePlatform, nodeSqliteDriver } from "./node-driver";
import { openDatabaseWith } from "./portable";
import type { SqliteDriver } from "./connection";
import type { Db, OpenOptions } from "./sqlite";
import { compactOnOpen } from "./compact";

export * from "./portable";
export { nodePlatform, nodeSqliteDriver } from "./node-driver";
export { wasmSqliteDriver, type WasmDriverOptions, type WasmImages } from "./wasm-driver";

let defaultDriver: SqliteDriver = nodeSqliteDriver;

/** The engine openDatabase() uses (node:sqlite unless a host or test project swaps it, e.g. the db-wasm suite). */
export function useSqliteDriver(driver: SqliteDriver): void {
  defaultDriver = driver;
}

export function sqliteDriver(): SqliteDriver {
  return defaultDriver;
}

/** Opens (and migrates, unless read-only) the Terno database on the default driver (node:sqlite). */
export function openDatabase(path: string, options: OpenOptions = {}): Db {
  const db = openDatabaseWith(defaultDriver, path, { uuid: nodePlatform.uuid, ...options });
  // plan 69: a compaction a storage removal asked for, before anything reads (only this host can check the disk)
  if (!options.readonly && defaultDriver.features.compactOnOpen) compactOnOpen(db);
  return db;
}
export { compactOnOpen, type CompactOutcome } from "./compact";
