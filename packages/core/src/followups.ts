import { REMIND_MORNING } from "./reminders";

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
}

export interface FollowupsSetting {
  enabled: boolean;
  /** the moment it went on: mail from before it is never read without a yes */
  enabledAt: number | null;
  nudgeAfterDays: number;
  /** the one-time offer was answered */
  scanAnswered: boolean;
}

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

/** The thread's most urgent, for a row: due first, soonest first. */
export function mostUrgent<T extends Pick<FollowupRow, "state" | "dueAt" | "id">>(rows: readonly T[]): T | undefined {
  return [...rows].sort((a, b) => (a.state === "due" ? 0 : 1) - (b.state === "due" ? 0 : 1) || a.dueAt - b.dueAt || a.id - b.id)[0];
}

/** Whole days since it was sent, for "hasn't replied in 5 days": 0 until a full day has passed (plan 161: "yet", never "in 1 day" minutes after). */
export const followupDaysSince = (sentAt: number, now: number): number => Math.max(0, Math.floor((now - sentAt) / 86_400_000));
