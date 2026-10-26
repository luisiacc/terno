import PostalMime from "postal-mime";
import { MAX_INCOMING_MIME_BYTES, attachmentFilename, attachmentMime, bulkHeaders, type Address } from "@terno/core";
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
  /** Header-only local capture policy; providers must persist this as unavailable, never full. */
  captureUnavailable?: "size";
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

async function tooLarge(raw: Uint8Array | string): Promise<boolean> {
  if (typeof raw !== "string") return raw.byteLength > MAX_INCOMING_MIME_BYTES;
  if (raw.length > MAX_INCOMING_MIME_BYTES) return true;
  if (raw.length <= MAX_INCOMING_MIME_BYTES / 3) return false;
  let size = 0;
  for (let i = 0; i < raw.length;) {
    let end = Math.min(raw.length, i + 16384);
    const last = raw.charCodeAt(end - 1);
    if (end < raw.length && last >= 0xd800 && last <= 0xdbff) end--;
    size += new TextEncoder().encode(raw.slice(i, end)).length;
    if (size > MAX_INCOMING_MIME_BYTES) return true;
    i = end;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return false;
}

/** A complete bounded header block only: no truncated MIME body is interpreted as content. */
function envelopeOnly(raw: Uint8Array | string): Uint8Array | string {
  const header = typeof raw === "string" ? raw.slice(0, 65536) : new TextDecoder("latin1").decode(raw.subarray(0, 65536));
  const end = /\r?\n\r?\n/.exec(header);
  if (!end) return "";
  const length = end.index + end[0].length;
  return typeof raw === "string" ? raw.slice(0, length) : raw.subarray(0, length);
}

export async function parseRaw(raw: Uint8Array | string, options: { captureUnavailable?: "size" } = {}): Promise<ParsedMessage> {
  const unavailable = options.captureUnavailable === "size" || await tooLarge(raw);
  const email = await PostalMime.parse(unavailable ? envelopeOnly(raw) : raw);
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
    ...(unavailable ? { captureUnavailable: "size" as const } : {}),
    text: unavailable ? null : email.text ?? (email.html ? htmlToText(email.html) : null),
    html: unavailable ? null : email.html ?? null,
    attachments: (unavailable ? [] : email.attachments).map((a) => {
      const bytes = typeof a.content === "string" ? new TextEncoder().encode(a.content) : new Uint8Array(a.content);
      return { filename: attachmentFilename(a.filename ?? "attachment"), mime: attachmentMime(a.mimeType), size: bytes.byteLength, contentId: a.contentId?.replace(/^<|>$/g, "") ?? null, bytes };
    }),
  };
}

/** Providers can decode only a bounded prefix when the raw source is over the local capture policy. */
export function parseRawHeaders(prefix: Uint8Array, reason: "size"): Promise<ParsedMessage> {
  return parseRaw(prefix.subarray(0, 65536), { captureUnavailable: reason });
}
