import type { OpInfo } from "@terno/core/rpc";

export function sendWarningTitle(op: Pick<OpInfo, "sentCopy" | "partialRecipients" | "recipientOutcomeUnknown">) {
  if (op.recipientOutcomeUnknown) return "actions.send.recipientUnknown";
  if (op.sentCopy && op.sentCopy !== "saved" && !op.partialRecipients) return "actions.send.copyWarning";
  return "actions.send.partial";
}
