import type { FolderCountCursor } from "./types";

/**
 * Plan 107 (Codex code review round 17 #1): the thread merges a store made, a bounded log in memory, so an export's
 * id walk (by thread id, ascending) can tell when messages it hasn't read moved into a thread it already passed. A
 * merge keeps the lower id, so a later thread merged into a visited one took its messages behind the walk. Both
 * stores record every merge here; the walk's cursor carries the sequence it saw (`FolderExportCursor.merges`).
 */

/** merges kept: a walk that saw more since its last stretch starts over */
const KEPT = 4096;

export class ThreadMerges {
  private seq = 0;
  private readonly log: { seq: number; from: number; into: number }[] = [];
  private start = 0;

  /** the last merge's sequence */
  get current(): number {
    return this.seq;
  }

  record(from: number, into: number): void {
    const entry = { seq: ++this.seq, from, into };
    if (this.log.length < KEPT) this.log.push(entry);
    else {
      this.log[this.start] = entry;
      this.start = (this.start + 1) % KEPT;
    }
  }

  /**
   * The threads merges since `since` merged into (the latest first), or null when the log no longer reaches back that
   * far: a count asks whether one of them is a thread it already passed (Codex code review round 19 #2).
   */
  into(since: number): number[] | null {
    if (since >= this.seq) return [];
    const oldest = this.log.length < KEPT ? 1 : this.log[this.start]!.seq;
    if (since < oldest - 1) return null;
    const out = new Set<number>();
    for (let i = this.log.length - 1; i >= 0; i--) {
      const e = this.log[(this.start + i) % this.log.length]!;
      if (e.seq <= since) break;
      out.add(e.into);
    }
    return [...out];
  }

  /**
   * Where a walk at thread `at` (read up to it, or inside it) must read again from, inclusive, for the merges since
   * `since`: the lowest thread at or below `at` that received messages from `at` or above (followed through later
   * merges). null: none did. 1: more merges than the log keeps, start over.
   */
  rewind(since: number, at: number): number | null {
    if (since >= this.seq) return null;
    const oldest = this.log.length < KEPT ? 1 : this.log[this.start]!.seq;
    if (since < oldest - 1) return 1;
    // threads at or below `at` holding messages the walk hasn't read
    const behind = new Set<number>();
    for (let i = 0; i < this.log.length; i++) {
      const e = this.log[(this.start + i) % this.log.length]!;
      if (e.seq <= since) continue;
      const unread = e.from >= at || behind.delete(e.from);
      if (unread && e.into <= at) behind.add(e.into);
    }
    let low: number | null = null;
    for (const t of behind) if (low === null || t < low) low = t;
    return low;
  }
}

/**
 * Plan 107 (Codex code review round 19 #2): whether a thread merges took messages into (`into`; null: more merges than
 * the log keeps) is one a count at `at` has passed: a member of a folder whose rows it read, or of the folder it's
 * reading at or below the thread it reached. Places are read by location, which a merge doesn't move. Both stores'
 * counts; `foldersOf`: a thread's member folders.
 */
export function mergedBehind(at: FolderCountCursor, into: readonly number[] | null, places: readonly { mailbox: string; uidvalidity?: number }[], foldersOf: (thread: number) => readonly string[]): boolean {
  if (into === null) return true;
  if (!into.length) return false;
  const index = new Map<string, number>();
  places.forEach((p, i) => { if (p.uidvalidity === undefined && !index.has(p.mailbox)) index.set(p.mailbox, i); });
  const through = at.places ? 0 : at.after[0] ?? 0;
  // a pending stretch's position is kept below 0 (IndexedDB's `pendingAfter`)
  const reached = through < 0 ? -through - 1 : through;
  return into.some((t) => foldersOf(t).some((f) => {
    const i = index.get(f);
    return i !== undefined && (i < at.key || (i === at.key && !at.places && t <= reached));
  }));
}
