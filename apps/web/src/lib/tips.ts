import { create } from "zustand";

/**
 * Plan 113: education tips, each shown once per install beside the thing it teaches (components/tip.tsx draws them).
 * A new tip is an id here, an `offerTip` where the moment happens, and a lazy component built on `Tip`.
 */
export const TIPS = [
  // a new category is hidden from the Inbox: right-click → Show in Inbox brings it back
  "category-inbox",
] as const;
export type TipId = (typeof TIPS)[number];

export const tipKey = (id: TipId): string => `terno:${id}-tip`;

/**
 * The one tip waiting for its stage (never two at once), and what it points at (the tip's own meaning: a category id…).
 * The newest offer wins: a moment that passed before its tip could show isn't pointed at later.
 */
export const useTips = create<{ pending: { id: TipId; target: number } | null }>(() => ({ pending: null }));

export function tipShown(id: TipId): boolean {
  try {
    return localStorage.getItem(tipKey(id)) === "shown";
  } catch {
    return true;
  }
}

export function offerTip(id: TipId, target: number): void {
  if (tipShown(id)) return;
  useTips.setState({ pending: { id, target } });
}

/** it opened: from now on it's been seen, here and in every other window */
export function markTipShown(id: TipId): void {
  try {
    localStorage.setItem(tipKey(id), "shown");
  } catch {
    // storage refused: it may show again next time, which is harmless
  }
}

export function dismissTip(id: TipId): void {
  if (useTips.getState().pending?.id === id) useTips.setState({ pending: null });
}

/** what tip `id` waits to point at, or null */
export const usePendingTip = (id: TipId): number | null => useTips((s) => (s.pending?.id === id ? s.pending.target : null));
