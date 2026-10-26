import PostalMime from "postal-mime";
import { MAX_INCOMING_MIME_BYTES, attachmentFilename, attachmentMime, bulkHeaders, parseAddressHeader, repairAddresses, type Address } from "@terno/core";
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

/** An address as a MIME parser or an IMAP envelope gives it. */
export type PostalAddress = { name?: string; address?: string; group?: PostalAddress[] };

function flatten(list: PostalAddress[] | PostalAddress | undefined): Address[] {
  if (!list) return [];
  const arr = Array.isArray(list) ? list : [list];
  return arr.flatMap((a) => (a.group ? flatten(a.group) : a.address ? [{ name: a.name ?? "", email: a.address }] : []));
}

export interface MessageAddresses {
  from: Address;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  replyTo: Address[];
}

const lower = (list: Address[]) => list.map((a) => ({ name: a.name, email: a.email.toLowerCase() }));

/**
 * A message's addresses (plan 26): read by our own parser from the raw header
 * values (every occurrence: some clients write two Cc lines), so encoded
 * words are decoded only after the structure is known (no spoofed From), and
 * repaired. Where a header can't be read at all, what the MIME parser or the
 * IMAP envelope made of it (repaired) stands in. Addresses are lowercased, as
 * the store keys them.
 */
export function messageAddresses(values: (name: string) => string[], parsed: Partial<Record<keyof MessageAddresses, PostalAddress[] | PostalAddress | undefined>> = {}): MessageAddresses {
  const read = (name: string, key: keyof MessageAddresses, single = false): Address[] => {
    const raw = values(name);
    const ours = raw.length ? parseAddressHeader(raw.join(", "), { single }) : [];
    if (ours.length) return lower(ours);
    const theirs = repairAddresses(flatten(parsed[key]), { split: !single });
    return lower(single ? theirs.slice(0, 1) : theirs);
  };
  const from = read("from", "from", true)[0] ?? { name: "", email: "" };
  // an IMAP envelope fills Reply-To in from From when the message has none (RFC 3501): that is no Reply-To
  const replyTo = read("reply-to", "replyTo").filter((a) => values("reply-to").length > 0 || a.email !== from.email);
  return { from, to: read("to", "to"), cc: read("cc", "cc"), bcc: read("bcc", "bcc"), replyTo };
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });
const LATIN1 = new TextDecoder("windows-1252");

/** A raw header block's fields by lowercase name, unfolded (8-bit bytes read as UTF-8, else Latin-1). */
export function headerFields(block: Uint8Array | undefined): (name: string) => string[] {
  if (!block) return () => [];
  let text: string;
  try {
    text = UTF8.decode(block);
  } catch {
    text = LATIN1.decode(block);
  }
  const fields = new Map<string, string[]>();
  for (const line of text.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    // appended in place: thousands of repeated lines stay linear (Codex code review 5)
    const list = fields.get(name);
    if (list) list.push(line.slice(colon + 1).trim());
    else fields.set(name, [line.slice(colon + 1).trim()]);
  }
  return (name) => fields.get(name) ?? [];
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
  const values = (name: string) => email.headers.filter((h) => h.key.toLowerCase() === name).map((h) => h.value);
  const addresses = messageAddresses(values, { from: email.from as PostalAddress | undefined, to: email.to, cc: email.cc, bcc: email.bcc, replyTo: email.replyTo });
  const date = email.date ? Date.parse(email.date) : NaN;
  return {
    rfcMessageId: email.messageId ? email.messageId.replace(/[<>]/g, "").trim() : null,
    inReplyTo: email.inReplyTo ? splitIds(email.inReplyTo)[0] ?? null : null,
    references: splitIds(email.references ?? header("references")),
    ...addresses,
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
