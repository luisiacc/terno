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
