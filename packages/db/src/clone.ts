/**
 * Plan 112: the backup before a migration as an APFS clone, so an update's
 * first start doesn't wait for a copy of the whole mailbox.
 *
 * - A worker thread takes the mailbox's exclusive lock (any other connection
 *   makes it step aside) and folds the WAL into the file, off the backend's
 *   event loop; the lock holds until the clone is made, and dies with the
 *   process.
 * - The clone is `/bin/cp -c` (clonefile(2)): Node's COPYFILE_FICLONE copies
 *   in full on macOS (measured: 8–20 s for 2 GB; `cp -c` 30 ms).
 */
import { execFile, type ChildProcess } from "node:child_process";
import { existsSync, statfsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { Worker } from "node:worker_threads";

/** statfs f_type of APFS on macOS */
const APFS = 26;

/** The file and the folder (or, before it exists, its parent) are on one APFS volume, so a clone between them shares blocks. */
export function sameApfsVolume(file: string, dir: string): boolean {
  if (process.platform !== "darwin") return false;
  if (!existsSync(dir)) dir = dirname(dir);
  try {
    return statfsSync(dir).type === APFS && statSync(file).dev === statSync(dir).dev;
  } catch {
    return false;
  }
}

const children = new Set<ChildProcess>();
// a quit mid-clone: the copy is a partial folder the next start removes, never a process left writing it
process.once("exit", () => {
  for (const c of children) c.kill();
});

/** Ends a clone in flight (the backend's shutdown): its promise rejects, its partial folder goes. */
export function cancelClones(): void {
  for (const c of children) c.kill();
}

/** cp says why in words; the classifier reads errno codes */
export function cpError(stderr: string, fallback: unknown): Error {
  const code = /No space left|Disc quota exceeded/i.test(stderr) ? "ENOSPC" : /Read-only file system/i.test(stderr) ? "EROFS" : /Permission denied|Operation not permitted/i.test(stderr) ? "EACCES" : undefined;
  return Object.assign(new Error(`cp -c failed: ${stderr.trim() || String(fallback)}`), code ? { code } : {}, { cause: fallback });
}

/** A clone of `src` at `dst` (a full copy where the volume can't clone; the caller checks the space it took). */
export function cloneFile(src: string, dst: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile("/bin/cp", ["-c", src, dst], (error, _stdout, stderr) => {
      children.delete(child);
      if (error) reject(cpError(String(stderr ?? ""), error));
      else resolve();
    });
    children.add(child);
  });
}

/**
 * Inlined (eval) so it survives bundling. Exclusive locking mode is set
 * before the connection's first access, so in WAL mode it takes the file's
 * lock outright (no shared memory) and keeps it until the connection closes.
 */
const LOCK_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const { statSync } = require("node:fs");
let db = null;
const walBytes = () => { try { return statSync(workerData.path + "-wal").size; } catch { return 0; } };
try {
  db = new DatabaseSync(workerData.path);
  db.exec("PRAGMA busy_timeout = 0");
  db.exec("PRAGMA checkpoint_fullfsync = ON");
  db.exec("PRAGMA locking_mode = EXCLUSIVE");
  db.exec("BEGIN EXCLUSIVE");
  db.exec("COMMIT");
  const c = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  if (c.busy !== 0 || walBytes() !== 0) throw Object.assign(new Error("checkpoint incomplete"), { busy: true });
  const version = Number(db.prepare("PRAGMA user_version").get().user_version);
  const pages = Number(db.prepare("PRAGMA page_count").get().page_count);
  parentPort.postMessage({ locked: true, version, pages });
} catch (e) {
  const rc = typeof (e && e.errcode) === "number" ? e.errcode & 0xff : 0;
  try { if (db) db.close(); } catch {}
  db = null;
  // SQLITE_BUSY (5) or LOCKED (6): another connection has the file; anything else is the open's to explain
  parentPort.postMessage({ locked: false, busy: rc === 5 || rc === 6 || !!(e && e.busy), message: String((e && e.message) || e), errcode: rc || undefined, code: e && e.code });
}
parentPort.on("message", (m) => {
  if (m !== "release") return;
  try { if (db) db.close(); } catch {}
  parentPort.postMessage("released");
});
`;

export interface MailboxLock {
  /** the file's schema and pages as locked: the clone must match both */
  version: number;
  pages: number;
  release(): Promise<void>;
}

/**
 * The mailbox to itself with its WAL folded in, or null when another
 * connection has it open (the backup API then makes a consistent copy
 * whatever others do). Throws when the file can't be opened at all.
 */
export function lockMailbox(path: string): Promise<MailboxLock | null> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(LOCK_SOURCE, { eval: true, workerData: { path } });
    let released: (() => void) | null = null;
    let settled = false;
    const release = () =>
      new Promise<void>((done) => {
        released = done;
        worker.postMessage("release");
      });
    worker.on("message", (m: { locked: boolean; busy?: boolean; version?: number; pages?: number; message?: string; errcode?: number; code?: string } | "released") => {
      if (m === "released") {
        void worker.terminate().then(() => released?.());
        return;
      }
      settled = true;
      if (m.locked) return resolve({ version: m.version!, pages: m.pages!, release });
      void worker.terminate();
      if (m.busy) resolve(null);
      else reject(Object.assign(new Error(m.message), { errcode: m.errcode, code: m.code }));
    });
    worker.on("error", (e) => {
      if (!settled) reject(e);
    });
    worker.on("exit", () => {
      released?.();
      if (!settled) reject(new Error("the mailbox lock ended before it answered"));
    });
  });
}
