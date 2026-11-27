import { ATTACHMENT_CHUNK, MAX_ATTACHMENT_BYTES, MAX_MIME_BYTES, attachmentFilename, attachmentMessageBudgetAsync, base64Bytes, browserPreviewType, bytesBase64, opensInPlace, type AttachmentRef } from "@terno/core";
import { t } from "@terno/i18n";
import { create } from "zustand";
import { textToHtmlChunks } from "@terno/richtext/quote";
import { getApp, useApp } from "~/state/app";
import { mergeAttachmentRefs } from "./compose-fields";
import { client } from "~/rpc/connection";
import { beginDraftWork, editDraft, fieldsOf, flushDraft, materialize, sendBody, sendHtml, useDrafts, type DraftFields, type LocalDraft } from "./drafts";
import { formatBytes } from "./format";
import { gmailRefusal } from "./gmail-attachments";
import { outOfText } from "./inline-images";
import { snack } from "./snack";

/** plan 76: drops waiting their turn, by draft (Send waits for them as for a staging) */
const queued = new Map<string, Promise<unknown>>();
/** `keys`: staging now; `waiting`: dropped, being prepared or waiting their turn */
export const useAttachmentUploads = create<{ keys: Set<string>; waiting: Set<string> }>(() => ({ keys: new Set(), waiting: new Set() }));
export const attachmentUploading = (key: string) => useAttachmentUploads.getState().keys.has(key) || queued.has(key);
/** The same as `attachmentUploading`, for a component to follow (Send's look, the strip). */
export const useFilesOnTheirWay = (key: string): boolean => useAttachmentUploads((s) => s.keys.has(key) || s.waiting.has(key));

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

/**
 * Stages files into the draft. Plan 76: a file given a content ID is an
 * image placed in the text; `placed` runs with the adopted refs (in file
 * order) before the draft is saved, to put them there. Whether it was adopted.
 */
export async function attachFiles(key: string, files: readonly File[], o: { contentIds?: readonly (string | null)[]; placed?: (refs: AttachmentRef[]) => void } = {}): Promise<boolean> {
  const finish = beginDraftWork();
  if (!finish) return false;
  try { return await attachFilesNow(key, files, o); } finally { finish(); }
}

/** plan 76: drops wait their turn (one staging per draft at a time) rather than being refused */
const idle = (key: string) => new Promise<void>((resolve) => {
  if (!useAttachmentUploads.getState().keys.has(key)) return resolve();
  const stop = useAttachmentUploads.subscribe((s) => { if (!s.keys.has(key)) { stop(); resolve(); } });
});
/** Files may still be being prepared (an image scaled down): the draft counts as adding files from the drop on, so Send waits for them. */
export function attachFilesInTurn(key: string, files: readonly File[] | Promise<{ files: readonly File[]; o?: Parameters<typeof attachFiles>[2] }>, o: Parameters<typeof attachFiles>[2] = {}): Promise<boolean> {
  const ready = Array.isArray(files) ? Promise.resolve({ files, o }) : (files as Promise<{ files: readonly File[]; o?: Parameters<typeof attachFiles>[2] }>);
  // the drop is draft work from now on (a quit or a store switch waits for it), not only once its staging starts
  const finish = beginDraftWork();
  if (!finish) return Promise.resolve(false);
  const run = (queued.get(key) ?? Promise.resolve()).then(() => idle(key)).then(async () => { const r = await ready; return attachFiles(key, r.files, r.o); }).finally(finish);
  const tail = run.catch(() => false);
  queued.set(key, tail);
  if (!useAttachmentUploads.getState().waiting.has(key)) useAttachmentUploads.setState((s) => ({ waiting: new Set([...s.waiting, key]) }));
  void tail.then(() => {
    if (queued.get(key) !== tail) return;
    queued.delete(key);
    useAttachmentUploads.setState((s) => ({ waiting: new Set([...s.waiting].filter((k) => k !== key)) }));
  });
  return run;
}

