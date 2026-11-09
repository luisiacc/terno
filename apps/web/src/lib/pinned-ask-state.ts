import type { AskSourceView, AskTurn } from "@terno/core";
import { create } from "zustand";

/**
 * Plan 165: one Ask answer pinned at the reading pane's bottom right, kept while its sources are read. A copy of the
 * answer as it was pinned (a follow-up or a new question in Ask doesn't change it). Session state only, per window, as
 * the pinned draft (plan 115).
 */
export interface PinnedAnswer {
  conversationId: number;
  turn: AskTurn;
  /** where its sources were when it was pinned; what Ask learns since is read over it */
  views: Readonly<Record<number, AskSourceView>>;
}

interface PinnedAskState {
  pinned: PinnedAnswer | null;
  /** the card folded to its header (the user's choice) */
  collapsed: boolean;
  /** the card's height plus its offsets: the reader, the list and a new message pad their scroll end by it */
  inset: number;
  /** where it stands on the snack dock, from the pane's bottom (px; 0: it doesn't meet it): the draft beside it stands
   * there too, so their feet stay on one line */
  floor: number;
  /** it reaches past the reading pane over Split's thread list: the list's end scrolls clear of it */
  overList: boolean;
  /** each request for focus in the card (a pin) */
  focus: number;
}

export const usePinnedAsk = create<PinnedAskState>(() => ({ pinned: null, collapsed: false, inset: 0, floor: 0, overList: false, focus: 0 }));

export const clearPinnedAnswer = (): void => usePinnedAsk.setState({ pinned: null, inset: 0, floor: 0, overList: false });

/** Conversations gone (deleted here or in another window; null: everything, Clear AI data): a card quoting one goes. */
export function forgetPinnedAnswer(conversationIds: readonly number[] | null): void {
  const pinned = usePinnedAsk.getState().pinned;
  if (pinned && (conversationIds === null || conversationIds.includes(pinned.conversationId))) clearPinnedAnswer();
}

/** The card's distance from the pane's edges and from the draft (px), the draft's own. */
export const CARD_GAP = 12;
/** Its widest (24 rem), and its width beside a pinned draft where the reading pane can't hold that (20 rem: it reaches
 * over the thread list for it). */
export const CARD_MAX_W = 384;
export const CARD_MIN_BESIDE = 320;
/** Under this (15 rem) between the list's edge and the draft, it may reach over the sidebar, to the window's edge. */
export const CARD_MIN_FIT = 240;
/** Its tallest (30 rem), as 60% of the pane allows; never shorter than its header (40 px), which a short window may push up. */
export const CARD_MAX_H = 480;
export const CARD_HEADER = 40;

export interface CardPlace {
  /** from the pane's right edge and bottom edge (px) */
  right: number;
  bottom: number;
  width: number;
  /** its tallest here (px) */
  maxHeight: number;
  where: "alone" | "beside";
  /** how far it reaches past the pane's left edge (px; over the thread list in Split) */
  past: number;
}

/** From the pane's right edge (px): to the thread list's left edge, and to the window's. */
export interface CardReach {
  list: number;
  window: number;
}

/**
 * Plan 165: where the card goes. Alone, the pane's corner. A pinned draft keeps the corner and the card is always to its
 * left, its foot on the draft's (`draft.bottom`), at every size (the owner: never above it): 24 rem at most where the
 * pane holds it, else 20 rem reaching left over the thread list, narrower only where even the list's edge is closer, and
 * over the sidebar only where that leaves under 15 rem. `floor`: the least its foot may be from the pane's bottom (it
 * stands on the snack dock where they'd meet). `top`: what it never covers at the pane's top (the reader's toolbar).
 */
export function pinnedAskPlace(pane: { width: number; height: number }, draft: { width: number; bottom: number } | null, floor = 0, top = 0, reach: CardReach = { list: pane.width, window: pane.width }): CardPlace {
  const bottom = Math.max(draft ? draft.bottom : CARD_GAP, floor);
  const room = Math.max(0, pane.height - bottom - top - CARD_GAP);
  const maxHeight = Math.max(CARD_HEADER, Math.floor(Math.min(room, pane.height * 0.6, CARD_MAX_H)));
  if (!draft) return { right: CARD_GAP, bottom, width: Math.max(0, Math.min(CARD_MAX_W, pane.width - CARD_GAP * 2)), maxHeight, where: "alone", past: 0 };
  const right = CARD_GAP * 2 + draft.width;
  const inPane = pane.width - right - CARD_GAP;
  const toList = reach.list - right - CARD_GAP;
  const fits = toList >= CARD_MIN_FIT ? toList : Math.max(toList, reach.window - right - CARD_GAP);
  const width = Math.max(0, Math.min(CARD_MAX_W, Math.max(CARD_MIN_BESIDE, inPane), fits));
  return { right, bottom, width, maxHeight, where: "beside", past: Math.max(0, right + width - pane.width) };
}
