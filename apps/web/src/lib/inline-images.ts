import type { AttachmentRef } from "@terno/core";
import { attachmentBlob } from "./attachments";

/**
 * Plan 76: images placed in a draft's text. Each is one of the draft's
 * attachments with a content ID of ours (terno-img-…@terno), named by the
 * text's <img src="cid:…">: it lives in the text, never as a chip, and is
 * left out of a send whose text no longer shows it. Ours by where it is,
 * not by its name alone: a forward of a mail Terno sent carries such parts
 * too, with no image in its text, and they stay files (chips, and sent).
 */

/** what the reader shows inline (lib/cid.ts): the rest attach */
const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif"]);
export const isInlineImage = (file: { type: string }): boolean => INLINE_TYPES.has(file.type.toLowerCase());

export const newImageCid = (): string => `terno-img-${crypto.randomUUID()}@terno`;
export const isOwnImage = (ref: Pick<AttachmentRef, "contentId">): boolean => /^terno-img-[0-9a-f-]+@terno$/.test(ref.contentId ?? "");

/** images an editor has shown in a text this session (taken out since, they may come back with Undo) */
const inText = new Set<string>();
export const markInText = (cid: string): void => void inText.add(cid);
const shownBy = (ref: AttachmentRef, html: string | undefined) => (html ?? "").includes(`cid:${ref.contentId}`);

/** The draft's files as chips: everything but the images in (or taken out of) its text. */
export const chipRefs = (refs: readonly AttachmentRef[], html: string | undefined): AttachmentRef[] =>
  refs.filter((r) => !isOwnImage(r) || !(inText.has(r.contentId!) || shownBy(r, html)));

/** Images taken out of the text (kept for Undo): not sent, and the first to go when a drop needs the room. */
export const outOfText = (refs: readonly AttachmentRef[], html: string | undefined): AttachmentRef[] =>
  refs.filter((r) => isOwnImage(r) && inText.has(r.contentId!) && !shownBy(r, html));

/** What a send carries: all but the images taken out of the text. */
export const sentRefs = (refs: readonly AttachmentRef[], html: string | undefined): AttachmentRef[] => {
  const out = new Set(outOfText(refs, html));
  return refs.filter((r) => !out.has(r));
};

/** A send's HTML without an image whose file isn't sent (one let go for room, then brought back by Undo). */
export function withSentImages(html: string, refs: readonly AttachmentRef[]): string {
  const sent = new Set(refs.map((r) => r.contentId));
  return html.replace(/<img src="cid:(terno-img-[0-9a-f-]+@terno)"[^>]*>/g, (img, cid: string) => (sent.has(cid) ? img : ""));
}

// ── what the editor shows for an image: an object URL, by asset (a few; the oldest revoked once nothing shows it)

const MAX_URLS = 32;
const urls = new Map<string, Promise<string | null>>();
const shown = (url: string) => [...document.querySelectorAll<HTMLImageElement>("img.rt-image")].some((img) => img.src === url);
function keep(assetId: string, url: Promise<string | null>): Promise<string | null> {
  urls.delete(assetId);
  urls.set(assetId, url);
  for (const [oldest, value] of urls) {
    if (urls.size <= MAX_URLS) break;
    urls.delete(oldest);
    // one still on screen stays valid (a later look for it reads it again); it goes with the page
    void value.then((u) => { if (u && !shown(u)) URL.revokeObjectURL(u); });
  }
  return url;
}

/** A node view that showed this URL is gone: one already out of the cache, and shown nowhere else, is revoked. */
export function releaseImageUrl(url: string): void {
  queueMicrotask(async () => {
    for (const cached of urls.values()) if (await cached === url) return;
    if (!shown(url)) URL.revokeObjectURL(url);
  });
}

/** A file just placed: shown from itself at once, no read back. */
export function seedImageUrl(assetId: string, file: Blob): void {
  keep(assetId, Promise.resolve(URL.createObjectURL(file)));
}

/**
 * Reads one at a time: the backend takes two attachment calls at once (a
 * staging in flight holds one), so a draft with many images would have the
 * rest refused. One refused (busy) is tried again after a moment.
 */
let lane: Promise<unknown> = Promise.resolve();
const RETRY_MS = [250, 1000, 3000];
async function read(accountId: number, ref: AttachmentRef): Promise<string | null> {
  for (let attempt = 0; ; attempt++) {
    try { return URL.createObjectURL(await attachmentBlob(accountId, ref)); } catch {
      if (attempt >= RETRY_MS.length) return null;
      await new Promise((r) => setTimeout(r, RETRY_MS[attempt]));
    }
  }
}

/** The image's URL: the one at hand, else read from the local asset (null when it can't be). */
export function imageUrl(accountId: number, ref: AttachmentRef): Promise<string | null> {
  const known = urls.get(ref.assetId);
  if (known) return keep(ref.assetId, known);
  const url = lane.then(() => read(accountId, ref));
  lane = url;
  return keep(ref.assetId, url.then((u) => {
    if (!u && urls.get(ref.assetId)) urls.delete(ref.assetId); // a later look tries again
    return u;
  }));
}
