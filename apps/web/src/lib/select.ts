/**
 * The selection, bound to the app: clicks with their modifiers, ⌘A and the
 * `*` sequences, ⇧J/⇧K, Esc, and "select all N" (a scope the backend acts
 * on). The rules themselves are the pure functions in lib/selection.ts.
 */
import { listScroller } from "~/components/thread-list";
import type { ThreadScope } from "@terno/core/rpc";
import { getApp, setApp, type AppState } from "~/state/app";
import { currentScope, listKey, useList } from "~/state/list";
import { loadThread } from "~/state/threads";
import { VIEW_LABEL } from "~/lib/format";
import { addRange, extend, pick, targetsOf, toggle, type Order } from "~/lib/selection";

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function listOrder(): Order {
  const { items, index } = useList.getState();
  return { ids: items.map((t) => t.id), index };
}

const EMPTY: ReadonlySet<number> = new Set();
/** Clears the multi-selection (one write, none if already clear). */
export function clearSelection(): void {
  const s = getApp();
  if (s.checked.size || s.scope) setApp({ checked: EMPTY, scope: null });
}

/** ⌘/⇧ meaning of a press on a row (Ctrl-click is the platform's right click on a Mac, so only ⌘ toggles there). */
export interface PressModifiers {
  meta: boolean;
  ctrl: boolean;
  shift: boolean;
}

let collapseOnClick: number | null = null;

/**
 * Primary-button press on a row. Plain: open it and drop the multi-selection,
 * except on a row that is part of it (the press may start a drag of the
 * group; a click without dragging collapses it, see `releaseRow`).
 * ⌘-click (Ctrl-click off Mac) toggles; ⇧-click adds the anchor→row range.
 */
export function pressRow(id: number, m: PressModifiers): void {
  const s = getApp();
  const toggleKey = isMac ? m.meta : m.ctrl;
  collapseOnClick = null;
  // the open thread counts as selected when a multi-selection starts from it
  const base = (): ReadonlySet<number> => (s.checked.size ? s.checked : s.selectedId !== null && s.selectedId !== id ? new Set([s.selectedId]) : EMPTY);
  // the open thread (the cursor) stays where it is: a toggle re-renders the one row it changes
  if (m.shift) {
    setApp({ checked: addRange(base(), listOrder(), s.anchorId ?? s.selectedId, id), scope: null });
    return;
  }
  if (toggleKey) {
    setApp({ checked: toggle(base(), id), anchorId: id, scope: null });
    return;
  }
  if (s.checked.size > 1 && s.checked.has(id)) {
    collapseOnClick = id;
    if (s.selectedId !== id) setApp({ selectedId: id, anchorId: id });
    return;
  }
  const patch: Partial<AppState> = { selectedId: id, readerOpen: true, anchorId: id };
  if (s.checked.size || s.scope) Object.assign(patch, { checked: EMPTY, scope: null });
  // a new message in the reader steps aside for the conversation clicked (it stays in the drafts strip)
  if (s.compose) patch.compose = null;
  setApp(patch);
}

/** The click that ends a plain press on a selected row without a drag: the selection becomes that row. */
export function releaseRow(id: number): void {
  if (collapseOnClick !== id) return;
  collapseOnClick = null;
  setApp({ checked: EMPTY, scope: null, selectedId: id, readerOpen: true });
}

/** x */
export function toggleCurrent(): void {
  const s = getApp();
  if (s.selectedId === null) return;
  setApp({ checked: toggle(s.checked, s.selectedId), anchorId: s.selectedId, scope: null });
}

/** ⌘A / `* a`: every loaded row (more may exist: the banner offers the whole view). */
export function selectAll(): void {
  const { items } = useList.getState();
  if (items.length === 0) return;
  const s = getApp();
  setApp({ checked: pick(items), anchorId: s.anchorId ?? items[0]!.id, scope: null });
}

/** `* r` / `* u` / `* s` */
export function selectWhere(keep: (t: { unread: boolean; starred: boolean }) => boolean): void {
  setApp({ checked: pick(useList.getState().items, keep), scope: null });
}

/** ⇧J / ⇧K: the cursor moves and the anchor→cursor range is selected. */
export function extendSelection(delta: number): void {
  const s = getApp();
  const order = listOrder();
  const r = extend(s.checked, order, s.anchorId ?? s.selectedId, s.selectedId, delta);
  setApp({ checked: r.checked, selectedId: r.cursor, anchorId: r.anchor, scope: null });
  const i = r.cursor === null ? undefined : order.index.get(r.cursor);
  if (i !== undefined) {
    listScroller.scrollToIndex?.(i);
    const next = useList.getState().items[i + delta];
    if (next) void loadThread(next.id);
  }
}

/** "Seleccionar las N conversaciones de «…»": the whole view or search, by scope. */
export function selectScope(count: number): void {
  const scope = currentScope();
  if (!scope) return;
  const s = getApp();
  const category = s.categories.find((c) => c.id === s.categoryId)?.name;
  const label = scope.kind === "search" ? `«${s.query.trim()}»` : (category ?? VIEW_LABEL[s.view] ?? s.view);
  setApp({ scope: { key: listKey(), scope, label: scope.unreadOnly ? `${label} · Unread` : label, count }, checked: new Set(scopeRows(useList.getState().items, scope).map((t) => t.id)) });
}

/**
 * A scope's loaded rows: with the unread filter, the unread ones (a read row
 * the filter kept, the open one, is shown but isn't part of "all N unread").
 */
export function scopeRows<T extends { unread: boolean }>(items: readonly T[], scope: ThreadScope): T[] {
  return scope.unreadOnly ? items.filter((t) => t.unread) : [...items];
}

/** What an action applies to now: a scope, the checked rows (in list order), or the open thread. */
export function currentTargets(): { scope: NonNullable<AppState["scope"]> } | { ids: number[] } {
  const s = getApp();
  if (s.scope && s.scope.key === listKey()) return { scope: s.scope };
  return { ids: targetsOf(s.checked, s.selectedId, s.checked.size ? listOrder() : undefined) };
}
