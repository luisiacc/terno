import { dayKeyOf, parseProposal, parseSchedule, proposalJson, readWall, scheduleJson, type DatedWall, type ItemSchedule, type ScheduleProposal } from "@terno/core";
import { proposalOf, scheduledInbox, type DatedFinish, type DatedScheduleSnapshot, type DatedSource, type PromiseScheduleSnapshot, type ScheduleChanges, type ScheduleSnapshots } from "@terno/store";
import type { Db } from "./sqlite";

/** Plan 210 (iteration 4, Change…) on SQLite (v68): see packages/store/src/schedule.ts. */

/** The three columns a row reads them from (both tables). */
export const scheduleFields = (r: { changed_at?: number | null; changed_from?: string | null; proposal?: string | null }): { changedAt: number | null; changedFrom: ItemSchedule | null; proposal: ScheduleProposal | null } => ({
  changedAt: r.changed_at ?? null,
  changedFrom: parseSchedule(r.changed_from),
  proposal: parseProposal(r.proposal),
});

interface DatedRaw {
  id: number; revision: number; due_day: string; due_at: number; timed: number; dated: number; act_at: number; text: string; deferred_until: number | null;
  changed_at: number | null; changed_from: string | null; proposal: string | null; before_day: string | null; wall: string | null;
}
interface PromiseRaw {
  id: number; revision: number; state: PromiseScheduleSnapshot["state"]; inbox_state: PromiseScheduleSnapshot["inboxState"]; from_scan: number; due_at: number; dated: number; timed: number; broken_due_at: number | null; deferred_until: number | null;
  changed_at: number | null; changed_from: string | null; proposal: string | null; before_day: string | null;
}

/** Plan 210 (iteration 4, revision 10): the mail's own clock, kept as JSON (v67); one that doesn't read is none. */
export const wallOf = (json: string | null): DatedWall | null => {
  try {
    return json ? readWall(JSON.parse(json)) : null;
  } catch {
    return null;
  }
};
export const wallJson = (w: DatedWall | null | undefined): string | null => (w ? JSON.stringify({ day: w.day, time: w.time, zone: w.zone, place: w.place }) : null);

const datedSnapshot = (r: DatedRaw): DatedScheduleSnapshot => ({
  id: r.id, revision: r.revision, dueDay: r.due_day, dueAt: r.due_at, timed: r.timed === 1, dated: r.dated === 1, actAt: r.act_at, text: r.text, deferredUntil: r.deferred_until ?? null, ...scheduleFields(r), before: r.before_day ?? null, wall: wallOf(r.wall),
});
const promiseSnapshot = (r: PromiseRaw): PromiseScheduleSnapshot => ({
  id: r.id, revision: r.revision, state: r.state, inboxState: r.inbox_state, dueAt: r.due_at, dated: r.dated === 1, timed: r.timed === 1, brokenDueAt: r.broken_due_at ?? null, deferredUntil: r.deferred_until ?? null, ...scheduleFields(r), before: r.before_day ?? null,
});

const json = (v: ItemSchedule | null): string | null => (v ? scheduleJson(v) : null);
const proposal = (v: ScheduleProposal | null): string | null => (v ? proposalJson(v) : null);

/** Every row at the revision it was read at and still open, all of them changed, or none (null). */
export function scheduleItems(db: Db, c: ScheduleChanges): ScheduleSnapshots | null {
  return db.tx(() => {
    const dated = c.dated.map((x) => db.get<DatedRaw>("SELECT * FROM dated_items WHERE id = ? AND revision = ? AND state = 'open'", x.id, x.revision));
    const promises = c.promises.map((x) => db.get<PromiseRaw>("SELECT * FROM followups WHERE id = ? AND revision = ? AND kind = 'promise' AND state IN ('open','due')", x.id, x.revision));
    if (dated.some((r) => !r) || promises.some((r) => !r)) return null;
    c.dated.forEach(({ id, to }, i) => {
      const r = dated[i]!;
      db.run(
        "UPDATE dated_items SET due_day = ?, due_at = ?, timed = ?, dated = 1, act_at = ?, text = coalesce(?, text), before_day = ?, wall = ?, deferred_until = NULL, changed_at = ?, changed_from = ?, proposal = NULL, revision = revision + 1 WHERE id = ?",
        to.dueDay, to.dueAt, to.timed ? 1 : 0, to.actAt, to.text ?? null, to.before ?? null, wallJson(to.wall), c.at, scheduleJson({ dueDay: r.due_day, dueAt: r.due_at, timed: r.timed === 1, dated: r.dated === 1 }), id,
      );
    });
    c.promises.forEach(({ id, to }, i) => {
      const r = promises[i]!;
      db.run(
        "UPDATE followups SET due_at = ?, dated = 1, timed = ?, state = ?, inbox_state = ?, broken_due_at = NULL, before_day = ?, deferred_until = NULL, changed_at = ?, changed_from = ?, proposal = NULL, revision = revision + 1 WHERE id = ?",
        to.dueAt, to.timed ? 1 : 0, to.state, scheduledInbox({ state: r.state, inboxState: r.inbox_state, fromScan: r.from_scan === 1 }, to.state), to.before ?? null, c.at, scheduleJson({ dueDay: dayKeyOf(r.due_at), dueAt: r.due_at, timed: r.timed === 1, dated: r.dated === 1 }), id,
      );
    });
    return { dated: dated.map((r) => datedSnapshot(r!)), promises: promises.map((r) => promiseSnapshot(r!)) };
  });
}

