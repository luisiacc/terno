import type { DatedRow, FollowupRow, FollowupState, ItemSchedule, ScheduleProposal } from "@terno/core";

/**
 * Plan 210 (iteration 4, the owner's "Change…"): a revision-checked schedule act of its own (not Done, Remove or Later's
 * `today.act`), on an item and every item it's the same thing as (`sameAs`), all or none. Each row: its new day and time,
 * its Later cleared, any proposal taken away, `changed_at` the act's moment and `changed_from` its schedule as it was (the
 * one change event an item keeps); a promise's broken day goes (the day is the user's now). Its Undo puts every field back
 * exactly, or none when one changed since.
 */
export interface ScheduleChanges {
  /** the act's moment: `changedAt` */
  at: number;
  dated: readonly { id: number; revision: number; to: { dueDay: string; dueAt: number; timed: boolean; actAt: number; /** an accepted proposal's new words */ text?: string } }[];
  promises: readonly { id: number; revision: number; to: { dueAt: number; timed: boolean; /** open when its new moment is ahead, else as it was */ state: FollowupState } }[];
}

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
}

export interface ScheduleSnapshots {
  dated: readonly DatedScheduleSnapshot[];
  promises: readonly PromiseScheduleSnapshot[];
}

/** The schedule a row has now (its `changed_from` when the user changes it). */
export const datedScheduleOf = (r: Pick<DatedRow, "dueDay" | "dueAt" | "timed" | "dated">): ItemSchedule => ({ dueDay: r.dueDay, dueAt: r.dueAt, timed: r.timed, dated: r.dated });

export const datedScheduleSnapshot = (r: DatedRow): DatedScheduleSnapshot => ({
  id: r.id, revision: r.revision, dueDay: r.dueDay, dueAt: r.dueAt, timed: r.timed, dated: r.dated, actAt: r.actAt, text: r.text, deferredUntil: r.deferredUntil,
  changedAt: r.changedAt ?? null, changedFrom: r.changedFrom ?? null, proposal: r.proposal ?? null,
});

export const promiseScheduleSnapshot = (r: FollowupRow): PromiseScheduleSnapshot => ({
  id: r.id, revision: r.revision, state: r.state, inboxState: r.inboxState, dueAt: r.dueAt, dated: r.dated, timed: r.timed === true, brokenDueAt: r.brokenDueAt ?? null, deferredUntil: r.deferredUntil,
  changedAt: r.changedAt ?? null, changedFrom: r.changedFrom ?? null, proposal: r.proposal ?? null,
});
