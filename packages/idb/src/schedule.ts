import { dayKeyOf, parseProposal, parseSchedule, proposalJson, readWall, scheduleJson, type DatedWall, type ItemSchedule, type ScheduleProposal } from "@terno/core";
import { proposalOf, scheduledInbox, type DatedFinish, type DatedScheduleSnapshot, type DatedSource, type PromiseScheduleSnapshot, type ScheduleChanges, type ScheduleSnapshots } from "@terno/store";
import { T, type Ctx, type R } from "./mail";
import type { Table } from "./mem";

/**
 * Plan 210 (iteration 4, Change…) on IndexedDB, like SQL's (packages/db/src/schedule.ts). The three fields are kept as SQL's
 * columns are (a JSON text, null when none), so one reading serves both; a record stored before them has none (no version
 * bump: nothing is indexed on them).
 */

export const scheduleFields = (r: R): { changedAt: number | null; changedFrom: ItemSchedule | null; proposal: ScheduleProposal | null } => ({
  changedAt: r.changed_at ?? null,
  changedFrom: parseSchedule(r.changed_from),
  proposal: parseProposal(r.proposal),
});

const datedSnapshot = (r: R): DatedScheduleSnapshot => ({
  id: r.id, revision: r.revision, dueDay: r.due_day, dueAt: r.due_at, timed: r.timed === 1, dated: r.dated === 1, actAt: r.act_at, text: r.text, deferredUntil: r.deferred_until ?? null, ...scheduleFields(r), before: r.before_day ?? null, wall: readWall(r.wall),
});
const promiseSnapshot = (r: R): PromiseScheduleSnapshot => ({
  id: r.id, revision: r.revision, state: r.state, inboxState: r.inbox_state, dueAt: r.due_at, dated: r.dated === 1, timed: r.timed === 1, brokenDueAt: r.broken_due_at ?? null, deferredUntil: r.deferred_until ?? null, ...scheduleFields(r), before: r.before_day ?? null,
});

/** Plan 210 (iteration 4, revision 10): the mail's own clock as a record keeps it (an object, as SQL's JSON reads), or none. */
export const wallRecord = (w: DatedWall | null | undefined): DatedWall | null => (w ? { day: w.day, time: w.time, zone: w.zone, place: w.place } : null);

const json = (v: ItemSchedule | null): string | null => (v ? scheduleJson(v) : null);
const proposal = (v: ScheduleProposal | null): string | null => (v ? proposalJson(v) : null);

/** As SQL's: every row at its revision and open, all changed (one command), or none. */
export function scheduleItems(c: Ctx, s: ScheduleChanges): ScheduleSnapshots | null {
  const datedRows = T(c, "dated_items");
  const promiseRows = T(c, "followups");
  const dated = s.dated.map((x) => datedRows.get(x.id)).map((r, i) => (r && r.revision === s.dated[i]!.revision && r.state === "open" ? r : undefined));
  const promises = s.promises.map((x) => promiseRows.get(x.id)).map((r, i) => (r && r.revision === s.promises[i]!.revision && r.kind === "promise" && (r.state === "open" || r.state === "due") ? r : undefined));
  if (dated.some((r) => !r) || promises.some((r) => !r)) return null;
  const before = { dated: dated.map((r) => datedSnapshot(r!)), promises: promises.map((r) => promiseSnapshot(r!)) };
  s.dated.forEach(({ to }, i) => {
    const r = dated[i]!;
    datedRows.update(r, {
      due_day: to.dueDay, due_at: to.dueAt, timed: to.timed ? 1 : 0, dated: 1, act_at: to.actAt, ...(to.text ? { text: to.text } : {}), before_day: to.before ?? null, wall: wallRecord(to.wall), deferred_until: null,
      changed_at: s.at, changed_from: scheduleJson({ dueDay: r.due_day, dueAt: r.due_at, timed: r.timed === 1, dated: r.dated === 1 }), proposal: null, revision: r.revision + 1,
    });
  });
  s.promises.forEach(({ to }, i) => {
    const r = promises[i]!;
    promiseRows.update(r, {
      due_at: to.dueAt, dated: 1, timed: to.timed ? 1 : 0, state: to.state, inbox_state: scheduledInbox({ state: r.state, inboxState: r.inbox_state, fromScan: r.from_scan === 1 }, to.state), broken_due_at: null, before_day: to.before ?? null, deferred_until: null,
      changed_at: s.at, changed_from: scheduleJson({ dueDay: dayKeyOf(r.due_at), dueAt: r.due_at, timed: r.timed === 1, dated: r.dated === 1 }), proposal: null, revision: r.revision + 1,
    });
  });
  return before;
}

/** As SQL's: every row still at the revision the change left, each field back, or none. */
export function unscheduleItems(c: Ctx, s: ScheduleSnapshots): boolean {
  const datedRows = T(c, "dated_items");
  const promiseRows = T(c, "followups");
  if (!s.dated.every((r) => datedRows.get(r.id)?.revision === r.revision + 1) || !s.promises.every((r) => promiseRows.get(r.id)?.revision === r.revision + 1)) return false;
  for (const r of s.dated) {
    const row = datedRows.get(r.id)!;
    datedRows.update(row, {
      due_day: r.dueDay, due_at: r.dueAt, timed: r.timed ? 1 : 0, dated: r.dated ? 1 : 0, act_at: r.actAt, text: r.text, before_day: r.before, wall: wallRecord(r.wall), deferred_until: r.deferredUntil,
      changed_at: r.changedAt, changed_from: json(r.changedFrom), proposal: proposal(r.proposal), revision: row.revision + 1,
    });
  }
  for (const r of s.promises) {
    const row = promiseRows.get(r.id)!;
    promiseRows.update(row, {
      state: r.state, inbox_state: r.inboxState, due_at: r.dueAt, dated: r.dated ? 1 : 0, timed: r.timed ? 1 : 0, broken_due_at: r.brokenDueAt, before_day: r.before, deferred_until: r.deferredUntil,
      changed_at: r.changedAt, changed_from: json(r.changedFrom), proposal: proposal(r.proposal), revision: row.revision + 1,
    });
  }
  return true;
}

/**
 * As SQL's, in the dated reader's finish, once the caller has checked the move's own guards: a row whose schedule is the
 * user's keeps it, the move kept as its proposal (none when it's the schedule it has). True: handled here.
 */
export function proposedMove(rows: Table<R>, r: R, to: { dueDay?: string; dueAt: number; timed: boolean; actAt?: number; text?: string; before?: string | null; wall?: DatedWall | null }, src: Pick<DatedSource, "fromName" | "fromEmail">, w: Pick<DatedFinish, "messageId" | "now">): boolean {
  if (r.changed_at == null) return false;
  const same = r.due_at === to.dueAt && (r.timed === 1) === to.timed && !to.text;
  if (same && r.proposal == null) return true;
  const kept = same ? null : proposalJson(proposalOf(to, src, w));
  rows.update(r, { proposal: kept, revision: r.revision + 1 });
  return true;
}
