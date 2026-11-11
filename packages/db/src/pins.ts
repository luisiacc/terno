import type { Pin } from "@terno/core";
import type { Db } from "./sqlite";

/** Plan 179: conversations pinned to the Inbox's top (`pins`, v55). */

interface Row {
  thread_id: number;
  pinned_at: number;
}

const toPin = (r: Row): Pin => ({ threadId: r.thread_id, pinnedAt: r.pinned_at });

export function listPins(db: Db): Pin[] {
  return db.all<Row>("SELECT thread_id, pinned_at FROM pins ORDER BY thread_id").map(toPin);
}

function pinsOf(db: Db, threadIds: readonly number[]): Pin[] {
  if (threadIds.length === 0) return [];
  return db.all<Row>("SELECT thread_id, pinned_at FROM pins WHERE thread_id IN (SELECT value FROM json_each(?)) ORDER BY thread_id", JSON.stringify(threadIds)).map(toPin);
}

/** All or nothing (one transaction): a pinned thread keeps its pin, a gone one is skipped, the cap counts what would be. */
export function addPins(db: Db, rows: readonly Pin[], cap: number): { ok: true; added: Pin[] } | { ok: false } {
  return db.tx(() => {
    // the last of a thread's rows wins
    const byThread = new Map(rows.map((r) => [r.threadId, r]));
    for (const p of pinsOf(db, [...byThread.keys()])) byThread.delete(p.threadId);
    const ids = [...byThread.keys()];
    const live = new Set(ids.length ? db.all<{ id: number }>("SELECT id FROM threads WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(ids)).map((r) => r.id) : []);
    const pinned = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM pins")!.n;
    if (pinned + live.size > cap) return { ok: false as const };
    const added: Pin[] = [];
    for (const p of byThread.values()) {
      if (!live.has(p.threadId)) continue;
      db.run("INSERT INTO pins (thread_id, pinned_at) VALUES (?, ?)", p.threadId, p.pinnedAt);
      added.push(p);
    }
    return { ok: true as const, added };
  });
}

export function deletePins(db: Db, threadIds: readonly number[]): Pin[] {
  return db.tx(() => {
    const gone = pinsOf(db, threadIds);
    for (const p of gone) db.run("DELETE FROM pins WHERE thread_id = ?", p.threadId);
    return gone;
  });
}

export function deleteExactPins(db: Db, rows: readonly Pin[]): Pin[] {
  return db.tx(() => rows.filter((p) => db.run("DELETE FROM pins WHERE thread_id = ? AND pinned_at = ?", p.threadId, p.pinnedAt).changes > 0));
}

/** A merge: the vanished thread's pin goes to the survivor when it has none. */
export function mergePin(db: Db, into: number, from: number): void {
  const moved = db.get<Row>("SELECT thread_id, pinned_at FROM pins WHERE thread_id = ?", from);
  if (moved) db.run("INSERT OR IGNORE INTO pins (thread_id, pinned_at) VALUES (?, ?)", into, moved.pinned_at);
}
