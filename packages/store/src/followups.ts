import { addressKey, type FollowupKind, type FollowupRow, type FollowupState, type PartOfDay } from "@terno/core";
import type { ClosedAt } from "./dated";

/**
 * Plan 142: what you've promised and who owes you a reply.
 *
 * - `ai_sent_mail`: "this was really sent, and the worker hasn't read it": written in the commit that makes the send
 *   known (the confirmed send, or live sync of mail sent elsewhere). `source` says whose it is: a scan row is one of the
 *   300 the user agreed to, and lives 14 days rather than 3.
 * - `followups`: one row per promise or wait, unique on its source message and item, since the same sentence on two
 *   messages is two promises. Rows outlive the source (`message_id` has no cascade), never the thread.
 */

export const SENT_MARK_MS = 3 * 86_400_000;
export const SCAN_MARK_MS = 14 * 86_400_000;
export const FOLLOWUPS_ACTIVE_MAX = 1000;
export const FOLLOWUP_CLOSED_KEEP_MS = 90 * 86_400_000;
/** the item a wait is, beside promises 0, 1, 2: one wait a source message */
export const AWAITING_ITEM = 100;

export interface SentMark {
  messageId: number;
  threadId: number;
  sentAt: number;
  queuedAt: number;
  source: "live" | "scan";
}

/** What the worker reads of one sent message, no body. */
export interface FollowupSource {
  id: number;
  threadId: number;
  accountId: number;
  subject: string;
  rfcMessageId: string | null;
  date: number;
  bulk: boolean;
  draft: boolean;
  spam: boolean;
  trash: boolean;
  to: { name: string; email: string }[];
  cc: { name: string; email: string }[];
  attachments: string[];
  bodyState: "none" | "partial" | "full";
  bodyUnavailable: boolean;
  /** the newest message before it from someone else: what it answers */
  answering: { id: number; bodyState: "none" | "partial" | "full"; bodyUnavailable: boolean } | null;
}

export interface FollowupWrite {
  kind: FollowupKind;
  item: number;
  text: string;
  quote: string | null;
  personName: string | null;
  personEmail: string | null;
  dueAt: number;
  dated: boolean;
  /** plan 210 (iteration 2): `dueAt` is a time its words state (`FollowupRow.timed`); absent, not */
  timed?: boolean;
  /** plan 210 (iteration 5, revision 4): the part of its day it's promised for (`FollowupRow.partOfDay`); absent, the whole day */
  partOfDay?: PartOfDay | null;
  /**
   * Plan 210 (round 14's faults, the second morning): a promise you'd already made, still open, said again (the same person,
   * conversation and deliverable: Theo's "full written update" for Monday morning after Friday's): that row takes it, never
   * a second row beside it. The older takes this one's moment when this one names a day or the older named none, its
   * first missed day kept (`brokenDueAt`, as a person's move keeps it), and a verdict on this item reaches it. Only at the
   * revision shown, an open promise of this conversation: otherwise this is a row of its own. Absent: a new promise
   */
  renews?: { id: number; revision: number; brokenDueAt: number | null };
}

export interface FollowupFinish {
  messageId: number;
  /** what it read: anything else means the source changed under the request */
  threadId: number;
  fromScan: boolean;
  /** rows to add; none is a valid answer, which still consumes the mark */
  rows: readonly FollowupWrite[];
  /**
   * open promises this message kept: only the exact row it was shown, at the revision it was shown. Plan 210 (iteration 3):
   * a request a kept promise answers (`FollowupRow.answers`) is settled with it, when the reply is yours for certain
   */
  kept: readonly { id: number; revision: number }[];
  /**
   * Plan 210 (iteration 3, the Codex review's revision 1): this reply's checked verdict on the conversation's requests it
   * was shown (dated `ask`/`respond` items), the only authority over them a reply has. `fulfilled`: the request is settled
   * (`answered`), at the revision shown, and in that commit the open promises of yours in its conversation, from before this
   * reply, that answer it (`FollowupRow.answers`) are kept with it (the second morning, Diego's adjustments; its code review:
   * never when the request has changed since, so a stale verdict keeps nothing); `promise`: this message's promise `item` answers it (`FollowupRow.answers`), the
   * request open, its day carried; `holding` (plan 210, iteration 4): this message's promise `item` only holds it ("let me
   * check and get back to you", `FollowupRow.holds`), the request open, the row its. No verdict leaves it as it is. Applied only to an open request of this
   * reply's conversation that came before it, and only when the reply is yours for certain (Gmail's SENT label, or Terno's
   * own confirmed send: `followupSendConfirmed`). Absent: none
   */
  verdicts?: readonly ({ request: { id: number; revision: number }; verdict: "fulfilled" } | { request: { id: number; revision: number }; verdict: "promise" | "holding"; item: number })[];
  /** a wait is added only if no reply or later send has come */
  now: number;
  model: string | null;
  provider: string | null;
  promptVersion: number | null;
  clearGeneration: number;
}

