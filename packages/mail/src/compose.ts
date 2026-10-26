import { checkedAttachments, checkMimeSize } from "./attachment-payload";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type { SendPayload } from "./types";

const fmt = (a: { name: string; email: string }) => (a.name ? { name: a.name, address: a.email } : a.email);

/** Builds the RFC 5322 source once, so the same bytes are sent and saved to Sent. */
export async function buildRaw(p: SendPayload, options: { keepBcc?: boolean; now?: Date } = {}): Promise<Buffer> {
  const attachments = checkedAttachments(p);
  const now = options.now ?? new Date();
  const composer = new MailComposer({
    from: fmt(p.from),
    to: p.to.map(fmt),
    cc: p.cc.length ? p.cc.map(fmt) : undefined,
    bcc: p.bcc.length ? p.bcc.map(fmt) : undefined,
    subject: p.subject,
    attachments: attachments.map((a) => ({ filename: a.filename, contentType: a.mime, content: a.dataBase64, encoding: "base64", ...(a.contentId ? { cid: a.contentId, contentDisposition: "inline" as const } : {}) })),
    text: p.text,
    // with html, MailComposer writes multipart/alternative: the text first, the HTML last (the preferred one)
    ...(p.html ? { html: p.html } : {}),
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
  const raw = await node.build();
  checkMimeSize(raw.byteLength);
  return raw;
}

export function envelopeOf(p: SendPayload): { from: string; to: string[] } {
  return { from: p.from.email, to: [...p.to, ...p.cc, ...p.bcc].map((a) => a.email) };
}
