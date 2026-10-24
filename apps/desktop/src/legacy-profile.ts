/**
 * The app was called Única: its profile directories were "Unica…" and its
 * database "unica.db". These move to their Terno names once, by rename only
 * (never copy-then-delete, never over something that exists).
 *
 * Plain Node and erasable TypeScript only: scripts/dev.mjs
 * imports this file directly (Node strips the types).
 */
import { existsSync, readlinkSync, renameSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const DB_FILE = "terno.db";
export const LEGACY_DB_FILE = "unica.db";
export const PROFILE_PREFIX = "Terno";
export const LEGACY_PROFILE_PREFIX = "Unica";
/** what SQLite keeps beside the database: one unit with it (WAL frames only make sense with their own database) */
const UNIT = ["-wal", "-shm", "-journal"];
/** the instant index's snapshot: a cache, rebuilt if missing */
const SNAPSHOT = ".search";

export interface ProfileMigration {
  /** the legacy directory renamed to the profile, if that happened now */
  movedFrom: string | null;
  /** files renamed inside the profile (legacy name → new name) */
  renamed: string[];
  /** both names exist: the new one is used, the legacy one is left alone */
  conflicts: string[];
}

/**
 * Files of an earlier, interrupted migration whose pairing can't be trusted
 * (a terno.db WAL, shared memory or journal without terno.db): nothing was
 * renamed or opened, and the app must not start on this profile.
 */
export class LegacyProfileConflictError extends Error {
  readonly files: string[];
  constructor(files: string[]) {
    super(`Única's database can't move to Terno: ${files.join(", ")} already exist${files.length === 1 ? "s" : ""} without terno.db. Nothing was changed.`);
    this.name = "LegacyProfileConflictError";
    this.files = files;
  }
}

export class LegacyProfileInUseError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`${path} is open in another app (Única is still running). Quit it and open Terno again.`);
    this.name = "LegacyProfileInUseError";
    this.path = path;
  }
}

/** The legacy sibling of a profile directory named "Terno…", or null for any other name (an explicit path is used as is). */
export function legacyProfilePath(target: string): string | null {
  const name = basename(target);
  return name.startsWith(PROFILE_PREFIX) ? join(dirname(target), LEGACY_PROFILE_PREFIX + name.slice(PROFILE_PREFIX.length)) : null;
}

/**
 * Chromium's single-instance lock is a symlink "SingletonLock" → "<host>-<pid>".
 * A live pid means an app has this profile open right now: renaming it under
 * a running SQLite connection would split the database between two writers.
 */
export function profileInUse(dir: string, isAlive: (pid: number) => boolean = pidAlive): boolean {
  let target: string;
  try {
    target = readlinkSync(join(dir, "SingletonLock"));
  } catch {
    return false;
  }
  const pid = Number(/-(\d+)$/.exec(target)?.[1]);
  return Number.isInteger(pid) && pid > 0 && pid !== process.pid && isAlive(pid);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Terno's own sidecars lying there without terno.db: their database is unknown, so nothing may be paired with them. */
function orphanedSidecars(dir: string): string[] {
  return UNIT.map((suffix) => join(dir, DB_FILE + suffix)).filter((f) => existsSync(f));
}

/**
 * unica.db → terno.db, when terno.db doesn't exist yet. The database and its
 * WAL, shared memory and journal are one unit: first SQLite folds the WAL
 * (and any hot journal) into unica.db and closes it, so the move is a single
 * rename of a self-contained file. If Terno sidecars already lie there
 * without terno.db (an earlier run stopped halfway, and Única may have
 * written since), LegacyProfileConflictError is thrown before anything is
 * opened or renamed.
 */
export function migrateLegacyDbFiles(dir: string): Pick<ProfileMigration, "renamed" | "conflicts"> {
  const legacy = join(dir, LEGACY_DB_FILE);
  const current = join(dir, DB_FILE);
  if (!existsSync(legacy)) return { renamed: [], conflicts: [] };
  if (existsSync(current)) return { renamed: [], conflicts: [legacy] };
  const orphans = orphanedSidecars(dir);
  if (orphans.length) throw new LegacyProfileConflictError(orphans);

  const db = new DatabaseSync(legacy);
  try {
    // a hot rollback journal is rolled back by the first read; the WAL is folded in and truncated
    db.prepare("SELECT count(*) FROM sqlite_schema").get();
    const { busy } = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number };
    if (busy) throw new Error(`${legacy} is busy: its WAL couldn't be folded in`);
  } finally {
    db.close();
  }
  const unfolded = ["-wal", "-journal"].map((s) => legacy + s).filter((f) => existsSync(f) && statSync(f).size > 0);
  if (unfolded.length) throw new Error(`${unfolded.join(", ")} still hold data after closing ${legacy}: nothing was renamed`);

  const renamed: string[] = [];
  const move = (suffix: string) => {
    renameSync(legacy + suffix, current + suffix);
    renamed.push(`${LEGACY_DB_FILE}${suffix} → ${DB_FILE}${suffix}`);
  };
  // what's left of the unit is empty (an emptied WAL, shared memory SQLite rebuilds): it goes along, the database last
  for (const suffix of UNIT) if (existsSync(legacy + suffix)) move(suffix);
  move("");
  const conflicts: string[] = [];
  if (existsSync(legacy + SNAPSHOT)) {
    if (existsSync(current + SNAPSHOT)) conflicts.push(legacy + SNAPSHOT);
    else move(SNAPSHOT);
  }
  return { renamed, conflicts };
}

/**
 * Before anything opens the profile: a "Terno…" directory that doesn't exist
 * takes over its "Unica…" sibling (renamed, so a profile is never copied or
 * merged), then the database files inside are renamed. Throws
 * LegacyProfileInUseError while Única still has the legacy profile open.
 */
export function migrateLegacyProfile(target: string, options: { isAlive?: (pid: number) => boolean } = {}): ProfileMigration {
  let movedFrom: string | null = null;
  const conflicts: string[] = [];
  const legacy = legacyProfilePath(target);
  if (legacy && existsSync(legacy)) {
    if (existsSync(target)) conflicts.push(legacy);
    else {
      if (profileInUse(legacy, options.isAlive)) throw new LegacyProfileInUseError(legacy);
      // a conflict inside stops everything before the directory moves
      if (existsSync(join(legacy, LEGACY_DB_FILE)) && !existsSync(join(legacy, DB_FILE))) {
        const orphans = orphanedSidecars(legacy);
        if (orphans.length) throw new LegacyProfileConflictError(orphans);
      }
      renameSync(legacy, target);
      movedFrom = legacy;
    }
  }
  if (!existsSync(target)) return { movedFrom, renamed: [], conflicts };
  // the legacy database inside a profile that kept its path (an explicit TERNO_USER_DATA): Única may have it open
  const legacyDbOnly = existsSync(join(target, LEGACY_DB_FILE)) && !existsSync(join(target, DB_FILE));
  if (!movedFrom && legacyDbOnly && profileInUse(target, options.isAlive)) throw new LegacyProfileInUseError(target);
  const files = migrateLegacyDbFiles(target);
  return { movedFrom, renamed: files.renamed, conflicts: [...conflicts, ...files.conflicts] };
}
