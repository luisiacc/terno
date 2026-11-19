// Available on both supported runtimes (Node 24 and browsers).
declare function btoa(value: string): string;
declare function atob(value: string): string;

/** Immutable local attachment identity; filenames are labels, never paths. */
export interface AttachmentRef {
  assetId: string;
  filename: string;
  mime: string;
  size: number;
  contentId?: string | null;
}

export const ATTACHMENT_CHUNK = 48 * 1024; // divisible by three: concatenated base64 stays canonical
export const MAX_ATTACHMENT_BYTES = 18 * 1024 * 1024;
export const MAX_INCOMING_MIME_BYTES = 75 * 1024 * 1024;
export const MAX_MIME_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENT_COUNT = 100;
export const ATTACHMENT_ACCOUNT_BYTES = 256 * 1024 * 1024;

export function attachmentFilename(value: string): string {
  const leaf = value.replace(/\\/g, "/").split("/").pop() ?? "";
  // oxlint-disable-next-line no-control-regex -- filenames exclude control characters
  return leaf.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, "").replace(/^[.\s]+|[.\s]+$/gu, "").slice(0, 120).replace(/[\ud800-\udbff]$/u, "").replace(/[.\s]+$/gu, "") || "attachment";
}

export function attachmentMime(value: string): string {
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(value) && value.length <= 120 ? value.toLowerCase() : "application/octet-stream";
}

export function attachmentCid(value: string | null | undefined): string | null {
  if (!value) return null;
  const cid = value.replace(/^<|>$/g, "");
  // oxlint-disable-next-line no-control-regex -- content IDs cannot contain header controls
  return cid.length <= 300 && !/[\x00-\x20\x7f<>]/.test(cid) ? cid.toLowerCase() : null;
}

/** URI escaping belongs only to a renderer reference, never stored Content-ID metadata. */
export function attachmentCidUri(value: string): string | null {
  if (!/^cid:/i.test(value)) return null;
  try { return attachmentCid(decodeURIComponent(value.slice(4))); } catch { return null; }
}

const ENTITIES: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };
const decodeReferences = (value: string) => value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
  if (ref[0] !== "#") return ENTITIES[ref.toLowerCase()] ?? whole;
  const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
});

/** Elements whose content is text (or nothing shown): an `<img>` inside one is no picture. */
const NO_IMAGES = ["script", "style", "textarea", "title", "noscript", "template", "xmp", "iframe", "noembed", "noframes"];
const CLOSE = new Map(NO_IMAGES.map((name) => [name, new RegExp(`</${name}[\\s/>]`, "gi")]));
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/**
 * Plan 220: the `cid:` sources of a body's `<img>`s, in document order, with their character references decoded (the URI
 * is left to `attachmentCidUri`). Without a DOM and linear: comments and elements that show no image are skipped, a tag
 * is read only to its first `>` and an unterminated one ends the scan. In doubt it finds nothing (a file stays a file).
 */
export function cidImageSources(html: string): string[] {
  const found: string[] = [];
  const tag = /<(!--|[a-z][a-z0-9]*)/gi;
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    const name = m[1]!.toLowerCase();
    const close = html.indexOf(name === "!--" ? "-->" : ">", tag.lastIndex);
    if (close < 0) break;
    tag.lastIndex = close + 1;
    const skip = CLOSE.get(name);
    if (skip) {
      skip.lastIndex = close + 1;
      if (!skip.exec(html)) break;
      tag.lastIndex = skip.lastIndex;
    } else if (name === "img") {
      const attrs = html.slice(m.index + 4, close);
      // the first src counts, as in a parsed document
      for (const a of attrs.matchAll(ATTRIBUTE)) {
        if (a[1]!.toLowerCase() !== "src") continue;
        const raw = decodeReferences(a[2] ?? a[3] ?? a[4] ?? "");
        if (/^cid:/i.test(raw)) found.push(raw);
        break;
      }
    }
  }
  return found;
}

/** Plan 185: the Content-IDs a body shows as images, normalized like `attachmentCid`. */
export function cidReferences(html: string): Set<string> {
  const found = new Set<string>();
  for (const raw of cidImageSources(html)) {
    const cid = attachmentCidUri(raw);
    if (cid) found.add(cid);
  }
  return found;
}

/** What the reader shows in a message's text (lib/cid.ts): these types, each this big at most, within the message's budgets. */
export const INLINE_IMAGE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/gif", "image/jpeg"]);
export const INLINE_IMAGE_MAX = 4 * 1024 * 1024;
const INLINE_BYTES = 8 * 1024 * 1024;
const INLINE_DATA_URLS = 8 * 1024 * 1024;

type InlinePart = { assetId?: string; contentId?: string | null; mime: string; size: number };

export interface InlineAdmission<T extends InlinePart> {
  /**
   * The part a `cid:` image (its canonical Content-ID) shows, its kept bytes counted once (read or not); null when none.
   * A part whose bytes aren't kept here is still the text's picture (it can't be read, so it costs nothing).
   */
  reserve(cid: string | null): T | null;
  /** Would its data URL still fit in the text? */
  fits(part: T): boolean;
  /** One image placed: its data URL spent, each time it is shown. False when it no longer fits. */
  place(part: T): boolean;
}

