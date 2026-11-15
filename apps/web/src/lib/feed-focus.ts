import { hideFocusRing } from "~/lib/focus-ring";
import { listScroller } from "~/lib/list-scroller";
import { focusQuietly } from "~/lib/quiet-focus";
import { getApp } from "~/state/app";
import { useList } from "~/state/list";
import { create } from "zustand";

/**
 * Plan 210: the item a conversation put away (Esc, the reader's Close, a second click) was opened from: the feed marks it
 * quietly and j/k go on from it, as from the open item. Gone once another opens, or What matters is left.
 */
export const useFeedCursor = create<{ id: number | null }>(() => ({ id: null }));

/** An item's own control in the feed (the digest's too, which has no conversation), if it's drawn. */
const itemButton = (id: number): HTMLElement | null => document.querySelector<HTMLElement>(`[data-testid=wm-feed] [data-item-id="${id}"] [data-testid=wm-item-open]`);

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
 * Plan 210: the keys back on What matters' feed, where the list's rows would have them (Esc from the digest's page, the
 * skip link, a pane switch, j/k): on the open item, else the one a conversation was put away from, else the first drawn.
 * One the feed has scrolled out of its drawn window is brought into view first (Codex code review). False when the feed
 * has no item.
 */
export function focusFeed(o: { quiet?: boolean } = {}): boolean {
  const quiet = o.quiet === true;
  const id = getApp().selectedId ?? useFeedCursor.getState().id;
  const first = () => document.querySelector<HTMLElement>("[data-testid=wm-feed] [data-testid=wm-item-open]");
  const index = id === null ? undefined : useList.getState().index.get(id);
  if (id === null || index === undefined) {
    land(first(), quiet);
    return first() !== null;
  }
  // in view first, drawn or not: a drawn one may be in the overscan, past the edge (Codex code review, round 2)
  listScroller.scrollToIndex?.(index);
  const el = itemButton(id);
  if (el) {
    land(el, quiet);
    return true;
  }
  // drawn once the feed has measured its window (two frames: the scroll, then the rows it brings)
  requestAnimationFrame(() => requestAnimationFrame(() => land(itemButton(id) ?? first(), quiet)));
  return true;
}

/** The item put away has the keys again (once the feed has drawn it: a frame more while it's being drawn), with no ring. */
export function focusFeedItem(id: number): void {
  const el = itemButton(id);
  if (el) land(el, true);
  else requestAnimationFrame(() => land(itemButton(id), true));
}

/**
 * Codex code review: the item the keyboard is on in the feed, which D and the item's keys act on before the open one
 * (Tab to another item, D finishes that one); null when the keys aren't on an item.
 */
export function focusedFeedItem(): number | null {
  const el = document.activeElement?.closest?.("[data-testid=wm-feed] [data-item-id]");
  const id = el ? Number(el.getAttribute("data-item-id")) : NaN;
  return Number.isFinite(id) ? id : null;
}
