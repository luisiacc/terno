import { REMIND_MORNING } from "./reminders";
import type { ItemSchedule, ScheduleProposal } from "./schedule";

/** Plan 142: Follow-ups: what you promised, and who hasn't replied to you. */

export const FOLLOWUP_KINDS = ["promise", "awaiting"] as const;
export type FollowupKind = (typeof FOLLOWUP_KINDS)[number];
export const FOLLOWUP_STATES = ["open", "due", "done", "dismissed"] as const;
export type FollowupState = (typeof FOLLOWUP_STATES)[number];
export type FollowupInboxState = "none" | "onTop" | "seen";
export const NUDGE_DAYS = [3, 5, 7, 14] as const;
export const NUDGE_DEFAULT = 5;
/** Scan: past these it's over, not a follow-up (plan §8). */
export const SCAN_PROMISE_OVERDUE_MS = 7 * 86_400_000;
export const SCAN_WAIT_STALE_MS = 14 * 86_400_000;
export const SCAN_MESSAGES_MAX = 300;
export const SCAN_DAYS = 30;
/** Plan 210 (iteration 4): a reply's promises at most (the follow-ups reader keeps ten), what its row acts on with its lead */
export const FOLLOWUP_REPLY_MAX = 10;

export interface FollowupRow {
  id: number;
  threadId: number;
  /** the message it came from: it may have gone, the promise hasn't */
  messageId: number;
  rfcMessageId: string | null;
  item: number;
  kind: FollowupKind;
  /** in the app's language, a verb phrase: "send the contract" */
  text: string;
  /** your words, for a promise */
  quote: string | null;
  personName: string | null;
  personEmail: string | null;
  sentAt: number;
  dueAt: number;
  dated: boolean;
  /** plan 204 (the fifth panel round): a promise's Later, hidden until then; its day (`dueAt`) stays. A nudge's Later moves `dueAt` */
  deferredUntil: number | null;
  state: FollowupState;
  inboxState: FollowupInboxState;
  closedReason: string | null;
  closedAt: number | null;
  notifiedAt: number | null;
  fromScan: boolean;
  /** ups on each change: what you saw is what your action applies to */
  revision: number;
  model: string | null;
  provider: string | null;
  createdAt: number;
  /** Plan 210 (iteration 2): the same thing as another item (`ItemRef` key, "dated:42" or "promise:7"): one row, its canonical's */
  sameAs?: string | null;
  /**
   * Plan 210 (iteration 2): the first day it was promised for, when the person's mail gave it a new one after that day had
   * passed (captured at the move, from that mail's date): its row says "You said Tue 10 (missed)". Null: never broken, or moved before.
   */
  brokenDueAt?: number | null;
  /** Plan 210 (iteration 2): `dueAt` is a time its words state ("call Marcus at 4:00 PM"), not the day's default */
  timed?: boolean;
  /**
   * Plan 210 (iteration 3): the dated request (`DatedRow.id`, an `ask` or `respond`) this promise answers, by its reply's
   * checked verdict: while the promise is open the request is its row's, its day carried (`promiseDay`). Null: none
   */
  answers?: number | null;
  /** Plan 210 (iteration 4, Change…): as `DatedRow.changedAt`, `changedFrom` and `proposal`: the user's schedule, and a mail's move kept for them */
  changedAt?: number | null;
  changedFrom?: ItemSchedule | null;
  proposal?: ScheduleProposal | null;
  /** Plan 210 (iteration 4): whom it was handed to (`closedReason` `handed`), as the confirmed forward went. Absent: not handed */
  handedTo?: import("./handoff").HandedTo | null;
  /** Plan 210 (iteration 4, revision 7): the sent mail that kept it, or the person's that replaced it, and that mail's date */
  settledBy?: number | null;
  settledAt?: number | null;
  /**
   * Plan 210 (iteration 4, revision 11): the day its person asked for it before, when their mail moved it ("before then",
   * the Monday): `dueAt` is the day before; its row says "needed before Mon". Null: none, or stored before it.
   */
  before?: string | null;
  /**
   * Plan 210 (iteration 4, the Codex review's revision 4): the dated request this promise only holds ("let me check my
   * calendar and get back to you"), by its reply's checked verdict: the request is the row, never this; it closes with the
   * request (`FollowupWorker.retire`). Null: none
   */
  holds?: number | null;
  /**
   * Plan 210 (iteration 5, revision 4): the part of its day it was promised for ("Friday morning", "tonight"), never a clock
   * written into its words; untimed, it's over at that part's end (`dueCutoff`). Absent or null: the whole day.
   */
  partOfDay?: import("./part-of-day").PartOfDay | null;
}

