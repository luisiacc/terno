import { nodePlatform, nodeSqliteDriver } from "./node-driver";
import { openDatabaseWith } from "./portable";
import type { Db, OpenOptions } from "./sqlite";

export * from "./portable";
export { nodePlatform, nodeSqliteDriver } from "./node-driver";

/** Opens (and migrates, unless read-only) the Única database with node:sqlite. */
export function openDatabase(path: string, options: OpenOptions = {}): Db {
  return openDatabaseWith(nodeSqliteDriver, path, { uuid: nodePlatform.uuid, ...options });
}
