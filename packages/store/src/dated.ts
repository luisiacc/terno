import { addressKey, ANSWERED_KINDS, tabOfCode, type SettledHow, type DatedKind, type DatedMute, type DatedMuteOn, type DatedRow, type DatedState, type DatedWall, type PartOfDay } from "@terno/core";

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

/** A reading that records "nothing asked": the reader's verdict (`DatedFinish.nothingAsked`), a trusted prompt, and no request of the reader (`ask`, `respond`) among the rows. */
export const readNothingAsked = (w: Pick<DatedFinish, "rows" | "promptVersion" | "nothingAsked">): boolean =>
  w.nothingAsked === true && w.promptVersion != null && w.promptVersion >= DATED_NOTHING_ASKED_SINCE && !w.rows.some((r) => ANSWERED_KINDS.includes(r.kind));

export interface DatedMark {
  messageId: number;
  threadId: number;
  /** the message's own date: marks are read oldest first (revision 5) */
  arrivedAt: number;
  queuedAt: number;
  source: "live" | "scan";
  /** plan 239: 0, new mail and what came before it from its conversation or its sender; 1, the rest of a check */
  lane: 0 | 1;
}

/** Plan 239: where a page of marks starts after (`marks.page`): the last mark's lane, date and id. */
export interface MarkKey {
  lane: 0 | 1;
  arrivedAt: number;
  messageId: number;
}

/** Plan 239: a mark as a store reads it for ordering, with its message's sender (oldest first: `(arrivedAt, messageId)`). */
export type RawMark = Omit<DatedMark, "lane"> & { fromEmail: string | null };

/** Plan 239: where a chunk of raw marks starts after, in date order. */
export interface RawMarkKey {
  arrivedAt: number;
  messageId: number;
}

/**
 * Plan 239 (the owner: "lets do the new email first"): the marks in reading order, both stores. New mail first: every live
 * mark, and with it every mark joined to one by its conversation or its sender (`addressKey`, as the reader settles by),
 * through any chain of them (Codex review 1: A and B in one conversation, B and a live C from one sender), so what may settle
 * an item is still read after it (revision 5); then the rest of a check. `marks` come oldest first (the stores read them by
 * their date index), so each lane keeps that order: linear, no sort (the Codex code review: a queue of tens of thousands).
 */
export function markOrder(marks: readonly RawMark[]): DatedMark[] {
  // one set per chain: a mark's conversation and its sender are joined (union-find over numbered nodes), each address read once
  const node = new Map<string, number>();
  const parent: number[] = [];
  const of = (key: string): number => {
    let n = node.get(key);
    if (n === undefined) {
      node.set(key, (n = parent.length));
      parent.push(n);
    }
    return n;
  };
  const root = (x: number): number => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]!]!;
    return x;
  };
  const senders = new Map<string, string>();
  const threadOf = marks.map((m) => {
    const t = of(`t${m.threadId}`);
    if (m.fromEmail) {
      let key = senders.get(m.fromEmail);
      if (key === undefined) senders.set(m.fromEmail, (key = `s${addressKey(m.fromEmail)}`));
      const a = root(of(key));
      const b = root(t);
      if (a !== b) parent[a] = b;
    }
    return t;
  });
  const fresh = new Set<number>();
  marks.forEach((m, i) => m.source === "live" && fresh.add(root(threadOf[i]!)));
  const first: DatedMark[] = [];
  const rest: DatedMark[] = [];
  marks.forEach((m, i) => {
    const lane = fresh.has(root(threadOf[i]!)) ? 0 : 1;
    (lane === 0 ? first : rest).push({ messageId: m.messageId, threadId: m.threadId, arrivedAt: m.arrivedAt, queuedAt: m.queuedAt, source: m.source, lane });
  });
  return first.concat(rest);
}

