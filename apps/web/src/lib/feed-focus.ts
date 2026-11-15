import { focusQuietly } from "~/lib/quiet-focus";
import { getApp } from "~/state/app";
import { create } from "zustand";

/**
 * Plan 210: the item a conversation put away (Esc, the reader's Close, a second click) was opened from: the feed marks it
 * quietly and j/k go on from it, as from the open item. Gone once another opens, or What matters is left.
 */
export const useFeedCursor = create<{ id: number | null }>(() => ({ id: null }));

/** An item's own control in the feed (the digest's too, which has no conversation), if it's drawn. */
const itemButton = (id: number): HTMLElement | null => document.querySelector<HTMLElement>(`[data-testid=wm-feed] [data-item-id="${id}"] [data-testid=wm-item-open]`);

/**
 * Plan 210: the keys back on What matters' feed, where the list's rows would have them (Esc from the digest's page, the
 * skip link, a pane switch): on the open item, else the one a conversation was put away from, else the first drawn.
 * Quietly (no ring after a key, plan 54). An item just scrolled to is drawn a frame later. False when the feed has none.
 */
export function focusFeed(): boolean {
  const id = getApp().selectedId ?? useFeedCursor.getState().id;
  const first = () => document.querySelector<HTMLElement>("[data-testid=wm-feed] [data-testid=wm-item-open]");
  const el = id === null ? first() : itemButton(id);
  if (el) {
    focusQuietly(el);
    return true;
  }
  if (id === null || !first()) return false;
  requestAnimationFrame(() => focusQuietly(itemButton(id) ?? first()));
  return true;
}

/** The item put away has the keys again (once the feed has drawn it). */
export const focusFeedItem = (id: number): void => focusQuietly(itemButton(id));
