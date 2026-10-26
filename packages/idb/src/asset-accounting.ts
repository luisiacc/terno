import type { MemDb, Row } from "./mem";

type Orphan = { id: string; grace_started_at: number };
/** An indexed min-heap: deletion never leaves tombstones or a later unbounded sweep. */
class Orphans {
  private readonly rows: Orphan[] = [];
  private readonly positions = new Map<string, number>();
  get size(): number { return this.rows.length; }
  private before(a: number, b: number): boolean {
    const x = this.rows[a]!, y = this.rows[b]!;
    return x.grace_started_at < y.grace_started_at || (x.grace_started_at === y.grace_started_at && x.id < y.id);
  }
  private swap(a: number, b: number): void {
    [this.rows[a], this.rows[b]] = [this.rows[b]!, this.rows[a]!];
    this.positions.set(this.rows[a]!.id, a); this.positions.set(this.rows[b]!.id, b);
  }
  private repair(position: number): void {
    while (position > 0 && this.before(position, (position - 1) >> 1)) {
      const parent = (position - 1) >> 1; this.swap(position, parent); position = parent;
    }
    for (;;) {
      let next = position;
      for (const child of [2 * position + 1, 2 * position + 2]) if (child < this.rows.length && this.before(child, next)) next = child;
      if (next === position) return;
      this.swap(position, next); position = next;
    }
  }
  set(row: Orphan): void {
    const position = this.positions.get(row.id);
    if (position !== undefined) { this.rows[position] = row; this.repair(position); return; }
    this.positions.set(row.id, this.rows.length); this.rows.push(row); this.repair(this.rows.length - 1);
  }
  delete(id: string): void {
    const position = this.positions.get(id);
    if (position === undefined) return;
    const last = this.rows.pop()!; this.positions.delete(id);
    if (position === this.rows.length) return;
    this.rows[position] = last; this.positions.set(last.id, position); this.repair(position);
  }
  beforeTime(before: number): string[] {
    const result: string[] = [], pending = [0];
    while (pending.length && result.length < 50) {
      const position = pending.pop()!, row = this.rows[position];
      if (!row || row.grace_started_at >= before) continue;
      result.push(row.id); pending.push(2 * position + 1, 2 * position + 2);
    }
    return result;
  }
}

class AssetAccounting {
  private readonly usage = new Map<number, number>();
  private readonly orphans = new Map<number, Orphans>();
  private readonly pending = new Map<number, Set<string>>();
  constructor(private readonly db: MemDb) {
    const assets = db.table("attachment_assets"), links = db.table("attachment_links");
    const refresh = (row: Row | undefined) => {
      if (!row) return;
      const account = Number(row.account_id), id = String(row.id);
      let heap = this.orphans.get(account);
      const pending = this.pending.get(account);
      if (links.count("fk_asset_id", id)) { heap?.delete(id); pending?.delete(id); }
      else if (typeof row.orphan_grace_started_at === "number") {
        pending?.delete(id);
        if (!heap) this.orphans.set(account, heap = new Orphans());
        heap.set({ id, grace_started_at: row.orphan_grace_started_at });
      } else {
        heap?.delete(id);
        if (pending) pending.add(id); else this.pending.set(account, new Set([id]));
      }
      if (heap?.size === 0) this.orphans.delete(account);
      if (pending?.size === 0) this.pending.delete(account);
    };
    db.onRow((table, row, prev) => {
      if (table === "attachment_assets") {
        for (const [r, sign] of [[prev, -1], [row, 1]] as const) {
          if (!r) continue;
          const account = Number(r.account_id), total = (this.usage.get(account) ?? 0) + sign * (Number(r.size) + 1024);
          if (total) this.usage.set(account, total); else this.usage.delete(account);
        }
        if (prev && (!row || prev.account_id !== row.account_id)) {
          const account = Number(prev.account_id), heap = this.orphans.get(account); heap?.delete(String(prev.id));
          if (!heap?.size) this.orphans.delete(account);
          const pending = this.pending.get(account); pending?.delete(String(prev.id));
          if (!pending?.size) this.pending.delete(account);
        }
        refresh(row);
      } else if (table === "attachment_links") {
        if (prev) refresh(assets.get(prev.asset_id));
        if (row && row.asset_id !== prev?.asset_id) refresh(assets.get(row.asset_id));
      }
    });
  }
  used(account: number): number { return this.usage.get(account) ?? 0; }
  beginGrace(account: number, now: number): void {
    const pending = this.pending.get(account);
    if (!pending) return;
    let count = 0;
    for (const id of pending) {
      this.db.table("attachment_assets").update(this.db.table("attachment_assets").get(id)!, { orphan_grace_started_at: now });
      if (++count === 50) break;
    }
  }
  aged(account: number, before: number): string[] { return this.orphans.get(account)?.beforeTime(before) ?? []; }
}
const accounting = new WeakMap<MemDb, AssetAccounting>();
/** Installed before row loading; the existing load and undo stream builds and maintains both indexes. */
export function installAssetAccounting(db: MemDb): void { accounting.set(db, new AssetAccounting(db)); }
export function assetAccounting(db: MemDb): AssetAccounting {
  const result = accounting.get(db);
  if (!result) throw new Error("Attachment accounting was not installed before loading");
  return result;
}
