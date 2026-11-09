import { create } from "zustand";
import { usePinnedAsk } from "./pinned-ask-state";

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
  /** plan 165: its width, for the pinned answer that goes to its left */
  width: number;
  /** its foot's distance from the pane's bottom (px): the pinned answer beside it stands on the same line */
  bottom: number;
  /** each request for focus in the card (a pin, r/a/f on its conversation, the strip) */
  focus: number;
}

export const usePinned = create<PinnedState>(() => ({ key: null, threadId: null, inset: 0, width: 0, bottom: 0, focus: 0 }));

export const pinnedKey = (): string | null => usePinned.getState().key;

/**
 * The draft's tallest: 70% of its pane and 40 rem, and never past the pane's top however high it stands (plan 165: a
 * snack under the pinned answer beside it lifts both, onto one line).
 */
export const draftMaxHeight = (bottom: number): string => `min(70%, 40rem, calc(100% - ${bottom + 12}px))`;

/** What pads a scroll end at the bottom right: the snack dock's or the card's, whichever is taller. */
export const bottomInset = (snackInset: number, pinnedInset: number): number => Math.max(snackInset, pinnedInset);

/**
 * Plan 165: how much of the pane's foot the pinned cards cover, the draft's and the answer's (each its offset from the
 * bottom plus its height: the answer's stands on the draft's when it's above it). `on`: only where they're over this pane.
 */
export const usePinnedInset = (on = true): number => Math.max(usePinned((s) => (on ? s.inset : 0)), usePinnedAsk((s) => (on ? s.inset : 0)));
export const pinnedInsetNow = (): number => Math.max(usePinned.getState().inset, usePinnedAsk.getState().inset);

/** Asks the card to take focus (its body). */
export function focusPinned(): void {
  usePinned.setState((s) => ({ focus: s.focus + 1 }));
}

/** Pins a draft, for what can't import the card's module (it's the DOM's); `pinned-draft` sets it. */
export const pinning: { pin: (key: string) => boolean } = { pin: () => false };
