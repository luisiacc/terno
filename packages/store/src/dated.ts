import { addressKey, ANSWERED_KINDS, tabOfCode, type DatedKind, type DatedRow, type DatedState } from "@terno/core";

/**
 * Plan 204: dated items, from mail the user got.
 *
 * - `ai_dated_mail`: "this arrived as live mail, and the dated reader hasn't read it" (revision 1: its own marker, not a
 *   flag on `ai_new_mail`, whose clean-ups belong to summaries and categories). Written in the ingest commit by the same
 *   rule as `markNewMail` (`newMailRule`), or by the user's yes to the 14-day check (`source = 'scan'`, revision 2).
 * - `dated_items`: one row per item, unique on its source message and item. Rows outlive the source message
 *   (`message_id` has no cascade), never the thread.
 */

export const DATED_MARK_MS = 3 * 86_400_000;
export const DATED_SCAN_MARK_MS = 14 * 86_400_000;

/**
 * Plan 210 (iteration 2, the owner: "only when something is asked"): `dated_nothing_asked` keeps each message the reader
 * read, at this prompt or later, and found no `ask` or `respond` in (what the checks kept). A waiting conversation whose
 * latest message from them is one leaves Needs you (`stillWaiting`, both stores); mail not read keeps plan 145's rule.
 * Prompt v12 is the first whose "nothing asked" is trusted for it (a thanks, a closing reply).
 */
export const DATED_NOTHING_ASKED_SINCE = 12;

/** A reading that records "nothing asked": of the whole message, at a trusted prompt, and no request of the reader (`ask`, `respond`) kept. */
export const readNothingAsked = (w: Pick<DatedFinish, "rows" | "promptVersion" | "readWhole">): boolean =>
  w.readWhole === true && w.promptVersion != null && w.promptVersion >= DATED_NOTHING_ASKED_SINCE && !w.rows.some((r) => ANSWERED_KINDS.includes(r.kind));

export interface DatedMark {
  messageId: number;
  threadId: number;
  /** the message's own date: marks are read oldest first (revision 5) */
  arrivedAt: number;
  queuedAt: number;
  source: "live" | "scan";
}

/** What the reader needs of one received message, no body. */
export interface DatedSource {
  id: number;
  threadId: number;
  accountId: number;
  subject: string;
  date: number;
  fromName: string;
  fromEmail: string;
  /** `addressKey(fromEmail)` */
  senderKey: string;
  /** a list or bulk sender: a cue the worker reads, never a reason to skip (revision 4) */
  automated: boolean;
  /** plan 17's `senderIsPerson` (a role address only if you've written to it): who an ask may come from (third panel round) */
  person: boolean;
  /** Gmail's tab for its thread, or null where there are none (plan 86) */
  tab: "primary" | "social" | "promotions" | "updates" | "forums" | null;
  draft: boolean;
  sent: boolean;
  spam: boolean;
  trash: boolean;
  /** any message of its thread is in Spam: the owner's rule, plan 132's `hasSpam` */
  threadSpam: boolean;
  /** from one of the user's own addresses */
  own: boolean;
  bodyState: "none" | "partial" | "full";
  bodyUnavailable: boolean;
  /** the eval: who it was sent to, and whether the reader is addressed, only copied, or not named (a list, Bcc) */
  to: { name: string; email: string }[];
  cc: { name: string; email: string }[];
  readerIn: "to" | "cc" | "none";
}

/** Where the reader is among a message's recipients, by their own addresses (`addressKey`s). */
export function readerIn(to: readonly { email: string }[], cc: readonly { email: string }[], own: ReadonlySet<string>): DatedSource["readerIn"] {
  if (to.some((r) => own.has(addressKey(r.email)))) return "to";
  return cc.some((r) => own.has(addressKey(r.email))) ? "cc" : "none";
}

/**
 * `DatedSource.tab` from what's stored: the thread's tab where Terno separates one (`threads.tab`, plan 86), else the
 * message's own Gmail category (`messages.category`; null: not Gmail).
 */
export function datedTab(threadTab: number, category: number | null): DatedSource["tab"] {
  const tab = tabOfCode(threadTab);
  if (tab) return tab;
  if (category == null) return null;
  // Gmail's own category, whether or not this account shows the tabs apart: Promotions is Promotions
  return category === 2 ? "promotions" : category === 3 ? "social" : category === 4 ? "updates" : category === 5 ? "forums" : "primary";
}

export interface DatedWrite {
  kind: DatedKind;
  item: number;
  text: string;
  quote: string;
  dueDay: string;
  dueAt: number;
  timed: boolean;
  dated: boolean;
  actAt: number;
}

