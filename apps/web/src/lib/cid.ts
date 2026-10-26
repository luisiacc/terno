import { attachmentCid, bytesBase64, type AttachmentInfo } from "@terno/core";
import { attachmentBlob } from "./attachments";

/** Raster dimensions before decoding: inline mail cannot allocate an unbounded bitmap. */
export function inlineRaster(mime: string, bytes: Uint8Array): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0; let height = 0;
  if (mime === "image/png" && bytes.length >= 24 && bytes.slice(0, 8).join(",") === "137,80,78,71,13,10,26,10") {
    width = view.getUint32(16); height = view.getUint32(20);
  } else if (mime === "image/gif" && bytes.length >= 10 && String.fromCharCode(...bytes.slice(0, 6)).match(/^GIF8[79]a$/)) {
    width = view.getUint16(6, true); height = view.getUint16(8, true);
  } else if (mime === "image/jpeg" && bytes[0] === 255 && bytes[1] === 216) {
    for (let offset = 2; offset + 4 < bytes.length;) {
      if (bytes[offset] !== 255) break;
      const marker = bytes[offset + 1]!;
      const size = view.getUint16(offset + 2);
      if (size < 2 || offset + 2 + size > bytes.length) break;
      if ([192,193,194].includes(marker) && size >= 7) { height = view.getUint16(offset + 5); width = view.getUint16(offset + 7); break; }
      offset += size + 2;
    }
  }
  return width > 0 && height > 0 && width <= 4096 && height <= 4096 && width * height <= 16_000_000;
}

/** Only this message's unambiguous CIDs; inert DOM replacement never expands the remote policy. */
export async function resolveCidHtml(html: string, accountId: number, attachments: AttachmentInfo[], current: () => boolean): Promise<string> {
  const template = document.createElement("template");
  template.innerHTML = html;
  const refs = new Map<string, AttachmentInfo | null>();
  for (const a of attachments) { const cid = attachmentCid(a.contentId); if (cid) refs.set(cid, refs.has(cid) ? null : a); }
  let budget = 8 * 1024 * 1024;
  let renderBudget = 8 * 1024 * 1024;
  const resolved = new Map<string, string | null>();
  for (const img of template.content.querySelectorAll("img")) {
    const src = img.getAttribute("src") ?? "";
    if (!/^cid:/i.test(src)) continue;
    img.removeAttribute("src");
    const a = refs.get(attachmentCid(src) ?? "");
    if (!current() || !a?.assetId || !Number.isSafeInteger(a.size) || a.size < 0 || a.size > 4 * 1024 * 1024 || !["image/png", "image/gif", "image/jpeg"].includes(a.mime)) continue;
    if (!resolved.has(a.assetId)) {
      resolved.set(a.assetId, null);
      if (a.size > budget) continue;
      // Failed and invalid reads consume the same reservation as successful ones.
      budget -= a.size;
      try {
        const bytes = new Uint8Array(await (await attachmentBlob(accountId, { ...a, assetId: a.assetId })).arrayBuffer());
        if (!current()) return html;
        if (bytes.length === a.size && inlineRaster(a.mime, bytes)) resolved.set(a.assetId, `data:${a.mime};base64,${bytesBase64(bytes)}`);
      } catch { /* An unavailable inline image never replaces the readable message. */ }
    }
    const data = resolved.get(a.assetId);
    if (data && data.length <= renderBudget) {
      renderBudget -= data.length;
      img.setAttribute("src", data);
    }
  }
  return template.innerHTML;
}
