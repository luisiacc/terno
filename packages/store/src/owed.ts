import type { FollowupRow, PartOfDay } from "@terno/core";
import type { DatedSource } from "./dated";
import type { FollowupFinishOutcome } from "./followups";

/**
 * Plan 280: their promises to you ("Owed to you"), read by the follow-ups reader from received mail.
 *
 * - `ai_owed_mail`: "this received message may hold, keep, move or withdraw a promise to you, and the reader hasn't read
 *   it": written in the ingest commit while Follow-ups wants it (revision 1), its own marker, never the dated reader's.
 *   `source` says whose it is: a scan's lives 14 days, a live one 3.
 * - The rows are `followups` of kind `theirs`, `item` from `THEIRS_ITEM`, the debtor's `person_key` the only sender whose
 *   own mail can keep, move or withdraw one.
 */

export const OWED_MARK_MS = 3 * 86_400_000;
export const OWED_SCAN_MARK_MS = 14 * 86_400_000;
/** Revision 1: a debt found after its debtor's later mail was read: that mail is read again, within these */
export const OWED_REQUEUE_MS = 14 * 86_400_000;
export const OWED_REQUEUE_MAX = 20;
/** §4: an open promise of theirs retires quietly this long after it came due */
export const OWED_RETIRE_MS = 30 * 86_400_000;

export interface OwedMark {
  messageId: number;
  threadId: number;
  senderKey: string;
  arrivedAt: number;
  queuedAt: number;
  /** "live" or "scan"; one the app doesn't know reads as "live" */
  source: "live" | "scan";
}

/** What the reader reads of one received message, no body: the dated reader's facts, its attachments, and your message it answers. */
export interface OwedSource extends DatedSource {
  rfcMessageId: string | null;
  /** file names, at most 10 */
  attachments: string[];
  /** revision 4: the message of yours it answers (its In-Reply-To), only a trusted send of yours on this account and conversation */
  answering: { id: number; bodyState: "none" | "partial" | "full"; bodyUnavailable: boolean } | null;
}

/** A new promise of theirs, as checked. */
export interface OwedWrite {
  item: number;
  text: string;
  quote: string;
  personName: string | null;
  personEmail: string;
  dueAt: number;
  dated: boolean;
  dueDay: string | null;
  timed?: boolean;
  partOfDay?: PartOfDay | null;
  firm: boolean;
}

export interface OwedRef {
  id: number;
  revision: number;
}

export interface OwedFinish {
  messageId: number;
  /** what it read: anything else means the source changed under the request */
  threadId: number;
  fromScan: boolean;
  rows: readonly OwedWrite[];
  /** the debtor delivered (§2: their mail, the row's `person_key` its sender) */
  kept: readonly OwedRef[];
  /** a new day from the debtor: `dueAt` the late moment, `dueDay` the day promised */
  moved: readonly (OwedRef & { dueAt: number; dueDay: string; timed?: boolean; partOfDay?: PartOfDay | null })[];
  withdrawn: readonly OwedRef[];
  /** revision 5: a service's mail naming the debtor's address and the thing: it may have arrived (never a close) */
  hints: readonly OwedRef[];
  now: number;
  model: string | null;
  provider: string | null;
  promptVersion: number | null;
  clearGeneration: number;
}

export interface OwedStore {
  marks: {
    /** oldest first by arrival, strictly after a key */
    page(after: { arrivedAt: number; messageId: number } | null, limit: number): Promise<OwedMark[]>;
    count(): Promise<number>;
    /** Revision 3: a check's, idempotent on the message, never resetting a live mark */
    queueScan(messageIds: readonly number[], now: number): Promise<number>;
    /** Revision 1: a debtor's received mail in this account since `since`, marked again (at most `OWED_REQUEUE_MAX`) */
    requeue(personEmail: string, accountId: number, since: number, now: number): Promise<number>;
    /** read and found nothing to do, or never to be read (revision 2: every exit consumes this mark alone) */
    consume(messageId: number): Promise<void>;
    clear(): Promise<void>;
    prune(now: number): Promise<number>;
  };
  /** Revision 3: an account's received mail in a span a check could read, newest first, the filter left to the reader */
  scanCandidates(since: number, limit: number, accountId: number): Promise<number[]>;
  source(messageId: number): Promise<OwedSource | null>;
  /**
   * Open promises of theirs this message could keep, move or withdraw: its conversation's, and its sender's in this account
   * (`followups_owed`), from conversations not in Spam or Trash, made before it, newest first, at most `limit`
   */
  openFor(o: { threadId: number; accountId: number; senderKey: string; before: number; limit: number }): Promise<FollowupRow[]>;
  /** Results, closures, moves and consuming the mark, in one commit (revision 8: each change only at the revision shown) */
  finish(write: OwedFinish): Promise<FollowupFinishOutcome>;
}