export interface FollowupsSetting {
  enabled: boolean;
  /**
   * the moment it was turned on: what was sent before it is the check's (plan 211: the backend's, per account), never read
   * live; null while it's on by default
   */
  enabledAt: number | null;
  nudgeAfterDays: number;
}

/**
 * When a row comes due (the fifth panel round): its moment, or a promise's Later if that's later. One rule for both stores'
 * due transition and next moment, the notice and the Inbox's top, so a promise put off past its day doesn't come due at once.
 */
export const followupWakeAt = (r: Pick<FollowupRow, "dueAt"> & { deferredUntil?: number | null }): number => (r.deferredUntil != null ? Math.max(r.dueAt, r.deferredUntil) : r.dueAt);

/** The app's view: what's active, with `due` true by now; never MCP. */
export interface FollowupsSnapshot {
  rows: FollowupRow[];
}

const startOfDay = (ms: number): Date => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d;
};

const atHour = (day: Date, plusDays: number, hour: number): number => {
  const d = new Date(day);
  d.setDate(d.getDate() + plusDays);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
};

/** The next 9:00 at or after this moment. */
const nextMorning = (ms: number): number => {
  const today = atHour(startOfDay(ms), 0, REMIND_MORNING);
  return ms <= today ? today : atHour(startOfDay(ms), 1, REMIND_MORNING);
};

/** "2026-11-06" as the local day, or null: parsed by parts, since Date would read it as UTC. */
export function localDay(text: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? d : null;
}

/**
 * Plan 142 §5, all in local time, built with setDate/setHours so a day across a DST change keeps its hour:
 * - a promise with a date: that day at 9:00
 * - a promise for today written after 9:00: today at 17:00; after 17:00, tomorrow at 9:00
 * - a promise with no date: 3 days after sending, at the next 9:00
 * - awaiting a reply: `nudgeAfterDays` after sending, at the next 9:00
 *
 * Today places a promise by the day of `dueAt` (plan 204's `promisePlace`), so one for "today" made after 17:00 is
 * tomorrow's there: in Deadlines tomorrow, Missed a day later than its words say. Kept (plan 204): rare, and the
 * alternative is a day column on `followups`.
 */
export function followupDue(o: { kind: FollowupKind; sentAt: number; due: string | null; nudgeAfterDays: number }): { dueAt: number; dated: boolean } {
  const sent = startOfDay(o.sentAt);
  const after = (days: number) => {
    const d = new Date(o.sentAt);
    d.setDate(d.getDate() + days);
    return nextMorning(d.getTime());
  };
  if (o.kind === "awaiting") return { dueAt: after(o.nudgeAfterDays), dated: false };
  const day = o.due ? localDay(o.due) : null;
  if (!day) return { dueAt: after(3), dated: false };
  const morning = atHour(day, 0, REMIND_MORNING);
  if (morning > o.sentAt) return { dueAt: morning, dated: true };
  if (day.getTime() === sent.getTime()) {
    const evening = atHour(sent, 0, 17);
    return { dueAt: evening > o.sentAt ? evening : atHour(sent, 1, REMIND_MORNING), dated: true };
  }
  return { dueAt: after(0), dated: true };
}

/** A date a model gave: real, on or after the day it was written, within a year. Else it's undated. */
export function validFollowupDate(due: string | null | undefined, sentAt: number): string | null {
  if (!due) return null;
  const day = localDay(due);
  if (!day) return null;
  const sent = startOfDay(sentAt).getTime();
  const limit = new Date(sentAt);
  limit.setFullYear(limit.getFullYear() + 1);
  return day.getTime() >= sent && day.getTime() <= limit.getTime() ? due : null;
}

type Urgency = Pick<FollowupRow, "state" | "dueAt" | "id"> & { deferredUntil?: number | null };

/**
 * Due first, then the soonest to wake (`followupWakeAt`: a promise's Later counts). One order for the follow-ups list's
 * threads and a row's line (Codex code review of plan 204's fifth round): a thread placed by one promise shows that one.
 */
export const byUrgency = (a: Urgency, b: Urgency): number => (a.state === "due" ? 0 : 1) - (b.state === "due" ? 0 : 1) || followupWakeAt(a) - followupWakeAt(b) || a.id - b.id;

/** The thread's most urgent, for a row (`byUrgency`). */
export function mostUrgent<T extends Urgency>(rows: readonly T[]): T | undefined {
  return [...rows].sort(byUrgency)[0];
}

/** Whole days since it was sent, for "hasn't replied in 5 days": 0 until a full day has passed (plan 161: "yet", never "in 1 day" minutes after). */
export const followupDaysSince = (sentAt: number, now: number): number => Math.max(0, Math.floor((now - sentAt) / 86_400_000));
