/**
 * Plan 95: putting a backup back in place of a mailbox that can't open, run
 * by main while the backend is stopped. It is journaled so a crash or a
 * power cut at any point leaves either the old mailbox or the restored one,
 * never neither and never a mix:
 *
 * 1. the copy is prepared beside the mailbox (`terno.db.restoring`) and checked
 * 2. the journal (`terno.db.restore.json`) is written
 * 3. the live WAL, then the file, move aside (`terno.db.before-restore[-wal]`;
 *    the SHM is SQLite's to rebuild): the old WAL must never meet the new file
 * 4. the copy is renamed into place, the marker that tells the backend to
 *    quarantine it (`terno.db.restored.json`) is written, the journal goes
 *
 * `reconcileRestore` runs before every backend start and settles a journal
 * left behind: the copy in place with the old one aside means finished;
 * anything else is put back as it was.
 */
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, statfsSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import type { BackupInfo } from "@terno/db/backups";
import { cloneFile, sameApfsVolume } from "@terno/db/clone";

const MiB = 2 ** 20;
export const BEFORE_RESTORE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

export const restorePaths = (db: string) => ({
  journal: `${db}.restore.json`,
  restoring: `${db}.restoring`,
  aside: `${db}.before-restore`,
  marker: `${db}.restored.json`,
});

export class RestoreError extends Error {
  override name = "RestoreError";
  constructor(
    readonly kind: "no-room" | "failed",
    override readonly cause?: unknown,
  ) {
    super(`The restore didn't happen (${kind})`);
  }
}

export interface RestoreDeps {
  freeBytes?(dir: string): number;
  fsync?(fd: number): void;
  now?(): number;
  /** a seam for tests: fails the step named, as a crash or a disk error would */
  fault?(step: "copy" | "journal" | "aside-wal" | "aside" | "swap" | "marker"): void;
  /** a seam for tests: what was made durable, in order (a file or a folder) */
  synced?(path: string): void;
  /** seams for tests: whether the backup can be cloned beside the mailbox, and the clone */
  volume?(file: string, dir: string): boolean;
  clone?(src: string, dst: string): Promise<void>;
}

const exists = (p: string) => existsSync(p);

let onSynced: ((path: string) => void) | undefined;

function syncFile(path: string, fsync: (fd: number) => void): void {
  const fd = openSync(path, "r");
  try {
    fsync(fd);
  } finally {
    closeSync(fd);
  }
  onSynced?.(path);
}

/** Written through a temp file, then the rename itself made durable (the folder's fsync): a power cut keeps it or not. */
function writeDurably(path: string, text: string, fsync: (fd: number) => void): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  syncFile(tmp, fsync);
  renameSync(tmp, path);
  syncFile(dirname(path), fsync);
}

/** The marker the backend reads at start: quarantine this mailbox, then say it was restored from `createdAt`. */
export function readRestoredMarker(db: string): { createdAt: number } | null {
  try {
    const v = JSON.parse(readFileSync(restorePaths(db).marker, "utf8")) as { createdAt?: unknown };
    return typeof v.createdAt === "number" ? { createdAt: v.createdAt } : null;
  } catch {
    return null;
  }
}

/**
 * The backend, before it starts on a restored mailbox: quarantine it, make
 * that durable (commits are fsynced only at a checkpoint with
 * synchronous=NORMAL), and only then drop the marker, durably. A power cut
 * anywhere leaves the marker, so the next start quarantines again.
 */
export function settleRestored(
  db: { get<T>(sql: string): T | undefined },
  path: string,
  quarantine: () => void,
  fsync: (fd: number) => void = fsyncSync,
): { createdAt: number } | null {
  const marker = readRestoredMarker(path);
  if (!marker) return null;
  quarantine();
  const r = db.get<{ busy: number; log: number; checkpointed: number }>("PRAGMA wal_checkpoint(FULL)");
  if (!r || r.busy !== 0 || r.log !== r.checkpointed) throw new Error("the restored mailbox's quarantine isn't on disk yet");
  rmSync(restorePaths(path).marker, { force: true });
  syncFile(dirname(path), fsync);
  return marker;
}

function stamp(path: string, at: number): void {
  try {
    utimesSync(path, at / 1000, at / 1000);
  } catch {
    /* gone: nothing to keep */
  }
}

/** Restores `backup` over the mailbox at `db`. Throws RestoreError; on any failure the mailbox is as it was. */
export async function restoreFromBackup(db: string, backup: BackupInfo, deps: RestoreDeps = {}): Promise<void> {
  onSynced = deps.synced;
  try {
    await restore(db, backup, deps);
  } finally {
    onSynced = undefined;
  }
}

