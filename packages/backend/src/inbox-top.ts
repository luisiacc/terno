import { PINS_MAX, REMINDERS_MAX, type Pin, type Reminder } from "@terno/core";
import { L } from "@terno/i18n";
import type { FollowupSnapshot } from "@terno/store";
import type { FollowupWorker } from "./followups";
import type { Pins } from "./pins";
import type { Reminders } from "./reminders";
import { RpcError } from "@terno/core/rpc";

/**
 * What the Inbox's top held for conversations that were put away (archived,
 * trashed, marked as spam, moved to a folder or filed out of the Inbox): their
 * due reminders (plan 87), follow-ups on top (142) and pins (177). Each would
 * bring the conversation straight back to the top, so putting it away ends
 * them, and the action's Undo puts them back exactly.
 */
export interface TopLeft {
  reminders: Reminder[];
  followups: FollowupSnapshot[];
  pins: Pin[];
}

interface TopHost {
  readonly reminders: Reminders;
  readonly followups: FollowupWorker;
  readonly pins: Pins;
}

export const nothingLeft = (): TopLeft => ({ reminders: [], followups: [], pins: [] });

export const leftNothing = (l: TopLeft): boolean => l.reminders.length === 0 && l.followups.length === 0 && l.pins.length === 0;

/** Adds one slice's to what an action gathered so far. */
export function gather(into: TopLeft, more: TopLeft): void {
  into.reminders.push(...more.reminders);
  into.followups.push(...more.followups);
  into.pins.push(...more.pins);
}

/**
 * These conversations were put away: what the top held for them ends. A pin ends only for those that left the Inbox by
 * it (`pinIds`; a filing into a hidden category of one already archived or hidden leaves its pin).
 */
export async function leaveTop(b: TopHost, threadIds: readonly number[], pinIds: readonly number[] = threadIds): Promise<TopLeft> {
  return {
    reminders: await b.reminders.endDue(threadIds),
    followups: await b.followups.endTop(threadIds),
    pins: pinIds.length ? await b.pins.end(pinIds) : [],
  };
}

/**
 * An Undo around its mail: the pins and reminders first, where nothing newer
 * took their place, then the mail, then the follow-ups. A cap that refuses
 * throws before the mail moves and leaves the top as it was (pins put back are
 * taken out again when the reminders' cap refuses), so the Undo stays for a
 * retry (putting back is idempotent).
 */
export async function returnTop<R>(b: TopHost, left: TopLeft, mail: () => Promise<R>): Promise<R> {
  const pinned = left.pins.length ? await b.pins.putBack(left.pins) : [];
  if (pinned === null) throw new RpcError("BAD_REQUEST", L("errors.pinsFull", { max: PINS_MAX }));
  if (left.reminders.length && !(await b.reminders.restore([], left.reminders))) {
    if (pinned.length) await b.pins.restore(pinned, []);
    throw new RpcError("BAD_REQUEST", L("errors.remindersFull", { max: REMINDERS_MAX }));
  }
  // the mail itself, then the follow-ups (their snapshots expect the conversation back where it was)
  const r = await mail();
  await b.followups.putBack(left.followups);
  return r;
}
