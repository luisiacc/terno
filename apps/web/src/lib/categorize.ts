import type { CategorizeSource } from "@unica/core/rpc";
import { toast } from "sonner";
import { client } from "~/rpc/connection";
import { reflowRemoval } from "~/lib/flash";
import { patchRows, reloadList, useList } from "~/state/list";
import { invalidateThreads, loadThread } from "~/state/threads";
import { getApp, setApp } from "~/state/app";

export interface Filed {
  categoryId: number;
  /** the threads the user acted on (quick actions are computed from these) */
  threadIds: number[];
  /** the ones that were not in the category before: undo removes exactly these */
  addedIds: number[];
  batchId: number | null;
  /** ⌥-drag in a category view: the threads also left this category (undo puts them back) */
  movedFrom?: { categoryId: number; threadIds: number[] };
}

type Listener = (filed: Filed, source: CategorizeSource) => void;
const listeners = new Set<Listener>();

/** The snackbar (and anything else) hears about every UI categorization. */
export function onFiled(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

function patch(threadIds: readonly number[], categoryId: number, on: boolean): void {
  patchRows(threadIds, (t) => ({
    ...t,
    categoryIds: on ? [...new Set([...t.categoryIds, categoryId])] : t.categoryIds.filter((c) => c !== categoryId),
  }));
}

function refreshReader(threadIds: readonly number[]): void {
  invalidateThreads(threadIds);
  const selected = getApp().selectedId;
  if (selected !== null && threadIds.includes(selected)) void loadThread(selected, true);
}

/**
 * The one way the UI files threads into a category: the picker, an accepted
 * suggestion and drag and drop all come through here. Rows update in the same
 * frame, the backend records the training signal, and listeners (the
 * snackbar) get what changed so it can be undone.
 */
export async function addToCategory(categoryId: number, threadIds: readonly number[], options: { source?: CategorizeSource; movedFrom?: number } = {}): Promise<Filed | null> {
  const ids = [...new Set(threadIds)];
  if (ids.length === 0) return null;
  const { items, index } = useList.getState();
  const from = options.movedFrom;
  if (from !== undefined) leaveView(ids, from);
  const fresh = ids.filter((id) => !items[index.get(id) ?? -1]?.categoryIds.includes(categoryId));
  patch(fresh, categoryId, true);
  // the sidebar count moves in the same frame; the backend's counts event confirms it
  const unread = fresh.filter((id) => items[index.get(id) ?? -1]?.unread).length;
  if (unread) {
    const counts = getApp().counts;
    setApp({ counts: { ...counts, categoryUnread: { ...counts.categoryUnread, [categoryId]: (counts.categoryUnread[categoryId] ?? 0) + unread } } });
  }
  try {
    const res = await client.call("categories.addThreads", { categoryId, threadIds: ids, source: options.source ?? "picker" });
    refreshReader(ids);
    if (from !== undefined) await client.call("categories.removeThreads", { categoryId: from, threadIds: ids, reason: "user" });
    const filed: Filed = { categoryId, threadIds: ids, addedIds: res.addedIds, batchId: res.batchId, movedFrom: from === undefined ? undefined : { categoryId: from, threadIds: ids } };
    for (const l of listeners) l(filed, options.source ?? "picker");
    return filed;
  } catch (error) {
    toast.error(`No se pudo añadir: ${error instanceof Error ? error.message : error}`);
    void reloadList({ keepSelection: true });
    return null;
  }
}

/**
 * ⌥-move out of the category being viewed: the rows leave the list in this
 * frame (the rest slide up) and the selection moves on, as with archive.
 */
function leaveView(ids: readonly number[], from: number): void {
  const s = getApp();
  if (s.categoryId !== from) return;
  const { items, index } = useList.getState();
  const leaving = new Set(ids);
  if (s.selectedId !== null && leaving.has(s.selectedId)) {
    const start = index.get(s.selectedId) ?? 0;
    const next = items.slice(start + 1).find((t) => !leaving.has(t.id)) ?? items.slice(0, start).reverse().find((t) => !leaving.has(t.id));
    setApp({ selectedId: next?.id ?? null });
  }
  reflowRemoval(ids);
  patchRows(ids, () => null);
  if (s.checked.size) setApp({ checked: new Set() });
}

/** A user removal: the engine learns from it (unless it undoes the user's own add a moment ago). */
export async function removeFromCategory(categoryId: number, threadIds: readonly number[], reason: "user" | "undo" = "user"): Promise<void> {
  if (threadIds.length === 0) return;
  patch(threadIds, categoryId, false);
  try {
    await client.call("categories.removeThreads", { categoryId, threadIds: [...threadIds], reason });
    refreshReader(threadIds);
  } catch (error) {
    toast.error(`No se pudo quitar: ${error instanceof Error ? error.message : error}`);
    void reloadList({ keepSelection: true });
  }
}

/** Takes back one categorization exactly (its batch), whether one thread or a thousand. */
export async function undoFiled(filed: Pick<Filed, "categoryId" | "addedIds" | "batchId" | "movedFrom">): Promise<number> {
  const moved = filed.movedFrom;
  if (filed.batchId === null && !moved) return 0;
  patch(filed.addedIds, filed.categoryId, false);
  const { removed } = filed.batchId === null ? { removed: 0 } : await client.call("categorize.undo", { batchId: filed.batchId });
  // a move also puts the threads back where they were
  if (moved) await client.call("categories.addThreads", { categoryId: moved.categoryId, threadIds: moved.threadIds, source: "dnd" });
  refreshReader(moved ? [...new Set([...filed.addedIds, ...moved.threadIds])] : filed.addedIds);
  void reloadList({ keepSelection: true });
  return removed;
}

/** "Sí, es de Facturas": filed as an accepted suggestion (full weight), with the snackbar like any other add. */
export function acceptSuggestion(threadId: number, categoryId: number): Promise<Filed | null> {
  return addToCategory(categoryId, [threadId], { source: "suggestion" });
}

/** "No": a negative example of weight 1 for that category. */
export async function rejectSuggestion(threadId: number, categoryId: number): Promise<void> {
  try {
    await client.call("categorize.feedback", { threadId, categoryId, verdict: "reject" });
    refreshReader([threadId]);
  } catch (error) {
    toast.error(`No se pudo guardar: ${error instanceof Error ? error.message : error}`);
  }
}
