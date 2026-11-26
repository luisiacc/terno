import type { Placement } from "@terno/core";
import { create } from "zustand";

/**
 * Plan 282: Put away's placements by conversation, published with the rows they came with (a page's answer), and the
 * Inbox's line (who needs a look since the user last saw it).
 */
interface PutAwayState {
  byThread: ReadonlyMap<number, Placement>;
  /** the conversations a fix took out of Put away while in view, with what the row says now ("Back in the Inbox"): the open one stays, under its section */
  returned: ReadonlyMap<number, Returned>;
  notice: { count: number; first: { threadId: number; name: string } | null; through: number } | null;
  /** the line's laid-out height: the room the rows leave above them while it shows */
  noticeHeight: number;
}

/** One line's height, before the line has been measured (the learned offer's) */
export const NOTICE_H = 36;

export const usePutAway = create<PutAwayState>(() => ({ byThread: new Map(), returned: new Map(), notice: null, noticeHeight: NOTICE_H }));

/** A page's placements: the first page replaces them, a later one adds to them. */
export function publishPlacements(placements: readonly Placement[], replace: boolean): void {
  const { byThread, returned } = usePutAway.getState();
  const next = new Map(replace ? [] : byThread);
  // a conversation brought back keeps its placement (its section) while its row stays; put away again, it's the new one
  if (replace) for (const id of returned.keys()) if (byThread.has(id)) next.set(id, byThread.get(id)!);
  const still = new Map(returned);
  for (const p of placements) {
    next.set(p.threadId, p);
    still.delete(p.threadId);
  }
  usePutAway.setState({ byThread: next, returned: still.size === returned.size ? returned : still });
}

/** What a row brought back says, and whether that's the Inbox (another hidden category may still keep it out) */
export interface Returned {
  line: string;
  inbox: boolean;
}

/** What a fix did, said on the rows it took out of Put away (they stay until you leave it) */
export function markReturned(threadIds: readonly number[], line: string, inbox = true): void {
  const returned = new Map(usePutAway.getState().returned);
  for (const id of threadIds) returned.set(id, { line, inbox });
  usePutAway.setState({ returned });
}

/** Rows no longer shown as brought back: their row left, or the view did */
export function forgetReturned(threadIds?: readonly number[]): void {
  const { returned } = usePutAway.getState();
  if (returned.size === 0) return;
  if (!threadIds) return usePutAway.setState({ returned: new Map() });
  const next = new Map(returned);
  for (const id of threadIds) next.delete(id);
  usePutAway.setState({ returned: next });
}
