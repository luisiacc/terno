import { addressKey, CALENDAR_ANSWER_PREFIXES, type DigestItem, type DigestState } from "@terno/core";

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

export interface TodayStore {
  /** What needs you (`needsYou`), newest first, among the newest `NEEDS_WALK` waiting: plan 17's "a person" holds any plain address, and on real mail most of it was a bank's and a service's notices. `after` is the last id of the page before */
  waitingPage(o: { now: number; after: { lastDate: number; id: number } | null; limit: number }): Promise<{ id: number; lastDate: number; /** why `needsYou` let it in: you've written in it (else: new, from someone you write to) */ hasSent: boolean }[]>;
  /** which of these threads the Inbox holds as waiting (a due follow-up may be one too: it counts once) */
  waitingAmong(threadIds: readonly number[], now: number): Promise<number[]>;
  /** how many `waitingPage` would walk: the sidebar's number, on every count */
  needsCount(now: number): Promise<number>;
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
