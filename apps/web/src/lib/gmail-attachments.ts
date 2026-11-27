import { GMAIL_HEAD_BYTES, gmailBlocked, gmailNeedsWholeFile, MAX_ATTACHMENT_BYTES, type GmailBlock } from "@terno/core";
import { t } from "@terno/i18n";

/** Plan 293 (CASA 5.2.1): what to tell the user about a file Gmail won't send, in plain words. */
export function gmailBlockedMessage(block: GmailBlock, name: string): string {
  switch (block.reason) {
    case "type": return t("attachments.gmailBlocked.type", { name, ext: block.ext });
    case "archive": return t("attachments.gmailBlocked.archive", { name, ext: block.ext });
    case "protected": return t("attachments.gmailBlocked.protected", { name });
    case "executable": return t("attachments.gmailBlocked.executable", { name });
  }
}

/** Why Gmail won't send this file, or null: its name and its first bytes (an archive's whole, to look inside). */
export async function gmailRefusal(file: File): Promise<string | null> {
  // too big to attach at all: refused for its size, with the limit, before this would matter
  if (file.size > MAX_ATTACHMENT_BYTES) return null;
  const bytes = new Uint8Array(await file.slice(0, gmailNeedsWholeFile(file.name) ? file.size : GMAIL_HEAD_BYTES).arrayBuffer());
  const block = await gmailBlocked(file.name, bytes);
  return block ? gmailBlockedMessage(block, file.name) : null;
}
