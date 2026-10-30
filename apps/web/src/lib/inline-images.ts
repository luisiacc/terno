import type { AttachmentRef } from "@terno/core";
import { attachmentBlob } from "./attachments";

/**
 * Plan 76: images placed in a draft's text. Each is one of the draft's
 * attachments with a content ID of ours (terno-img-…@terno), named by the
 * text's <img src="cid:…">: it lives in the text, never as a chip, and is
 * left out of a send whose text no longer shows it.
 */

/** what the reader shows inline (lib/cid.ts): the rest attach */
const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif"]);
export const isInlineImage = (file: { type: string }): boolean => INLINE_TYPES.has(file.type.toLowerCase());

export const newImageCid = (): string => `terno-img-${crypto.randomUUID()}@terno`;
export const isOwnImage = (ref: Pick<AttachmentRef, "contentId">): boolean => /^terno-img-[0-9a-f-]+@terno$/.test(ref.contentId ?? "");

/** The draft's files as chips: everything but its own inline images. */
export const chipRefs = (refs: readonly AttachmentRef[]): AttachmentRef[] => refs.filter((r) => !isOwnImage(r));

/** What a send carries: its own inline images only while the text shows them. */
export const sentRefs = (refs: readonly AttachmentRef[], html: string | undefined): AttachmentRef[] =>
  refs.filter((r) => !isOwnImage(r) || (html ?? "").includes(`cid:${r.contentId}`));

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
