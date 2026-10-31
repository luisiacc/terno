import type { MemDb } from "./mem";

/** Retained rules and pending imports can name a category that no longer exists. */
export function categoryReferenceCeiling(json: string): number {
  let value: unknown;
  try { value = JSON.parse(json); } catch { return 0; }
  let ceiling = 0;
  const pending = [value];
  while (pending.length) {
    const next = pending.pop();
    if (!next || typeof next !== "object") continue;
    for (const [key, item] of Object.entries(next)) {
      if (key === "categoryId" && typeof item === "number" && Number.isSafeInteger(item) && item > ceiling) ceiling = item;
      else if (item && typeof item === "object") pending.push(item);
    }
  }
  return ceiling;
}

export function reserveCategoryIds(db: MemDb, ceiling: number): void {
  const counter = db.table("category_counter");
  if (ceiling > Number(counter.get(1)?.last_id ?? 0)) counter.put({ id: 1, last_id: ceiling });
}

export function nextCategoryId(db: MemDb): number {
  const id = Math.max(Number(db.table("category_counter").get(1)?.last_id ?? 0), db.table("categories").highestKey()) + 1;
  if (!Number.isSafeInteger(id)) throw new Error("Category identity space exhausted");
  reserveCategoryIds(db, id);
  return id;
}
