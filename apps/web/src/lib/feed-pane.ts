import { listScroller } from "~/components/thread-list";
import { listLayout } from "~/lib/page";
import { focusQuietly } from "~/lib/quiet-focus";
import { feedLook, useFeedCursor, useWmLook } from "~/lib/what-matters-look";
import { getApp, setApp } from "~/state/app";
import { useList } from "~/state/list";

/**
 * Plan 204, the UI experiment: Esc, the reader's Close and a click on the open item, in Split: the conversation open
 * beside Today's feed goes, and the feed has the room again; the keyboard is back on the item it was opened from (quietly:
 * no ring after a key or a click, plan 54), which keeps the place (`useFeedCursor`). False where there's none to put away.
 * Here, not in the feed's component, so the keyboard and the reader reach it without the feed's parts.
 */
export function closeFeedConversation(): boolean {
  const s = getApp();
  const id = s.selectedId;
  if (id === null || listLayout() || !feedLook(s.today, useWmLook.getState().look)) return false;
  const index = useList.getState().index.get(id);
  setApp({ selectedId: null });
  useFeedCursor.setState({ id });
  // once the feed has its width back (its items rewrap), the item is in view if it went out of it, and has the keyboard
  requestAnimationFrame(() => {
    if (index !== undefined) listScroller.scrollToIndex?.(index);
    requestAnimationFrame(() => focusQuietly(document.querySelector<HTMLElement>(`[data-testid=wm-feed] [data-thread-id="${id}"] button`)));
  });
  return true;
}
