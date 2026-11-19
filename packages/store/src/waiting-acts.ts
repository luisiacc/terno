import type { ClosedAt, DatedSnapshot } from "./dated";

/**
 * Plan 215: Done and Later on What matters' "Waiting on you" rows, both stores' (`waiting_acts`, SQLite v74, IndexedDB 38).
 * A record is a message's: the one the conversation waited on when it was acted on (its thread is the message's, through
 * merges and moves; it goes with its message). Done is "no reply needed": the thread's facts read it (`FactContext.cleared`),
 * so everything that says "waiting" agrees. Later only puts the row off in What matters, until its moment. `rev` moves on
 * every write, so two windows never overwrite each other's choice; Undo puts the whole previous record back. Records go only with
 * their message (a Later over is kept, never pruned: a revision that started again could name another's act, Codex code
 * review 1, #1).
 */

/** Plan 216: `removed` takes the row off What matters only (the fact and the Inbox untouched, no Earlier line, the reader's requests left alone). */
export type WaitingActState = "done" | "later" | "removed";

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
  /** the dated reader's requests from the message the act changed, as they were (each put back while it's at the act's revision) */
  items: DatedSnapshot[];
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

/** How many deferrals' moments the clock reads at most (the soonest). */
export const WAITING_MOMENTS_MAX = 500;

/** A waiting conversation's record as its row needs it: the message the facts judge waiting, its revision, Later's moment. */
export interface WaitingRowFacts {
  /** null: not resolved (asked without `messages`) */
  message: number | null;
  rev: number;
  /** Later's moment while it's ahead */
  until: number | null;
  /** plan 216: taken off What matters (present only then) */
  removed?: true;
}

export interface WaitingActsStore {
  /**
   * Done, Later or (plan 216) Remove on a conversation waiting on you, in one transaction: its facts are walked again
   * (bounded) for the message they judge waiting; refused (null) unless that's still `message`, waiting since `since`, and
   * its record is still at `rev` (absent: 0). Done clears the thread's `waiting_since` (marking search) in the same write;
   * the dated reader's requests from the message follow Done and Later (Remove leaves them as they are).
   */
  act(o: { threadId: number; since: number; message: number; rev: number; state: WaitingActState; until: number | null; now: number }): Promise<WaitingSnapshot | null>;
  /** Its Undo: the previous record back (or none), the facts refreshed; the thread refreshed, or null when it changed since */
  restore(s: WaitingSnapshot): Promise<number | null>;
  /**
   * Of these waiting conversations (their waiting date), what their rows need: with `messages`, each one's waiting message
   * (the list's; one seek a row) and its record; without, only what keeps a row out of the count (a deferral still ahead, a
   * Remove), read from those records alone (nothing read while there's none)
   */
  rows(threads: readonly { threadId: number; since: number }[], now: number, o: { messages: boolean }): Promise<Map<number, WaitingRowFacts>>;
  /** The moments of the deferrals still ahead, soonest first, at most `limit`: what the clock wakes for */
  moments(now: number, limit: number): Promise<number[]>;
  /** Done records since `since`, strictly after `after` by (at, message), newest first */
  donePage(o: { since: number; after: ClosedAt | null; limit: number }): Promise<WaitingDone[]>;
}

/** A record's words, bounded. */
export const waitingWords = (s: string | null | undefined): string => (s ?? "").trim().slice(0, WAITING_WORDS_MAX);
