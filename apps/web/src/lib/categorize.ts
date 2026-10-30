import type { CategorizeSource } from "@terno/core/rpc";
import { t } from "@terno/i18n";
import { client } from "~/rpc/connection";
import { exclusivelyIn } from "~/lib/drag";
import { reflowRemoval } from "~/lib/flash";
import { patchRows, reloadList, useList } from "~/state/list";
import { invalidateThreads, loadThread } from "~/state/threads";
import { getApp, setApp, type ScopeSelection } from "~/state/app";
import { deferred, trackJob, undoAction } from "~/lib/actions";
import { scopeRows } from "~/lib/select";
import { dismissSnack, registerUndo, snack } from "~/lib/snack";
import { closePage, currentPage, listLayout } from "~/lib/page";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export interface Filed {
  categoryId: number;
  /** the threads the user acted on (quick actions are computed from these) */
  threadIds: number[];
  /** the ones that were not in the category before: undo removes exactly these */
  addedIds: number[];
  batchId: number | null;
  /** an exclusive move (drag and drop, "Move to…"): the threads also left every other category; undo puts them back */
  moved?: boolean;
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
 * The one way the UI files threads into a category (additive): the picker,
 * the context menu's toggles and an accepted suggestion come through here.
 * Rows update in the same frame, the backend records the training signal,
 * and listeners (the snackbar) get what changed so it can be undone.
 */
export async function addToCategory(categoryId: number, threadIds: readonly number[], options: { source?: CategorizeSource } = {}): Promise<Filed | null> {
  const ids = [...new Set(threadIds)];
  if (ids.length === 0) return null;
  const { items, index } = useList.getState();
  const fresh = ids.filter((id) => !items[index.get(id) ?? -1]?.categoryIds.includes(categoryId));
  patch(fresh, categoryId, true);
  // the sidebar count moves in the same frame; the backend's counts event confirms it
  const unread = fresh.filter((id) => items[index.get(id) ?? -1]?.unread).length;
  const bumped = unread ? bumpUnread({ [categoryId]: unread }) : null;
  try {
    const res = await client.call("categories.addThreads", { categoryId, threadIds: ids, source: options.source ?? "picker" });
    refreshReader(ids);
    const filed: Filed = { categoryId, threadIds: ids, addedIds: res.addedIds, batchId: res.batchId };
    for (const l of listeners) l(filed, options.source ?? "picker");
    return filed;
  } catch (error) {
    snack.error(t("category.addFailed", { error: errorText(error) }));
    if (bumped) void reconcileCounts(bumped);
    void reloadList({ keepSelection: true });
    return null;
  }
}

/** Would moving these threads to the category change nothing (each is in it, and only in it)? */
export function isExclusivelyIn(categoryId: number, threadIds: readonly number[]): boolean {
  const { items, index } = useList.getState();
  return exclusivelyIn(threadIds, categoryId, (id) => items[index.get(id) ?? -1]?.categoryIds);
}

/**
 * Drag and drop and "Move to…": an exclusive move. Afterwards every thread
 * is in `categoryId` and nowhere else. Rows show it in the same frame; in a
 * category view the rows that left it leave the list (as with archive); the
 * sidebar's unread counts move from the sources to the target. One undo
 * (the snackbar's) restores every membership.
 */
export async function moveToCategory(categoryId: number, threadIds: readonly number[], options: { source?: CategorizeSource } = {}): Promise<Filed | null> {
  const ids = [...new Set(threadIds)];
  if (ids.length === 0) return null;
  const { items, index } = useList.getState();
  const delta: Record<number, number> = {};
  for (const id of ids) {
    const t = items[index.get(id) ?? -1];
    if (!t?.unread) continue;
    for (const c of t.categoryIds) if (c !== categoryId) delta[c] = (delta[c] ?? 0) - 1;
    if (!t.categoryIds.includes(categoryId)) delta[categoryId] = (delta[categoryId] ?? 0) + 1;
  }
  const s = getApp();
  const viewing = s.reviewCategoryId === null ? s.categoryId : null;
  if (viewing !== null && viewing !== categoryId) leaveView(ids.filter((id) => index.has(id)));
  else patchRows(ids, (t) => ({ ...t, categoryIds: [categoryId] }));
  const bumped = Object.keys(delta).length ? bumpUnread(delta) : null;
  const source = options.source ?? "dnd";
  try {
    const res = await client.call("categories.moveThreads", { to: categoryId, threadIds: ids, source });
    refreshReader(ids);
    const filed: Filed = { categoryId, threadIds: ids, addedIds: res.addedIds, batchId: res.batchId, moved: true };
    for (const l of listeners) l(filed, source);
    return filed;
  } catch (error) {
    snack.error(t("category.moveFailed", { error: errorText(error) }));
    if (bumped) void reconcileCounts(bumped);
    void reloadList({ keepSelection: true });
    return null;
  }
}

/**
 * "Select all N" + a category: the backend files the whole scope in slices
 * (progress snack), then "N added to X · Undo" (one batch).
 */
export async function addScopeToCategory(categoryId: number, sel: ScopeSelection): Promise<void> {
  const name = getApp().categories.find((c) => c.id === categoryId)?.name ?? "";
  // the scope's loaded rows (with the unread filter, not a read row it kept)
  const loaded = scopeRows(useList.getState().items, sel.scope).map((t) => t.id);
  patch(loaded, categoryId, true);
  setApp({ checked: new Set(), scope: null });
  const progress = trackJob(t("category.addingScope", { count: sel.count, category: name }));
  try {
    const { added, batchId } = await client.call("categories.addScope", { categoryId, scope: sel.scope, jobId: progress.jobId });
    const undo = batchId === null ? null : registerUndo(() => undoFiled({ categoryId, addedIds: [], batchId }).then((n) => void snack(t("category.removed", { count: n, category: name }), { background: true })));
    snack.success(t("category.added", { count: added, category: name }), { id: progress.snackId, duration: 8000, action: undo ? undoAction(undo, t("category.undoAdd", { category: name })) : undefined });
  } catch (error) {
    snack.error(t("category.addFailed", { error: errorText(error) }), { id: progress.snackId });
  } finally {
    progress.stop();
    void reloadList({ keepSelection: true });
  }
}

/** The optimistic change of categories' unread counts (by category id). */
type Bump = Record<number, number>;

function bumpUnread(delta: Bump): Bump {
  const counts = getApp().counts;
  const categoryUnread = { ...counts.categoryUnread };
  for (const [c, n] of Object.entries(delta)) categoryUnread[Number(c)] = Math.max(0, (categoryUnread[Number(c)] ?? 0) + n);
  setApp({ counts: { ...counts, categoryUnread } });
  return delta;
}

/**
 * The change failed: take the bump back at once, then ask the backend for the
 * real numbers (a reloaded list doesn't reload counts).
 */
async function reconcileCounts(b: Bump): Promise<void> {
  bumpUnread(Object.fromEntries(Object.entries(b).map(([c, n]) => [c, -n])));
  try {
    setApp({ counts: await client.call("counts.get", {}) });
  } catch {
    /* the reverted value stands until the next counts event */
  }
}

/**
 * A move out of the category being viewed: the rows leave the list in this
 * frame (the rest slide up) and the selection moves on, as with archive.
 */
function leaveView(ids: readonly number[]): void {
  const s = getApp();
  // List's conversation page (plan 24): the open thread moved out of this list, so the list comes back
  const backToList = s.selectedId !== null && ids.includes(s.selectedId) && listLayout() && currentPage() === "thread";
  if (backToList) closePage({ focus: true });
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
    snack.error(t("category.removeFailed", { error: errorText(error) }));
    void reloadList({ keepSelection: true });
  }
}

