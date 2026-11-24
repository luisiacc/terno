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
import { pathToFileURL } from "node:url";
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
const killAll = () => {
  for (const c of children) c.kill();
};
// a quit mid-clone: the copy is a partial folder the next start removes, never a process left writing it. Main
// retires the backend with SIGTERM, which ends it without "exit": while a cp runs, that signal kills it first and
// then ends the process as it would have (Codex code review #2)
process.once("exit", killAll);
const onTerm = () => {
  killAll();
  process.kill(process.pid, "SIGTERM");
};
const track = (child: ChildProcess) => {
  if (children.size === 0) process.once("SIGTERM", onTerm);
  children.add(child);
};
const untrack = (child: ChildProcess) => {
  children.delete(child);
  if (children.size === 0) process.removeListener("SIGTERM", onTerm);
};

/** Ends a clone in flight (the backend's shutdown): its promise rejects, its partial folder goes. */
export function cancelClones(): void {
  killAll();
}

/**
 * A backup file opened for reading only, never written: `immutable` keeps
 * SQLite from touching it or adding a -wal or -shm beside it (plan 253: the
 * first write to a fresh clone is the expensive one, and it is the settle's).
 */
export const untouchedUri = (file: string) => `${pathToFileURL(file).href}?immutable=1`;

// mode=rw: a generation removed meanwhile is never created again
const SETTLE_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
try {
  const db = new DatabaseSync(workerData.uri);
  let mode;
  try {
    db.exec("PRAGMA synchronous = FULL");
    mode = db.prepare("PRAGMA journal_mode = DELETE").get().journal_mode;
  } finally {
    db.close();
  }
  parentPort.postMessage(mode === "delete" ? { ok: true } : { ok: false, message: "journal mode stayed " + mode });
} catch (e) {
  parentPort.postMessage({ ok: false, message: String((e && e.message) || e) });
}
`;

export interface Settle {
  /** resolves with how long it took; rejects when it failed or was stopped */
  done: Promise<number>;
  /** ends it (a shutdown) and waits for its thread to be gone; a switch cut short leaves a journal the next settle plays back */
  stop(): Promise<void>;
}

/**
 * Plan 253: a clone backup's first write, off the caller's thread. After a
 * clone, whichever file is written first pays while APFS splits the extents
 * the two share (seconds on a large, fragmented mailbox), and a reader of
 * that file waits meanwhile. Paid here, on the backup, the mailbox's own
 * first write (its checkpoint, held until this ends) is free. The write is
 * the switch to a rollback journal, which also leaves the backup one
 * self-contained file (and plays back a journal an earlier settle left).
 */
export function settleBackup(file: string): Settle {
  const started = performance.now();
  const worker = new Worker(SETTLE_SOURCE, { eval: true, workerData: { uri: `${pathToFileURL(file).href}?mode=rw` } });
  const exited = new Promise<void>((resolve) => worker.once("exit", () => resolve()));
  const done = new Promise<number>((resolve, reject) => {
    worker.once("message", (m: { ok: boolean; message?: string }) => {
      if (m.ok) resolve(performance.now() - started);
      else reject(new Error(m.message));
      void worker.terminate();
    });
    worker.once("error", reject);
    void exited.then(() => reject(new Error("the backup's settle ended before it answered")));
  });
  done.catch(() => {});
  return {
    done,
    stop: async () => {
      await worker.terminate();
      await exited;
    },
  };
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
      untrack(child);
      if (error) reject(cpError(String(stderr ?? ""), error));
      else resolve();
    });
    track(child);
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
