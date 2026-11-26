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
/** Revision 3: how far back a check of received mail reads */
export const OWED_SCAN_DAYS = 14;
/** §4: an open promise of theirs retires quietly this long after it came due */
export const OWED_RETIRE_MS = 30 * 86_400_000;

export type OwedSourceKind = "live" | "scan" | "requeue";
export const owedSourceOf = (raw: unknown): OwedSourceKind => (raw === "scan" || raw === "requeue" ? raw : "live");

export interface OwedMark {
  messageId: number;
  threadId: number;
  senderKey: string;
  arrivedAt: number;
  queuedAt: number;
  /**
   * "live", "scan" (a check's), or "requeue" (a debtor's mail read again once a debt was found late: the Fable review, never
   * a check's, so what it finds can reach the Inbox's top); one the app doesn't know reads as "live"
   */
  source: OwedSourceKind;
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
  /**
   * The Fable review: of these open promises of theirs, those that may be material for a reading in this account (as
   * `openFor` reads them: the account's, no conversation in Trash or with anything in Spam), in one read
   */
  readable(ids: readonly number[], accountId: number): Promise<Set<number>>;
  /**
   * Results, closures, moves and consuming the mark, in one commit. The QA panel: a mail's close, move or hint applies to a
   * promise still open whatever its revision (coming due, or a Later, while the reading was out ups it), as the dated
   * reader's moves do; always the debtor's own mail, newer than the promise and its last move. The Fable review: a message
   * read before (it has a promise of theirs, closed ones too) adds none: a re-read judges what it keeps and moves, never
   * finds the same promises again under other positions
   */
  finish(write: OwedFinish): Promise<FollowupFinishOutcome>;
}
