/**
 * Plan 95: why a mailbox couldn't open, in kinds the window can explain.
 * Every step of an open (the pragmas, the version read, each migration, the
 * cleanup after it, the backup before it) can fail; one function sorts the
 * failure, from SQLite's result code or the file system's errno anywhere in
 * the error's cause chain. Anything it doesn't recognise stays unclassified
 * and is treated as a crash (restarted, then "The mail engine stopped").
 */

/** The file was written by a newer Terno. The message keeps the words the web worker matches. */
export class SchemaNewerError extends Error {
  override name = "SchemaNewerError";
  constructor(
    readonly schema: number,
    readonly supported: number,
  ) {
    super(`Database schema v${schema} is newer than this app (v${supported}). Update Terno.`);
  }
}

/** A migration step failed; its transaction rolled back, so the file is at the step before. */
export class MigrationError extends Error {
  override name = "MigrationError";
  constructor(
    readonly step: number,
    readonly stepName: string,
    override readonly cause: unknown,
  ) {
    // SQLite's own words (a statement's error never carries mail content) say what failed inside the step
    super(`Migration v${step} (${stepName}) failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

/** Not enough free disk for the backup or the migration (the numbers are estimates when the stage is "migrate"). */
export class NoRoomError extends Error {
  override name = "NoRoomError";
  constructor(
    readonly stage: "backup" | "migrate",
    readonly needBytes: number,
    readonly freeBytes: number,
    readonly canSkipBackup: boolean,
    override readonly cause?: unknown,
  ) {
    super(`Not enough free disk to ${stage === "backup" ? "back up" : "update"} the mailbox`);
  }
}

/** The backup before a migration failed (the mailbox itself was only read). */
export class BackupError extends Error {
  override name = "BackupError";
  constructor(
    readonly kind: "unwritable" | "failed",
    override readonly cause: unknown,
  ) {
    super(`The mailbox backup failed (${kind})`);
  }
}

export type OpenFailure =
  | { kind: "newer"; schema: number; supported: number }
  | { kind: "no-room"; stage: "backup" | "migrate"; needBytes: number; freeBytes: number; canSkipBackup: boolean }
  | { kind: "failed"; reason: "migration" | "corrupt" | "unwritable" | "backup"; step: number | null };

// SQLite's primary result codes (an extended code carries one in its low byte)
const SQLITE_IOERR = 10;
const SQLITE_CORRUPT = 11;
const SQLITE_FULL = 13;
const SQLITE_CANTOPEN = 14;
const SQLITE_READONLY = 8;
const SQLITE_PERM = 3;
const SQLITE_NOTADB = 26;

/** The SQLite primary code or errno code of an error, or of anything in its cause chain. */
function codes(error: unknown): { sqlite: number[]; errno: string[] } {
  const sqlite: number[] = [];
  const errno: string[] = [];
  const seen = new Set<unknown>();
  for (let e = error; e && typeof e === "object" && !seen.has(e); e = (e as { cause?: unknown }).cause) {
    seen.add(e);
    const o = e as { errcode?: unknown; resultCode?: unknown; code?: unknown };
    // node:sqlite says errcode, SQLite-WASM resultCode
    const rc = typeof o.errcode === "number" ? o.errcode : typeof o.resultCode === "number" ? o.resultCode : null;
    if (rc !== null) sqlite.push(rc & 0xff);
    if (typeof o.code === "string" && /^E[A-Z]+$/.test(o.code)) errno.push(o.code);
  }
  return { sqlite, errno };
}

/** What kind of failure an open (or the backup before it) ended in, or null: a crash like any other. */
export function classifyOpenError(error: unknown, estimate: () => { needBytes: number; freeBytes: number } = () => ({ needBytes: 0, freeBytes: 0 })): OpenFailure | null {
  if (error instanceof SchemaNewerError) return { kind: "newer", schema: error.schema, supported: error.supported };
  if (error instanceof NoRoomError) return { kind: "no-room", stage: error.stage, needBytes: error.needBytes, freeBytes: error.freeBytes, canSkipBackup: error.canSkipBackup };
  const step = error instanceof MigrationError ? error.step : null;
  const { sqlite, errno } = codes(error);
  if (sqlite.includes(SQLITE_FULL) || errno.includes("ENOSPC") || errno.includes("EDQUOT")) {
    const { needBytes, freeBytes } = estimate();
    return { kind: "no-room", stage: error instanceof BackupError ? "backup" : "migrate", needBytes, freeBytes, canSkipBackup: false };
  }
  if (sqlite.includes(SQLITE_CORRUPT) || sqlite.includes(SQLITE_NOTADB)) return { kind: "failed", reason: "corrupt", step };
  if (error instanceof BackupError) return { kind: "failed", reason: error.kind === "unwritable" ? "unwritable" : "backup", step: null };
  if (
    sqlite.includes(SQLITE_READONLY) ||
    sqlite.includes(SQLITE_CANTOPEN) ||
    sqlite.includes(SQLITE_PERM) ||
    sqlite.includes(SQLITE_IOERR) ||
    errno.some((c) => c === "EACCES" || c === "EPERM" || c === "EROFS" || c === "EIO")
  ) {
    return { kind: "failed", reason: "unwritable", step };
  }
  if (error instanceof MigrationError) return { kind: "failed", reason: "migration", step };
  return null;
}
