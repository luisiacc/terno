import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmdirSync } from "node:fs";
import { dirname } from "node:path";
import type { SpendLedger } from "./spend";

/** A holder only reads and appends a line. Far past that, something died holding it, and the cap can't be proved. */
const LOCK_WAIT_MS = 10_000;

/** Blocks the caller briefly: a holder has only a read and an append to do. */
function locked<T>(lock: string, waitMs: number, work: () => T): T {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
      // fail closed: breaking someone's lock is how two runs pass one cap
      if (Date.now() > deadline) throw new Error(`the spend ledger stayed locked; if no run is active, remove ${lock}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  try {
    return work();
  } finally {
    rmdirSync(lock);
  }
}

interface Line {
  type?: "reserve" | "settle";
  id?: string;
  usd: number;
}

/** A line with no type is from before reservations: plain money spent. */
function total(path: string): number {
  if (!existsSync(path)) return 0;
  const reservations = new Map<string, number>();
  let plain = 0;
  // a torn line throws: an unreadable ledger proves nothing, so nothing more runs on it
  for (const text of readFileSync(path, "utf8").split("\n")) {
    if (!text) continue;
    const line = JSON.parse(text) as Line;
    if (line.type && line.id) reservations.set(line.id, line.usd);
    else plain += line.usd;
  }
  return [...reservations.values()].reduce((sum, usd) => sum + usd, plain);
}

/**
 * The spend ledger on disk, shared by every process on a developer's key: an
 * append-only file of `reserve` and `settle` lines under a mkdir lock. A
 * reservation counts as spent until its settle line replaces it, so a process
 * that dies mid-request leaves its worst case counted. Node only, and no value
 * imports, so a test can load it in several real processes.
 */
export function fileLedger(path: string, capUsd: number, lockWaitMs: number = LOCK_WAIT_MS): SpendLedger {
  mkdirSync(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  const append = (line: object) => appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`);
  return {
    capUsd,
    spent: () => locked(lock, lockWaitMs, () => total(path)),
    reserve(entry) {
      return locked(lock, lockWaitMs, () => {
        if (total(path) + entry.usd > capUsd) return null;
        const id = randomUUID();
        append({ type: "reserve", id, ...entry });
        return id;
      });
    },
    settle(id, entry) {
      locked(lock, lockWaitMs, () => append({ type: "settle", id, ...entry }));
    },
  };
}
