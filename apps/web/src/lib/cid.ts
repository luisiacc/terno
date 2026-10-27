import { attachmentCid, attachmentCidUri, bytesBase64, type AttachmentInfo } from "@terno/core";
import { attachmentBlob } from "./attachments";

/** Raster dimensions before decoding: inline mail cannot allocate an unbounded bitmap. */
function* rasterCheck(mime: string, bytes: Uint8Array): Generator<void, boolean> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0; let height = 0;
  if (mime === "image/png" && bytes.length >= 24 && bytes.slice(0, 8).join(",") === "137,80,78,71,13,10,26,10") {
    width = view.getUint32(16); height = view.getUint32(20);
  } else if (mime === "image/gif" && bytes.length >= 10 && String.fromCharCode(...bytes.slice(0, 6)).match(/^GIF8[79]a$/)) {
    width = view.getUint16(6, true); height = view.getUint16(8, true);
  } else if (mime === "image/jpeg" && bytes[0] === 255 && bytes[1] === 216) {
    for (let offset = 2, markers = 0; offset + 4 < bytes.length;) {
      if (bytes[offset] !== 255) break;
      const marker = bytes[offset + 1]!;
      const size = view.getUint16(offset + 2);
      if (size < 2 || offset + 2 + size > bytes.length) break;
      if ([192,193,194].includes(marker) && size >= 7) { height = view.getUint16(offset + 5); width = view.getUint16(offset + 7); break; }
      offset += size + 2;
      if (++markers % 4096 === 0) yield;
    }
  }
  return width > 0 && height > 0 && width <= 4096 && height <= 4096 && width * height <= 16_000_000;
}

export function inlineRaster(mime: string, bytes: Uint8Array): boolean {
  const check = rasterCheck(mime, bytes);
  for (;;) { const result = check.next(); if (result.done) return result.value; }
}

async function rasterAllowed(mime: string, bytes: Uint8Array, current: () => boolean, yieldTo: () => Promise<void>): Promise<boolean> {
  const check = rasterCheck(mime, bytes);
  for (;;) {
    if (!current()) return false;
    const result = check.next();
    if (result.done) return result.value;
    await yieldTo();
  }
}

/** Only this message's unambiguous CIDs; inert DOM replacement never expands the remote policy. */
export async function resolveCidHtml(html: string, accountId: number, attachments: AttachmentInfo[], current: () => boolean): Promise<string> {
  return resolve(html, accountId, attachments, current, () => new Promise<void>((resolve) => setTimeout(resolve, 0)));
}

type InlineData = { parts: string[]; length: number };
async function inlineData(mime: string, bytes: Uint8Array, current: () => boolean, yieldTo: () => Promise<void>): Promise<InlineData | null> {
  const parts = [`data:${mime};base64,`];
  let length = parts[0]!.length;
  // Divisible by three, so every encoded slice except the last has no padding.
  for (let start = 0; start < bytes.length; start += 48 * 1024) {
    if (!current()) return null;
    const encoded = bytesBase64(bytes.subarray(start, start + 48 * 1024));
    parts.push(encoded); length += encoded.length;
    await yieldTo();
  }
  return { parts, length };
}

async function resolve(html: string, accountId: number, attachments: AttachmentInfo[], current: () => boolean, yieldTo: () => Promise<void>): Promise<string> {
  const template = document.createElement("template");
  template.innerHTML = html;
  const refs = new Map<string, AttachmentInfo | null>();
  for (const a of attachments) { const cid = attachmentCid(a.contentId); if (cid) refs.set(cid, refs.has(cid) ? null : a); }
  let budget = 8 * 1024 * 1024;
  let renderBudget = 8 * 1024 * 1024;
  const resolved = new Map<string, InlineData | null>();
  const replacements = new Map<string, InlineData>();
  const nonce = crypto.randomUUID();
  for (const img of template.content.querySelectorAll("img")) {
    const src = img.getAttribute("src") ?? "";
    if (!/^cid:/i.test(src)) continue;
    img.removeAttribute("src");
    const a = refs.get(attachmentCidUri(src) ?? "");
    if (!current() || !a?.assetId || !Number.isSafeInteger(a.size) || a.size < 0 || a.size > 4 * 1024 * 1024 || !["image/png", "image/gif", "image/jpeg"].includes(a.mime)) continue;
    if (!resolved.has(a.assetId)) {
      resolved.set(a.assetId, null);
      if (a.size > budget) continue;
      // Failed and invalid reads consume the same reservation as successful ones.
      budget -= a.size;
      try {
        const bytes = new Uint8Array(await (await attachmentBlob(accountId, { ...a, assetId: a.assetId })).arrayBuffer());
        if (!current()) return html;
        if (bytes.length === a.size && await rasterAllowed(a.mime, bytes, current, yieldTo) && `data:${a.mime};base64,`.length + 4 * Math.ceil(bytes.length / 3) <= renderBudget) resolved.set(a.assetId, await inlineData(a.mime, bytes, current, yieldTo));
      } catch { /* An unavailable inline image never replaces the readable message. */ }
    }
    const data = resolved.get(a.assetId);
    if (data && data.length <= renderBudget) {
      renderBudget -= data.length;
      const marker = `terno-cid:${nonce}:${replacements.size}`;
      replacements.set(marker, data);
      img.setAttribute("src", marker);
    }
  }
  if (!current()) return html;
  // Serialize only small placeholders: DOM serializers can rescan/escape a whole data URL in one task.
  const serialized = template.innerHTML;
  if (!replacements.size) return serialized;
  const output: string[] = [];
  let cursor = 0;
  for (const [marker, data] of replacements) {
    const index = serialized.indexOf(marker, cursor);
    output.push(serialized.slice(cursor, index), ...data.parts);
    cursor = index + marker.length;
    await yieldTo();
    if (!current()) return html;
  }
  output.push(serialized.slice(cursor));
  return output.join("");
}
