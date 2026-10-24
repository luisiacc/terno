/**
 * The app was called Única: its profile directories were "Unica…" and its
 * database "unica.db". These move to their Terno names once, by rename only
 * (never copy-then-delete, never over something that exists).
 *
 * Plain Node and erasable TypeScript only: scripts/dev.mjs
 * imports this file directly (Node strips the types).
 */
import { existsSync, readlinkSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const DB_FILE = "terno.db";
export const LEGACY_DB_FILE = "unica.db";
export const PROFILE_PREFIX = "Terno";
export const LEGACY_PROFILE_PREFIX = "Unica";
/** what lives beside the database: WAL, shared memory, a rollback journal, the instant index's snapshot */
const SIDECARS = ["-wal", "-shm", "-journal", ".search"];

export interface ProfileMigration {
  /** the legacy directory renamed to the profile, if that happened now */
  movedFrom: string | null;
  /** files renamed inside the profile (legacy name → new name) */
  renamed: string[];
  /** both names exist: the new one is used, the legacy one is left alone */
  conflicts: string[];
}

export class LegacyProfileInUseError extends Error {
  constructor(readonly path: string) {
    super(`${path} is open in another app (Única is still running). Quit it and open Terno again.`);
    this.name = "LegacyProfileInUseError";
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

/**
 * unica.db (and its sidecars) → terno.db, when terno.db doesn't exist yet.
 * Sidecars move first and the database last: interrupted halfway, the next
 * run still sees unica.db and finishes, and a WAL never ends up beside the
 * wrong database. A sidecar whose new name exists is left where it is.
 */
export function migrateLegacyDbFiles(dir: string): Pick<ProfileMigration, "renamed" | "conflicts"> {
  const renamed: string[] = [];
  const conflicts: string[] = [];
  const legacy = join(dir, LEGACY_DB_FILE);
  const current = join(dir, DB_FILE);
  if (!existsSync(legacy)) return { renamed, conflicts };
  if (existsSync(current)) return { renamed, conflicts: [legacy] };
  for (const suffix of [...SIDECARS, ""]) {
    const from = legacy + suffix;
    const to = current + suffix;
    if (!existsSync(from)) continue;
    if (existsSync(to)) {
      conflicts.push(from);
      continue;
    }
    renameSync(from, to);
    renamed.push(`${LEGACY_DB_FILE}${suffix} → ${DB_FILE}${suffix}`);
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
