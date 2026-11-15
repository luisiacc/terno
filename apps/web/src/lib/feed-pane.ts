import { listLayout } from "~/lib/page";
import { feedPlace, feedScroller, focusFeedItem } from "~/lib/feed-focus";
import { getApp, setApp } from "~/state/app";
import { useFeedRow } from "~/state/today";

/**
 * Plan 204 (the feed), plan 210: Esc, the reader's Close and a click on the open item, in Split: the conversation open
 * beside Today's feed goes, and the feed has the room again; the keyboard is back on the row it was opened from (quietly:
 * no ring after a key or a click, plan 54), which keeps the place (`useFeedRow.cursor`). Iteration 2: that row, not its
 * conversation's first. False where there's none to put away. Here, not in the feed's component, so the keyboard and the
 * reader reach it without the feed's parts.
 */
export function closeFeedConversation(): boolean {
  const s = getApp();
  if (s.selectedId === null || listLayout() || !s.today) return false;
  const row = feedPlace();
  useFeedRow.setState(({ moves }) => ({ opened: null, cursor: row, moves: moves + 1 }));
  setApp({ selectedId: null });
  // once the feed has its width back (its items rewrap), the row is in view if it went out of it, and has the keyboard
  if (row !== null)
    requestAnimationFrame(() => {
      feedScroller.toRow?.(row);
      requestAnimationFrame(() => focusFeedItem(row));
    });
  return true;
}