/** Its Undo: every row still at the revision the change left, each field back as it was, or none. */
export function unscheduleItems(db: Db, s: ScheduleSnapshots): boolean {
  return db.tx(() => {
    const at = (table: string, id: number, revision: number) => !!db.get(`SELECT 1 FROM ${table} WHERE id = ? AND revision = ?`, id, revision);
    if (!s.dated.every((r) => at("dated_items", r.id, r.revision + 1)) || !s.promises.every((r) => at("followups", r.id, r.revision + 1))) return false;
    for (const r of s.dated) {
      db.run(
        "UPDATE dated_items SET due_day = ?, due_at = ?, timed = ?, dated = ?, act_at = ?, text = ?, before_day = ?, wall = ?, deferred_until = ?, changed_at = ?, changed_from = ?, proposal = ?, revision = revision + 1 WHERE id = ?",
        r.dueDay, r.dueAt, r.timed ? 1 : 0, r.dated ? 1 : 0, r.actAt, r.text, r.before, wallJson(r.wall), r.deferredUntil, r.changedAt, json(r.changedFrom), proposal(r.proposal), r.id,
      );
    }
    for (const r of s.promises) {
      db.run(
        "UPDATE followups SET state = ?, inbox_state = ?, due_at = ?, dated = ?, timed = ?, broken_due_at = ?, before_day = ?, deferred_until = ?, changed_at = ?, changed_from = ?, proposal = ?, revision = revision + 1 WHERE id = ?",
        r.state, r.inboxState, r.dueAt, r.dated ? 1 : 0, r.timed ? 1 : 0, r.brokenDueAt, r.before, r.deferredUntil, r.changedAt, json(r.changedFrom), proposal(r.proposal), r.id,
      );
    }
    return true;
  });
}

/**
 * In the dated reader's finish: a move of an item whose schedule is the user's (`changed_at`) is kept as its proposal, never
 * applied, under the guards the move itself has (a dated item: open and reached by this message; a promise: at the revision
 * the reader saw, on this thread, open or due). A move to the schedule it already has takes any older proposal away. The
 * revision moves (something new to look at: an Undo across it is refused). True: the row is the user's, so the move is done
 * with here (applied as a proposal or not at all); false: the caller moves it as before.
 */
export function proposedMove(
  db: Db,
  table: "dated_items" | "followups",
  at: { id: number; threadId: number; revision?: number; senderKey?: string; reaches?: string },
  to: { dueDay?: string; dueAt: number; timed: boolean; actAt?: number; text?: string; before?: string | null; wall?: DatedWall | null },
  src: Pick<DatedSource, "fromName" | "fromEmail">,
  w: Pick<DatedFinish, "messageId" | "now">,
): boolean {
  const row = db.get<{ changed_at: number | null; due_at: number; timed: number; proposal: string | null }>(`SELECT changed_at, due_at, timed, proposal FROM ${table} WHERE id = ?`, at.id);
  if (row?.changed_at == null) return false;
  const guard =
    table === "dated_items"
      ? { sql: `state = 'open' AND (thread_id = ? OR (sender_key = ? AND ${at.reaches}))`, params: [at.threadId, at.senderKey ?? ""] }
      : { sql: "revision = ? AND thread_id = ? AND kind = 'promise' AND state IN ('open','due')", params: [at.revision ?? -1, at.threadId] };
  const same = row.due_at === to.dueAt && (row.timed === 1) === to.timed && !to.text;
  if (same && row.proposal === null) return true;
  const kept = same ? null : proposalJson(proposalOf(to, src, w));
  db.run(`UPDATE ${table} SET proposal = ?, revision = revision + 1 WHERE id = ? AND ${guard.sql}`, kept, at.id, ...guard.params);
  return true;
}
