import { dayKeyOf, proposerOf, type DatedRow, type DatedWall, type FollowupRow, type FollowupState, type ItemSchedule, type ScheduleProposal } from "@terno/core";
import type { DatedFinish, DatedSource } from "./dated";

/**
 * Plan 210 (iteration 4, the owner's "Change…"): a revision-checked schedule act of its own (not Done, Remove or Later's
 * `today.act`), on an item and every item it's the same thing as (`sameAs`), all or none. Each row: its new day and time,
 * its Later cleared, any proposal taken away, `changed_at` the act's moment and `changed_from` its schedule as it was (the
 * one change event an item keeps); a promise's broken day goes (the day is the user's now). Its Undo puts every field back
 * exactly, or none when one changed since. The day asked before ("before Mon") and the mail's own clock (iteration 4's
 * reading) are the mail's words about its schedule, so a change of the user's has none, and an accepted proposal the move's.
 */
export interface ScheduleChanges {
  /** the act's moment: `changedAt` */
  at: number;
  dated: readonly { id: number; revision: number; to: { dueDay: string; dueAt: number; timed: boolean; actAt: number; /** an accepted proposal's new words */ text?: string; /** the day asked before and the mail's clock: an accepted proposal's; absent, none */ before?: string | null; wall?: DatedWall | null } }[];
  promises: readonly { id: number; revision: number; to: { dueAt: number; timed: boolean; /** open when its new moment is ahead, else due */ state: FollowupState; /** an accepted proposal's day asked before; absent, none */ before?: string | null } }[];
}

/**
 * A changed promise's Inbox top: open, none; due, as follow-ups' `makeDue` would put it (on top, but a scan's), or as it was
 * when it was due already. The change writes what the next look would, so that look finds nothing to do and never moves the
 * revision under the change's own Undo (Codex's code review of iteration 4).
 */
export const scheduledInbox = (r: { state: FollowupState; inboxState: FollowupRow["inboxState"]; fromScan: boolean }, state: FollowupState): FollowupRow["inboxState"] =>
  state !== "due" ? "none" : r.state === "due" ? r.inboxState : r.fromScan ? "none" : "onTop";

/** A dated row's schedule and everything a change touches, as it was: what Undo restores. */
export interface DatedScheduleSnapshot {
  id: number;
  revision: number;
  dueDay: string;
  dueAt: number;
  timed: boolean;
  dated: boolean;
  actAt: number;
  text: string;
  deferredUntil: number | null;
  changedAt: number | null;
  changedFrom: ItemSchedule | null;
  proposal: ScheduleProposal | null;
  before: string | null;
  wall: DatedWall | null;
}

/** A promise's, likewise (its state and Inbox top too: one past its day comes back open). */
export interface PromiseScheduleSnapshot {
  id: number;
  revision: number;
  state: FollowupState;
  inboxState: FollowupRow["inboxState"];
  dueAt: number;
  dated: boolean;
  timed: boolean;
  brokenDueAt: number | null;
  deferredUntil: number | null;
  changedAt: number | null;
  changedFrom: ItemSchedule | null;
  proposal: ScheduleProposal | null;
  before: string | null;
}

export interface ScheduleSnapshots {
  dated: readonly DatedScheduleSnapshot[];
  promises: readonly PromiseScheduleSnapshot[];
}

/**
 * A later mail's move kept for the user (both stores' `proposedMove`): its day, moment and words, the day asked before and
 * the mail's clock (all a move writes, so taking it is the move exactly), and who said it.
 */
export const proposalOf = (
  to: { dueDay?: string; dueAt: number; timed: boolean; actAt?: number; text?: string; before?: string | null; wall?: DatedWall | null },
  src: Pick<DatedSource, "fromName" | "fromEmail">,
  w: Pick<DatedFinish, "messageId" | "now">,
): ScheduleProposal => ({
  dueDay: to.dueDay ?? dayKeyOf(to.dueAt), dueAt: to.dueAt, timed: to.timed, ...(to.actAt !== undefined ? { actAt: to.actAt } : {}), ...(to.text ? { text: to.text } : {}),
  ...(to.before ? { before: to.before } : {}), ...(to.wall ? { wall: to.wall } : {}),
  by: proposerOf({ name: src.fromName, email: src.fromEmail }), messageId: w.messageId, at: w.now,
});

/** The schedule a row has now (its `changed_from` when the user changes it). */
export const datedScheduleOf = (r: Pick<DatedRow, "dueDay" | "dueAt" | "timed" | "dated">): ItemSchedule => ({ dueDay: r.dueDay, dueAt: r.dueAt, timed: r.timed, dated: r.dated });

export const datedScheduleSnapshot = (r: DatedRow): DatedScheduleSnapshot => ({
  id: r.id, revision: r.revision, dueDay: r.dueDay, dueAt: r.dueAt, timed: r.timed, dated: r.dated, actAt: r.actAt, text: r.text, deferredUntil: r.deferredUntil,
  changedAt: r.changedAt ?? null, changedFrom: r.changedFrom ?? null, proposal: r.proposal ?? null, before: r.before ?? null, wall: r.wall ?? null,
});

export const promiseScheduleSnapshot = (r: FollowupRow): PromiseScheduleSnapshot => ({
  id: r.id, revision: r.revision, state: r.state, inboxState: r.inboxState, dueAt: r.dueAt, dated: r.dated, timed: r.timed === true, brokenDueAt: r.brokenDueAt ?? null, deferredUntil: r.deferredUntil,
  changedAt: r.changedAt ?? null, changedFrom: r.changedFrom ?? null, proposal: r.proposal ?? null, before: r.before ?? null,
});
