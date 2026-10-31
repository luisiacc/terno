import type { MemDb } from "./mem";

/** Derived from the acknowledged head/capture tables; rollback and reopen rebuild the same candidates. */
export class BodyOwnership {
  private readonly orphans = new Set<string>();
  onRetired?: () => void;
  constructor(db: MemDb) {
    const captures = db.table("body_captures"), heads = db.table("body_heads");
    const refresh = (id: unknown) => {
      if (typeof id !== "string") return;
      if (captures.has(id) && !heads.count("capture", id)) this.orphans.add(id); else this.orphans.delete(id);
    };
    db.onRow((table, row, prior) => {
      if (table === "body_captures") { refresh(prior?.id); refresh(row?.id); }
      else if (table === "body_heads") {
        if (prior?.capture_id !== row?.capture_id) { refresh(prior?.capture_id); refresh(row?.capture_id); if (prior) this.onRetired?.(); }
      }
    });
  }
  isOrphan(id: string): boolean { return this.orphans.has(id); }
  candidates(): IterableIterator<string> { return this.orphans.values(); }
}
const ownership = new WeakMap<MemDb, BodyOwnership>();
export function installBodyOwnership(db: MemDb): void { ownership.set(db, new BodyOwnership(db)); }
export function bodyOwnership(db: MemDb): BodyOwnership { return ownership.get(db)!; }
