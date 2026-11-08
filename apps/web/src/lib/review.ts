import type { Category } from "@terno/core";
import { getApp, navigate, setApp, useApp, type AppState } from "~/state/app";

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

/** Where Review was entered from: a mailbox, an account's folder, a list of its own or a search. */
type Origin = Pick<AppState, "view" | "accountId" | "categoryId" | "folder" | "gmailTab" | "reminders" | "followups" | "today" | "query">;
/** (an object's property, not a module let: the React Compiler and a read-then-reset of a let don't mix) */
export const reviewFrom: { origin: Origin | null } = { origin: null };

/** Into a category's Review: from elsewhere, where you were is kept for the way back; from Review, it's a switch. */
export function enterReview(categoryId: number): void {
  const s = getApp();
  if (s.reviewCategoryId !== null) return switchReview(categoryId);
  // a sentence's preview is no place to come back to (it's over once left): the way back is the Inbox's
  reviewFrom.origin = s.actionPreview
    ? null
    : { view: s.view, accountId: s.accountId, categoryId: s.categoryId, folder: s.folder, gmailTab: s.gmailTab, reminders: s.reminders, followups: s.followups, today: s.today, query: s.query };
  navigate({ view: "all", reviewCategoryId: categoryId, accountId: null });
}

/** Another category's suggestions, in the same Review: the way back stays the one you came in by. */
export function switchReview(categoryId: number): void {
  if (getApp().reviewCategoryId === categoryId) return;
  setApp({ reviewCategoryId: categoryId, selectedId: null, checked: new Set(), anchorId: null, scope: null, readerOpen: false });
}

/** Out of Review, back where it was entered from (that mailbox's own place: its thread and scroll), else the Inbox. */
export function leaveReview(): void {
  const from = reviewFrom.origin;
  reviewFrom.origin = null;
  if (getApp().reviewCategoryId === null) return;
  if (!from) return navigate({ view: "inbox", accountId: null, categoryId: null, reviewCategoryId: null });
  const { query, ...place } = from;
  if (!query.trim()) return navigate({ ...place, reviewCategoryId: null });
  // a search: its query again, in one step (one list asked for, not the mailbox's and then the search's)
  setApp({ ...place, reviewCategoryId: null, actionPreview: null, query, selectedId: null, checked: new Set(), anchorId: null, scope: null, readerOpen: false });
}

useApp.subscribe((s, prev) => {
  const review = s.reviewCategoryId;
  // left for anywhere but a search typed in it (whose Esc comes back to it): the way back is forgotten
  if (review === null) {
    if (prev.reviewCategoryId !== null && !s.query.trim()) reviewFrom.origin = null;
    return;
  }
  // its category deleted (here or in another window): out, the same way
  if (s.categories !== prev.categories && !s.categories.some((c) => c.id === review)) leaveReview();
});
