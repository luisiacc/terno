/**
 * Plan 275: Focused Inbox's per-sender override (Graph's inferenceClassification overrides), an op of the account's,
 * not of messages: "always Focused" or "always Other" for one sender's future mail, and its undo (the override gone).
 */
export const CLASSIFY_SENDER = "classifySender";
export const UNCLASSIFY_SENDER = "unclassifySender";
export interface SenderClassificationPayload {
  /** the sender's SMTP address, lower case */
  address: string;
  /** classifySender only */
  as?: "focused" | "other";
}
/** the ops `ops.enqueueAccount` queues: an account's, naming no messages */
export const ACCOUNT_OPS: ReadonlySet<string> = new Set([CLASSIFY_SENDER, UNCLASSIFY_SENDER]);
