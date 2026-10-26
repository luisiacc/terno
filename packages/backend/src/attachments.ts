import { attachmentMessageBudgetAsync } from "@terno/core";
import type { MailStore } from "@terno/store";
import { attachmentData } from "@terno/store";
import { ProviderError, type SendPayload } from "@terno/mail/portable";
import { L } from "@terno/i18n";

/** Called only at dispatch, before provider execution; durable operation JSON stays as immutable refs. */
export async function hydrateSendAttachments(store: MailStore, accountId: number, payload: SendPayload, yieldTo: () => Promise<void>): Promise<SendPayload> {
  if (typeof payload.text !== "string" || (payload.html !== undefined && typeof payload.html !== "string") || !await attachmentMessageBudgetAsync(payload.text, payload.html, payload.attachments ?? [], yieldTo)) throw new ProviderError(L("attachments.tooLarge"), false);
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

/** Export chunks stay bounded and portable; local opaque IDs never become import authority. */
export async function exportAttachment(store: MailStore, accountId: number, ref: import("@terno/core").AttachmentRef, yieldTo: () => Promise<void>): Promise<import("@terno/core/rpc").ExportedAttachment> {
  const info = await store.attachments.info(accountId, ref.assetId);
  const chunks: string[] = [];
  let bytes = 0;
  for (let i = 0; i < Math.ceil(info.size / ATTACHMENT_CHUNK); i++) {
    const chunk = await store.attachments.read(accountId, ref.assetId, i);
    if (chunk === null) throw new RpcError("BAD_REQUEST", L("attachments.unavailable"));
    bytes += base64Bytes(chunk).length;
    chunks.push(chunk);
    await yieldTo();
  }
  if (bytes !== info.size) throw new RpcError("BAD_REQUEST", L("attachments.unavailable"));
  return { filename: info.filename, mime: info.mime, size: info.size, contentId: info.contentId, chunks };
}

export async function validateExportedAttachments(parts: import("@terno/core/rpc").ExportedAttachment[], yieldTo: () => Promise<void>): Promise<void> {
  for (const part of parts) {
    let size = 0;
    if (part.chunks.length !== Math.ceil(part.size / ATTACHMENT_CHUNK)) throw new RpcError("BAD_REQUEST", L("attachments.invalidBackup"));
    for (const chunk of part.chunks) {
      const bytes = base64Bytes(chunk);
      if (bytes.length !== Math.min(ATTACHMENT_CHUNK, part.size - size)) throw new RpcError("BAD_REQUEST", L("attachments.invalidBackup"));
      size += bytes.length;
      await yieldTo();
    }
    if (size !== part.size) throw new RpcError("BAD_REQUEST", L("attachments.invalidBackup"));
  }
}

export async function importAttachments(store: MailStore, accountId: number, parts: import("@terno/core/rpc").ExportedAttachment[], now: number, yieldTo: () => Promise<void>) {
  const refs: import("@terno/core").AttachmentRef[] = [];
  try {
    for (const part of parts) {
      const ref = await store.attachments.create({ ...part, accountId, now });
      refs.push(ref);
      for (let i = 0; i < part.chunks.length; i++) { await store.attachments.append(accountId, ref.assetId, i, part.chunks[i]!); await yieldTo(); }
      await store.attachments.seal(accountId, ref.assetId);
    }
    return refs;
  } catch (error) {
    for (const ref of refs) await store.attachments.discard(accountId, ref.assetId).catch(() => {});
    throw error;
  }
}

export async function attachmentFingerprint(store: MailStore, accountId: number, ref: import("@terno/core").AttachmentRef, yieldTo: () => Promise<void>): Promise<string> {
  const part = await exportAttachment(store, accountId, ref, yieldTo);
  return portableAttachmentFingerprint(part, yieldTo);
}

export async function portableAttachmentFingerprint(part: import("@terno/core/rpc").ExportedAttachment, yieldTo: () => Promise<void>): Promise<string> {
  const bytes = new Uint8Array(part.size);
  let offset = 0;
  for (const chunk of part.chunks) { const data = base64Bytes(chunk); bytes.set(data, offset); offset += data.length; await yieldTo(); }
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
import { ATTACHMENT_CHUNK, base64Bytes } from "@terno/core";
import { RpcError } from "@terno/core/rpc";
