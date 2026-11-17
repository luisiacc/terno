import { addressKey, CALENDAR_ANSWER_PREFIXES, SUMMARY_WHO_ACTS_SINCE, type DatedRow, type DigestItem, type DigestState, type FollowupRow, type ItemRef } from "@terno/core";
import type { DatedSnapshot } from "./dated";
import type { FollowupSnapshot } from "./followups";
import type { ScheduleChanges, ScheduleSnapshots } from "./schedule";

/**
 * Plan 210 (iteration 2): one act on the items a row is, each at the revision it was seen at. A dated item's patch is
 * `dated.update`'s, a promise's `followups.update`'s.
 */
export interface ItemChanges {
  dated: readonly { id: number; revision: number; patch: Partial<Pick<DatedRow, "state" | "deferredUntil" | "closedReason" | "closedAt">> }[];
  promises: readonly { id: number; revision: number; patch: Partial<Pick<FollowupRow, "state" | "dueAt" | "deferredUntil" | "inboxState" | "closedReason" | "closedAt">> }[];
}

/**
 * Plan 210 (iteration 3): a request closed with the promise of yours that answered it (Done on the promise's row): it's
 * that promise's history line, not one of its own.
 */
export const ANSWERED_WITH_PROMISE = "promise";

/**
 * Plan 210 (iteration 4): a promise that only held a request ("let me check and get back to you"), closed once the request
 * is: the request's line says what happened, so it has none of its own.
 */
export const HELD_REQUEST_CLOSED = "held";

/** What an act changed, as it was before: Undo restores each row while its revision is still the act's. */
export interface ItemSnapshots {
  dated: readonly DatedSnapshot[];
  promises: readonly FollowupSnapshot[];
}

/**
 * Plan 145's reads and table, the part both stores share (`packages/db/src/today.ts`, `packages/idb/src/today.ts`). The
 * digest isn't exported, synced, searched or on MCP.
 */
export interface DigestStored {
  day: string;
  state: DigestState;
  /** checkpointed by batch: a restart goes on from what's done */
  items: DigestItem[];
  /** what's still to read, with a run underway */
  pending: DigestItem[];
  attempts: number;
  errorKind: string | null;
  /** how far arrivals had been read: the next digest starts after it, so nothing's lost or read twice (revision 8) */
  watermark: { at: number; id: number };
  model: string | null;
  provider: string | null;
  promptVersion: number | null;
  generatedAt: number | null;
}

/** A message a digest could list: its thread's newest, inbound, unread and automated, in the Inbox and not Social. */
export interface DigestFact {
  threadId: number;
  messageId: number;
  /** plan 211: an account whose AI or What matters is off gives the digest nothing */
  accountId: number;
  arrivedAt: number;
  lastDate: number;
  messageCount: number;
  from: string;
  /** plan 166: the sender's address, what "Not a newsletter" keeps out */
  fromEmail: string;
  subject: string;
  snippet: string;
}

/** How many of the newest waiting threads the rule reads: every count pays for this, and a window with more isn't a person's. */
export const NEEDS_WALK = 2000;

export interface WaitingRow {
  id: number;
  lastDate: number;
  from: string;
  subject: string;
  hasSent: boolean;
}

/**
 * Needs you: a waiting conversation they've written in, or the single new conversation from someone they've written to
 * who isn't themselves; never a calendar's answer. Both stores come here, so they can't disagree.
 */
export function needsYou(rows: readonly WaitingRow[], known: (key: string) => { written: number; own: number } | undefined): WaitingRow[] {
  const answerless = (r: WaitingRow) => CALENDAR_ANSWER_PREFIXES.some((p) => r.subject.toLowerCase().startsWith(p));
  const unanswered = new Map<string, number>();
  for (const r of rows) {
    if (r.hasSent || answerless(r)) continue;
    const key = addressKey(r.from);
    unanswered.set(key, (unanswered.get(key) ?? 0) + 1);
  }
  return rows.filter((r) => {
    if (answerless(r)) return false;
    if (r.hasSent) return true;
    const key = addressKey(r.from);
    if (unanswered.get(key) !== 1) return false;
    const who = known(key);
    return who?.written === 1 && who.own !== 1;
  });
}

/**
 * Plan 204, the second panel round (plan 145's rule, tighter; Codex review): a current summary of the thread that gives the
 * reader no action and no question. Current: ready, from a prompt that says who has to act, valid, and generated after
 * every message the thread shows arrived (the caller checks that against `generated_at`: a write checks its sources in
 * its own transaction, while `through_message_id` moves when mail is queued, and a dropped request leaves it moved).
 * Anything else (missing, stale, malformed, older) says nothing.
 */
export function summaryAsksNothing(row: { state: string; prompt_version: number | null; body_json: string | null; generated_at: number | null } | null | undefined): boolean {
  if (!row || row.state !== "ready" || (row.prompt_version ?? 0) < SUMMARY_WHO_ACTS_SINCE || !row.body_json || row.generated_at == null) return false;
  try {
    const body = JSON.parse(row.body_json) as { summary?: unknown; items?: unknown };
    if (typeof body.summary !== "string" || !Array.isArray(body.items)) return false;
    return !body.items.some((i) => i && typeof i === "object" && ((i as { kind?: unknown }).kind === "action" || (i as { kind?: unknown }).kind === "question"));
  } catch {
    return false;
  }
}

