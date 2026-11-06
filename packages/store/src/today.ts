import type { DigestItem, DigestState } from "@terno/core";

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
  subject: string;
  snippet: string;
}

export interface TodayStore {
  /** Inbox threads waiting for a reply, newest first, walking date order: `after` is the last id of the page before */
  waitingPage(o: { now: number; after: { lastDate: number; id: number } | null; limit: number }): Promise<{ id: number; lastDate: number }[]>;
  /** which of these threads the Inbox holds as waiting (a due follow-up may be one too: it counts once) */
  waitingAmong(threadIds: readonly number[], now: number): Promise<number[]>;
  /** of these messages, those that qualify; `arrivedAt` also for those that don't is what a walk stops on */
  digestFacts(messageIds: readonly number[]): Promise<{ facts: DigestFact[]; oldest: number | null }>;
  /** of these listed threads, how many are still as a digest would act on them: in the Inbox and unread */
  digestLive(threadIds: readonly number[]): Promise<number[]>;
  /** of these messages, those still stored */
  messagesHere(messageIds: readonly number[]): Promise<number[]>;
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