async function attachFilesNow(key: string, files: readonly File[], o: { contentIds?: readonly (string | null)[]; placed?: (refs: AttachmentRef[]) => void }): Promise<boolean> {
  const draft = materialize(key);
  if (!draft || draft.sending || draft.recovery || useAttachmentUploads.getState().keys.has(key) || !files.length) return false;
  if (!getApp().accounts.some((a) => a.id === draft.accountId)) { snack.error(t("errors.accountGone")); return false; }
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
    // plan 293 (CASA 5.2.1): on a Gmail account, a file Gmail won't send (its type, an archive holding one, a protected
    // archive, a program by its content) is said and left out; the others still attach, each with its own content id
    // (one file at a time, and none when the batch is past what a message carries: it's refused for its size below, and
    // opening every archive of a refused batch at once could take more memory than the window has; Codex code review #3)
    const total = files.reduce((n, f) => n + f.size, 0);
    if (getApp().accounts.find((a) => a.id === draft.accountId)?.kind === "gmail" && total <= MAX_ATTACHMENT_BYTES) {
      const refusals: (string | null)[] = [];
      for (const f of files) refusals.push(await gmailRefusal(f));
      if (refusals.some(Boolean)) {
        snack.error(refusals.filter(Boolean).join(" "));
        const kept = files.flatMap((_, i) => (refusals[i] ? [] : [i]));
        const placed = o.placed;
        files = kept.map((i) => files[i]!);
        o = {
          ...(o.contentIds && { contentIds: kept.map((i) => o.contentIds![i] ?? null) }),
          // the caller's placement reads refs by its own files' places: each staged ref goes back to its file's (Codex code review #6)
          ...(placed && { placed: (refs: AttachmentRef[]) => {
            const aligned: AttachmentRef[] = [];
            refs.forEach((r, k) => { aligned[kept[k]!] = r; });
            placed(aligned);
          } }),
        };
        if (!files.length) return false;
      }
    }
    // plan 76: one file mail can't carry at all is named, with the limit (nothing to remove would help)
    const huge = files.find((f) => f.size > MAX_ATTACHMENT_BYTES);
    if (huge) throw new Error(t("attachments.fileTooLarge", { name: huge.name, size: formatBytes(huge.size), limit: formatBytes(MAX_ATTACHMENT_BYTES) }));
    const signature = getApp().accounts.find((a) => a.id === draft.accountId)?.signature;
    const contentId = (i: number) => o.contentIds?.[i] ?? null;
    const incoming = files.map((f, i) => ({ assetId: "", filename: f.name, mime: f.type || "application/octet-stream", size: f.size, contentId: contentId(i) }));
    // plan 76: images taken out of the text are kept for Undo, until a drop needs their room
    const spare = outOfText(draft.attachments ?? [], materialize(key)?.bodyHtml);
    if (spare.length && !await draftAttachmentBudget({ ...fieldsOf(draft), attachments: [...(draft.attachments ?? []), ...incoming] }, signature)) {
      editDraft(key, { attachments: (current(true).attachments ?? []).filter((a) => !spare.some((x) => x.assetId === a.assetId)) });
    }
    // plan 76: typing while the budget is checked doesn't refuse the files: it is checked again against what is there now
    const admitted = await settledBudget(() => current(true), (d) => draftAttachmentBudget({ ...fieldsOf(d), attachments: [...(d.attachments ?? []), ...incoming] }, getApp().accounts.find((a) => a.id === d.accountId)?.signature ?? signature));
    if (!admitted) throw new Error(t("attachments.tooLarge"));
    for (const [i, file] of files.entries()) {
      current();
      const ref = await client.call("attachments.create", { accountId: draft.accountId, filename: file.name, mime: file.type || "application/octet-stream", size: file.size, ...(contentId(i) ? { contentId: contentId(i) } : {}) });
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
    const fits = await settledBudget(() => current(true), (d) => draftAttachmentBudget({ ...fieldsOf(d), attachments: mergeAttachmentRefs(d.attachments ?? [], staged) }, getApp().accounts.find((a) => a.id === d.accountId)?.signature));
    if (!fits) throw new Error(t("attachments.tooLarge"));
    const live = current(true);
    if (!editDraft(key, { attachments: mergeAttachmentRefs(live.attachments ?? [], staged) })) throw new Error(t("attachments.unavailable"));
    adopted = true;
    o.placed?.(staged);
    await flushDraft(key);
    return true;
  } catch (error) {
    if (!adopted) for (const ref of staged) {
      if (Object.values(useDrafts.getState().drafts).some((d) => d.attachments?.some((a) => a.assetId === ref.assetId))) continue;
      await client.call("attachments.discard", { accountId: draft.accountId, assetId: ref.assetId }).catch(() => {});
    }
    if (useDrafts.getState().drafts[key]) snack.error(error instanceof Error ? error.message : t("attachments.unavailable"));
    return adopted;
  } finally {
    unsubscribe();
    unsubscribeAccount();
    useAttachmentUploads.setState((s) => { const keys = new Set(s.keys); keys.delete(key); return { keys }; });
  }
}

