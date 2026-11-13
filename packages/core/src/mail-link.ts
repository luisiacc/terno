/**
 * Plan 201: links to emails. A link names a message by its canonical Message-ID: the RFC 5322 `Message-ID` header,
 * trimmed, one `<` and `>` taken off, trimmed again, lower-cased. It comes from the message itself (every copy, every
 * account, every device and provider has the same), so any client derives the same id with these steps, and a server
 * can still be asked for it (Gmail's rfc822msgid:, IMAP's HEADER Message-ID). Ingestion stores Message-IDs this way.
 *
 * No imports: main and the preload read it too.
 */

export const MAIL_LINK_SCHEME = "terno";
const PREFIX = `${MAIL_LINK_SCHEME}://message/`;
/** RFC 5322's longest line: no real Message-ID is longer */
export const MESSAGE_ID_MAX = 998;

/** The canonical form of a Message-ID header (null when nothing is left). */
export function canonicalMessageId(header: string | null | undefined): string | null {
  if (!header) return null;
  const id = header.trim().replace(/^<|>$/g, "").trim();
  return id ? id.toLowerCase() : null;
}

/** A canonical id as a link may carry it: non-empty, bounded, already canonical, no control characters. */
export function isMailLinkId(id: unknown): id is string {
  // eslint-disable-next-line no-control-regex
  return typeof id === "string" && id.length > 0 && id.length <= MESSAGE_ID_MAX && canonicalMessageId(id) === id && !/[\u0000-\u001f\u007f]/.test(id);
}

/** `terno://message/<id>` for a message's Message-ID (any form), or null when it has none. */
export function mailLink(messageId: string | null | undefined): string | null {
  const id = canonicalMessageId(messageId);
  return id && isMailLinkId(id) ? PREFIX + encodeURIComponent(id) : null;
}

/** The canonical id a link names, or null for anything that isn't exactly a link to a message. */
export function parseMailLink(url: unknown): string | null {
  if (typeof url !== "string" || url.length > PREFIX.length + MESSAGE_ID_MAX * 12) return null;
  // the scheme and host in any case (an OS may hand them over either way); the id is percent-encoded, one segment
  if (url.slice(0, PREFIX.length).toLowerCase() !== PREFIX) return null;
  const encoded = url.slice(PREFIX.length).replace(/\/$/, "");
  if (!encoded || /[/?#]/.test(encoded)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  const id = canonicalMessageId(decoded);
  return id && isMailLinkId(id) ? id : null;
}

/** What main asks a window to open (plan 41's notification: a conversation, null for the Inbox; plan 201: a link's message). */
export type OpenTarget = { kind: "thread"; threadId: number | null } | { kind: "link"; id: string };
