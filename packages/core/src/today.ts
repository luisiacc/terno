import type { AppSettings } from "./rpc/contract";
import type { ThreadSummary } from "./types";

/** Plan 145: what needs you today, and newsletters folded into one digest. Local but for the digest, which is its own opt-in. */

export const TODAY_NEEDS_MAX = 12;
export const DIGEST_CANDIDATES_MAX = 40;
export const DIGEST_WINDOW_MS = 3 * 86_400_000;
export const DIGEST_KEEP_DAYS = 14;
export const DIGEST_LINE_CHARS = 140;
/** the list's row for the digest: no thread has it */
export const DIGEST_ROW_ID = 0;
/** what a notice's click opens when it's the brief: no thread has it */
export const BRIEF_NOTICE_THREAD = -1;

export interface TodaySetting {
  show: boolean;
  /** HH:MM, local */
  prepareAt: string;
  notify: boolean;
  digest: boolean;
}

export const DEFAULT_TODAY: TodaySetting = { show: true, prepareAt: "08:00", notify: false, digest: false };

/**
 * Who sees Today: a provider set up, or (once plan 85's Pro exists) an active entitlement. One helper, so Pro joins in one
 * line. It reads no provider's id but "none".
 */
export function aiFeaturesAvailable(settings: Pick<AppSettings, "ai"> | null | undefined, entitlement?: { active: boolean } | null): boolean {
  if (entitlement?.active === true) return true;
  const ai = settings?.ai;
  if (!ai || ai.provider === "none" || ai.keyUnreadable) return false;
  // a key removed leaves the provider chosen: without one, it can't run. A model here needs none.
  return !ai.needsKey || (ai.hasKey && ai.keyConfirmed);
}

export interface TodayWhy {
  kind: "promise" | "nudge" | "waiting" | "reminder";
  text?: string;
  dueAt?: number;
  personName?: string | null;
  sentAt?: number;
}

export interface TodayItem {
  thread: ThreadSummary;
  why: TodayWhy;
  /** the stored summary's first sentence, only when it's current */
  summary?: string;
}

export type TodaySection = { kind: "needsYou"; items: TodayItem[]; more: number } | { kind: "reminders"; items: TodayItem[] };

export interface DigestItem {
  threadId: number;
  messageId: number;
  /** a thread that moved since isn't what was listed */
  lastDate: number;
  messageCount: number;
  from: string;
  subject: string;
  /** null: no line, with the digest off */
  line: string | null;
}

export type DigestState = "pending" | "ready" | "failed";

export interface DigestRow {
  day: string;
  state: DigestState;
  items: DigestItem[];
  /** with no digest: what's automated, unsorted: nothing here has said these are newsletters */
  automated: boolean;
  /** of `items`, those still in the Inbox and unread: the rest stay listed, muted */
  liveIds: number[];
  /** the failure's kind, for its help line */
  errorKind?: string | null;
  model?: string | null;
  provider?: string | null;
}

export interface TodayList {
  sections: TodaySection[];
  digest: DigestRow | null;
  now: number;
  /** the open and checked rows no section holds any more: kept in place until the selection lets go (revision 9) */
  held: ThreadSummary[];
}

/** A day's key, in the machine's own time. */
export function todayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** When "HH:MM" next comes round after `now`, local, through a DST change as a clock on the wall would. */
export function nextPrepareAt(prepareAt: string, now: number): number {
  const [h, m] = prepareAt.split(":").map(Number);
  const at = new Date(now);
  at.setHours(h ?? 8, m ?? 0, 0, 0);
  if (at.getTime() <= now) at.setDate(at.getDate() + 1);
  at.setHours(h ?? 8, m ?? 0, 0, 0);
  return at.getTime();
}

/** Today's "HH:MM", local. */
export function prepareTimeToday(prepareAt: string, now: number): number {
  const [h, m] = prepareAt.split(":").map(Number);
  const at = new Date(now);
  at.setHours(h ?? 8, m ?? 0, 0, 0);
  return at.getTime();
}
