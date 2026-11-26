import type { Placement } from "@terno/core";
import { create } from "zustand";

/**
 * Plan 282: Put away's placements by conversation, published with the rows they came with (a page's answer), and the
 * Inbox's line (who needs a look since the user last saw it).
 */
interface PutAwayState {
  byThread: ReadonlyMap<number, Placement>;
  notice: { count: number; first: { threadId: number; name: string } | null; through: number } | null;
  /** the line's laid-out height: the room the rows leave above them while it shows */
  noticeHeight: number;
}

/** One line's height, before the line has been measured (the learned offer's) */
export const NOTICE_H = 36;

export const usePutAway = create<PutAwayState>(() => ({ byThread: new Map(), notice: null, noticeHeight: NOTICE_H }));

/** A page's placements: the first page replaces them, a later one adds to them. */
export function publishPlacements(placements: readonly Placement[], replace: boolean): void {
  const next = new Map(replace ? [] : usePutAway.getState().byThread);
  for (const p of placements) next.set(p.threadId, p);
  usePutAway.setState({ byThread: next });
}
