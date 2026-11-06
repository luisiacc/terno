import type { AiProviderId } from "./ai";
import type { Condition } from "./rules/schema";

/** Plan 143: a sentence that does something. What's planned, what's previewed, and nothing runs until Apply. */

export const ACTION_VERBS = ["archive", "trash", "spam", "markRead", "star"] as const;
export type ActionVerb = (typeof ACTION_VERBS)[number];

export type PlannedAction =
  | { type: ActionVerb }
  | { type: "moveToCategory"; categoryId: number }
  | { type: "createCategory"; name: string }
  | { type: "moveToFolder"; accountId: number; folder: string };

export interface ActionPlan {
  /** "Archive shipping notices older than a month, except Amazon" */
  summary: string;
  action: PlannedAction;
  conditions: Condition[];
  /** everywhere still leaves out Spam and Trash */
  lookIn: "inbox" | "everywhere";
  /** the sentence implies new mail too */
  future: boolean;
  /** the sentence names a meaning ("recruiters"), not literal words ("from ups.com") */
  meaning: boolean;
}

/** Whether "+ new mail too" can be offered, and why not. */
export type ActionKeep = { kind: "ok" } | { kind: "hidden" } | { kind: "disabled"; reason: "forwarding" | "exceptions" };

export interface ActionPreviewInfo {
  previewId: string;
  plan: ActionPlan;
  /** what Apply would act on now */
  count: number;
  /** starred or replied in: spared unless they're included */
  skipped: number;
  skippedIncluded: boolean;
  /** the model said these don't fit: unticked, at the end */
  leftOut: number;
  /** past what the check could look at: left out, and said */
  unchecked: number;
  check: "none" | "needed" | "done" | "skipped";
  keep: ActionKeep;
  /** what a saved filter would hold: the rule with the check's exceptions */
  keepConditions: Condition[];
  /** still finding: the count grows, and Apply waits */
  scanning: boolean;
  /** a category this files into is hidden from the Inbox */
  hidden: boolean;
  categoryName: string | null;
  /** a person's own request to a place that forwards: one-time, and it doesn't forward */
  forwards: boolean;
}

export type AiActionStart =
  /** Settings moved since the question was agreed */
  | { status: "consent"; provider: AiProviderId; endpoint: string | null; destination: string }
  | { status: "preview"; preview: ActionPreviewInfo }
  /** outside what a sentence may do */
  | { status: "refused" }
  | { status: "noCondition" }
  /** `done`: the rule found mail, all of it already as asked or in Spam or Trash */
  | { status: "noMatch"; summary: string; done?: number }
  | { status: "tooMany" };

export type AiActionCheck = { status: "consent"; provider: AiProviderId; endpoint: string | null; destination: string } | { status: "done"; preview: ActionPreviewInfo };

export type AiActionEvent = { previewId: string; preview: ActionPreviewInfo } | { previewId: string; ended: "tooMany" | "failed" };

export interface AiActionApplied {
  /** one Undo reverses it all */
  undoToken: string | null;
  done: number;
  /** changed since the preview, and left alone */
  changed: number;
  /** a thread starred or replied in since: spared */
  spared: number;
  /** it stopped partway: what committed stays, with its Undo */
  stopped: boolean;
  /** the mail moved, the filter didn't */
  filterFailed: boolean;
  filterSaved: boolean;
  /** a slice failed: what committed is kept */
  failed: boolean;
  conversationId: number | null;
}

/** Address literals never go in a check's groups, whichever field they're in (revision 8). */
export const redactAddresses = (text: string): string => text.replace(/(?:"[^"\n]*"|[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+)@(?:\[[^\]\n]*\]|[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*)/gu, "…");
