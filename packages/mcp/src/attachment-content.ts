import { attachmentCid, cidReferences, type AttachmentInfo } from "@terno/core";

/**
 * Plan 185: how an agent gets a file. Text and images come inline when every client shows them and they fit its
 * limits (Claude Code spills text past 50k characters, Codex keeps 12k tokens per output by default, Anthropic takes
 * images to 5 MB); the rest is a file path for the agent's own tools (no client documents embedded resource blobs).
 */
export const TEXT_INLINE_MAX = 1024 * 1024;
export const IMAGE_INLINE_MAX = 5 * 1024 * 1024;
export const PAGE_CHARS = 32_000;
export const PAGE_TOKENS = 8_000;

const INLINE_IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const TEXT_MIMES = new Set([
  "application/json", "application/x-ndjson", "application/xml", "application/yaml", "application/x-yaml", "application/csv",
  "application/javascript", "application/x-sh", "application/sql", "application/ics", "application/rtf", "message/rfc822", "image/svg+xml",
]);
const TEXT_EXTENSIONS = new Set(["txt", "text", "md", "markdown", "csv", "tsv", "log", "json", "xml", "yaml", "yml", "ics", "vcf", "eml", "html", "htm", "svg", "ini", "toml"]);

export type ContentKind = "text" | "image" | "file";

export function isTextLike(mime: string, filename: string): boolean {
  if (mime.startsWith("text/") || TEXT_MIMES.has(mime) || /\+(json|xml)$/.test(mime)) return true;
  // a mailer that didn't know the type
  const ext = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase();
  return (mime === "application/octet-stream" || mime === "") && ext !== undefined && TEXT_EXTENSIONS.has(ext);
}

export function contentKind(a: { mime: string; filename: string; size: number }): ContentKind {
  if (INLINE_IMAGES.has(a.mime) && a.size <= IMAGE_INLINE_MAX) return "image";
  if (isTextLike(a.mime, a.filename) && a.size <= TEXT_INLINE_MAX) return "text";
  return "file";
}

/** UTF-8 when the bytes are UTF-8, else windows-1252 (what mail without a charset usually is). */
export function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/** One page from `offset`: at most PAGE_CHARS, and about PAGE_TOKENS (an ASCII character ~¼ token, any other ~1). */
export function textPage(text: string, offset: number): { page: string; nextOffset: number | null } {
  let end = offset;
  let tokens = 0;
  const limit = Math.min(text.length, offset + PAGE_CHARS);
  while (end < limit && tokens < PAGE_TOKENS) {
    tokens += text.charCodeAt(end) < 128 ? 0.25 : 1;
    end++;
  }
  // never half a surrogate pair
  if (end < text.length && end > offset + 1) {
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end--;
  }
  return { page: text.slice(offset, end), nextOffset: end < text.length ? end : null };
}

/** The parts of a message its HTML shows as images. A Content-ID two parts share is ambiguous: neither. */
export function inlineParts(html: string | null, attachments: readonly AttachmentInfo[]): Set<number> {
  const inline = new Set<number>();
  if (!html) return inline;
  const refs = cidReferences(html);
  const cids = attachments.map((a) => attachmentCid(a.contentId));
  for (const [i, a] of attachments.entries()) {
    const cid = cids[i];
    if (cid && refs.has(cid) && cids.filter((c) => c === cid).length === 1) inline.add(a.id);
  }
  return inline;
}