async function restore(db: string, backup: BackupInfo, deps: RestoreDeps): Promise<void> {
  const p = restorePaths(db);
  const fsync = deps.fsync ?? fsyncSync;
  const fault = deps.fault ?? (() => {});
  const freeBytes = deps.freeBytes ?? ((dir: string) => { const s = statfsSync(dir); return Number(s.bavail) * Number(s.bsize); });
  const free = freeBytes(dirname(db));
  // plan 112: a clone on the backup's own APFS volume takes no room when made (Node's COPYFILE_FICLONE copies in full)
  const clone = (deps.volume ?? sameApfsVolume)(backup.file, dirname(db));
  if (free < (clone ? 0 : backup.size) + 64 * MiB) throw new RestoreError("no-room");
  // what an earlier restore set aside goes now: the journal's states are only unambiguous without it
  for (const f of [p.aside, `${p.aside}-wal`, p.restoring]) rmSync(f, { force: true });
  try {
    fault("copy");
    // off main's thread (a large mailbox takes a while); a clone where the volume can (the backup never changes)
    if (clone) {
      await (deps.clone ?? cloneFile)(backup.file, p.restoring);
      // cp copies in full where it can't clone: the margin is checked again before anything moves (Codex code review #3)
      if (freeBytes(dirname(db)) < 64 * MiB) throw Object.assign(new Error("no room left after the copy"), { code: "ENOSPC" });
    } else await copyFile(backup.file, p.restoring);
    syncFile(p.restoring, fsync);
    const check = new DatabaseSync(p.restoring, { readOnly: true });
    try {
      const v = (check.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
      if (Number(v) !== backup.fromSchema) throw new Error("the backup isn't the version its manifest says");
    } finally {
      check.close();
    }
  } catch (error) {
    rmSync(p.restoring, { force: true });
    const code = (error as { code?: unknown }).code;
    throw new RestoreError(code === "ENOSPC" || code === "EDQUOT" ? "no-room" : "failed", error);
  }
  try {
    fault("journal");
    // durable (the folder too) before anything moves: a power cut that kept a move must keep the journal that undoes it
    writeDurably(p.journal, JSON.stringify({ createdAt: backup.createdAt, at: (deps.now ?? Date.now)() }), fsync);
    fault("aside-wal");
    if (exists(`${db}-wal`)) renameSync(`${db}-wal`, `${p.aside}-wal`);
    rmSync(`${db}-shm`, { force: true });
    fault("aside");
    if (exists(db)) renameSync(db, p.aside);
    // the set-aside mailbox is kept 14 days from now, not from when it was last written (a rename keeps its mtime)
    stamp(p.aside, (deps.now ?? Date.now)());
    syncFile(dirname(db), fsync);
    fault("swap");
    renameSync(p.restoring, db);
    fault("marker");
    writeDurably(p.marker, JSON.stringify({ createdAt: backup.createdAt }), fsync);
    syncFile(dirname(db), fsync);
    rmSync(p.journal, { force: true });
  } catch (error) {
    // what a crash at this point would leave, settled now the same way the next start would (past the swap, that
    // is a finished restore)
    if (reconcileRestore(db, deps) === "completed") return;
    throw new RestoreError("failed", error);
  }
}

/**
 * Before a backend start: a journal left by a restore that didn't finish is
 * settled. Returns what happened, or null when there was nothing to do.
 */
export function reconcileRestore(db: string, deps: Pick<RestoreDeps, "fsync" | "now"> = {}): "completed" | "rolled-back" | null {
  const p = restorePaths(db);
  const now = (deps.now ?? Date.now)();
  // a mailbox set aside by a finished restore is kept for a while, then goes (no timer: a start is the check)
  if (!exists(p.journal)) {
    rmSync(p.restoring, { force: true });
    try {
      if (exists(p.aside) && now - statSync(p.aside).mtimeMs >= BEFORE_RESTORE_RETENTION_MS) for (const f of [p.aside, `${p.aside}-wal`]) rmSync(f, { force: true });
    } catch {
      /* next start */
    }
    return null;
  }
  let createdAt = 0;
  try {
    createdAt = Number((JSON.parse(readFileSync(p.journal, "utf8")) as { createdAt?: unknown }).createdAt) || 0;
  } catch {
    /* a torn journal: what's on disk decides */
  }
  if (exists(db) && exists(p.aside) && !exists(p.restoring)) {
    // the copy is in place and the old mailbox aside: finished but for the marker and the journal
    if (!exists(p.marker)) writeDurably(p.marker, JSON.stringify({ createdAt }), deps.fsync ?? fsyncSync);
    stamp(p.aside, now);
    rmSync(p.journal, { force: true });
    return "completed";
  }
  // anything else: the old mailbox goes back where it was (its WAL with it), and the copy goes
  if (!exists(db) && exists(p.aside)) renameSync(p.aside, db);
  if (!exists(`${db}-wal`) && exists(`${p.aside}-wal`)) renameSync(`${p.aside}-wal`, `${db}-wal`);
  rmSync(p.restoring, { force: true });
  // a marker can only be an earlier restore's (this one writes its own after the swap): the backend still owes it
  rmSync(p.journal, { force: true });
  return "rolled-back";
}
