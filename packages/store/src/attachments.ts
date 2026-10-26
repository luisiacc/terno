import { AttachmentLimitError } from "./attachment-repo";
import { ATTACHMENT_CHUNK, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_COUNT, attachmentCid, attachmentFilename, attachmentMime, base64Bytes, bytesBase64, type AttachmentRef } from "@terno/core";
import type { MailStore } from "./mail-store";
import type { IncomingAttachment } from "./types";

/** Staging is separate from linking: a failed write never replaces a prior message/draft revision. */
export async function stageAttachments(store: MailStore, accountId: number, parts: readonly IncomingAttachment[], now: number, yieldTo: () => Promise<void>, previous: readonly IncomingAttachment[] = []): Promise<IncomingAttachment[]> {
  const staged: IncomingAttachment[] = [];
  const created: string[] = [];
  const verified = new Map<number, AttachmentRef>();
  const claimed = new Set<string>();
  let comparisonBytes = MAX_ATTACHMENT_BYTES * 2;
  const metadataKey = (part: IncomingAttachment, size: number) => JSON.stringify([size, attachmentFilename(part.filename), attachmentMime(part.mime), attachmentCid(part.contentId)]);
  const candidates = new Map<string, Map<string | null, IncomingAttachment[]>>();
  // Unavailable metadata is never a byte candidate. Read each eligible tail only once.
  for (const [position, prior] of previous.entries()) {
    if (position % 128 === 127) await yieldTo();
    if (!prior.assetId) continue;
    const key = metadataKey(prior, prior.size);
    let tails = candidates.get(key);
    if (!tails) candidates.set(key, tails = new Map());
    const tail = prior.size ? await store.attachments.read(accountId, prior.assetId, Math.ceil(prior.size / ATTACHMENT_CHUNK) - 1) : null;
    const bucket = tails.get(tail) ?? [];
    bucket.push(prior);
    tails.set(tail, bucket);
    await yieldTo();
  }
  // Candidate signatures select comparisons; only complete byte equality authorizes reuse.
  for (const [position, part] of parts.entries()) {
    if (position % 128 === 127) await yieldTo();
    if (part.bytes === undefined) continue;
    const tails = candidates.get(metadataKey(part, part.bytes.length));
    if (!tails) continue;
    const offset = Math.max(0, Math.ceil(part.bytes.length / ATTACHMENT_CHUNK) - 1) * ATTACHMENT_CHUNK;
    const tail = part.bytes.length ? bytesBase64(part.bytes.subarray(offset)) : null;
    for (const prior of tails.get(tail) ?? []) {
      if (claimed.has(prior.assetId!)) continue;
      // An incomplete comparison must never replace a still-downloadable prior revision.
      if (prior.size > comparisonBytes) return [...previous];
      let equal = true;
      for (let offset = 0, i = 0; offset < part.bytes.length; offset += ATTACHMENT_CHUNK, i++) {
        const slice = part.bytes.subarray(offset, offset + ATTACHMENT_CHUNK);
        const bytes = await store.attachments.read(accountId, prior.assetId!, i);
        comparisonBytes -= slice.length;
        const matches = bytes === bytesBase64(slice);
        await yieldTo();
        if (!matches) { equal = false; break; }
      }
      if (equal) {
        verified.set(position, await store.attachments.info(accountId, prior.assetId!));
        claimed.add(prior.assetId!);
        break;
      }
    }
  }
  let capturedBytes = [...verified.values()].reduce((n, ref) => n + ref.size, 0);
  let capturedCount = verified.size;
  try {
    for (const [position, part] of parts.entries()) {
      const reused = verified.get(position);
      if (reused) { staged.push({ ...reused, providerRef: part.providerRef }); continue; }
      if (part.bytes === undefined) { staged.push(part); continue; }
      let ref: AttachmentRef;
      try {
        if (capturedBytes + part.bytes.byteLength > MAX_ATTACHMENT_BYTES || capturedCount >= MAX_ATTACHMENT_COUNT) throw new AttachmentLimitError();
        ref = await store.attachments.create({ ...part, size: part.bytes.byteLength, accountId, now });
      } catch (error) {
        if (!(error instanceof AttachmentLimitError)) throw error;
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
      capturedBytes += ref.size;
      capturedCount++;
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
