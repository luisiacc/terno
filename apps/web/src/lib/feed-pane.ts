import { listLayout } from "~/lib/page";
import { feedPlace, feedScroller, focusFeedItem } from "~/lib/feed-focus";
import { getApp, setApp } from "~/state/app";
import { reloadList } from "~/state/list";
import { feedRow, useFeedRow } from "~/state/today";

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
  // plan 210 (iteration 4): a row held only because its conversation was open (it left the backend's answer meanwhile: handed
  // on by a confirmed forward, settled) is held no longer once that conversation is put away: the list reads again
  const held = feedRow(useFeedRow.getState().opened)?.held === true;
  useFeedRow.setState(({ moves }) => ({ opened: null, cursor: row, moves: moves + 1 }));
  setApp({ selectedId: null });
  if (held) void reloadList({ keepSelection: true });
  // once the feed has its width back (its items rewrap), the row is in view if it went out of it, and has the keyboard
  if (row !== null) {
    const still = restoring(useFeedRow.getState().moves);
    requestAnimationFrame(() => {
      if (!still()) return;
      feedScroller.toRow?.(row);
      requestAnimationFrame(() => still() && focusFeedItem(row, still));
    });
  }
  return true;
}

/** The latest put-away's place: an older one's frames still on their way land nowhere. */
let putAway = 0;

/**
 * Codex's code review of iteration 4: the frames that bring the keys back land only while nothing moved since: no later
 * put-away, no row chosen or conversation opened, and the keys nowhere or still where they were (Esc on "Pay the rent", then
 * the keys on "Wire payroll" before the frames came, used to take them back to the rent, so Enter opened the rent).
 */
function restoring(moves: number): () => boolean {
  const token = ++putAway;
  const from = document.activeElement;
  return () => {
    const now = document.activeElement;
    return token === putAway && useFeedRow.getState().moves === moves && getApp().selectedId === null && (now === null || now === document.body || now === from);
  };
}
