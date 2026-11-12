import type { Category } from "@terno/core";
import { getApp, navigate, setApp, useApp, type AppState } from "~/state/app";
import { reloadList, useList } from "~/state/list";

/**
 * Plan 159: sorting the categories' suggestions. One category's Review at a time (no All: its suggestions come one
 * category per query), entered from the sidebar on the category with the most, switched in its header, and left for
 * where it was entered from (Esc, or its category deleted). Its last suggestion answered, it stays, empty, saying what's
 * left elsewhere: Undo brings the rows back where you are.
 */

export interface Pending {
  category: Category;
  count: number;
}

/** The categories with suggestions waiting, the most first (ties in the sidebar's order), and their sum: the sidebar's number. */
export function reviewTotals(categories: readonly Category[], suggestions: Readonly<Record<number, number>>): { total: number; pending: Pending[] } {
  let total = 0;
  const pending: Pending[] = [];
  for (const category of categories) {
    const count = suggestions[category.id] ?? 0;
    if (count <= 0) continue;
    total += count;
    pending.push({ category, count });
  }
  // stable: equal counts keep the sidebar's order
  pending.sort((a, b) => b.count - a.count);
  return { total, pending };
}

/**
 * Plan 192: where an emptied Review goes on to: the category with the most waiting that isn't the one in view (by id: its
 * own count may not have caught up yet), or none.
 */
export function nextToSort(categories: readonly Category[], suggestions: Readonly<Record<number, number>>, current: number): Category | null {
  return reviewTotals(categories, suggestions).pending.find((p) => p.category.id !== current)?.category ?? null;
}

/** Where Review was entered from: a mailbox, an account's folder, a list of its own or a search. */
type Origin = Pick<AppState, "view" | "accountId" | "categoryId" | "folder" | "gmailTab" | "reminders" | "followups" | "today" | "query" | "selectedId"> & {
  /** a search's rows and offset (a mailbox's own place is kept by the list; a search's isn't, Codex code review #2) */
  results: { rows: Pick<ReturnType<typeof useList.getState>, "key" | "itemsKey" | "items" | "index" | "nextCursor">; scrollTop: number } | null;
};
/** (an object's property, not a module let: the React Compiler and a read-then-reset of a let don't mix) */
export const reviewFrom: { origin: Origin | null } = { origin: null };

const listEl = () => document.querySelector<HTMLElement>('[data-keep-scroll="list"]');

/** Into a category's Review: from elsewhere, where you were is kept for the way back; from Review, it's a switch. */
export function enterReview(categoryId: number): void {
  const s = getApp();
  if (s.reviewCategoryId !== null) return switchReview(categoryId);
  const { key, itemsKey, items, index, nextCursor } = useList.getState();
  // a sentence's preview is no place to come back to (it's over once left): the way back is the Inbox's
  reviewFrom.origin = s.actionPreview
    ? null
    : {
        view: s.view, accountId: s.accountId, categoryId: s.categoryId, folder: s.folder, gmailTab: s.gmailTab, reminders: s.reminders, followups: s.followups, today: s.today, query: s.query, selectedId: s.selectedId,
        results: s.query.trim() && itemsKey === key ? { rows: { key, itemsKey, items, index, nextCursor }, scrollTop: listEl()?.scrollTop ?? 0 } : null,
      };
  navigate({ view: "all", reviewCategoryId: categoryId, accountId: null });
}

/** Another category's suggestions, in the same Review: the way back stays the one you came in by. */
export function switchReview(categoryId: number): void {
  if (getApp().reviewCategoryId === categoryId) return;
  setApp({ reviewCategoryId: categoryId, selectedId: null, checked: new Set(), anchorId: null, scope: null, readerOpen: false });
}

/** Plan 192: out of an emptied Review with nothing left anywhere, to the Inbox (Esc still goes back where it was entered from). */
export function reviewToInbox(): void {
  if (getApp().reviewCategoryId === null) return;
  navigate({ view: "inbox", accountId: null, categoryId: null, reviewCategoryId: null });
}

/** Is the place still there (its category, account or folder gone meanwhile, maybe in another window: Codex code review #3)? */
function stillThere(o: Origin, s: AppState): boolean {
  if (o.categoryId !== null && !s.categories.some((c) => c.id === o.categoryId)) return false;
  if (o.accountId !== null && !s.accounts.some((a) => a.id === o.accountId)) return false;
  return o.folder === null || s.folders.some((f) => f.accountId === o.accountId && f.key === o.folder && f.selectable);
}

/** Out of Review, back where it was entered from (that mailbox's own place: its thread and scroll), else the Inbox. */
export function leaveReview(): void {
  const from = reviewFrom.origin;
  reviewFrom.origin = null;
  const s = getApp();
  if (s.reviewCategoryId === null) return;
  if (!from || !stillThere(from, s)) return navigate({ view: "inbox", accountId: null, categoryId: null, reviewCategoryId: null });
  const { query, selectedId, results, ...place } = from;
  if (!query.trim()) return navigate({ ...place, reviewCategoryId: null });
  // a search: its query again, in one step, on the rows it showed (the cursor and offset with them), then refreshed in
  // place, as a sentence's preview comes back to its list
  if (results) useList.setState({ ...results.rows, loading: false, loadingMore: false, error: null });
  setApp({ ...place, reviewCategoryId: null, actionPreview: null, query, selectedId: results ? selectedId : null, checked: new Set(), anchorId: null, scope: null, readerOpen: false });
  if (!results) return;
  void reloadList({ keepSelection: true, window: true });
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const el = listEl();
      if (el) el.scrollTop = results.scrollTop;
    }),
  );
}

useApp.subscribe((s, prev) => {
  const review = s.reviewCategoryId;
  // left for anywhere but a search typed in it (whose Esc comes back to it) or a sentence's preview (whose Cancel comes
  // back to it, Codex code review round 2 #1): the way back is forgotten
  if (review === null) {
    if (prev.reviewCategoryId !== null && !s.query.trim() && s.actionPreview === null) reviewFrom.origin = null;
    return;
  }
  // its category deleted (here or in another window): out, the same way
  if (s.categories !== prev.categories && !s.categories.some((c) => c.id === review)) leaveReview();
});
