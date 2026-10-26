import { ATTACHMENT_CHUNK, MAX_MIME_BYTES, attachmentFilename, attachmentMessageBudgetAsync, attachmentMime } from "@terno/core";
import { L } from "@terno/i18n";
import { ProviderError, type SendPayload } from "./types";

/** Macrotask boundary only while preparing mail; browsers use their foreground scheduler. */
export const yieldPreparation = (): Promise<void> => {
  const scheduler = (globalThis as { scheduler?: { yield(): Promise<void> } }).scheduler;
  if (scheduler) return scheduler.yield();
  return new Promise((resolve) => typeof setImmediate === "function" ? setImmediate(resolve) : setTimeout(resolve, 0));
};

/** Last check before transport: persisted refs must never turn into silently empty files. */
export async function checkedAttachments(p: SendPayload) {
  const parts = p.attachments ?? [];
  for (const a of parts) {
    if (a.dataBase64 === undefined || !Number.isSafeInteger(a.size) || a.size < 0 || a.dataBase64.length !== Math.ceil(a.size / 3) * 4) throw new ProviderError(L("attachments.unavailable"), false);
  }
  if (!await attachmentMessageBudgetAsync(p.text, p.html, parts, yieldPreparation)) throw new ProviderError(L("attachments.tooLarge"), false);
  for (const a of parts) {
    const value = a.dataBase64!;
    const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
    if (value.length / 4 * 3 - padding !== a.size) throw new ProviderError(L("attachments.unavailable"), false);
    const width = ATTACHMENT_CHUNK / 3 * 4;
    for (let i = 0; i < value.length; i += width) {
      const chunk = value.slice(i, i + width);
      const last = i + width >= value.length;
      // Exact length plus canonical padding bits proves decoded size without allocating decoded bytes.
      const valid = last ? /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$/.test(chunk) : /^[A-Za-z0-9+/]+$/.test(chunk);
      if (!valid) throw new ProviderError(L("attachments.unavailable"), false);
      await yieldPreparation();
    }
  }
  return parts.map((a) => ({ ...a, filename: attachmentFilename(a.filename), mime: attachmentMime(a.mime), dataBase64: a.dataBase64! }));
}

export function checkMimeSize(size: number): void {
  if (size > MAX_MIME_BYTES) throw new ProviderError(L("attachments.tooLarge"), false);
}
