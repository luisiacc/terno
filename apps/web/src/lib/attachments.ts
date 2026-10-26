import { ATTACHMENT_CHUNK, MAX_ATTACHMENT_BYTES, attachmentFilename, base64Bytes, bytesBase64, type AttachmentRef } from "@terno/core";
import { t } from "@terno/i18n";
import { create } from "zustand";
import { client } from "~/rpc/connection";
import { editDraft, flushDraft, useDrafts } from "./drafts";
import { snack } from "./snack";

export const useAttachmentUploads = create<{ keys: Set<string> }>(() => ({ keys: new Set() }));
export const attachmentUploading = (key: string) => useAttachmentUploads.getState().keys.has(key);

export async function attachFiles(key: string, files: readonly File[]): Promise<void> {
  const draft = useDrafts.getState().drafts[key];
  if (!draft || draft.sending || attachmentUploading(key) || !files.length) return;
  const current = draft.attachments ?? [];
  if (files.length + current.length > 100 || files.reduce((n, f) => n + f.size, current.reduce((n, f) => n + f.size, 0)) > MAX_ATTACHMENT_BYTES) { snack.error(t("attachments.tooLarge")); return; }
  useAttachmentUploads.setState((s) => ({ keys: new Set([...s.keys, key]) }));
  const staged: AttachmentRef[] = [];
  try {
    for (const file of files) {
      const ref = await client.call("attachments.create", { accountId: draft.accountId, filename: file.name, mime: file.type || "application/octet-stream", size: file.size });
      staged.push(ref);
      for (let offset = 0, index = 0; offset < file.size; offset += ATTACHMENT_CHUNK, index++) {
        const live = useDrafts.getState().drafts[key];
        if (!live || live.accountId !== draft.accountId || live.sending) throw new Error(t("attachments.unavailable"));
        const bytes = new Uint8Array(await file.slice(offset, offset + ATTACHMENT_CHUNK).arrayBuffer());
        await client.call("attachments.append", { accountId: draft.accountId, assetId: ref.assetId, index, dataBase64: bytesBase64(bytes) });
      }
      await client.call("attachments.seal", { accountId: draft.accountId, assetId: ref.assetId });
    }
    const live = useDrafts.getState().drafts[key];
    if (!live || live.accountId !== draft.accountId || live.sending) throw new Error(t("attachments.unavailable"));
    editDraft(key, { attachments: [...(live.attachments ?? []), ...staged] });
    await flushDraft(key);
  } catch (error) {
    for (const ref of staged) await client.call("attachments.discard", { accountId: draft.accountId, assetId: ref.assetId }).catch(() => {});
    if (useDrafts.getState().drafts[key]) snack.error(error instanceof Error ? error.message : t("attachments.unavailable"));
  } finally {
    useAttachmentUploads.setState((s) => { const keys = new Set(s.keys); keys.delete(key); return { keys }; });
  }
}

export async function attachmentBlob(accountId: number, ref: AttachmentRef): Promise<Blob> {
  const info = await client.call("attachments.info", { accountId, assetId: ref.assetId });
  if (info.size !== ref.size || info.mime !== ref.mime || info.filename !== ref.filename || info.size > MAX_ATTACHMENT_BYTES) throw new Error(t("attachments.unavailable"));
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  for (let index = 0; size < ref.size; index++) {
    const { dataBase64 } = await client.call("attachments.read", { accountId, assetId: ref.assetId, index });
    if (dataBase64 === null) throw new Error(t("attachments.unavailable"));
    const bytes = base64Bytes(dataBase64);
    if (!bytes.length || size + bytes.length > ref.size) throw new Error(t("attachments.unavailable"));
    chunks.push(new Uint8Array(bytes));
    size += bytes.length;
  }
  return new Blob(chunks, { type: ref.mime });
}

export async function downloadAttachment(accountId: number, ref: AttachmentRef): Promise<void> {
  const blob = await attachmentBlob(accountId, ref);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = attachmentFilename(ref.filename);
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