/**
 * Plan 220: the reader's rule for a message's pictures, one place for the reader (which reads the bytes between `reserve`
 * and `place`) and for what lists them as files (`messageParts`, every read assumed to succeed). Only an unambiguous
 * Content-ID, of a type and size the reader shows.
 */
export function inlineImageAdmission<T extends InlinePart>(attachments: readonly T[]): InlineAdmission<T> {
  const refs = new Map<string, T | null>();
  for (const a of attachments) { const cid = attachmentCid(a.contentId); if (cid) refs.set(cid, refs.has(cid) ? null : a); }
  const counted = new Map<string, boolean>();
  let bytes = INLINE_BYTES;
  let dataUrls = INLINE_DATA_URLS;
  const dataLength = (a: T) => `data:${a.mime};base64,`.length + 4 * Math.ceil(a.size / 3);
  return {
    reserve(cid) {
      const a = refs.get(cid ?? "");
      if (!a || !Number.isSafeInteger(a.size) || a.size < 0 || a.size > INLINE_IMAGE_MAX || !INLINE_IMAGE_TYPES.has(a.mime)) return null;
      if (!a.assetId) return a;
      let admitted = counted.get(a.assetId);
      if (admitted === undefined) {
        admitted = a.size <= bytes;
        if (admitted) bytes -= a.size;
        counted.set(a.assetId, admitted);
      }
      return admitted ? a : null;
    },
    fits: (a) => dataLength(a) <= dataUrls,
    place(a) {
      const length = dataLength(a);
      if (length > dataUrls) return false;
      dataUrls -= length;
      return true;
    },
  };
}

/**
 * Plan 220: a message's parts split into its files and the pictures its text shows (by `inlineImageAdmission`), each in
 * order (the message's menu offers the pictures, so a wrong guess costs a submenu, never the file). Cached per attachments
 * array and body, so a conversation's strip and its messages scan a body once; a message without a part with a
 * Content-ID isn't scanned, and its files are its own array.
 */
export function messageParts<T extends InlinePart & { id: number }>(html: string | null | undefined, attachments: readonly T[]): { files: readonly T[]; images: readonly T[] } {
  if (!html || !attachments.some((a) => a.contentId)) return { files: attachments, images: [] };
  const cached = partsCache.get(attachments);
  if (cached?.html === html) return cached.parts as { files: readonly T[]; images: readonly T[] };
  const admission = inlineImageAdmission(attachments);
  const shown = new Set<number>();
  for (const src of cidImageSources(html)) {
    const a = admission.reserve(attachmentCidUri(src));
    if (a && (!a.assetId || admission.place(a))) shown.add(a.id);
  }
  const parts = shown.size ? { files: attachments.filter((a) => !shown.has(a.id)), images: attachments.filter((a) => shown.has(a.id)) } : { files: attachments, images: [] };
  partsCache.set(attachments, { html, parts });
  return parts;
}
const partsCache = new WeakMap<readonly object[], { html: string; parts: { files: readonly object[]; images: readonly object[] } }>();

export function bytesBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

export function base64Bytes(value: string, limit = ATTACHMENT_CHUNK): Uint8Array {
  if (value.length > Math.ceil(limit / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error("Invalid attachment bytes");
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  if (bytes.length > limit || bytesBase64(bytes) !== value) throw new Error("Invalid attachment bytes");
  return bytes;
}

/** Budget includes base64 and line folding plus bounded per-part/header overhead. */
export function attachmentMessageBudget(text: string, html: string | undefined, attachments: readonly AttachmentRef[]): boolean {
  return attachmentBudgetFromBytes(utf8Size(text) + utf8Size(html ?? ""), attachments);
}

function attachmentBudgetFromBytes(bodyBytes: number, attachments: readonly AttachmentRef[]): boolean {
  if (attachments.length > MAX_ATTACHMENT_COUNT) return false;
  const decoded = attachments.reduce((n, a) => n + a.size, 0);
  const size = bodyBytes + decoded;
  return decoded <= MAX_ATTACHMENT_BYTES && Math.ceil(size / 3) * 4 + Math.ceil(size / 57) * 2 + attachments.length * 2048 + 16384 <= MAX_MIME_BYTES;
}

/** Outside atomic writes: exact UTF-8 accounting with bounded scan/allocation slices. */
export async function attachmentMessageBudgetAsync(text: string, html: string | undefined, attachments: readonly AttachmentRef[], yieldTo: () => Promise<void>): Promise<boolean> {
  if (text.length + (html?.length ?? 0) <= 16384) return attachmentMessageBudget(text, html, attachments);
  let bytes = 0;
  for (const value of [text, html ?? ""]) {
    for (let i = 0; i < value.length;) {
      let end = Math.min(i + 16384, value.length);
      const last = value.charCodeAt(end - 1);
      if (end < value.length && last >= 0xd800 && last <= 0xdbff) end--;
      bytes += utf8Size(value.slice(i, end));
      if (!attachmentBudgetFromBytes(bytes, attachments)) return false;
      i = end;
      await yieldTo();
    }
  }
  return attachmentBudgetFromBytes(bytes, attachments);
}

declare class TextEncoder { encode(value: string): Uint8Array; }
function utf8Size(value: string): number { return new TextEncoder().encode(value).length; }
