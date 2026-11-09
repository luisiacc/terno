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
  /** each request for focus in the card (a pin) */
  focus: number;
}

export const usePinnedAsk = create<PinnedAskState>(() => ({ pinned: null, collapsed: false, inset: 0, focus: 0 }));

export const clearPinnedAnswer = (): void => usePinnedAsk.setState({ pinned: null, inset: 0 });

/** Conversations gone (deleted here or in another window; null: everything, Clear AI data): a card quoting one goes. */
export function forgetPinnedAnswer(conversationIds: readonly number[] | null): void {
  const pinned = usePinnedAsk.getState().pinned;
  if (pinned && (conversationIds === null || conversationIds.includes(pinned.conversationId))) clearPinnedAnswer();
}

/** The card's distance from the pane's edges and from the draft (px), the draft's own. */
export const CARD_GAP = 12;
/** Its widest (24 rem) and the least it takes beside a pinned draft (20 rem); narrower, it goes above the draft. */
export const CARD_MAX_W = 384;
export const CARD_MIN_BESIDE = 320;
/** Above a draft with less room than this (px) for it, it shows its header alone. */
export const CARD_MIN_OPEN = 140;
/** Its tallest (30 rem), as 60% of the pane allows; over a draft, 20 rem, so the conversation still reads beside them. */
export const CARD_MAX_H = 480;
export const CARD_MAX_H_ABOVE = 320;

export interface CardPlace {
  /** from the pane's right edge and bottom edge (px) */
  right: number;
  bottom: number;
  width: number;
  /** its tallest here (px) */
  maxHeight: number;
  /** too little room to open: its header alone, whatever its own choice */
  squeezed: boolean;
  where: "alone" | "beside" | "above";
}

/**
 * Plan 165: where the card goes. A pinned draft keeps the corner: the card is to its left when the pane holds both and
 * 20 rem for the card, else above it. `floor`: the least its foot may be from the pane's bottom (it stands on the snack
 * dock where they'd meet, as the draft does). `top`: what it never covers at the pane's top (the reader's toolbar). Its
 * height is capped by the room left (60% of the pane and 30 rem at most, 20 rem over a draft); under 140 px it shows its
 * header alone.
 */
export function pinnedAskPlace(pane: { width: number; height: number }, draft: { width: number; inset: number } | null, floor = 0, top = 0): CardPlace {
  const full = Math.max(0, Math.min(CARD_MAX_W, pane.width - CARD_GAP * 2));
  const beside = draft ? pane.width - draft.width - CARD_GAP * 3 : 0;
  const where: CardPlace["where"] = !draft ? "alone" : beside >= CARD_MIN_BESIDE ? "beside" : "above";
  // above the draft: its foot a gap over the draft's top (the draft's inset is its height, its lift and both gaps)
  const bottom = Math.max(where === "above" ? draft!.inset : CARD_GAP, floor);
  const room = Math.max(0, pane.height - bottom - top - CARD_GAP);
  return {
    right: where === "beside" ? CARD_GAP * 2 + draft!.width : CARD_GAP,
    bottom,
    width: where === "beside" ? Math.min(CARD_MAX_W, beside) : full,
    maxHeight: Math.floor(Math.min(room, pane.height * 0.6, where === "above" ? CARD_MAX_H_ABOVE : CARD_MAX_H)),
    squeezed: room < CARD_MIN_OPEN,
    where,
  };
}
