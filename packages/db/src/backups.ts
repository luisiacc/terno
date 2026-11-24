/**
 * Plan 95: the backups folder, read without SQLite (main reads it too, to
 * restore, and stays small): each generation is `<createdAt>-v<from>-v<to>/`
 * with `terno.db` and `manifest.json`; a folder whose manifest doesn't name
 * its own file and size is never trusted, and goes.
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export const BACKUP_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
export interface BackupInfo {
  /** the generation's folder name */
  id: string;
  dir: string;
  file: string;
  fromSchema: number;
  toSchema: number;
  appVersion: string;
  size: number;
  createdAt: number;
}

export const fileSize = (path: string) => {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
};

/** Housekeeping never fails an open: a folder that won't go is tried again next start. */
export function remove(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    /* next start */
  }
}

export function readManifest(dir: string, id: string): BackupInfo | null {
  try {
    const m = JSON.parse(readFileSync(join(dir, id, "manifest.json"), "utf8")) as Record<string, unknown>;
    const file = join(dir, id, "terno.db");
    const ok = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
    if (!ok(m.fromSchema) || !ok(m.toSchema) || !ok(m.size) || !ok(m.createdAt) || typeof m.appVersion !== "string") return null;
    // the manifest names its own file: one of another size is a different (or broken) copy, unless a settle cut short
    // left its journal, whose playback puts the size back (plan 253)
    if (m.file !== "terno.db" || (fileSize(file) !== m.size && !existsSync(`${file}-journal`))) return null;
    return { id, dir: join(dir, id), file, fromSchema: m.fromSchema, toSchema: m.toSchema, appVersion: m.appVersion, size: m.size, createdAt: m.createdAt };
  } catch {
    return null;
  }
}

/** The valid generations, newest first; partial and broken folders removed. */
export function listBackups(backupsDir: string): BackupInfo[] {
  let names: string[];
  try {
    names = readdirSync(backupsDir);
  } catch {
    return [];
  }
  const out: BackupInfo[] = [];
  for (const name of names) {
    if (name.startsWith(".")) {
      // a backup a crash or a quit cut short (".partial-…"); nothing else of ours starts with a dot
      if (name.startsWith(".partial-")) remove(join(backupsDir, name));
      continue;
    }
    const info = readManifest(backupsDir, name);
    if (info) out.push(info);
    else remove(join(backupsDir, name));
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Still to settle: the header says WAL (bytes 18–19 are 2), or a rollback
 * journal beside it (a settle cut short) is still to be played back.
 */
export function unsettled(file: string): boolean {
  if (existsSync(`${file}-journal`)) return true;
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    const b = new Uint8Array(2);
    return readSync(fd, b, 0, 2, 18) === 2 && (b[0] === 2 || b[1] === 2);
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** The kept backup that still has to be settled, or null. */
export function backupToSettle(backupsDir: string): string | null {
  return listBackups(backupsDir).find((b) => unsettled(b.file))?.file ?? null;
}
