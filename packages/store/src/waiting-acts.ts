import type { WaitingDeferred } from "@terno/core";
import type { ClosedAt } from "./dated";

/**
 * Plan 215: Done and Later on What matters' "Waiting on you" rows, both stores' (`waiting_acts`, SQLite v74, IndexedDB 38).
 * A record is a message's: the one the conversation waited on when it was acted on (its thread is the message's, through
 * merges and moves; it goes with its message). Done is "no reply needed": the thread's facts read it (`FactContext.cleared`),
 * so everything that says "waiting" agrees. Later only puts the row off in What matters, until its moment. `rev` moves on
 * every write, so two windows never overwrite each other's choice; Undo puts the whole previous record back.
 */

export type WaitingActState = "done" | "later";

/**
 * A request the dated reader read from a message marked Done is stored closed with this reason (or closed with the Done that
 * replaced its Later): the waiting line says it, so it has no history line of its own, and the Done's Undo reopens it.
 */
export const WAITING_CLOSED = "waiting";

/** How much of who wrote and of the subject a record keeps for Earlier's line. */
export const WAITING_WORDS_MAX = 200;

/** A message's record as stored. */
export interface WaitingActRecord {
  messageId: number;
  state: WaitingActState;
  /** Later's moment; null for Done */
  until: number | null;
  /** when it was done or put off */
  at: number;
  rev: number;
  /** Earlier's words, as the row had them: who wrote, about what, and whether you'd written there */
  who: string;
  subject: string;
  wrote: boolean;
}

/** What an act changed: its Undo puts `before` back while the record is still at `rev` (the act's). */
export interface WaitingSnapshot {
  messageId: number;
  threadId: number;
  rev: number;
  before: WaitingActRecord | null;
}

/** A waiting conversation's Done, as Earlier lists it (its thread is its message's now). */
export interface WaitingDone {
  messageId: number;
  threadId: number;
  at: number;
  who: string;
  subject: string;
  wrote: boolean;
}

/** How many deferrals the open part and the clock read at most. */
export const WAITING_DEFERRED_MAX = 500;

export interface WaitingActsStore {
  /**
   * Done or Later on a conversation waiting on you, in one transaction: its facts are walked again (bounded) for the message
   * they judge waiting; refused (null) unless that's still waiting since `since` and its record is still at `rev` (absent:
   * 0). Done refreshes the thread's `person` and `waiting_since` and marks it for search in the same write.
   */
  act(o: { threadId: number; since: number; rev: number; state: WaitingActState; until: number | null; now: number }): Promise<WaitingSnapshot | null>;
  /** Its Undo: the previous record back (or none), the facts refreshed; the thread refreshed, or null when it changed since */
  restore(s: WaitingSnapshot): Promise<number | null>;
  /** Of these waiting conversations (their waiting date), the revisions of their waiting message's records; most have none */
  revs(threads: readonly { threadId: number; since: number }[]): Promise<Map<number, number>>;
  /** Deferrals still ahead whose conversation still waits at the message put off, in the Inbox, soonest first */
  deferred(now: number, limit: number): Promise<WaitingDeferred[]>;
  /** Done records since `since`, strictly after `after` by (at, message), newest first */
  donePage(o: { since: number; after: ClosedAt | null; limit: number }): Promise<WaitingDone[]>;
  /** Deferrals whose moment has come go; how many */
  prune(now: number): Promise<number>;
}

/** A record's words, bounded. */
export const waitingWords = (s: string | null | undefined): string => (s ?? "").trim().slice(0, WAITING_WORDS_MAX);
