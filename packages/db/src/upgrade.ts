/**
 * Plan 95: before a migration, a backup of the mailbox as it was.
 *
 * - On one APFS volume the backup is a clone made under the mailbox's
 *   exclusive lock (plan 112, `clone.ts`): milliseconds whatever its size.
 * - Elsewhere, or while another connection has the file, SQLite's backup API
 *   copies a consistent snapshot (the WAL's commits included) whatever other
 *   connections do, a few hundred pages at a time so the backend's event
 *   loop keeps answering.
 * - Each backup is an immutable generation, `backups/<createdAt>-v<from>-v<to>/`
 *   with `terno.db` and `manifest.json`: built in a `.partial-` folder,
 *   fsynced, renamed into place; only then does the previous one go. A folder
 *   without a manifest that names its own file and size is never trusted.
 * - The first backup of an upgrade is kept: a retry after a migration failed
 *   halfway (the file is at a step in between) never replaces it.
 * - Nothing here writes to the mailbox. A failure removes its partial folder
 *   and says what kind it was (no room, can't write, other).
 * - Bounded: one generation, removed 14 days after it was made once the
 *   mailbox opened upgraded; stray partial folders go at the next start.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, statfsSync, writeFileSync } from "node:fs";
import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { SCHEMA_VERSION } from "./migrations";
import { BACKUP_RETENTION_MS, fileSize, listBackups, readManifest, remove, type BackupInfo } from "./backups";
import { cloneFile, lockMailbox, sameApfsVolume } from "./clone";
import { BackupError, NoRoomError, SchemaNewerError } from "./open-errors";

export { BACKUP_RETENTION_MS, listBackups, type BackupInfo } from "./backups";

const MiB = 2 ** 20;
/** pages per backup step: ~1 MB with 4 KB pages, then the event loop gets a turn */
const PAGES_PER_STEP = 256;

export interface UpgradeOptions {
  backupsDir: string;
  appVersion: string;
  /** the user chose "Update Without a Backup" (one start only: main passes it once) */
  skipBackup?: boolean;
  /** called before the copy starts (the window says "Making a backup first") */
  onBackup?(): void;
  now?(): number;
  freeBytes?(dir: string): number;
  /** seams for tests: the backup API, fsync, the volume check, the lock and the clone */
  backup?: typeof sqliteBackup;
  volume?(file: string, dir: string): boolean;
  lock?: typeof lockMailbox;
  clone?: typeof cloneFile;
  fsync?(fd: number): void;
}

export interface UpgradePlan {
  /** the file's schema, or null when there is no mailbox yet */
  from: number | null;
  to: number;
  /** the backup this upgrade can go back to (made now or by an earlier attempt), or null */
  backup: BackupInfo | null;
  /** a backup was made by this call */
  made: boolean;
  /** how it was made: a clone (plan 112) or a full copy */
  method?: "clone" | "copy";
}

export function diskFree(dir: string): number {
  const s = statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
}

/** What a migration may need beyond the file (an estimate: a real SQLITE_FULL is caught and said the same way). */
export function migrateHeadroom(size: number): number {
  return 64 * MiB + Math.ceil(size / 2);
}

/** The mailbox's bytes as they stand: the file and its WAL. */
export function mailboxBytes(path: string): number {
  return fileSize(path) + fileSize(`${path}-wal`);
}

function fsyncPath(path: string, fsync: (fd: number) => void): void {
  const fd = openSync(path, "r");
  try {
    fsync(fd);
  } finally {
    closeSync(fd);
  }
}

/** `backups/` exists, and a new one is durable in its parent before anything is published into it */
function ensureBackupsDir(dir: string, fsync: (fd: number) => void): void {
  if (existsSync(dir)) return;
  mkdirSync(dir, { recursive: true });
  fsyncPath(dirname(dir), fsync);
}

function readSchema(path: string): number {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  } finally {
    db.close();
  }
}

/**
 * Before the mailbox is opened (and migrated): sweeps old backups, says
 * whether there is anything to migrate, and backs the file up first when
 * there is. Throws SchemaNewerError, NoRoomError or BackupError; never
 * writes to the mailbox.
 */
