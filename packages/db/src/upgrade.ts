/**
 * Before the mailbox is opened (and migrated): its schema, read without
 * writing anything, and the disk an update may need. There is no backup
 * (plan 255): a step that fails rolls back in its own transaction, a step
 * that only adds destroys nothing, and one that rewrites rows says why
 * (`Migration.rewrites`).
 */
import { existsSync, statfsSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_VERSION } from "./migrations";
import { SchemaNewerError } from "./open-errors";

const MiB = 2 ** 20;

export function diskFree(dir: string): number {
  const s = statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
}

/** What a migration may need beyond the file (an estimate: a real SQLITE_FULL is caught and said the same way). */
export function migrateHeadroom(size: number): number {
  return 64 * MiB + Math.ceil(size / 2);
}

const fileSize = (path: string) => {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
};

/** The mailbox's bytes as they stand: the file and its WAL. */
export function mailboxBytes(path: string): number {
  return fileSize(path) + fileSize(`${path}-wal`);
}

/**
 * The file's schema, or null when there is no mailbox yet. Throws
 * SchemaNewerError for one a newer Terno wrote, before anything opens it
 * for writing.
 */
export function mailboxSchema(path: string): number | null {
  if (!existsSync(path)) return null;
  const db = new DatabaseSync(path, { readOnly: true });
  let schema: number;
  try {
    schema = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  } finally {
    db.close();
  }
  if (schema > SCHEMA_VERSION) throw new SchemaNewerError(schema, SCHEMA_VERSION);
  return schema;
}

/**
 * An earlier build's pre-update backups (plans 95, 112, 253): nothing reads them now, and a clone holds disk. Off the
 * opening's way (a large file takes a while to free); one cut short by a quit is finished at the next start.
 */
export function removeOldBackups(path: string): Promise<void> {
  const dir = join(dirname(path), "backups");
  if (!existsSync(dir)) return Promise.resolve();
  return rm(dir, { recursive: true, force: true }).catch(() => {});
}
