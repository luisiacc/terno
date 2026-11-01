import { create } from "zustand";

/**
 * Plan 115: one draft pinned at the reading area's bottom right, kept there
 * while other conversations are read. Session state only: after a reload the
 * draft is where it lives (its conversation, or the strip).
 */
interface PinnedState {
  key: string | null;
  /** the conversation it was pinned from (null for a new message): that conversation shows "Draft pinned" in its place */
  threadId: number | null;
  /** the card's height plus its margins: the reader, the list and a new message pad their scroll end by it */
  inset: number;
  /** each request for focus in the card (a pin, r/a/f on its conversation, the strip) */
  focus: number;
}

export const usePinned = create<PinnedState>(() => ({ key: null, threadId: null, inset: 0, focus: 0 }));

export const pinnedKey = (): string | null => usePinned.getState().key;

/** What pads a scroll end at the bottom right: the snack dock's or the card's, whichever is taller. */
export const bottomInset = (snackInset: number, pinnedInset: number): number => Math.max(snackInset, pinnedInset);

/** Asks the card to take focus (its body). */
export function focusPinned(): void {
  usePinned.setState((s) => ({ focus: s.focus + 1 }));
}
