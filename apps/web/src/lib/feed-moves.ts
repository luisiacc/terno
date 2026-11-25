import { armReflow } from "~/lib/flash";
import { listKey, MOVES_MAX, movesOwed, movesPaid } from "~/state/list";
import { useToday } from "~/state/today";

/**
 * Plan 271: What matters' rows move as the Inbox's do. A change to what the feed draws that an act made (`movingFeed`:
 * Done, Remove, Later, Archive there) or that motion is owed to (an Undo's answer bringing its rows back, Coming up opened
 * or closed: `movesOwed`) arms the feed's reflow and names, by their keys, the slots that come and go: the ones that stay
 * slide (globals.css), the ones that come arrive, the ones that go leave a fading copy where they were. Whatever else mounts
 * or unmounts a slot meanwhile (a scroll, a measurement) is simply there or gone.
 */

type TodayState = ReturnType<typeof useToday.getState>;

const moving = { came: new Set<string>(), went: new Set<string>(), moved: new Set<string>() };
let acting = false;

/** The feed changed by an act, now (`change` publishes it): what it takes away leaves, what it brings arrives. */
export function movingFeed(change: () => void): void {
  acting = true;
  try {
    change();
  } finally {
    acting = false;
  }
}

/**
 * This slot's row came, or went, in the change the feed is moving (read only within its reflow window). A slot drawn anew
 * for a row that only moved comes too: it wasn't drawn where it was (an Undo bringing a Done row back from Earlier).
 */
export const slotComes = (key: string): boolean => moving.came.has(key) || moving.moved.has(key);
export const slotGoes = (key: string): boolean => moving.went.has(key);

/**
 * While the feed is drawn: each change to what it draws (`keysOf`, the drawn rows' keys, headings included) that moves
 * arms its reflow before React draws it (a store's listeners run inside its change). Returns the way to stop.
 */
export function installFeedMoves(keysOf: (s: TodayState) => readonly string[]): () => void {
  return useToday.subscribe((s, p) => {
    const act = acting;
    if (s.rows === p.rows && s.comingUp === p.comingUp && s.counts === p.counts && s.answered === p.answered) return;
    const key = listKey();
    if (!act && !movesOwed(key)) return;
    const was = keysOf(p);
    const before = new Map(was.map((k, i) => [k, i]));
    const after = keysOf(s);
    const now = new Map(after.map((k, i) => [k, i]));
    const came = after.filter((k) => !before.has(k));
    const went = was.filter((k) => !now.has(k));
    const moved = after.filter((k) => before.has(k) && before.get(k) !== now.get(k));
    if (came.length === 0 && went.length === 0 && moved.length === 0) return;
    if (!act) {
      // an Undo's motion is for the answer bringing its rows back: their conversations, by the rows that came, or that
      // moved back (a Done row only went to Earlier, the same row)
      const threads = new Map(s.rows.map((r) => [r.id, r.threadId]));
      const brought = [...came, ...moved].flatMap((k) => (threads.has(k) ? [threads.get(k)!] : []));
      if (!movesOwed(key, { came: brought, went: went.length })) return;
      movesPaid();
    }
    if (came.length + went.length > MOVES_MAX) return;
    moving.came = new Set(came);
    moving.went = new Set(went);
    moving.moved = new Set(moved);
    armReflow("feed");
  });
}