/**
 * A budget check that holds for the draft as it is when it ends: one whose
 * body, files or signature changed meanwhile (the user typing) runs again on
 * the new one, a few times; a draft that keeps changing faster is refused.
 */
async function settledBudget(read: () => LocalDraft, check: (d: LocalDraft) => Promise<boolean>): Promise<boolean> {
  const same = (a: LocalDraft, b: LocalDraft) => a.localRev === b.localRev && a.bodyVersion === b.bodyVersion && a.bodyText === b.bodyText && a.bodyHtml === b.bodyHtml && a.attachments === b.attachments && a.accountId === b.accountId;
  const signatureOf = (d: LocalDraft) => getApp().accounts.find((a) => a.id === d.accountId)?.signature;
  for (let attempt = 0; attempt < 5; attempt++) {
    const before = read();
    const signature = signatureOf(before);
    const ok = await check(before);
    const after = read();
    if (same(before, after) && signatureOf(after) === signature) return ok;
  }
  throw new Error(t("attachments.unavailable"));
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
  saveBlob(await attachmentBlob(accountId, ref), ref.filename);
}

/** Bytes this page holds saved as a file, where downloads go (an attachment, plan 272's original) */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = attachmentFilename(filename);
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Plan 212: whether choosing this file opens it rather than downloading it. The desktop app hands a document to the OS
 * (a shell without that bridge downloads: Electron denies pop-ups); the web build shows a PDF or an image in a tab.
 */
export function canOpenAttachment(filename: string): boolean {
  const desktop = window.ternoDesktop;
  if (desktop) return typeof desktop.openAttachment === "function" && opensInPlace(filename);
  return browserPreviewType(filename) !== null;
}

/** An open that didn't happen: what's shown offers the download instead (plan 212). */
export class AttachmentOpenFailed extends Error {
  constructor(name: string) { super(t("attachments.openFailed", { name })); }
}

/** the web build's last few preview URLs: a tab left open keeps working (save, print), and memory stays bounded */
const PREVIEWS_KEPT = 3;
const previews: string[] = [];

/**
 * Opens a file `canOpenAttachment` said yes to. Call it straight from the click or the menu item: the web build
 * reserves its tab before anything is awaited, so no pop-up blocker stands in the way. "busy": the desktop app is
 * already opening one. Throws, with what to do next, when it couldn't.
 */
export function openAttachment(accountId: number, ref: AttachmentRef): Promise<"opened" | "downloaded" | "busy"> {
  const desktop = window.ternoDesktop?.openAttachment;
  if (desktop) return openOnDesktop(desktop, accountId, ref);
  const type = browserPreviewType(ref.filename);
  const tab = type ? window.open("", "_blank") : null;
  // blocked (or nothing a browser shows): a download instead
  if (!tab || !type) return downloadAttachment(accountId, ref).then(() => "downloaded" as const);
  tab.opener = null;
  return openInTab(tab, type, accountId, ref);
}

async function openOnDesktop(open: NonNullable<NonNullable<Window["ternoDesktop"]>["openAttachment"]>, accountId: number, ref: AttachmentRef): Promise<"opened" | "busy"> {
  const failed = () => new AttachmentOpenFailed(ref.filename);
  const blob = await attachmentBlob(accountId, ref).catch(() => { throw failed(); });
  const { status } = await open(ref.filename, await blob.arrayBuffer()).catch(() => ({ status: "failed" as const }));
  if (status === "failed") throw failed();
  return status;
}

async function openInTab(tab: Window, type: string, accountId: number, ref: AttachmentRef): Promise<"opened"> {
  let blob: Blob;
  try { blob = await attachmentBlob(accountId, ref); } catch { tab.close(); throw new AttachmentOpenFailed(ref.filename); }
  // closed while the bytes came: nothing more to do
  if (tab.closed) return "opened";
  // the type is the extension's, never the message's: a blob URL shares the app's origin
  const url = URL.createObjectURL(new Blob([blob], { type }));
  previews.push(url);
  while (previews.length > PREVIEWS_KEPT) URL.revokeObjectURL(previews.shift()!);
  tab.location.replace(url);
  return "opened";
}
