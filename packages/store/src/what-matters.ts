import type { DatedKind, DatedRow, PreferenceVerdict, PreferencesDraft, WhatMattersPreferences } from "@terno/core";

/**
 * Plan 248: What matters, in the user's own words, as both stores keep it.
 *
 * - The record (`whatMatters:preferences`, the small values): the words, their compiled rules and notes, a revision. Written
 *   only through `preferences.save`, one transaction that checks the revision (the Codex review's revision 3). The draft is
 *   its own key, versioned by `seq`, so a late debounced write never touches the saved words.
 * - `preference_verdicts`: which semantic rules apply to a row, against the basis (the semantic rules' keys) they were
 *   judged on, keyed by the row and its revision (revision 8). Bounded; kept through Clear (Undo brings the same basis back).
 * - `wanted_items`: what a show rule brought, apart from `dated_items` (revision 1: v16's reader reads that table as
 *   evidence). Shown while any of its `rules` is a current show rule; bounded and pruned on their own.
 * - `wanted_marks`: messages the words admitted, for the second reader (revision 10), live or from the look back.
 *
 * Workers' writes carry the revision they started from, and the store refuses them in their own transaction when the
 * record has moved on.
 */

export const PREFERENCES_KEY = "whatMatters:preferences";
export const PREFERENCES_DRAFT_KEY = "whatMatters:preferencesDraft";
/** revision 9: 1,000 items, 1,000 promises, 2,000 waiting, and history */
export const PREFERENCE_VERDICTS_MAX = 6000;
/** open wanted items kept at most: past it, a new one isn't added (never one dropped for it) */
export const WANTED_OPEN_MAX = 300;
export const WANTED_MARK_MS = 3 * 86_400_000;
export const WANTED_LOOK_MARK_MS = 14 * 86_400_000;
/** a look back reads at most this many messages */
export const WANTED_LOOK_MAX = 300;
/** a wanted item none of whose rules is current any more is kept this long (an Undo, an edit back) */
export const WANTED_ORPHAN_KEEP_MS = 30 * 86_400_000;
export const WANTED_CLOSED_KEEP_MS = 90 * 86_400_000;

export type WantedState = "open" | "done" | "dismissed";

export interface WantedRow {
  id: number;
  threadId: number;
  messageId: number;
  kind: DatedKind;
  text: string;
  quote: string;
  senderKey: string;
  dueDay: string;
  dueAt: number;
  timed: boolean;
  dated: boolean;
  actAt: number;
  deferredUntil: number | null;
  arrivedAt: number;
  state: WantedState;
  closedReason: string | null;
  closedAt: number | null;
  /** the show rules (keys) that brought it: shown while any is current */
  rules: string[];
  /** when none of its rules was current any more (pruned `WANTED_ORPHAN_KEEP_MS` after); null while one is */
  orphanedAt: number | null;
  fromLook: boolean;
  revision: number;
  model: string | null;
  provider: string | null;
  promptVersion: number | null;
  createdAt: number;
}

export interface WantedWrite {
  kind: DatedKind;
  text: string;
  quote: string;
  dueDay: string;
  dueAt: number;
  timed: boolean;
  dated: boolean;
  actAt: number;
  rules: string[];
}

export interface WantedFinish {
  messageId: number;
  threadId: number;
  senderKey: string;
  arrivedAt: number;
  rows: WantedWrite[];
  now: number;
  model: string | null;
  provider: string | null;
  promptVersion: number;
  fromLook: boolean;
  /** the record's revision the reading started from: a moved one keeps nothing (the mark stays for the next pass) */
  revision: number;
}

export interface WantedMark {
  messageId: number;
  threadId: number;
  arrivedAt: number;
  queuedAt: number;
  source: "live" | "look";
}

/** A message the look back may admit: what the local filter reads, no body. */
export interface WantedLookCandidate {
  id: number;
  threadId: number;
  accountId: number;
  subject: string;
  fromName: string;
  fromEmail: string;
  date: number;
}

export type WantedPatch = Partial<Pick<WantedRow, "state" | "deferredUntil" | "closedReason" | "closedAt">>;
export type WantedSnapshot = Pick<WantedRow, "id" | "revision" | "state" | "deferredUntil" | "closedReason" | "closedAt">;

