import { afterEach, describe, expect, it, vi } from "vitest";

// node: a Map-backed localStorage
vi.hoisted(() => {
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = { setItem: (k: string, v: string) => void store.set(k, v), getItem: (k: string) => store.get(k) ?? null, removeItem: (k: string) => void store.delete(k), clear: () => store.clear() };
});
import { dismissTip, markTipShown, offerTip, tipKey, tipShown, useTips } from "./tips";

afterEach(() => {
  localStorage.clear();
  useTips.setState({ pending: null });
});

describe("education tips (plan 113)", () => {
  it("waits with what it points at; the newest offer wins", () => {
    offerTip("category-inbox", 1);
    offerTip("category-inbox", 2);
    expect(useTips.getState().pending).toEqual({ id: "category-inbox", target: 2 });
  });

  it("once shown, is never offered again", () => {
    expect(tipShown("category-inbox")).toBe(false);
    offerTip("category-inbox", 1);
    markTipShown("category-inbox");
    dismissTip("category-inbox");
    expect(useTips.getState().pending).toBeNull();
    expect(localStorage.getItem(tipKey("category-inbox"))).toBe("shown");
    offerTip("category-inbox", 2);
    expect(useTips.getState().pending).toBeNull();
  });

  it("keeps the key the category tip shipped with", () => {
    expect(tipKey("category-inbox")).toBe("terno:category-inbox-tip");
  });
});
