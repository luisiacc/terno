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
import { ATTACHMENT_CHUNK, base64Bytes, GMAIL_HEAD_BYTES, gmailBlocked, gmailNeedsWholeFile } from "@terno/core";
import { RpcError } from "@terno/core/rpc";

/**
 * Plan 293 (CASA 5.2.1): refuses a Gmail account's message carrying a file Gmail won't send (its help page's list, an
 * archive holding one, a protected archive, a program by its content), with the same plain words the composer uses.
 * Reads the sealed assets the request names (their first bytes; an archive's whole). Other accounts pass untouched.
 */
export async function assertGmailSendable(store: MailStore, accountId: number, refs: readonly import("@terno/core").AttachmentRef[] | undefined, yieldTo: () => Promise<void>): Promise<void> {
  if (!refs?.length || (await store.accounts.get(accountId))?.kind !== "gmail") return;
  for (const ref of refs) {
    const want = gmailNeedsWholeFile(ref.filename) ? ref.size : Math.min(ref.size, GMAIL_HEAD_BYTES);
    const parts: Uint8Array[] = [];
    let got = 0;
    for (let index = 0; got < want; index++) {
      const chunk = await store.attachments.read(accountId, ref.assetId, index);
      // a missing asset is the send path's own refusal (attachments.unavailable)
      if (chunk === null) break;
      const bytes = base64Bytes(chunk);
      if (!bytes.length) break;
      parts.push(bytes);
      got += bytes.length;
      await yieldTo();
    }
    const bytes = new Uint8Array(got);
    let at = 0;
    for (const p of parts) {
      bytes.set(p, at);
      at += p.length;
    }
    const block = await gmailBlocked(ref.filename, bytes);
    if (!block) continue;
    const name = ref.filename;
    const message = block.reason === "type" ? L("attachments.gmailBlocked.type", { name, ext: block.ext })
      : block.reason === "archive" ? L("attachments.gmailBlocked.archive", { name, ext: block.ext })
      : block.reason === "protected" ? L("attachments.gmailBlocked.protected", { name })
      : L("attachments.gmailBlocked.executable", { name });
    throw new RpcError("BAD_REQUEST", message, { reason: "gmailBlocked" });
  }
}
