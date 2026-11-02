import type { Category } from "@terno/core";
import { afterEach, describe, expect, it, vi } from "vitest";

// node: a Map-backed localStorage
vi.hoisted(() => {
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = { setItem: (k: string, v: string) => void store.set(k, v), getItem: (k: string) => store.get(k) ?? null, removeItem: (k: string) => void store.delete(k), clear: () => store.clear() };
});
import { categoryTipShown, dismissCategoryTip, markCategoryTipShown, offerCategoryTip, useCategoryTip } from "./category-tip";

const category = (id: number, showInInbox = false): Category => ({ id, name: `C${id}`, color: "rose", position: id, autoApply: true, showInInbox }) as Category;

afterEach(() => {
  localStorage.clear();
  useCategoryTip.setState({ id: null });
});

describe("the new category's tip (plan 113)", () => {
  it("is offered for a category created hidden from the Inbox, not for one that shows there", () => {
    offerCategoryTip(category(1, true));
    expect(useCategoryTip.getState().id).toBeNull();
    offerCategoryTip(category(2));
    expect(useCategoryTip.getState().id).toBe(2);
  });

  it("points at the newest creation while none has shown", () => {
    offerCategoryTip(category(1));
    offerCategoryTip(category(2));
    expect(useCategoryTip.getState().id).toBe(2);
  });

  it("once shown, is never offered again", () => {
    expect(categoryTipShown()).toBe(false);
    offerCategoryTip(category(1));
    markCategoryTipShown();
    dismissCategoryTip();
    expect(useCategoryTip.getState().id).toBeNull();
    expect(categoryTipShown()).toBe(true);
    offerCategoryTip(category(2));
    expect(useCategoryTip.getState().id).toBeNull();
  });
});
