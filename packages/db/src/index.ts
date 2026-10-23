import { migrate } from "./migrations";
import { registerFunctions } from "./rules";
import { Db, type OpenOptions } from "./sqlite";

export * from "./sqlite";
export * from "./migrations";
export * from "./ingest";
export * from "./queries";
export * from "./search";
export * from "./rules";
export * from "./actions";
export * from "./repos";

/** Opens (and migrates, unless read-only) the Única database. */
export function openDatabase(path: string, options: OpenOptions = {}): Db {
  const db = new Db(path, options);
  registerFunctions(db);
  if (!options.readonly) migrate(db);
  return db;
}
export * from "./seed";
export * from "./checkpoint";
export * from "./owner";
