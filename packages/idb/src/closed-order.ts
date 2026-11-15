import type { ClosedAt } from "@terno/store";
import type { MemDb, Table } from "./mem";
import type { R } from "./mail";

/**
 * Plan 210 (Codex code review): what SQLite's `dated_closed` and `followups_closed` indexes are, in memory: a table's
 * closed rows by `(closed_at, id)`, newest first, kept as rows change (a closing, an Undo, a prune, a merge) rather than
 * sorted for each page. A page is a binary search to its key and a walk of `limit` rows. Built once, on the first read
 * (rows loaded before it existed), as `ThreadOrder` is; many changes at once (Clear AI data) rebuild it.
 */
export class ClosedOrder {
  private ids: number[] = [];
  private readonly at = new Map<number, number>();
  private readonly pending = new Set<number>();
  private stale = true;

  constructor(
    db: MemDb,
    private readonly table: string,
    private readonly keep: (row: R) => boolean,
  ) {
    db.onRow((name, row, prev) => {
      if (name !== this.table) return;
      const r = (row ?? prev) as R;
      if (row && prev && row.closed_at === prev.closed_at && this.keep(row as R) === this.keep(prev as R)) return;
      this.pending.add(r.id as number);
    });
  }

  /** newest first: the later closing, then the higher id */
  private before(a: number, b: number): boolean {
    const x = this.at.get(a)!;
    const y = this.at.get(b)!;
    return x > y || (x === y && a > b);
  }

  /** where `id` (with its closing known) goes, or is */
  private position(id: number): number {
    let lo = 0;
    let hi = this.ids.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.before(this.ids[mid]!, id)) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private current(rows: Table<R>): readonly number[] {
    if (!this.stale && this.pending.size === 0) return this.ids;
    if (this.stale || this.pending.size > 256) {
      this.stale = false;
      this.at.clear();
      this.ids = [];
      for (const r of rows.all()) {
        if (r.closed_at == null || !this.keep(r)) continue;
        this.at.set(r.id as number, r.closed_at as number);
        this.ids.push(r.id as number);
      }
      this.ids.sort((a, b) => (this.before(a, b) ? -1 : this.before(b, a) ? 1 : 0));
    } else {
      for (const id of this.pending) {
        if (this.at.has(id)) {
          const i = this.position(id);
          this.ids.splice(this.ids[i] === id ? i : this.ids.indexOf(id), 1);
          this.at.delete(id);
        }
        const r = rows.get(id);
        if (!r || r.closed_at == null || !this.keep(r)) continue;
        this.at.set(id, r.closed_at as number);
        this.ids.splice(this.position(id), 0, id);
      }
    }
    this.pending.clear();
    return this.ids;
  }

  /** closed rows since `since`, strictly after `after`, at most `limit`, newest first */
  page(rows: Table<R>, o: { since: number; after: ClosedAt | null; limit: number }): R[] {
    const ids = this.current(rows);
    let lo = 0;
    if (o.after) {
      const { at, id } = o.after;
      let hi = ids.length;
      // past every row at or before the key in this order: closed later, or at the same moment with an id >= its
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const x = this.at.get(ids[mid]!)!;
        if (x > at || (x === at && ids[mid]! >= id)) lo = mid + 1;
        else hi = mid;
      }
    }
    const out: R[] = [];
    for (let i = lo; i < ids.length && out.length < o.limit; i++) {
      if (this.at.get(ids[i]!)! < o.since) break;
      out.push(rows.get(ids[i]!)!);
    }
    return out;
  }
}