export interface DatedFinish {
  messageId: number;
  /** what it read: anything else means the source changed under the request (a merge: retried, revision 6) */
  threadId: number;
  fromScan: boolean;
  /** rows to add; none is a valid answer, which still consumes the mark */
  rows: readonly DatedWrite[];
  /**
   * open items this message settled: only the exact row it was shown, at the revision it was shown, of its thread or its
   * sender (the sixth panel round: a delivery or an ask only of its thread, `THREAD_SCOPED_KINDS`)
   */
  settled: readonly { id: number; revision: number }[];
  /**
   * After the panel: open items this message gives a new day. Applied to an open row it may reach (as `settled`) whatever its
   * revision (Codex review of the fixes: a Later meanwhile mustn't lose the mail's new day); it keeps its deferral. `text`:
   * its new words, in the same write (the fifth panel round); without it the words stay. Neither is in a snapshot, so an
   * Undo of a Later before or after keeps the move's day and words.
   */
  moved?: readonly { id: number; dueDay: string; dueAt: number; timed: boolean; actAt: number; text?: string }[];
  /**
   * The second panel round: promises of yours (plan 142's rows) this message gives a new day. Only at the revision the
   * reader saw (a Later or Done since wins), on this thread, still open or due; the revision bumps (an older Undo is
   * refused), and the promise is open again when its new moment is ahead.
   */
  movedPromises?: readonly { id: number; revision: number; dueAt: number }[];
  now: number;
  model: string | null;
  provider: string | null;
  promptVersion: number | null;
  /**
   * Plan 210 (the Codex code review of iteration 2): the model saw the whole message (not cut to the window or the reader's
   * limit, its body captured in full). Only such a reading may say nothing was asked; absent, it says nothing either way.
   */
  readWhole?: boolean;
  clearGeneration: number;
}

/** `moved`: the message is on another thread now (a merge), so the mark stays and the worker reads it again. */
export type DatedFinishOutcome = "written" | "gone" | "moved";

/** A journal entry: enough to put one row back exactly, if nothing else changed it since. */
export interface DatedSnapshot {
  id: number;
  revision: number;
  state: DatedState;
  deferredUntil: number | null;
  closedReason: string | null;
  closedAt: number | null;
}

export const datedSnapshotOf = (r: DatedRow): DatedSnapshot => ({ id: r.id, revision: r.revision, state: r.state, deferredUntil: r.deferredUntil, closedReason: r.closedReason, closedAt: r.closedAt });

/** Plan 210: a closed row's place in its table's history order: when it closed, then its id. */
export interface ClosedAt {
  at: number;
  id: number;
}

export interface DatedStore {
  marks: {
    /** oldest first, by the message's date */
    page(after: { arrivedAt: number; messageId: number } | null, limit: number): Promise<DatedMark[]>;
    count(): Promise<number>;
    /** the 14-day check: what the user agreed to; idempotent on the message */
    queueScan(messageIds: readonly number[], now: number): Promise<number>;
    /** read and found nothing to do, or never to be read */
    consume(messageId: number): Promise<void>;
    clear(): Promise<void>;
    /** live marks past `DATED_MARK_MS`, scan marks past `DATED_SCAN_MARK_MS` */
    prune(now: number): Promise<number>;
  };
  /** received mail since then a check could read, newest first: inbound, not a draft, sent, spam or trash, not from the user, not already marked or read */
  scanCandidates(since: number, limit: number): Promise<number[]>;
  source(messageId: number): Promise<DatedSource | null>;
  /**
   * open items a message could settle: its thread's and its sender's (a delivery or an ask only its thread's: the sixth panel
   * round), from messages older than it, newest first, at most `limit`
   */
  openFor(o: { threadId: number; senderKey: string; before: number; limit: number }): Promise<DatedRow[]>;
  /**
   * Results, settlements and consuming the mark, in one commit that checks the clear generation and the source (revision 6).
   * Plan 210: rows with no `ask` or `respond` at `DATED_NOTHING_ASKED_SINCE` or later also record the message as read with
   * nothing asked of the reader (`dated_nothing_asked`), in the same commit.
   */
  finish(write: DatedFinish): Promise<DatedFinishOutcome>;
  /** open, by `act_at`, at most `DATED_ACTIVE_MAX` */
  active(): Promise<DatedRow[]>;
  ofThread(threadId: number): Promise<DatedRow[]>;
  /**
   * Plan 210: closed rows (done, dismissed, settled) closed since `since`, newest first by `(closed_at, id)`, strictly after
   * `after`, at most `limit`: what What matters' history pages through (an index by closing time, both stores).
   */
  closedPage(o: { since: number; after: ClosedAt | null; limit: number }): Promise<DatedRow[]>;
  /** Plan 210: each of these threads' newest closing since `since` (by `(closed_at, id)`), by thread; none, not in the map */
  newestClosed(threadIds: readonly number[], since: number): Promise<Map<number, ClosedAt>>;
  /**
   * The senders among these (`addressKey`s) the user has written to (plan 17's correspondents), by key: one indexed
   * lookup each. After the fourth panel round, a sender named like a security desk you correspond with is trusted.
   */
  written(senderKeys: readonly string[]): Promise<Set<string>>;
  get(id: number): Promise<DatedRow | null>;
  /**
   * a change by the user, conditional on the revision they saw; with `schedule`, also on the day it was decided on (a move
   * keeps the revision, so retiring what's over checks the day hasn't moved since: Codex review, round 2)
   */
  update(id: number, revision: number, patch: Partial<Pick<DatedRow, "state" | "deferredUntil" | "closedReason" | "closedAt">>, schedule?: { dueDay: string; dueAt: number }): Promise<DatedSnapshot | null>;
  /** Undo: each row only if nothing else changed it since */
  restore(rows: readonly { snapshot: DatedSnapshot; expectRevision: number }[]): Promise<number>;
  /** closed rows past `DATED_CLOSED_KEEP_MS`, and "nothing asked" of mail older than the waiting window (`waitingCutoff`) */
  prune(now: number): Promise<number>;
  /** Clear AI data: rows, marks and what was read with nothing asked; ups the generation */
  clear(): Promise<void>;
  clearGeneration(): number;
}
