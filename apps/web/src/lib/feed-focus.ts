import type { FeedRowId } from "@terno/core";
import { hideFocusRing } from "~/lib/focus-ring";
import { focusQuietly } from "~/lib/quiet-focus";
import { getApp } from "~/state/app";
import { feedRow, useFeedRow, useToday } from "~/state/today";

/**
 * Plan 210 (iteration 2): the feed scrolls a row into view by its id (registered by the feed while it's drawn); the list's
 * own `listScroller` stays the conversations' (a list index).
 */
export const feedScroller: { toRow?: (id: FeedRowId) => void } = {};

/** An item's own control in the feed (the digest's too, which has no conversation), if it's drawn. */
const itemButton = (id: FeedRowId): HTMLElement | null => document.querySelector<HTMLElement>(`[data-testid=wm-feed] [data-row-id="${CSS.escape(id)}"] [data-testid=wm-item-open]`);

/**
 * The keys on an item the app moved them to, quietly. `quiet`: after a key the app answered (Esc, the reader's Close, j/k)
 * no ring (plan 54); F6 and the skip link move as Tab does, and keep it (Codex code review, round 2).
 */
function land(el: HTMLElement | null, quiet: boolean): void {
  if (!el) return;
  focusQuietly(el);
  if (quiet) hideFocusRing();
}

/**
 * The row the feed is on: the open one while its conversation is the app's open one, else the one a conversation was put
 * away from (plan 210, iteration 2: a row, never "the conversation's row").
 */
export function feedPlace(): FeedRowId | null {
  const { opened, cursor } = useFeedRow.getState();
  const open = feedRow(opened);
  return open && getApp().selectedId === open.threadId ? open.id : cursor;
}

/**
 * Plan 210: the keys back on What matters' feed, where the list's rows would have them (Esc from the digest's page, the
 * skip link, a pane switch, j/k): on the open row, else the one a conversation was put away from, else the first drawn.
 * One the feed has scrolled out of its drawn window is brought into view first (Codex code review). False when the feed
 * has no item.
 */
export function focusFeed(o: { quiet?: boolean } = {}): boolean {
  const quiet = o.quiet === true;
  const id = feedPlace();
  const first = () => document.querySelector<HTMLElement>("[data-testid=wm-feed] [data-testid=wm-item-open]");
  if (id === null || !useToday.getState().rows.some((r) => r.id === id)) {
    land(first(), quiet);
    return first() !== null;
  }
  // in view first, drawn or not: a drawn one may be in the overscan, past the edge (Codex code review, round 2)
  feedScroller.toRow?.(id);
  const el = itemButton(id);
  if (el) {
    land(el, quiet);
    return true;
  }
  // drawn once the feed has measured its window (two frames: the scroll, then the rows it brings)
  requestAnimationFrame(() => requestAnimationFrame(() => land(itemButton(id) ?? first(), quiet)));
  return true;
}

/**
 * The row put away has the keys again (once the feed has drawn it: a frame more while it's being drawn), with no ring;
 * `still`: whether that's still wanted when the frame comes (nothing moved the keys meanwhile).
 */
export function focusFeedItem(id: FeedRowId, still: () => boolean = () => true): void {
  const el = itemButton(id);
  if (el) land(el, true);
  else requestAnimationFrame(() => still() && land(itemButton(id), true));
}

/**
 * Codex code review: the row the keyboard is on in the feed, which D and the item's keys act on before the open one (Tab
 * to another item, D finishes that one); null when the keys aren't on an item.
 */
export function focusedFeedItem(): FeedRowId | null {
  const el = document.activeElement?.closest?.("[data-testid=wm-feed] [data-row-id]");
  return el?.getAttribute("data-row-id") ?? null;
}
