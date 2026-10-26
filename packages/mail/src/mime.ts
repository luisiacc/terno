import PostalMime from "postal-mime";
import { MAX_MIME_BYTES, attachmentFilename, attachmentMime, bulkHeaders, type Address } from "@terno/core";
import type { IncomingAttachment } from "@terno/store";

export interface ParsedMessage {
  rfcMessageId: string | null;
  inReplyTo: string | null;
  references: string[];
  from: Address;
  replyTo: Address[];
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  date: number | null;
  listId: string | null;
  /** List-Unsubscribe, Precedence: bulk/list/junk or Auto-Submitted (plan 17) */
  bulk: boolean;
  text: string | null;
  html: string | null;
  attachments: IncomingAttachment[];
}

type PostalAddress = { name?: string; address?: string; group?: PostalAddress[] };

function addresses(list: PostalAddress[] | PostalAddress | undefined): Address[] {
  if (!list) return [];
  const arr = Array.isArray(list) ? list : [list];
  return arr.flatMap((a) => (a.group ? addresses(a.group) : a.address ? [{ name: a.name ?? "", email: a.address.toLowerCase() }] : []));
}

export function splitIds(value: string | null | undefined): string[] {
  return value ? (value.match(/<[^>]+>/g) ?? value.split(/\s+/)).map((s) => s.replace(/[<>]/g, "").trim()).filter(Boolean) : [];
}

/** List-Id: "Name <list.example.com>" → "list.example.com". */
export function parseListId(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = /<([^>]+)>/.exec(value);
  return (m ? m[1]! : value).trim().toLowerCase() || null;
}

/** Plain-text fallback for HTML-only mail (used for search, snippets and filters). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|table)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

export async function parseRaw(raw: Uint8Array | string): Promise<ParsedMessage> {
  if ((typeof raw === "string" ? new TextEncoder().encode(raw).length : raw.byteLength) > MAX_MIME_BYTES) throw new Error("Message exceeds the local MIME limit");
  const email = await PostalMime.parse(raw);
  const header = (name: string) => email.headers.find((h) => h.key.toLowerCase() === name)?.value ?? null;
  const from = addresses(email.from as PostalAddress | undefined)[0] ?? { name: "", email: "" };
  const date = email.date ? Date.parse(email.date) : NaN;
  return {
    rfcMessageId: email.messageId ? email.messageId.replace(/[<>]/g, "").trim() : null,
    inReplyTo: email.inReplyTo ? splitIds(email.inReplyTo)[0] ?? null : null,
    references: splitIds(email.references ?? header("references")),
    from,
    replyTo: addresses(email.replyTo as PostalAddress[] | undefined),
    to: addresses(email.to as PostalAddress[]),
    cc: addresses(email.cc as PostalAddress[]),
    bcc: addresses(email.bcc as PostalAddress[]),
    subject: email.subject ?? "",
    date: Number.isNaN(date) ? null : date,
    listId: parseListId(header("list-id")),
    bulk: bulkHeaders({ listUnsubscribe: header("list-unsubscribe"), precedence: header("precedence"), autoSubmitted: header("auto-submitted") }),
    text: email.text ?? (email.html ? htmlToText(email.html) : null),
    html: email.html ?? null,
    attachments: email.attachments.map((a) => {
      const bytes = typeof a.content === "string" ? new TextEncoder().encode(a.content) : new Uint8Array(a.content);
      return { filename: attachmentFilename(a.filename ?? "attachment"), mime: attachmentMime(a.mimeType), size: bytes.byteLength, contentId: a.contentId?.replace(/^<|>$/g, "") ?? null, bytes };
    }),
  };
}