/**
 * Plan 76: everything from a sender out of a category. The loaded rows lose
 * it in this frame; the backend finds the rest. z undoes it from the start
 * (it waits for the backend's batch); the undo puts back every membership
 * exactly, including after a failure partway.
 */
export async function removeSenderFromCategory(categoryId: number, email: string): Promise<void> {
  const name = getApp().categories.find((c) => c.id === categoryId)?.name ?? "";
  const lower = email.toLowerCase();
  const loaded = useList.getState().items.filter((t) => t.fromEmail.toLowerCase() === lower && t.categoryIds.includes(categoryId)).map((t) => t.id);
  patch(loaded, categoryId, false);
  // what the reader refreshes after an undo: every thread that left (only the loaded ones after a failure)
  let left = loaded;
  const batch = deferred<number | null>();
  const undo = registerUndo(() =>
    batch.promise.then((batchId) =>
      batchId === null ? undefined : undoFiled({ categoryId, addedIds: [], threadIds: left, batchId, moved: true }).then(() => void snack(t("category.undone", { category: name }), { background: true })),
    ),
  );
  const id = snack.loading(t("category.removing", { category: name }));
  try {
    const { batchId, removed } = await client.call("categories.removeSender", { categoryId, email });
    left = removed;
    batch.resolve(batchId);
    refreshReader(removed);
    // undone with z before the answer came: nothing to say
    if (undo.state !== "ready") return dismissSnack(id);
    snack.success(t("category.removed", { count: removed.length, category: name }), { id, duration: 8000, action: batchId === null ? undefined : undoAction(undo, t("category.undoRemove", { category: name })) });
  } catch (error) {
    // part of it may be done (the backend says which batch): Undo still takes that back
    const batchId = (error as { details?: { batchId?: unknown } }).details?.batchId;
    batch.resolve(typeof batchId === "number" ? batchId : null);
    snack.error(t("category.removeFailed", { error: errorText(error) }), { id, action: typeof batchId === "number" ? undoAction(undo, t("category.undoRemove", { category: name })) : undefined });
  } finally {
    void reloadList({ keepSelection: true });
  }
}

/**
 * Takes back one categorization exactly (its batch), whether one thread or a
 * thousand; for a move, the backend restores every category the threads
 * left in the same transaction. Throws when the backend refuses: the caller keeps its undo
 * control so the user can retry (the undo is idempotent).
 */
export async function undoFiled(filed: Pick<Filed, "categoryId" | "addedIds" | "batchId" | "moved"> & { threadIds?: number[] }): Promise<number> {
  if (filed.batchId === null) return 0;
  if (!filed.moved) patch(filed.addedIds, filed.categoryId, false);
  try {
    const { removed } = await client.call("categorize.undo", { batchId: filed.batchId });
    refreshReader(filed.moved ? [...new Set([...filed.addedIds, ...(filed.threadIds ?? [])])] : filed.addedIds);
    return removed;
  } finally {
    // success shows the restored rows; failure puts the optimistic removal back
    void reloadList({ keepSelection: true });
  }
}

/** "Yes, it’s Invoices": filed as an accepted suggestion (full weight), with the snackbar like any other add. */
export function acceptSuggestion(threadId: number, categoryId: number): Promise<Filed | null> {
  return addToCategory(categoryId, [threadId], { source: "suggestion" });
}

/** "No": a negative example of weight 1 for that category. */
export async function rejectSuggestion(threadId: number, categoryId: number): Promise<void> {
  try {
    await client.call("categorize.feedback", { threadId, categoryId, verdict: "reject" });
    refreshReader([threadId]);
  } catch (error) {
    snack.error(t("category.saveFailed", { error: errorText(error) }));
  }
}
