import type { ListFilter } from "@terno/core";
/**
 * The multi-selection model, pure (no React, no store): which rows are
 * checked after a toggle, a range, an extension or a reload. Positions come
 * from the loaded list (`order` / `index`), never from the DOM, so a range
 * spans rows the virtualizer has unmounted. lib/select.ts binds it to the
 * app state.
 */
import { t } from "@terno/i18n";

export interface Order {
  /** loaded thread ids in list order */
  ids: readonly number[];
  /** id → position */
  index: ReadonlyMap<number, number>;
}

/** ⌘-click / x: flips one row. */
export function toggle(checked: ReadonlySet<number>, id: number): Set<number> {
  const next = new Set(checked);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** The loaded rows between a and b, both included, in list order. An end that left the list collapses the range to the other end. */
export function range(order: Order, a: number, b: number): number[] {
  const i = order.index.get(a);
  const j = order.index.get(b);
  if (j === undefined) return i === undefined ? [] : [a];
  if (i === undefined) return [b];
  return order.ids.slice(Math.min(i, j), Math.max(i, j) + 1) as number[];
}

/** ⇧-click: the range from the anchor to the row joins what is already checked. */
export function addRange(checked: ReadonlySet<number>, order: Order, anchor: number | null, to: number): Set<number> {
  const next = new Set(checked);
  for (const id of range(order, anchor ?? to, to)) next.add(id);
  return next;
}

/**
 * ⇧J / ⇧K (and ⇧↓ / ⇧↑): the cursor moves by `delta` and the selection is
 * the anchor→cursor range plus whatever else was checked, so moving back
 * toward the anchor shrinks it. Returns the new cursor too.
 */
export function extend(checked: ReadonlySet<number>, order: Order, anchor: number | null, cursor: number | null, delta: number): { checked: Set<number>; cursor: number | null; anchor: number | null } {
  if (order.ids.length === 0) return { checked: new Set(checked), cursor, anchor };
  const from = cursor !== null && order.index.has(cursor) ? cursor : order.ids[0]!;
  const start = anchor !== null && order.index.has(anchor) ? anchor : from;
  const at = order.index.get(from)!;
  const to = order.ids[Math.max(0, Math.min(order.ids.length - 1, at + delta))]!;
  const next = new Set(checked);
  for (const id of range(order, start, from)) next.delete(id);
  for (const id of range(order, start, to)) next.add(id);
  return { checked: next, cursor: to, anchor: start };
}

/** Rows that left the view leave the selection. Returns null when nothing changed (no store write). */
export function prune(checked: ReadonlySet<number>, index: ReadonlyMap<number, number>): Set<number> | null {
  let gone = false;
  for (const id of checked) if (!index.has(id)) gone = true;
  if (!gone) return null;
  return new Set([...checked].filter((id) => index.has(id)));
}

/** `* a` / `* r` / `* u` / `* s`: the loaded rows matching a predicate. */
export function pick<T extends { id: number }>(items: readonly T[], keep: (t: T) => boolean = () => true): Set<number> {
  const out = new Set<number>();
  for (const t of items) if (keep(t)) out.add(t.id);
  return out;
}

/** What an action applies to: the checked rows when there are any, else the open thread. */
export function targetsOf(checked: ReadonlySet<number>, selectedId: number | null, order?: Order): number[] {
  if (checked.size) return order ? [...checked].sort((a, b) => (order.index.get(a) ?? Infinity) - (order.index.get(b) ?? Infinity)) : [...checked];
  return selectedId === null ? [] : [selectedId];
}

/** The context menu's target: the selection when the clicked row is part of it, else that row alone. */
export function menuTargets(row: number, checked: ReadonlySet<number>, order?: Order): number[] {
  return checked.has(row) && checked.size > 1 ? targetsOf(checked, null, order) : [row];
}

/** A scope's name (a mailbox, a category, a quoted search), with "· Unread" (or the filter on) after it. */
export function scopeLabel(label: string, filter: ListFilter | undefined): string {
  return filter === "unread" ? t("list.scope.unread", { label }) : filter === "attachments" ? t("list.scope.attachments", { label }) : filter === "starred" ? t("list.scope.starred", { label }) : label;
}
