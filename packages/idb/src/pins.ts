import type { Pin } from "@terno/core";
import { T, type Ctx, type R } from "./mail";

/** Plan 177: conversations pinned to the Inbox's top, like SQL's `pins` (packages/db/src/pins.ts). */

const toPin = (r: R): Pin => ({ threadId: r.thread_id, pinnedAt: r.pinned_at });

export function listPins(c: Ctx): Pin[] {
  return [...T(c, "pins").all()].map(toPin).sort((a, b) => a.threadId - b.threadId);
}

export function addPins(c: Ctx, rows: readonly Pin[], cap: number): { ok: true; added: Pin[] } | { ok: false } {
  const pins = T(c, "pins");
  const threads = T(c, "threads");
  // the last of a thread's rows wins; a pinned thread keeps its pin
  const byThread = new Map(rows.map((r) => [r.threadId, r]));
  const added = [...byThread.values()].filter((p) => !pins.has(p.threadId) && threads.has(p.threadId));
  if (pins.rows.size + added.length > cap) return { ok: false };
  for (const p of added) pins.put({ thread_id: p.threadId, pinned_at: p.pinnedAt });
  return { ok: true, added };
}

export function deletePins(c: Ctx, threadIds: readonly number[]): Pin[] {
  const pins = T(c, "pins");
  const gone: Pin[] = [];
  for (const id of new Set(threadIds)) {
    const p = pins.get(id);
    if (!p) continue;
    pins.delete(id);
    gone.push(toPin(p));
  }
  return gone.sort((a, b) => a.threadId - b.threadId);
}

export function deleteExactPins(c: Ctx, rows: readonly Pin[]): Pin[] {
  const pins = T(c, "pins");
  return rows.filter((p) => {
    if (pins.get(p.threadId)?.pinned_at !== p.pinnedAt) return false;
    pins.delete(p.threadId);
    return true;
  });
}

/** A merge: the vanished thread's pin goes to the survivor when it has none. */
export function mergePin(c: Ctx, into: number, from: number): void {
  const pins = T(c, "pins");
  const moved = pins.get(from);
  if (moved && !pins.has(into)) pins.put({ thread_id: into, pinned_at: moved.pinned_at });
}
