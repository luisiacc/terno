import { attachmentMessageBudget } from "@terno/core";
import type { MailStore } from "@terno/store";
import { attachmentData } from "@terno/store";
import { ProviderError, type SendPayload } from "@terno/mail/portable";
import { L } from "@terno/i18n";

/** Called only at dispatch, before provider execution; durable operation JSON stays as immutable refs. */
export async function hydrateSendAttachments(store: MailStore, accountId: number, payload: SendPayload, yieldTo: () => Promise<void>): Promise<SendPayload> {
  if (!attachmentMessageBudget(payload.text, payload.html, payload.attachments ?? [])) throw new ProviderError(L("attachments.tooLarge"), false);
  if (!payload.attachments?.length) return payload;
  try {
    const attachments = [];
    for (const ref of payload.attachments) attachments.push({ ...ref, dataBase64: await attachmentData(store, accountId, ref, yieldTo) });
    return { ...payload, attachments };
  } catch {
    // This is before submission. Even an I/O refusal keeps the captured snapshot failed and recoverable;
    // an automatic retry cannot repair missing local bytes and must not submit a smaller message.
    throw new ProviderError(L("attachments.unavailable"), false);
  }
}
