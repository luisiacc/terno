import { nodePlatform, nodeSqliteDriver } from "./node-driver";
import { openDatabaseWith } from "./portable";
import type { SqliteDriver } from "./connection";
import type { Db, OpenOptions } from "./sqlite";

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

/** Opens (and migrates, unless read-only) the Única database on the default driver (node:sqlite). */
export function openDatabase(path: string, options: OpenOptions = {}): Db {
  return openDatabaseWith(defaultDriver, path, { uuid: nodePlatform.uuid, ...options });
}
