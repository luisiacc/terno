import type { Address } from "./types";
import type { WritingChecks, WritingUsed } from "./writing/contract";

/** Plan 144: a reply prepared when a conversation that waits for one is opened. A cached suggestion, never a draft. */

export const REPLY_STATES = ["skipped", "failed", "ready", "dismissed", "used"] as const;
export type ReplyState = (typeof REPLY_STATES)[number];
export const REPLY_BODY_MAX = 20_000;
export const REPLY_BODIES_MAX = 200;
/** a decision outlives the words: evicting one would pay again, or bring a dismissed reply back (revision 8) */
export const REPLY_DECISIONS_MAX = 5000;

export interface PreparedReply {
  threadId: number;
  /** any change to the thread hides it */
  sourceStamp: string;
  /** recipients, signature, instructions, model: what the words also depend on (revision 7) */
  generationKey: string;
  answeringMessageId: number;
  state: ReplyState;
  body: string | null;
  used: WritingUsed | null;
  checks: WritingChecks | null;
  to: Address[];
  cc: Address[];
  model: string | null;
  provider: string | null;
  promptVersion: number | null;
  generatedAt: number;
  /** every change of state moves it: a stale window's action is refused */
  revision: number;
}

export interface RepliesSetting {
  enabled: boolean;
}

export type AiPrepareReply =
  /** nothing to show, and nothing was sent */
  | { status: "none" }
  /** the newest message's body isn't here yet: it goes on when it is */
  | { status: "waitingBody"; messageId: number }
  /** underway: `aiReply` says the rest */
  | { status: "started" }
  | { status: "ready"; row: PreparedReply };

export type AiReplyEvent = { threadId: number; phase: "writing"; text: string } | { threadId: number; phase: "ready"; row: PreparedReply } | { threadId: number; phase: "none" };

export type ReplyAction = "use" | "restore" | "dismiss" | "undismiss";
