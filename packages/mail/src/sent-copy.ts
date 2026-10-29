import { L, type Localized } from "@terno/i18n";
import type { SentCopyState } from "@terno/core";

export interface SentCopyHooks {
  prepare(raw: Uint8Array): Promise<Uint8Array>;
  accepted(warning?: Localized): Promise<void>;
  record(copy: SentCopyState, identity?: { mailbox: string; uidValidity?: string; uid?: number }): Promise<void>;
}

export function sentCopyWarning(copy: SentCopyState, warning?: Localized): Localized | undefined {
  if (copy === "saved") return warning;
  if (warning?.key === "errors.smtp.recipientOutcomeUnknown") return L(copy === "rejected" ? "errors.sentCopy.recipientUnknownMissing" : "errors.sentCopy.recipientUnknownCopy");
  const recipients = warning?.key === "errors.smtp.notDeliveredTo" ? warning.params?.recipients : undefined;
  if (typeof recipients === "string") return L(copy === "rejected" ? "errors.sentCopy.partialMissing" : "errors.sentCopy.partialUnknown", { recipients });
  return L(copy === "rejected" ? "errors.sentCopy.missing" : "errors.sentCopy.unknown");
}
