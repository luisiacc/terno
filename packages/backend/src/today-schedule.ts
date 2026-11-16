import { datedTiming, dayEnd, localDay, REMIND_MORNING, type DatedRow, type FollowupRow, type ItemSeen, type ScheduleProposal } from "@terno/core";
import { RpcError } from "@terno/core/rpc";
import { L } from "@terno/i18n";
import type { ScheduleChanges } from "@terno/store";

/**
 * Plan 210 (iteration 4, the owner's "Change…"): what a change of an item's day and time writes, on the item named and every
 * item it's the same thing as (`sameAs`; a reply's grouped promises are a row's presentation, never members: each keeps its
 * own). Each dated item's moment it shows from is its kind's, as a mail's move would place it; a promise's day without a
 * time is 9:00 that day, as follow-ups place a dated promise. Not the words (but an accepted proposal's), not the kind.
 */

/** The user's day and time, or the move a later mail proposed for the item named. */
export type ScheduleAsk = { day: string; time: string | null } | { accept: true };

const open = (r: { state: string }): boolean => r.state === "open" || r.state === "due";

/** "HH:MM", local. */
const clockOf = (ms: number): string => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** A local day at a clock (or its 9:00), by wall clock across DST; NaN for a day that isn't one. */
function momentOf(day: string, time: string | null): number {
  const d = localDay(day);
  if (!d) return Number.NaN;
  const [h, m] = time ? (time.split(":").map(Number) as [number, number]) : [REMIND_MORNING, 0];
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

const stale = (source: ItemSeen["source"]) => new RpcError("STALE", L(source === "promise" ? "errors.followups.changed" : "errors.dated.changed"));

/**
 * The changes, or an error that says what to do: the named item changed or closed since (stale; an accepted proposal no
 * longer there too), a day and time already past, a day too far ahead for its kind, or an item with no day of its own (a
 * person's ask, which a day would make another kind).
 */
export function scheduleChanges(seen: ItemSeen, named: DatedRow | FollowupRow, members: { dated: readonly DatedRow[]; promises: readonly FollowupRow[] }, ask: ScheduleAsk, now: number): ScheduleChanges {
  if (named.revision !== seen.revision || !open(named)) throw stale(seen.source);
  if (seen.source === "dated" && (named as DatedRow).kind === "ask") throw new RpcError("BAD_REQUEST", L("errors.dated.changeNone"));
  let accepted: ScheduleProposal | null = null;
  let day: string;
  let time: string | null;
  if ("accept" in ask) {
    accepted = named.proposal ?? null;
    if (!accepted) throw stale(seen.source);
    day = accepted.dueDay;
    time = accepted.timed ? clockOf(accepted.dueAt) : null;
  } else {
    ({ day, time } = ask);
    const moment = time ? momentOf(day, time) : localDay(day) ? dayEnd(day) : Number.NaN;
    if (!(moment > now)) throw new RpcError("BAD_REQUEST", L("errors.dated.changePast"));
  }
  const isNamed = (source: ItemSeen["source"], id: number) => source === seen.source && id === seen.id;
  const dated: ScheduleChanges["dated"][number][] = [];
  for (const r of members.dated) {
    const mine = isNamed("dated", r.id);
    // the named one as it was seen; the others while they're open, and never an ask (it has no day to change)
    if (!mine && (r.state !== "open" || r.kind === "ask")) continue;
    if (mine && accepted) {
      dated.push({ id: r.id, revision: seen.revision, to: { dueDay: accepted.dueDay, dueAt: accepted.dueAt, timed: accepted.timed, actAt: accepted.actAt ?? r.actAt, ...(accepted.text ? { text: accepted.text } : {}), before: accepted.before ?? null, wall: accepted.wall ?? null } });
      continue;
    }
    // as a mail arriving now would place it: shown within its kind's lead of the new day, never more than a year ahead
    const timing = datedTiming({ kind: r.kind, due: day, time, arrivedAt: now });
    if (!timing) {
      if (mine) throw new RpcError("BAD_REQUEST", L("errors.dated.changeFar"));
      continue;
    }
    // the day asked before and the mail's clock were the mail's words about its day: the user's own day has neither
    dated.push({ id: r.id, revision: mine ? seen.revision : r.revision, to: { dueDay: timing.dueDay, dueAt: timing.dueAt, timed: timing.timed, actAt: timing.actAt, before: null, wall: null } });
  }
  const promises: ScheduleChanges["promises"][number][] = [];
  for (const r of members.promises) {
    const mine = isNamed("promise", r.id);
    if (!mine && !open(r)) continue;
    const dueAt = mine && accepted ? accepted.dueAt : momentOf(day, time);
    const timed = mine && accepted ? accepted.timed : time !== null;
    // ahead, it's open again (out of the Inbox's top); a moment already reached is due in the change's own transaction, never
    // left for follow-ups' next look (its revision would make the change's own Undo refuse: Codex's code review, iteration 4)
    promises.push({ id: r.id, revision: mine ? seen.revision : r.revision, to: { dueAt, timed, state: dueAt > now ? "open" : "due", before: mine && accepted ? (accepted.before ?? null) : null } });
  }
  return { at: now, dated, promises };
}
