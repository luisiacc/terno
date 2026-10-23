import type { CategorizeSource } from "@unica/core/rpc";
import { toast } from "sonner";
import { client } from "~/rpc/connection";
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
export async function addToCategory(categoryId: number, threadIds: readonly number[], options: { source?: CategorizeSource } = {}): Promise<Filed | null> {
  const ids = [...new Set(threadIds)];
  if (ids.length === 0) return null;
  const { items, index } = useList.getState();
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
    const filed: Filed = { categoryId, threadIds: ids, addedIds: res.addedIds, batchId: res.batchId };
    for (const l of listeners) l(filed, options.source ?? "picker");
    return filed;
  } catch (error) {
    toast.error(`No se pudo añadir: ${error instanceof Error ? error.message : error}`);
    void reloadList({ keepSelection: true });
    return null;
  }
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
export async function undoFiled(filed: Pick<Filed, "categoryId" | "addedIds" | "batchId">): Promise<number> {
  if (filed.batchId === null) return 0;
  patch(filed.addedIds, filed.categoryId, false);
  const { removed } = await client.call("categorize.undo", { batchId: filed.batchId });
  refreshReader(filed.addedIds);
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