export interface TodayStore {
  /** What needs you (`needsYou`), newest first, among the newest `NEEDS_WALK` waiting: plan 17's "a person" holds any plain address, and on real mail most of it was a bank's and a service's notices. `after` is the last id of the page before */
  waitingPage(o: { now: number; after: { lastDate: number; id: number } | null; limit: number }): Promise<{ id: number; lastDate: number; /** why `needsYou` let it in: you've written in it (else: new, from someone you write to) */ hasSent: boolean }[]>;
  /** which of these threads the Inbox holds as waiting (a due follow-up may be one too: it counts once) */
  waitingAmong(threadIds: readonly number[], now: number): Promise<number[]>;
  /** how many `waitingPage` would walk: plan 145's own number (the Today perf gate's baseline) */
  needsCount(now: number): Promise<number>;
  /**
   * Plan 210 (iteration 2): of these threads, those whose rows may show: still here, and in neither Spam nor Trash (one read
   * for every item the count places; replaces plan 204's `countWith` thread arithmetic, which the projection now does)
   */
  liveAmong(threadIds: readonly number[]): Promise<Set<number>>;
  /**
   * Plan 210 (iteration 2): every dated item and promise, in any state, that belongs to one of these canonical items (keys,
   * `refKey`: the item itself and those whose `sameAs` is it). One indexed read a key: what an act on a merged row and a
   * history page resolve membership by
   */
  members(keys: readonly string[]): Promise<{ dated: DatedRow[]; promises: FollowupRow[] }>;
  /**
   * Plan 210 (iteration 2): duplicate membership and related details, as the backend's matcher found them. `same`: the item
   * is the same thing as `sameAs` (a canonical's key); `details`: the dated item is a detail of `detailOf`. Written only on
   * rows still open, and never over a membership already set (a canonical keeps its id as evidence arrives). How many it set
   */
  link(o: { same: readonly { item: ItemRef; sameAs: string }[]; details: readonly { id: number; detailOf: number }[] }): Promise<number>;
  /**
   * Plan 210 (iteration 2): an act on a row, on every item it is at once (Done, Remove, Later on a merged one), each at the
   * revision it was read at: all or none (null: one changed since). Each row's revision ups, as `dated.update` and
   * `followups.update` do; what comes back is what Undo puts back
   */
  act(changes: ItemChanges): Promise<ItemSnapshots | null>;
  /** Its Undo: every row only if none changed since (all or none; false: one had) */
  restore(snapshots: ItemSnapshots): Promise<boolean>;
  /**
   * Plan 210 (iteration 4, Change…): a new day and time on every item a row is, each at the revision it was read at and still
   * open, all or none (null: one changed or closed since); see `ScheduleChanges`. What comes back is what its Undo puts back
   */
  schedule(changes: ScheduleChanges): Promise<ScheduleSnapshots | null>;
  /** Its Undo: every field of every row back, only if none changed since (all or none; false: one had) */
  unschedule(snapshots: ScheduleSnapshots): Promise<boolean>;
  /** of these messages, those that qualify; `arrivedAt` also for those that don't is what a walk stops on */
  digestFacts(messageIds: readonly number[]): Promise<{ facts: DigestFact[]; oldest: number | null }>;
  /** of these listed threads, how many are still as a digest would act on them: in the Inbox and unread */
  digestLive(threadIds: readonly number[]): Promise<number[]>;
  /** of these listed threads, those still in the Inbox but read: opened, so a digest leaves them (plan 161) */
  digestRead(threadIds: readonly number[]): Promise<number[]>;
  /** of these messages, those still stored */
  messagesHere(messageIds: readonly number[]): Promise<number[]>;
  /** plan 166: each stored message's sender address, by its id (a digest stored before items carried it) */
  senders(messageIds: readonly number[]): Promise<Map<number, string>>;
  /**
   * Plan 210 (iteration 3): each stored message's sender, name and address, by its id: What matters' row names its own
   * item's sender, not its conversation's latest. One read for the rows a list shows
   */
  fromOf(messageIds: readonly number[]): Promise<Map<number, { name: string; email: string }>>;
  digest: {
    get(day: string): Promise<DigestStored | null>;
    /** the newest at or before this day */
    latest(day: string): Promise<DigestStored | null>;
    /** pending, in one unit: two wake-ups can't both begin it. False: there's a row already */
    begin(day: string, watermark: { at: number; id: number }, pending: readonly DigestItem[], clearGeneration: number): Promise<boolean>;
    /** a batch done, or the last. Refused when cleared since */
    write(row: DigestStored, clearGeneration: number): Promise<boolean>;
    pendingDays(): Promise<string[]>;
    /** at most the 14 days kept */
    all(): Promise<DigestStored[]>;
    prune(keepFrom: string): Promise<void>;
    clear(): Promise<void>;
    clearGeneration(): number;
  };
}
