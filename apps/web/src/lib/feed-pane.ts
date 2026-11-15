import { listScroller } from "~/components/thread-list";
import { listLayout } from "~/lib/page";
import { focusFeedItem, useFeedCursor } from "~/lib/feed-focus";
import { getApp, setApp } from "~/state/app";
import { useList } from "~/state/list";

/**
 * Plan 204 (the feed), plan 210: Esc, the reader's Close and a click on the open item, in Split: the conversation open
 * beside Today's feed goes, and the feed has the room again; the keyboard is back on the item it was opened from (quietly:
 * no ring after a key or a click, plan 54), which keeps the place (`useFeedCursor`). False where there's none to put away.
 * Here, not in the feed's component, so the keyboard and the reader reach it without the feed's parts.
 */
export function closeFeedConversation(): boolean {
  const s = getApp();
  const id = s.selectedId;
  if (id === null || listLayout() || !s.today) return false;
  const index = useList.getState().index.get(id);
  setApp({ selectedId: null });
  useFeedCursor.setState({ id });
  // once the feed has its width back (its items rewrap), the item is in view if it went out of it, and has the keyboard
  requestAnimationFrame(() => {
    if (index !== undefined) listScroller.scrollToIndex?.(index);
    requestAnimationFrame(() => focusFeedItem(id));
  });
  return true;
}
