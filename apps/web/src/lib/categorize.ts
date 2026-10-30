import { capFilterName, FILTER_NAME_MAX, type FilterableScope } from "@terno/core";
import type { CategorizeSource } from "@terno/core/rpc";
import { t } from "@terno/i18n";
import { client } from "~/rpc/connection";
import { exclusivelyIn } from "~/lib/drag";
import { reflowRemoval } from "~/lib/flash";
import { patchRows, reloadList, useList } from "~/state/list";
import { invalidateThreads, loadThread } from "~/state/threads";
import { getApp, inPlainInbox, setApp, setCategories, type ScopeSelection } from "~/state/app";
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

/** Plan 80: filing into this category takes rows out of the list on screen (a category hidden from the Inbox you're in). */
function leavesInbox(categoryId: number): boolean {
  const s = getApp();
  return inPlainInbox(s) && s.categories.some((c) => c.id === categoryId && !c.showInInbox);
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
  // into a category hidden from the Inbox on screen: the rows leave once it's done (a refusal keeps your place, Codex review)
  const leaves = leavesInbox(categoryId);
  patch(fresh, categoryId, true);
  // the sidebar count moves in the same frame; the backend's counts event confirms it
  const unread = fresh.filter((id) => items[index.get(id) ?? -1]?.unread).length;
  const bumped = unread ? bumpUnread({ [categoryId]: unread }) : null;
  try {
    const res = await client.call("categories.addThreads", { categoryId, threadIds: ids, source: options.source ?? "picker" });
    if (leaves) leaveLoaded(ids);
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
  const leaves = leavesInbox(categoryId);
  if (viewing !== null && viewing !== categoryId) leaveView(ids.filter((id) => index.has(id)));
  else patchRows(ids, (t) => ({ ...t, categoryIds: [categoryId] }));
  const bumped = Object.keys(delta).length ? bumpUnread(delta) : null;
  const source = options.source ?? "dnd";
  try {
    const res = await client.call("categories.moveThreads", { to: categoryId, threadIds: ids, source });
    if (leaves) leaveLoaded(ids);
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
  const leaves = leavesInbox(categoryId);
  patch(loaded, categoryId, true);
  setApp({ checked: new Set(), scope: null });
  const progress = trackJob(t("category.addingScope", { count: sel.count, category: name }));
  try {
    const { added, batchId } = await client.call("categories.addScope", { categoryId, scope: sel.scope, jobId: progress.jobId });
    if (leaves) leaveLoaded(loaded);
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

/** The rows still in the list leave it (after a change into a category hidden from the Inbox on screen). */
function leaveLoaded(ids: readonly number[]): void {
  if (!inPlainInbox(getApp())) return;
  const { index } = useList.getState();
  const here = ids.filter((id) => index.has(id));
  if (here.length) leaveView(here);
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
 * Plan 77: everything from a sender out of a category. The loaded rows lose
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

/** "No": a negative example of weight 1 for that category. False when it failed (the user was told). */
export async function rejectSuggestion(threadId: number, categoryId: number): Promise<boolean> {
  try {
    await client.call("categorize.feedback", { threadId, categoryId, verdict: "reject" });
    refreshReader([threadId]);
    return true;
  } catch (error) {
    snack.error(t("category.saveFailed", { error: errorText(error) }));
    return false;
  }
}

/** The sidebar's ✨ count moves in the same frame; the backend's counts event confirms it. */
function bumpSuggestions(categoryId: number, n: number): void {
  const counts = getApp().counts;
  const left = Math.max(0, (counts.categorySuggestions[categoryId] ?? 0) + n);
  setApp({ counts: { ...counts, categorySuggestions: { ...counts.categorySuggestions, [categoryId]: left } } });
}

/** A failed answer: the real numbers, and the list as it is (the row comes back). */
async function recover(): Promise<void> {
  void reloadList({ keepSelection: true });
  try {
    setApp({ counts: await client.call("counts.get", {}) });
  } catch {
    /* the next counts event corrects them */
  }
}

/**
 * Plan 80: an answer in the Review list (its row's ✓, the thread menu, y/n).
 * The row leaves in this frame, as archive's does (the selection moves on);
 * a failure brings it back. Accepting shows the category snackbar as anywhere.
 */
export async function answerReview(threadId: number, categoryId: number, yes: boolean): Promise<void> {
  // the add reads the row (its unread count moves) before it leaves
  const answered = yes ? acceptSuggestion(threadId, categoryId).then((f) => f !== null) : rejectSuggestion(threadId, categoryId);
  bumpSuggestions(categoryId, -1);
  if (useList.getState().index.has(threadId)) leaveView([threadId]);
  if (!(await answered)) await recover();
}

/** What a filter made here is called: who (and the subject), the domain or the list → the category. */
export function filterNameOf(scope: FilterableScope, senderName: string | null, category: string): string {
  const who = scope.kind === "domain" ? `@${scope.domain}` : scope.kind === "list" ? scope.listId : senderName || scope.email;
  const tail = ` → ${category}`;
  // a filter's name has a cap: a long subject shortens, the category stays readable at the end
  const head = [...(scope.kind === "subject" ? `${who} · ${scope.subject}` : who)];
  const room = Math.max(1, FILTER_NAME_MAX - [...tail].length);
  return capFilterName(`${head.length <= room ? head.join("") : `${head.slice(0, room - 1).join("").trimEnd()}…`}${tail}`);
}

/** What one "always" filing left to take back: each part once (a retry after a failure redoes only what failed). */
interface AlwaysUndo {
  batchId: number | null;
  filterUndo: number | null;
}

/**
 * Plan 80: "Always add to C" from the Review list: every conversation the
 * scope matches now (this one included) and a filter for future mail. The
 * row leaves at once (plan 81: the snackbar's 1–3 pass no row); the rest when
 * the list reloads. One Undo (and z) takes
 * back the filter first (no new mail is caught meanwhile), then the batch;
 * the filter's failing never keeps the mail filed.
 */
export async function fileAlways(categoryId: number, scope: FilterableScope, threadId: number | null, filterName: string): Promise<void> {
  const name = getApp().categories.find((c) => c.id === categoryId)?.name ?? "";
  if (threadId !== null && getApp().reviewCategoryId !== null && useList.getState().index.has(threadId)) leaveView([threadId]);
  const outcome = deferred<AlwaysUndo>();
  const undo = registerUndo(() =>
    outcome.promise.then(async (u) => {
      let failed: unknown = null;
      if (u.filterUndo !== null) {
        try {
          await client.call("similar.undo", { undoId: null, filterUndo: u.filterUndo });
          u.filterUndo = null;
        } catch (error) {
          failed = error;
        }
      }
      if (u.batchId !== null) {
        try {
          await undoFiled({ categoryId, addedIds: [], batchId: u.batchId });
          u.batchId = null;
        } catch (error) {
          failed ??= error;
        }
      }
      if (failed !== null) throw failed;
      void snack(t("category.undone", { category: name }), { background: true });
    }),
  );
  const id = snack.loading(t("category.adding", { category: name }));
  try {
    const r = await client.call("categorize.apply", { categoryId, scope, always: true, filterName });
    outcome.resolve({ batchId: r.batchId, filterUndo: r.filter?.filterUndo ?? null });
    // undone with z before the answer came: its own snacks say so
    if (undo.state !== "ready") return dismissSnack(id);
    const undoable = r.batchId !== null || r.filter?.filterUndo != null;
    // a filter that was already there stays on: the Undo then promises only the filing (plan 81)
    const undoName = r.filter?.filterUndo != null ? t("review.always.undoName") : t("category.undoAdd", { category: name });
    // nothing left to file now: what it did is the filter
    const message = r.filterFailed ? t("category.added", { count: r.added, category: name }) : r.added ? t("review.always.done", { count: r.added, category: name }) : t("category.futureOnly", { category: name });
    snack[r.filterFailed ? "warning" : "success"](message, {
      id,
      duration: 10_000,
      description: r.filterFailed ? t("similar.filterFailed") : undefined,
      action: undoable ? undoAction(undo, undoName) : undefined,
    });
  } catch (error) {
    // part of it may be filed, and the filter made (the backend says which): Undo still takes those back
    const details = (error as { details?: { batchId?: unknown; filterUndo?: unknown } }).details;
    const u = { batchId: typeof details?.batchId === "number" ? details.batchId : null, filterUndo: typeof details?.filterUndo === "number" ? details.filterUndo : null };
    outcome.resolve(u);
    const undoable = u.batchId !== null || u.filterUndo !== null;
    snack.error(t("category.addFailed", { error: errorText(error) }), { id, action: undoable ? undoAction(undo, u.filterUndo !== null ? t("review.always.undoName") : t("category.undoAdd", { category: name })) : undefined });
  } finally {
    void reloadList({ keepSelection: true });
  }
}

/**
 * Plan 80: a category's mail in the Inbox, or not. Applied once the backend
 * has it (a local call), so a list refresh meanwhile never brings rows back:
 * then the category list follows, and hiding it from the Inbox on screen
 * takes its loaded rows out with the archive's fade and slide (the reload
 * the backend's change event brings agrees). Undo (and z) sets the value it
 * had, so a retry or a repeat does no harm. False when nothing changed.
 */
export async function setShowInInbox(categoryId: number, show: boolean): Promise<boolean> {
  const before = getApp().categories.find((c) => c.id === categoryId);
  if (!before) return false;
  try {
    await applyShowInInbox(categoryId, show);
  } catch (error) {
    snack.error(t("category.inboxFailed", { error: errorText(error) }));
    return false;
  }
  if (before.showInInbox === show) return true;
  const name = before.name;
  const undo = registerUndo(() => applyShowInInbox(categoryId, before.showInInbox));
  snack.success(t(show ? "category.shownInInbox" : "category.hiddenFromInbox", { category: name }), {
    duration: 6000,
    action: undoAction(undo, t(show ? "category.undoShowInInbox" : "category.undoHideFromInbox", { category: name })),
  });
  return true;
}

/** Sets it (throws when the backend refuses: an undo stays ready to retry). */
async function applyShowInInbox(categoryId: number, show: boolean): Promise<void> {
  const next = await client.call("categories.update", { id: categoryId, showInInbox: show });
  setCategories(getApp().categories.map((c) => (c.id === next.id ? next : c)));
  if (!show) leaveLoaded(useList.getState().items.filter((row) => row.categoryIds.includes(categoryId)).map((row) => row.id));
}
