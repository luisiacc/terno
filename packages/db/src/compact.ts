import { statfsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { Db } from "./sqlite";
import { getSetting, setSetting } from "./repos";
import { COMPACT_KEY } from "./storage";

export type CompactOutcome = "done" | "noRoom" | "failed";

const fileSize = (path: string) => {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
};

/**
 * Plan 69: the VACUUM a storage removal asked for, run once when the file opens (an older file can't give pages
 * back any other way; afterwards it is incremental and never needs this again). Only with room for the copy and
 * the WAL it writes (Codex R8); a failure leaves the file as it was, opens it, and isn't tried again.
 */
export function compactOnOpen(db: Db, o: { freeDisk?: (dir: string) => number } = {}): CompactOutcome | null {
  if (db.path === ":memory:" || getSetting<{ state?: string }>(db, COMPACT_KEY, {}).state !== "pending") return null;
  const size = fileSize(db.path) + fileSize(`${db.path}-wal`);
  const freeDisk = o.freeDisk ?? ((dir: string) => {
    const s = statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  });
  // still asked: the next open looks again (a statfs is all it costs)
  if (freeDisk(dirname(db.path)) < 2 * size + 64 * 2 ** 20) return "noRoom";
  try {
    // the copy goes to a temporary file, never memory: it is as large as the mailbox
    db.exec("PRAGMA temp_store = FILE");
    db.exec("PRAGMA auto_vacuum = INCREMENTAL");
    db.exec("VACUUM");
    db.get("PRAGMA wal_checkpoint(TRUNCATE)");
    setSetting(db, COMPACT_KEY, { state: "done", at: Date.now() });
    return "done";
  } catch (error) {
    try {
      setSetting(db, COMPACT_KEY, { state: "failed", at: Date.now(), error: error instanceof Error ? error.message : String(error) });
    } catch {
      // the next open tries again: a store that can't write a setting has bigger problems than this
    }
    return "failed";
  } finally {
    db.exec("PRAGMA temp_store = MEMORY");
  }
}
