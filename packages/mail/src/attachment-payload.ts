import { ATTACHMENT_CHUNK, MAX_MIME_BYTES, attachmentFilename, attachmentMessageBudget, attachmentMime, base64Bytes } from "@terno/core";
import { L } from "@terno/i18n";
import { ProviderError, type SendPayload } from "./types";

/** Last check before transport: persisted refs must never turn into silently empty files. */
export function checkedAttachments(p: SendPayload) {
  const parts = p.attachments ?? [];
  if (!attachmentMessageBudget(p.text, p.html, parts)) throw new ProviderError(L("attachments.tooLarge"), false);
  for (const a of parts) {
    if (a.dataBase64 === undefined || !Number.isSafeInteger(a.size) || a.size < 0) throw new ProviderError(L("attachments.unavailable"), false);
    const width = ATTACHMENT_CHUNK / 3 * 4;
    let bytes = 0;
    try {
      for (let i = 0; i < a.dataBase64.length; i += width) bytes += base64Bytes(a.dataBase64.slice(i, i + width)).length;
    } catch { throw new ProviderError(L("attachments.unavailable"), false); }
    if (bytes !== a.size || a.dataBase64.length !== Math.ceil(a.size / 3) * 4) throw new ProviderError(L("attachments.unavailable"), false);
  }
  return parts.map((a) => ({ ...a, filename: attachmentFilename(a.filename), mime: attachmentMime(a.mime), dataBase64: a.dataBase64! }));
}

export function checkMimeSize(size: number): void {
  if (size > MAX_MIME_BYTES) throw new ProviderError(L("attachments.tooLarge"), false);
}
