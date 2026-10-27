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
  return leaf.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, "").replace(/^\.+|\.+$/g, "").trim().slice(0, 120) || "attachment";
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
