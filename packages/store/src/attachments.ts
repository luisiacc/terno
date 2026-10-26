import { AttachmentLimitError } from "./attachment-repo";
import { ATTACHMENT_CHUNK, base64Bytes, bytesBase64, type AttachmentRef } from "@terno/core";
import type { MailStore } from "./mail-store";
import type { IncomingAttachment } from "./types";

/** Staging is separate from linking: a failed write never replaces a prior message/draft revision. */
export async function stageAttachments(store: MailStore, accountId: number, parts: readonly IncomingAttachment[], now: number, yieldTo: () => Promise<void>): Promise<IncomingAttachment[]> {
  const staged: IncomingAttachment[] = [];
  const created: string[] = [];
  try {
    for (const part of parts) {
      if (part.bytes === undefined) { staged.push(part); continue; }
      let ref: AttachmentRef;
      try { ref = await store.attachments.create({ ...part, size: part.bytes.byteLength, accountId, now }); }
      catch (error) {
        if (!(error instanceof AttachmentLimitError)) throw error;
        // Durable unavailable metadata keeps the body readable without repeatedly downloading quota-blocked bytes.
        const { bytes: _bytes, assetId: _id, ...metadata } = part;
        staged.push({ ...metadata, size: part.bytes.byteLength });
        continue;
      }
      created.push(ref.assetId);
      for (let offset = 0, i = 0; offset < part.bytes.length; offset += ATTACHMENT_CHUNK, i++) {
        await store.attachments.append(accountId, ref.assetId, i, bytesBase64(part.bytes.subarray(offset, offset + ATTACHMENT_CHUNK)));
        await yieldTo();
      }
      await store.attachments.seal(accountId, ref.assetId);
      staged.push({ ...ref, providerRef: part.providerRef });
    }
    return staged;
  } catch (error) {
    for (const id of created) await store.attachments.discard(accountId, id).catch(() => {});
    throw error;
  }
}

export async function attachmentData(store: MailStore, accountId: number, ref: AttachmentRef, yieldTo: () => Promise<void>): Promise<string> {
  const info = await store.attachments.info(accountId, ref.assetId);
  if (info.size !== ref.size || info.filename !== ref.filename || info.mime !== ref.mime || (info.contentId ?? null) !== (ref.contentId ?? null)) throw new Error("Attachment revision mismatch");
  const chunks: string[] = [];
  let size = 0;
  for (let i = 0; i < Math.ceil(ref.size / ATTACHMENT_CHUNK); i++) {
    const data = await store.attachments.read(accountId, ref.assetId, i);
    if (data === null) throw new Error("Attachment chunk missing");
    size += base64Bytes(data).byteLength;
    chunks.push(data);
    await yieldTo();
  }
  if (size !== ref.size) throw new Error("Attachment bytes missing");
  return chunks.join("");
}
