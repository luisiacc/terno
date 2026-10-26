import { Readable } from "node:stream";
import { ATTACHMENT_CHUNK } from "@terno/core";
import { checkedAttachments, checkMimeSize, yieldPreparation } from "./attachment-payload";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { asciiEmail } from "@terno/core";
import type { SendPayload } from "./types";

/** An address for MailComposer: the name without line breaks or invisible characters, a Unicode domain as punycode (plan 26). */
const fmt = (a: { name: string; email: string }) => {
  const address = asciiEmail(a.email.trim());
  // oxlint-disable-next-line no-control-regex -- control characters are exactly what must go
  const name = a.name.replace(/[\u{0}-\u{1F}\u{7F}\u{200B}\u{200E}\u{200F}\u{202A}-\u{202E}\u{2060}\u{2066}-\u{2069}\u{FEFF}]/gu, " ").replace(/\s+/g, " ").trim();
  return name ? { name, address } : address;
};

/** Builds the RFC 5322 source once, so the same bytes are sent and saved to Sent. */
export async function buildRaw(p: SendPayload, options: { keepBcc?: boolean; now?: Date } = {}): Promise<Buffer> {
  const attachments = await checkedAttachments(p);
  const now = options.now ?? new Date();
  const composer = new MailComposer({
    from: fmt(p.from),
    to: p.to.map(fmt),
    cc: p.cc.length ? p.cc.map(fmt) : undefined,
    bcc: p.bcc.length ? p.bcc.map(fmt) : undefined,
    subject: p.subject,
    attachments: attachments.map((a) => ({ filename: a.filename, contentType: a.mime, content: Readable.from(attachmentContent(a.dataBase64)), ...(a.contentId ? { cid: a.contentId, contentDisposition: "inline" as const } : {}) })),
    text: streamedText(p.text),
    // with html, MailComposer writes multipart/alternative: the text first, the HTML last (the preferred one)
    ...(p.html ? { html: streamedText(p.html) } : {}),
    messageId: `<${p.messageId}>`,
    inReplyTo: p.inReplyTo ? `<${p.inReplyTo}>` : undefined,
    references: p.references.length ? p.references.map((r) => `<${r}>`).join(" ") : undefined,
    date: now,
    // MailComposer drops the Bcc header by default; the envelope carries Bcc recipients
    headers: { "X-Mailer": "Terno" },
  });
  const node = composer.compile();
  // SMTP carries Bcc in the envelope only; the Gmail API reads recipients from headers, so keep it there.
  if (options.keepBcc) (node as unknown as { keepBcc: boolean }).keepBcc = true;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of node.createReadStream()) {
    size += chunk.length;
    checkMimeSize(size);
    chunks.push(chunk);
    await yieldPreparation();
  }
  const raw = Buffer.allocUnsafe(size);
  let offset = 0;
  for (const chunk of chunks) {
    chunk.copy(raw, offset);
    offset += chunk.length;
    await yieldPreparation();
  }
  return raw;
}

export function envelopeOf(p: SendPayload): { from: string; to: string[] } {
  return { from: asciiEmail(p.from.email), to: [...p.to, ...p.cc, ...p.bcc].map((a) => asciiEmail(a.email)) };
}

async function* attachmentContent(base64: string) {
  const width = ATTACHMENT_CHUNK / 3 * 4;
  for (let i = 0; i < base64.length; i += width) {
    yield Buffer.from(base64.slice(i, i + width), "base64");
    await yieldPreparation();
  }
}

function streamedText(text: string) {
  if (text.length <= 16384) return text;
  return { contentTransferEncoding: "base64" as const, content: Readable.from((async function* () {
    for (let i = 0; i < text.length;) {
      let end = Math.min(i + 16384, text.length);
      const last = text.charCodeAt(end - 1);
      if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
      yield Buffer.from(text.slice(i, end));
      i = end;
      await yieldPreparation();
    }
  })()) };
}