/** `markOrder` strictly after a key, at most `limit` (a store's `page`). */
export function markPage(marks: readonly RawMark[], after: MarkKey | null, limit: number): DatedMark[] {
  const order = (a: MarkKey, b: MarkKey) => a.lane - b.lane || a.arrivedAt - b.arrivedAt || a.messageId - b.messageId;
  return markOrder(marks)
    .filter((m) => !after || order(m, after) > 0)
    .slice(0, limit);
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
  /** plan 210 (iteration 2): shown before its kind's lead (`DatedRow.early`); absent, not */
  early?: boolean;
  /** plan 210 (iteration 3): it lapses unless renewed (`DatedRow.lapses`); absent, not */
  lapses?: boolean;
  /** plan 210 (iteration 4, revision 11): the day the mail asked for it before (`DatedRow.before`); absent, none */
  before?: string | null;
  /**
   * plan 210 (iteration 4, revision 11): the event this ask confirms, as one of this message's own rows (its `item`): stored as
   * that row's id (`DatedRow.confirms`) when it's written in the same commit, else nothing (the ask is kept unlinked)
   */
  confirmsItem?: number;
  /** plan 210 (iteration 4, revision 10): the mail's own clock in another zone (`DatedRow.wall`); absent, none */
  wall?: DatedWall | null;
  /** plan 210 (iteration 5, revision 4): the part of its day it's asked for (`DatedRow.partOfDay`); absent, the whole day */
  partOfDay?: PartOfDay | null;
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
   * sender (the sixth panel round: a delivery or an ask only of its thread, `THREAD_SCOPED_KINDS`); `how`, what its mail
   * said happened (the claims ledger's second batch: "cancelled", "arrived"), its `closedReason`, else "settled"
   */
  settled: readonly { id: number; revision: number; how?: SettledHow }[];
  /**
   * After the panel: open items this message gives a new day. Applied to an open row it may reach (as `settled`) whatever its
   * revision (Codex review of the fixes: a Later meanwhile mustn't lose the mail's new day); it keeps its deferral. `text`:
   * its new words, in the same write (the fifth panel round); without it the words stay. Neither is in a snapshot, so an
   * Undo of a Later before or after keeps the move's day and words.
   */
  moved?: readonly {
    id: number;
    dueDay: string;
    dueAt: number;
    timed: boolean;
    actAt: number;
    text?: string;
    /** plan 210 (iteration 4): the day it's asked before, and the mail's own clock, at its new moment: absent or null, none (a move clears them) */
    before?: string | null;
    wall?: DatedWall | null;
    /** plan 210 (iteration 5, revision 4): the part of its new day: absent or null, the whole day (a move clears it) */
    partOfDay?: PartOfDay | null;
  }[];
  /**
   * The second panel round: promises of yours (plan 142's rows) this message gives a new day. Only at the revision the
   * reader saw (a Later or Done since wins), on this thread, still open or due; the revision bumps (an older Undo is
   * refused), and the promise is open again when its new moment is ahead.
   */
  movedPromises?: readonly {
    id: number;
    revision: number;
    dueAt: number;
    /**
     * plan 210 (iteration 2): its day as it was, when this message came after that day was over (it had been broken): kept
     * as the promise's first broken day (`FollowupRow.brokenDueAt`) unless it already has one. Null or absent: it wasn't
     */
    brokenDueAt?: number | null;
    /** plan 210 (iteration 2): `dueAt` is a time its words state (`FollowupRow.timed`) */
    timed?: boolean;
    /** plan 210 (iteration 4, revision 11): the day its person asked for it before (`FollowupRow.before`): absent or null, none */
    before?: string | null;
    /** plan 210 (iteration 5, revision 4): the part of its new day (`FollowupRow.partOfDay`): absent or null, the whole day */
    partOfDay?: PartOfDay | null;
  }[];
  /**
   * Plan 210 (iteration 3, the owner's "Close replaced promises"): promises of yours this message replaced with a new
   * request (`item`, one of this message's rows). Closed as `replaced` (dismissed) in this commit only when that request's
   * row is written, the promise still open or due at the revision the reader saw, on this thread, made to this message's
   * sender before it came; else left as it is.
   */
  replaced?: readonly { id: number; revision: number; item: number }[];
  now: number;
  model: string | null;
  provider: string | null;
  promptVersion: number | null;
  /**
   * Plan 210 (the Codex code review of iteration 2): the reader's verdict that this message asks nothing of the reader: the
   * model saw all of it (its subject and text, not cut to the window or the reader's limit, the body captured in full) and
   * the checks found no request of the reader, kept or not (a scan drops one already over). Only then is "nothing asked"
   * recorded (`readNothingAsked` also checks the rows); absent, the reading says nothing either way.
   */
  nothingAsked?: boolean;
  /**
   * Plan 210 (iteration 3, the Codex review's revision 1): follow-ups is on (since `since`, null: always). A request this
   * message gives (`ask`, `respond`) that a reply of yours already followed was never shown to the follow-ups reader: the
   * first few such replies (yours for certain, by Gmail's SENT label, to someone else, sent since then, not marked now) are
   * marked again, in this commit, for their verdict on it. Absent: follow-ups is off, and a reply decides nothing
   */
  replies?: { since: number | null };
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

/** Plan 210 (iteration 4): a mute's add: new, there already, or refused at `DATED_MUTES_MAX` (nothing evicted). */
export type DatedMuteAdded = "added" | "already" | "full";

export interface DatedStore {
  /**
   * Plan 210 (iteration 4, revision 2): senders and kinds not shown in What matters, keyed as `muteKey` normalizes them
   * (a key it refuses throws). `finish` reads them in its own commit: a muted sender's reading writes nothing and consumes
   * its mark ("gone"); a muted kind's rows aren't added, its settlements and moves are. Clear AI data keeps them.
   * Iteration 5: a `pair` (`pairKey`, one kind from one sender) is kept apart (`DATED_MUTE_PAIRS_MAX` its own bound) and
   * read by `finish` for its sender only: that kind's new rows from them aren't added; their reading, their other kinds,
   * settlements and moves are kept, and it never reaches Needs you's walk.
   */
  mutes: {
    /** newest first, every target together: at most `DATED_MUTES_MAX` senders and kinds and `DATED_MUTE_PAIRS_MAX` pairs */
    list(): Promise<DatedMute[]>;
    add(m: DatedMute): Promise<DatedMuteAdded>;
    /** the mute removed, or null if there was none */
    remove(on: DatedMuteOn, key: string): Promise<DatedMute | null>;
  };
  marks: {
    /**
     * plan 239: new mail first, then the rest, oldest first within each (`markPage`), strictly after `after`. Each call orders
     * the whole queue (the reader orders it from `raw`'s chunks instead)
     */
    page(after: MarkKey | null, limit: number): Promise<DatedMark[]>;
    /**
     * plan 239 (the Codex code review): the marks with their senders, oldest first, strictly after `after`, at most `limit`:
     * what the reader orders a pass by (`markOrder`), read in chunks so a long queue never holds the loop
     */
    raw(after: RawMarkKey | null, limit: number): Promise<RawMark[]>;
    count(): Promise<number>;
    /** the 14-day check (plan 211: the backend's, per account); idempotent on the message */
    queueScan(messageIds: readonly number[], now: number): Promise<number>;
    /** read and found nothing to do, or never to be read */
    consume(messageId: number): Promise<void>;
    clear(): Promise<void>;
    /** live marks past `DATED_MARK_MS`, scan marks past `DATED_SCAN_MARK_MS` */
    prune(now: number): Promise<number>;
    /**
     * Plan 210 (iteration 3): a message of this conversation from before `before` is still to be read: a reply of yours
     * after it waits for its requests (the follow-ups reader's verdict is on what's known)
     */
    pendingOn(threadId: number, before: number): Promise<boolean>;
    /**
     * Plan 210 (iteration 5, revision 3): the mark's one second look, claimed before it's asked: true the first time, false
     * once claimed or with no mark, so a failure, a retry or a restart never asks it again (the mark keeps the claim until
     * it's consumed)
     */
    claimLook(messageId: number, now: number): Promise<boolean>;
  };
  /**
   * an account's received mail since then a check could read, newest first: inbound, not a draft, sent, spam or trash, not
   * from the user, nothing read from it yet (plan 211: one account at a time, read through its own mail, never the box's;
   * what's marked stays in, so a check made again picks the same messages, which `queueScan` ignores)
   */
  scanCandidates(since: number, limit: number, accountId: number): Promise<number[]>;
  source(messageId: number): Promise<DatedSource | null>;
  /**
   * open items a message could settle: its thread's and its sender's (a delivery or an ask only its thread's: the sixth panel
   * round), from messages older than it, newest first, at most `limit`
   */
  /** plan 211: `excludeAccounts`' items never go with a request (another account's, the AI may not read), before the limit */
  openFor(o: { threadId: number; senderKey: string; before: number; limit: number; excludeAccounts?: readonly number[] }): Promise<DatedRow[]>;
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
  /** closed rows past `DATED_CLOSED_KEEP_MS` but a request a promise of yours answers (plan 210, iteration 3), and "nothing asked" of mail older than the waiting window (`waitingCutoff`) */
  prune(now: number): Promise<number>;
  /** Clear AI data: rows, marks and what was read with nothing asked; ups the generation */
  clear(): Promise<void>;
  clearGeneration(): number;
}
