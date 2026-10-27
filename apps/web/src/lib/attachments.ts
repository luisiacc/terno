import { ATTACHMENT_CHUNK, MAX_ATTACHMENT_BYTES, MAX_MIME_BYTES, attachmentFilename, attachmentMessageBudgetAsync, base64Bytes, bytesBase64, type AttachmentRef } from "@terno/core";
import { t } from "@terno/i18n";
import { create } from "zustand";
import { textToHtmlChunks } from "@terno/richtext/quote";
import { getApp, useApp } from "~/state/app";
import { mergeAttachmentRefs } from "./compose-fields";
import { client } from "~/rpc/connection";
import { editDraft, fieldsOf, flushDraft, materialize, sendBody, sendHtml, useDrafts, type DraftFields } from "./drafts";
import { snack } from "./snack";

export const useAttachmentUploads = create<{ keys: Set<string> }>(() => ({ keys: new Set() }));
export const attachmentUploading = (key: string) => useAttachmentUploads.getState().keys.has(key);

/** Use the same body, quote, signature and MIME-envelope rules as Send. */
export async function draftAttachmentBudget(d: DraftFields, signature = ""): Promise<boolean> {
  const yieldTo = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const text = sendBody(d, signature);
  if (!await attachmentMessageBudgetAsync(text, undefined, d.attachments ?? [], yieldTo)) return false;
  let quotedHtml: string | undefined;
  if (d.bodyHtml && d.includeQuote && d.quotedText) {
    const pieces: string[] = [];
    let length = 0;
    for (const piece of textToHtmlChunks(d.quotedText)) {
      length += piece.length;
      // Each character needs at least one byte, before the MIME envelope is added.
      if (length > MAX_MIME_BYTES) return false;
      pieces.push(piece);
      await yieldTo();
    }
    quotedHtml = pieces.join("");
  }
  return attachmentMessageBudgetAsync(text, d.bodyHtml ? sendHtml(d.bodyHtml, d, signature, quotedHtml) : undefined, d.attachments ?? [], yieldTo);
}

export async function attachFiles(key: string, files: readonly File[]): Promise<void> {
  const draft = materialize(key);
  if (!draft || draft.sending || draft.recovery || attachmentUploading(key) || !files.length) return;
  if (!getApp().accounts.some((a) => a.id === draft.accountId)) { snack.error(t("errors.accountGone")); return; }
  useAttachmentUploads.setState((s) => ({ keys: new Set([...s.keys, key]) }));
  const staged: AttachmentRef[] = [];
  let adopted = false, cancelled = false;
  let target = { id: draft.id, generation: draft.generation };
  const unsubscribe = useDrafts.subscribe((s) => {
    const live = s.drafts[key];
    if (!live || live.accountId !== draft.accountId || live.sending || live.recovery) { cancelled = true; return; }
    // The ordinary first save acknowledges this same logical draft, not a replacement.
    if (target.id === null && live.id !== null) target = { id: live.id, generation: live.generation };
    else if (live.id !== target.id || live.generation !== target.generation) cancelled = true;
  });
  const unsubscribeAccount = useApp.subscribe((s) => { if (!s.accounts.some((a) => a.id === draft.accountId)) cancelled = true; });
  const current = (readBody = false) => {
    const live = readBody ? materialize(key) : useDrafts.getState().drafts[key];
    if (cancelled || !live || live.accountId !== draft.accountId || live.sending || live.recovery) throw new Error(t("attachments.unavailable"));
    return live;
  };
  try {
    const signature = getApp().accounts.find((a) => a.id === draft.accountId)?.signature;
    const incoming = files.map((f) => ({ assetId: "", filename: f.name, mime: f.type || "application/octet-stream", size: f.size }));
    const admitted = await draftAttachmentBudget({ ...fieldsOf(draft), attachments: [...(draft.attachments ?? []), ...incoming] }, signature);
    const latest = current(true);
    if (latest.localRev !== draft.localRev || latest.bodyText !== draft.bodyText || latest.bodyHtml !== draft.bodyHtml) throw new Error(t("attachments.unavailable"));
    if (!admitted) throw new Error(t("attachments.tooLarge"));
    for (const file of files) {
      current();
      const ref = await client.call("attachments.create", { accountId: draft.accountId, filename: file.name, mime: file.type || "application/octet-stream", size: file.size });
      staged.push(ref);
      current();
      for (let offset = 0, index = 0; offset < file.size; offset += ATTACHMENT_CHUNK, index++) {
        const bytes = new Uint8Array(await file.slice(offset, offset + ATTACHMENT_CHUNK).arrayBuffer());
        current();
        await client.call("attachments.append", { accountId: draft.accountId, assetId: ref.assetId, index, dataBase64: bytesBase64(bytes) });
        current();
      }
      await client.call("attachments.seal", { accountId: draft.accountId, assetId: ref.assetId });
      current();
    }
    const live = current(true);
    const attachments = mergeAttachmentRefs(live.attachments ?? [], staged);
    const signatureNow = getApp().accounts.find((a) => a.id === live.accountId)?.signature;
    const fits = await draftAttachmentBudget({ ...fieldsOf(live), attachments }, signatureNow);
    const final = current(true);
    if (final.localRev !== live.localRev || final.bodyVersion !== live.bodyVersion || final.bodyText !== live.bodyText || final.bodyHtml !== live.bodyHtml || getApp().accounts.find((a) => a.id === live.accountId)?.signature !== signatureNow) throw new Error(t("attachments.unavailable"));
    if (!fits) throw new Error(t("attachments.tooLarge"));
    editDraft(key, { attachments });
    adopted = true;
    await flushDraft(key);
  } catch (error) {
    if (!adopted) for (const ref of staged) {
      if (Object.values(useDrafts.getState().drafts).some((d) => d.attachments?.some((a) => a.assetId === ref.assetId))) continue;
      await client.call("attachments.discard", { accountId: draft.accountId, assetId: ref.assetId }).catch(() => {});
    }
    if (useDrafts.getState().drafts[key]) snack.error(error instanceof Error ? error.message : t("attachments.unavailable"));
  } finally {
    unsubscribe();
    unsubscribeAccount();
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