/**
 * A wanted item as the projection places it: a `DatedRow` whose id is negative (`-id`), so it never meets one of v16's ids,
 * is never linked, answered or merged (the projection adds it after reconciling links), and routes its acts here.
 */
export function wantedAsDated(w: WantedRow): DatedRow {
  return {
    id: -w.id,
    threadId: w.threadId,
    messageId: w.messageId,
    item: 0,
    kind: w.kind,
    text: w.text,
    quote: w.quote,
    senderKey: w.senderKey,
    dueDay: w.dueDay,
    dueAt: w.dueAt,
    timed: w.timed,
    dated: w.dated,
    actAt: w.actAt,
    deferredUntil: w.deferredUntil,
    arrivedAt: w.arrivedAt,
    state: w.state,
    closedReason: w.closedReason,
    closedAt: w.closedAt,
    fromScan: w.fromLook,
    revision: w.revision,
    model: w.model,
    provider: w.provider,
    createdAt: w.createdAt,
    wanted: true,
  };
}

export const isWantedId = (id: number): boolean => id < 0;

export interface WhatMattersStore {
  preferences: {
    /** `NO_PREFERENCES` when nothing was ever saved */
    get(): Promise<WhatMattersPreferences>;
    /** the record as `next`, at `expect + 1`; null when the stored revision isn't `expect` (another window saved) */
    save(next: Omit<WhatMattersPreferences, "revision">, expect: number): Promise<WhatMattersPreferences | null>;
    draft: {
      get(): Promise<PreferencesDraft | null>;
      /** false: a newer `seq` is stored */
      put(draft: PreferencesDraft): Promise<boolean>;
    };
  };
  verdicts: {
    get(targets: readonly string[]): Promise<Map<string, PreferenceVerdict & { failed: boolean }>>;
    /** false: the record's revision isn't `expect` any more (nothing written) */
    put(rows: readonly (PreferenceVerdict & { failed?: boolean })[], expect: number): Promise<boolean>;
    /** to `max`: other bases first, then the oldest not in `keep`; the number removed */
    prune(basis: string, keep: ReadonlySet<string>, max?: number): Promise<number>;
    clear(): Promise<void>;
  };
  wanted: {
    /** open items, by `act_at` */
    active(): Promise<WantedRow[]>;
    get(id: number): Promise<WantedRow | null>;
    ofThread(threadId: number): Promise<WantedRow[]>;
    /**
     * The second reader's one commit: the rows (deduplicated by message, kind, day and quote; a duplicate adds its rules to
     * the one there), the mark consumed. "stale": the revision moved (the mark stays); "gone": no mark (cleared or taken).
     */
    finish(w: WantedFinish): Promise<"written" | "stale" | "gone">;
    /** each change at its revision, all or none: the rows as they were (for Undo), or null when one changed */
    act(changes: readonly { id: number; revision: number; patch: WantedPatch }[]): Promise<WantedSnapshot[] | null>;
    /** an act's Undo: each back as it was, at the revision the act left (none when one changed since) */
    restore(before: readonly WantedSnapshot[]): Promise<boolean>;
    /**
     * Keeps `orphanedAt` in step with the rules now current (set when none of an item's is, cleared when one is again), and
     * drops orphans past `WANTED_ORPHAN_KEEP_MS` and closed items past `WANTED_CLOSED_KEEP_MS`; the number removed.
     */
    reconcile(current: ReadonlySet<string>, now: number): Promise<number>;
    clear(): Promise<void>;
    marks: {
      /** idempotent per message; false when it was there already */
      add(m: Omit<WantedMark, "queuedAt">, now: number): Promise<boolean>;
      /** newest first within a source, live before the look back */
      page(limit: number): Promise<WantedMark[]>;
      consume(messageId: number): Promise<void>;
      /** live marks past `WANTED_MARK_MS`, look marks past `WANTED_LOOK_MARK_MS` */
      prune(now: number): Promise<number>;
      /** the look back's marks (a new Save without show rules, Clear) */
      clearLook(): Promise<void>;
      count(source?: WantedMark["source"]): Promise<number>;
    };
    /**
     * The look back's walk (revision 10): received mail since `from`, newest first, at most `walk`, whatever its tab and
     * whether v16 noted something in it; not Spam, Trash, a draft, sent or the user's own. No body.
     */
    lookCandidates(from: number, walk: number): Promise<WantedLookCandidate[]>;
  };
}