export async function prepareUpgrade(path: string, o: UpgradeOptions): Promise<UpgradePlan> {
  const now = o.now ?? Date.now;
  const backups = listBackups(o.backupsDir);
  if (!existsSync(path)) return { from: null, to: SCHEMA_VERSION, backup: null, made: false };
  const from = readSchema(path);
  if (from > SCHEMA_VERSION) throw new SchemaNewerError(from, SCHEMA_VERSION);
  // a current file's backup stays until the mailbox has opened (expireBackups): a header that reads may still sit on
  // damaged tables, and that backup is then the way back (Codex review R8)
  if (from === SCHEMA_VERSION) return { from, to: SCHEMA_VERSION, backup: backups.find((b) => b.toSchema === SCHEMA_VERSION) ?? null, made: false };
  // an earlier attempt at this upgrade already has the copy from before it started
  const kept = backups.find((b) => b.toSchema === SCHEMA_VERSION);
  if (kept) return { from, to: SCHEMA_VERSION, backup: kept, made: false };
  if (o.skipBackup) return { from, to: SCHEMA_VERSION, backup: null, made: false };

  const size = mailboxBytes(path);
  const freeBytes = o.freeBytes ?? diskFree;
  const headroom = migrateHeadroom(size);
  const fsync = o.fsync ?? fsyncSync;
  // plan 112: on one APFS volume the backup is a clone, free when made; elsewhere a full copy
  let clone = (o.volume ?? sameApfsVolume)(path, o.backupsDir);
  const need = () => (clone ? headroom : size + headroom);
  const before = freeBytes(dirname(path));
  if (before < need()) throw new NoRoomError("backup", need(), before, before >= headroom);

  o.onBackup?.();
  const createdAt = now();
  const id = `${createdAt}-v${from}-v${SCHEMA_VERSION}`;
  const partial = join(o.backupsDir, `.partial-${id}`);
  const file = join(partial, "terno.db");
  let method: "clone" | "copy" = "copy";
  try {
    ensureBackupsDir(o.backupsDir, fsync);
    mkdirSync(partial, { recursive: true });
    let expected: { version: number; pages: number } | null = null;
    if (clone) {
      const lock = await (o.lock ?? lockMailbox)(path);
      if (lock) {
        try {
          expected = { version: lock.version, pages: lock.pages };
          await (o.clone ?? cloneFile)(path, file);
        } finally {
          await lock.release();
        }
        // cp -c copies in full where it can't clone: then the copy's room is what's left to judge by
        const after = freeBytes(dirname(path));
        method = before - after > size / 2 ? "copy" : "clone";
        if (after < headroom) {
          // what's free once the copy is gone says whether the migration alone fits (Codex code review #4)
          remove(partial);
          const freeNow = freeBytes(dirname(path));
          throw new NoRoomError("backup", size + headroom, freeNow, freeNow >= headroom);
        }
      } else {
        // another connection has the file: the backup API's snapshot is consistent whatever it does
        clone = false;
        if (before < need()) throw new NoRoomError("backup", need(), before, before >= headroom);
      }
    }
    if (!expected) {
      const source = new DatabaseSync(path, { readOnly: true });
      try {
        expected = { version: from, pages: Number((source.prepare("PRAGMA page_count").get() as { page_count: number }).page_count) };
        await (o.backup ?? sqliteBackup)(source, file, { rate: PAGES_PER_STEP });
      } finally {
        source.close();
      }
    }
    // the copy opens, at the version it was taken from, with every page; it leaves WAL mode (both ways keep the
    // source's), so it is one self-contained file that reading never adds a -wal or -shm next to
    const copy = new DatabaseSync(file);
    try {
      copy.exec("PRAGMA journal_mode = DELETE");
      const v = Number((copy.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
      const n = Number((copy.prepare("PRAGMA page_count").get() as { page_count: number }).page_count);
      if (v !== from || v !== expected.version || n !== expected.pages) throw new Error(`backup verification failed (v${v}/${from}, ${n}/${expected.pages} pages)`);
    } finally {
      copy.close();
    }
    fsyncPath(file, fsync);
    const manifest = { file: "terno.db", fromSchema: from, toSchema: SCHEMA_VERSION, appVersion: o.appVersion, size: fileSize(file), createdAt, method };
    const manifestFile = join(partial, "manifest.json");
    writeFileSync(manifestFile, JSON.stringify(manifest), { mode: 0o600 });
    fsyncPath(manifestFile, fsync);
    fsyncPath(partial, fsync);
    renameSync(partial, join(o.backupsDir, id));
    fsyncPath(o.backupsDir, fsync);
  } catch (error) {
    remove(partial);
    if (error instanceof NoRoomError) throw error;
    const code = (error as { code?: unknown }).code;
    const rc = (error as { errcode?: unknown }).errcode;
    if (code === "ENOSPC" || code === "EDQUOT" || (typeof rc === "number" && (rc & 0xff) === 13)) {
      const freeNow = freeBytes(dirname(path));
      throw new NoRoomError("backup", size + headroom, freeNow, freeNow >= headroom, error);
    }
    const unwritable = code === "EACCES" || code === "EPERM" || code === "EROFS" || (typeof rc === "number" && [3, 8, 14].includes(rc & 0xff));
    throw new BackupError(unwritable ? "unwritable" : "failed", error);
  }
  // the new generation is in place: the older ones go
  for (const b of backups) remove(b.dir);
  return { from, to: SCHEMA_VERSION, backup: readManifest(o.backupsDir, id), made: true, method };
}

/** After the mailbox opened (healthy, at this schema): a backup past its 14 days goes. No timer: a start is the check. */
export function expireBackups(backupsDir: string, now = Date.now()): void {
  for (const b of listBackups(backupsDir)) if (b.toSchema <= SCHEMA_VERSION && now - b.createdAt >= BACKUP_RETENTION_MS) remove(b.dir);
}