export type FollowupFinishOutcome = "written" | "gone";

export interface FollowupCounts {
  due: number;
  active: number;
}

/** A journal entry: enough to put one row back exactly, if nothing else changed it since. */
export interface FollowupSnapshot {
  id: number;
  revision: number;
  state: FollowupState;
  dueAt: number;
  /** plan 204 (the fifth panel round): restored as it was, null included */
  deferredUntil: number | null;
  inboxState: FollowupRow["inboxState"];
  closedReason: string | null;
  closedAt: number | null;
}

export const snapshotOf = (r: FollowupRow): FollowupSnapshot => ({ id: r.id, revision: r.revision, state: r.state, dueAt: r.dueAt, deferredUntil: r.deferredUntil, inboxState: r.inboxState, closedReason: r.closedReason, closedAt: r.closedAt });

/** A wait no one's a person to wait on: "noreply@…" and friends never owe anyone. Recipients are filtered by the worker. */
export const ownRecipientsOnly = (to: readonly { email: string }[], own: ReadonlySet<string>): boolean => to.length > 0 && to.every((r) => own.has(addressKey(r.email)));

export interface FollowupStore {
  /** Live sent mail or a confirmed send: marked once, with its waits on the thread closing in the same commit. */
  marks: {
    page(after: { sentAt: number; messageId: number } | null, limit: number): Promise<SentMark[]>;
    count(): Promise<number>;
    /** the 30-day check (plan 211: the backend's, per account) */
    queueScan(messageIds: readonly number[], now: number): Promise<number>;
    /** read and found nothing to do, or never to be read */
    consume(messageId: number): Promise<void>;
    clear(): Promise<void>;
    prune(now: number): Promise<number>;
  };
  /** an account's sent mail in a span that a check could read, newest first: templates and bulk are left to the worker (plan 211: per account) */
  scanCandidates(since: number, limit: number, accountId: number): Promise<number[]>;
  source(messageId: number): Promise<FollowupSource | null>;
  /** Results, closures and consuming the mark, in one commit: a crash can't redo or lose it. */
  finish(write: FollowupFinish): Promise<FollowupFinishOutcome>;
  active(): Promise<FollowupRow[]>;
  ofThread(threadId: number): Promise<FollowupRow[]>;
  /** Plan 210: closed promises of yours (done, dismissed) closed since `since`, newest first by `(closed_at, id)`, strictly after `after`, at most `limit` */
  closedPage(o: { since: number; after: ClosedAt | null; limit: number }): Promise<FollowupRow[]>;
  get(id: number): Promise<FollowupRow | null>;
  /** the soonest open row's moment (`followupWakeAt`: a promise's Later included); null: nothing to wait for */
  nextDue(): Promise<number | null>;
  /** what came due by `followupWakeAt`, now `due`, on the Inbox's top unless it's from a check */
  makeDue(now: number): Promise<FollowupRow[]>;
  /** said once each: what hadn't been said yet goes out with this */
  claimNotice(ids: readonly number[], now: number): Promise<number[]>;
  /** awaits with a reply since their source: closed. A message on the thread, or one naming the source, not from one of your addresses, not spam or trash nor a draft */
  closeAnswered(ids: readonly number[], now: number): Promise<number[]>;
  /** the threads' `onTop` rows are `seen` now; what to put back for Undo */
  endTop(threadIds: readonly number[]): Promise<FollowupSnapshot[]>;
  /** a change by the user, conditional on the revision they saw */
  update(id: number, revision: number, patch: Partial<Pick<FollowupRow, "state" | "dueAt" | "deferredUntil" | "inboxState" | "closedReason" | "closedAt">>): Promise<FollowupSnapshot | null>;
  /** Undo: each row only if nothing else changed it since */
  restore(rows: readonly { snapshot: FollowupSnapshot; expectRevision: number }[]): Promise<number>;
  prune(now: number): Promise<number>;
  clear(): Promise<void>;
  clearGeneration(): number;
}
