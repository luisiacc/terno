import type { ClosedAt } from "@terno/store";
import type { MemDb, Table } from "./mem";
import type { R } from "./mail";

/** Past this many changes since the last read, the order is rebuilt rather than patched (and nothing more is tracked). */
const PATCH_MAX = 256;

/** A closed row's place: newest first, the later closing, then the higher id. */
interface Entry {
  at: number;
  id: number;
}
const newer = (a: Entry, b: Entry): boolean => a.at > b.at || (a.at === b.at && a.id > b.id);
const byOrder = (a: Entry, b: Entry): number => b.at - a.at || b.id - a.id;

/** where `e` goes in a newest-first list */
function position(list: readonly Entry[], e: Entry): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (newer(list[mid]!, e)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Plan 210 (Codex code review): what SQLite's closing-time index is, in memory: a table's closed rows by `(closed_at, id)`,
 * newest first, kept as rows change (a closing, an Undo, a prune) rather than sorted for each page. A page is a binary
 * search to its key and a walk of `limit` rows. Built once, on the first read (rows loaded before it existed), as
 * `ThreadOrder` is; past `PATCH_MAX` changes unread (Clear AI data, a bulk prune) it's marked stale and tracks nothing more.
 * Plan 210 (iteration 2): a line per closed item, so no thread's own order any more.
 */
export class ClosedOrder {
  private all: Entry[] = [];
  private readonly entries = new Map<number, Entry>();
  private readonly pending = new Set<number>();
  private stale = true;

  constructor(
    db: MemDb,
    private readonly table: string,
    private readonly keep: (row: R) => boolean,
  ) {
    db.onRow((name, row, prev) => {
      if (name !== this.table || this.stale) return;
      if (row && prev && row.closed_at === prev.closed_at && this.keep(row as R) === this.keep(prev as R)) return;
      this.pending.add((row ?? prev)!.id as number);
      // too much to patch: rebuilt on the next read, and nothing more held meanwhile
      if (this.pending.size > PATCH_MAX) {
        this.stale = true;
        this.pending.clear();
      }
    });
  }

  private entry(r: R): Entry | null {
    return r.closed_at == null || !this.keep(r) ? null : { at: r.closed_at as number, id: r.id as number };
  }

  private add(e: Entry): void {
    this.entries.set(e.id, e);
    this.all.splice(position(this.all, e), 0, e);
  }

  private remove(id: number): void {
    const e = this.entries.get(id);
    if (!e) return;
    this.entries.delete(id);
    this.all.splice(position(this.all, e), 1);
  }

  private current(rows: Table<R>): void {
    if (this.stale) {
      this.stale = false;
      this.pending.clear();
      this.entries.clear();
      this.all = [];
      for (const r of rows.all()) {
        const e = this.entry(r);
        if (!e) continue;
        this.entries.set(e.id, e);
        this.all.push(e);
      }
      this.all.sort(byOrder);
      return;
    }
    for (const id of this.pending) {
      this.remove(id);
      const r = rows.get(id);
      const e = r && this.entry(r);
      if (e) this.add(e);
    }
    this.pending.clear();
  }

  /** closed rows since `since`, strictly after `after`, at most `limit`, newest first */
  page(rows: Table<R>, o: { since: number; after: ClosedAt | null; limit: number }): R[] {
    this.current(rows);
    let lo = 0;
    if (o.after) {
      // past every row at or before the key: closed later, or at the same moment with an id >= its
      const key: Entry = { at: o.after.at, id: o.after.id - 1 };
      lo = position(this.all, key);
    }
    const out: R[] = [];
    for (let i = lo; i < this.all.length && out.length < o.limit; i++) {
      const e = this.all[i]!;
      if (e.at < o.since) break;
      out.push(rows.get(e.id)!);
    }
    return out;
  }
}
