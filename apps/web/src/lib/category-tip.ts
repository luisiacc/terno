import type { Category } from "@terno/core";
import { create } from "zustand";

/**
 * Plan 113: the one-time tip beside a new category's sidebar row (new categories start hidden from the Inbox, plan 83).
 * Offered by every creation in the UI; written as shown once it opens, so it never comes back.
 */
const KEY = "terno:category-inbox-tip";

/** the category the tip is waiting to point at */
export const useCategoryTip = create<{ id: number | null }>(() => ({ id: null }));

export function categoryTipShown(): boolean {
  try {
    return localStorage.getItem(KEY) === "shown";
  } catch {
    return true;
  }
}

/** the newest creation wins: one made before the last could show is never pointed at */
export function offerCategoryTip(c: Category): void {
  if (c.showInInbox || categoryTipShown()) return;
  useCategoryTip.setState({ id: c.id });
}

/** it opened: from now on it's been seen, here and in every other window */
export function markCategoryTipShown(): void {
  try {
    localStorage.setItem(KEY, "shown");
  } catch {
    // storage refused: it may show again next time, which is harmless
  }
}

export function dismissCategoryTip(): void {
  if (useCategoryTip.getState().id !== null) useCategoryTip.setState({ id: null });
}
