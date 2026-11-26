import type { Placement, PutAwayDetail, ThreadSummary } from "@terno/core";

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
  decision: { p: number; explainJson: string; at: number; outcome: string | null } | null;
}

/** Plan 282: Put away, in both stores (the conformance suite holds them to the same answers). */
export interface PutAwayStore {
  /** The conversation's placement while its effect holds (in the window, not in Spam), with whether its rule is unchanged. */
  of(threadId: number, now: number): Promise<PutAwayDetail | null>;
  page(p: { now: number; after?: PutAwayCursor | null; limit: number }): Promise<PutAwayPage>;
  /** The Inbox's line: conversations needing a look placed after `after`; the newest one's sender; the newest `at` counted. */
  needsLook(p: { now: number; after: number }): Promise<{ count: number; first: { threadId: number; name: string } | null; through: number }>;
  /** Back to Inbox's half a thread action can't do: out of the hidden categories a rule filed them in (no example). */
  release(threadIds: readonly number[]): Promise<{ threadId: number; categoryId: number }[]>;
  /** Undo of release */
  refile(rows: readonly { threadId: number; categoryId: number }[], now: number): Promise<void>;
  /** "Don't file {sender} automatically": the sender kept, and this conversation out of the category without an example. */
  keep(p: { categoryId: number; sender: string; threadId: number | null; now: number }): Promise<{ added: boolean; withdrawn: PutAwayWithdrawn | null }>;
  /** Undo of keep */
  unkeep(p: { categoryId: number; sender: string; added: boolean; withdrawn: PutAwayWithdrawn | null }): Promise<void>;
  kept(): Promise<KeptSender[]>;
  /** Settings: back to automatic filing */
  removeKept(categoryId: number, sender: string): Promise<boolean>;
}
