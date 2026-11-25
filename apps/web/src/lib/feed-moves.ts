import { armReflow } from "~/lib/flash";
import { listKey, MOVES_MAX, movesOwed, takeMoves } from "~/state/list";
import { useToday } from "~/state/today";

/**
 * Plan 271: What matters' rows move as the Inbox's do. A change to what the feed draws that an act made (`movingFeed`:
 * Done, Remove, Later, Archive there) or that motion is owed to (an Undo's answer bringing its rows back, Coming up opened
 * or closed: `takeMoves`) arms the feed's reflow and names, by their keys, the slots that come and go: the ones that stay
 * slide (globals.css), the ones that come arrive, the ones that go leave a fading copy where they were. Whatever else mounts
 * or unmounts a slot meanwhile (a scroll, a measurement) is simply there or gone.
 */

type TodayState = ReturnType<typeof useToday.getState>;
type Row = TodayState["rows"][number];
/** A drawn slot's key, and what it is whatever its key (a heading is its group's, keyed by the row it stands above). */
export interface DrawnKey {
  key: string;
  same?: string;
}

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
 * for a row that moved to another part comes too: it wasn't drawn where it was (an Undo bringing a Done row back from
 * Earlier).
 */
export const slotComes = (key: string): boolean => moving.came.has(key) || moving.moved.has(key);
export const slotGoes = (key: string): boolean => moving.went.has(key);

/** where a row stands: its group, or Earlier for a history line */
const partOf = (r: Row): string => (r.line ? "history" : (r.group ?? ""));

/**
 * While the feed is drawn: each change to what it draws (`keysOf`, the drawn slots, headings included) that moves arms its
 * reflow before React draws it (a store's listeners run inside its change). Returns the way to stop.
 */
export function installFeedMoves(keysOf: (s: TodayState) => readonly DrawnKey[]): () => void {
  return useToday.subscribe((s, p) => {
    const act = acting;
    if (s.rows === p.rows && s.comingUp === p.comingUp && s.counts === p.counts && s.answered === p.answered) return;
    const key = listKey();
    if (!act && !movesOwed(key)) return;
    const was = keysOf(p);
    const now = keysOf(s);
    const before = new Set(was.map((d) => d.key));
    const after = new Set(now.map((d) => d.key));
    const came = now.filter((d) => !before.has(d.key));
    const went = was.filter((d) => !after.has(d.key));
    // a heading keyed anew by its group's first row is still its group's heading: neither leaves nor arrives (Codex code
    // review #7: Done on Today's first item faded one heading out under another fading in)
    for (const d of went.slice()) {
      const again = d.same === undefined ? -1 : came.findIndex((c) => c.same === d.same);
      if (again < 0) continue;
      came.splice(again, 1);
      went.splice(went.indexOf(d), 1);
    }
    // a row that changed part (Earlier back to Today) is the same row, by the same key; one only pushed along isn't moved
    // (Codex code review #4: an unrelated row arriving above it isn't an Undo's)
    const parts = new Map(p.rows.map((r) => [r.id, partOf(r)]));
    const moved = s.rows.filter((r) => parts.has(r.id) && parts.get(r.id) !== partOf(r)).map((r) => r.id);
    if (came.length === 0 && went.length === 0 && moved.length === 0) return;
    if (!act) {
      const rows = new Map(s.rows.map((r) => [r.id, r]));
      const prior = new Map(p.rows.map((r) => [r.id, r]));
      // an Undo's motion is for the answer bringing its rows back (their conversations, by the rows that came or changed
      // part); Coming up's for its own rows coming or going
      const brought = [...came.map((d) => d.key), ...moved].flatMap((k) => (rows.has(k) ? [rows.get(k)!.threadId] : []));
      const ahead = came.some((d) => rows.get(d.key)?.ahead === true) || went.some((d) => prior.get(d.key)?.ahead === true);
      if (!takeMoves(key, { came: brought, went: went.length, ahead })) return;
    }
    if (came.length + went.length > MOVES_MAX) return;
    moving.came = new Set(came.map((d) => d.key));
    moving.went = new Set(went.map((d) => d.key));
    moving.moved = new Set(moved);
    armReflow("feed");
  });
}
