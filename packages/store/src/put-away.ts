import { ruleHash as ruleHashOf, type Placement, type PutAwayDetail, type ThreadSummary } from "@terno/core";

/** Plan 282: where a page of Put away ends: its order is Needs a look first, then newest first, then thread id. */
export interface PutAwayCursor {
  needsLook: boolean;
  at: number;
  threadId: number;
}

export interface PutAwayPage {
  items: { thread: ThreadSummary; placement: Placement }[];
  next: PutAwayCursor | null;
}

/** A sender the user keeps out of a category's automatic filing ("Don't file … automatically"), by the classifier's key. */
export interface KeptSender {
  categoryId: number;
  sender: string;
  at: number;
}

/** What "Don't file … automatically" took out of the category, for its Undo. */
export interface PutAwayWithdrawn {
  threadId: number;
  categoryId: number;
  addedAt: number;
  batchId: number | null;
  decision: { p: number; explainJson: string; at: number; outcome: string | null } | null;
}

/** A membership Back to Inbox took a conversation out of, whole, so Undo puts back exactly that row */
export interface PutAwayMembership {
  threadId: number;
  categoryId: number;
  addedBy: string;
  addedAt: number;
  batchId: number | null;
}

/** Plan 282: Put away, in both stores (the conformance suite holds them to the same answers). */
export interface PutAwayStore {
  /** The conversation's placement while its effect holds (in the window, not in Spam), with whether its rule is unchanged. */
  of(threadId: number, now: number): Promise<PutAwayDetail | null>;
  page(p: { now: number; after?: PutAwayCursor | null; limit: number }): Promise<PutAwayPage>;
  /** The Inbox's line: conversations needing a look placed after `after`; the newest one's sender; the newest `at` counted. */
  needsLook(p: { now: number; after: number }): Promise<{ count: number; first: { threadId: number; name: string } | null; through: number }>;
  /** Back to Inbox's half a thread action can't do: out of every category hidden from the Inbox (no example, no decision touched), the rows whole. */
  release(threadIds: readonly number[]): Promise<PutAwayMembership[]>;
  /** Undo of release: those rows back as they were (a conversation or category gone since stays gone) */
  refile(rows: readonly PutAwayMembership[]): Promise<void>;
  /** "Don't file {sender} automatically": the sender kept, and this conversation out of the category without an example. */
  keep(p: { categoryId: number; sender: string; threadId: number | null; now: number }): Promise<{ added: boolean; at: number; withdrawn: PutAwayWithdrawn | null }>;
  /** Undo of keep: only what it did (a kept row made since by another hand stays; a newer decision isn't replaced) */
  unkeep(p: { categoryId: number; sender: string; added: boolean; at: number; withdrawn: PutAwayWithdrawn | null }): Promise<void>;
  /** A rule's placements that still hold, newest first, at most 500 (Back to Inbox's bound): what Stop's second step brings back */
  byRule(filterId: number, now: number): Promise<{ threadId: number; at: number }[]>;
  kept(): Promise<KeptSender[]>;
  /** Settings: back to automatic filing */
  removeKept(categoryId: number, sender: string): Promise<boolean>;
}

// ───────────────────────────── shared by both stores' watches ─────────────────────────────

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** What one source did to a conversation in a command, waiting for its end to see whether it took the conversation out */
export interface PlacementNote {
  by: "rule" | "terno";
  effect: import("@terno/core").PlacementEffect;
  categoryId: number | null;
  /** the snapshot, without who the newest mail is from (read at the end, per conversation) */
  detail: DistributiveOmit<import("@terno/core").PlacementDetail, "fromName">;
}

/** A rule's action as a note, or null when it doesn't take mail out of the Inbox (or it's Spam: Spam triggers nothing). */
export function ruleNote(filter: import("@terno/core").Filter, action: import("@terno/core").FilterAction, hidden: ReadonlySet<number>): PlacementNote | null {
  const base = { by: "rule" as const, filterId: filter.id, name: clipText(filter.name), auto: filter.auto, source: filter.source, createdAt: filter.createdAt, ruleHash: ruleHashOf(filter.rule) };
  switch (action.type) {
    case "archive":
    case "trash":
      return { by: "rule", effect: action.type, categoryId: null, detail: { ...base, action: action.type } };
    case "moveToFolder":
      return { by: "rule", effect: "folder", categoryId: null, detail: { ...base, action: "moveToFolder", folder: action.folder } };
    case "addCategory":
      return hidden.has(action.categoryId) ? { by: "rule", effect: "category", categoryId: action.categoryId, detail: { ...base, action: "addCategory", categoryId: action.categoryId } } : null;
    default:
      return null;
  }
}

/**
 * Of what a command's sources did to one conversation, what explains it now (the notes that still hold, as the store
 * reads it at the command's end): where it went over what it was filed in (a place says more than a label), a rule over
 * the engine (the rule is the user's own word), and the last of equals.
 */
export function explainingNote(notes: readonly PlacementNote[], holds: (n: PlacementNote) => boolean): PlacementNote | null {
  let best: PlacementNote | null = null;
  for (const n of notes) if (holds(n) && (!best || rank(n) >= rank(best))) best = n;
  return best;
}
const rank = (n: PlacementNote) => (n.effect === "trash" ? 4 : n.effect === "folder" ? 3 : n.effect === "archive" ? 2 : n.by === "rule" ? 1 : 0);

/** Display text a snapshot keeps, bounded so it always reads back (core's schema caps them) */
export const clipText = (s: string): string => (s.length > 400 ? `${s.slice(0, 399)}…` : s);

