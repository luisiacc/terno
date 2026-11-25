/**
 * Plan 275: Focused Inbox's per-sender override (Graph's inferenceClassification overrides), an op of the account's,
 * not of messages: "always Focused" or "always Other" for one sender's future mail, and its undo (the override gone).
 */
export const CLASSIFY_SENDER = "classifySender";
export const UNCLASSIFY_SENDER = "unclassifySender";
export interface SenderClassificationPayload {
  /** the sender's SMTP address, lower case */
  address: string;
  /** classifySender: the rule asked for; unclassifySender: the rule its action made (only that one is taken back) */
  as?: "focused" | "other";
  /**
   * unclassifySender (code review #2): the sender's rule before the action: put back when there was one, the action's
   * deleted when there wasn't (null); absent: unknown (its read failed), so only a rule still the action's goes
   */
  prior?: "focused" | "other" | null;
}
/** the ops `ops.enqueueAccount` queues: an account's, naming no messages */
export const ACCOUNT_OPS: ReadonlySet<string> = new Set([CLASSIFY_SENDER, UNCLASSIFY_SENDER]);
