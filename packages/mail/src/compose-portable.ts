import { checkedAttachments, checkMimeSize } from "./attachment-payload";
import type { Address } from "@terno/core";
import type { SendPayload } from "./types";

const CRLF = "\r\n";
const ASCII = /^[\x20-\x7e]*$/;

/** No header can be smuggled through a value. */
const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ");

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** RFC 2047 encoded word when the value isn't plain ASCII. */
function encodeWord(value: string): string {
  const v = oneLine(value);
  return ASCII.test(v) ? v : `=?UTF-8?B?${base64(v)}?=`;
}

function formatAddress(a: Address): string {
  const email = oneLine(a.email).replace(/[<>\s]/g, "");
  if (!a.name) return email;
  const name = oneLine(a.name);
  if (!ASCII.test(name)) return `${encodeWord(name)} <${email}>`;
  return `${/[()<>[\]:;@\\,."]/.test(name) ? `"${name.replace(/["\\]/g, "\\$&")}"` : name} <${email}>`;
}

const pad = (n: number) => String(n).padStart(2, "0");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function rfc5322Date(d: Date): string {
  return `${DAYS[d.getUTCDay()]}, ${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`;
}

/** A body as base64 lines of 76 (CRLF line ends in the text first). */
const base64Body = (text: string) => (base64(text.replace(/\r?\n/g, CRLF)).match(/.{1,76}/g) ?? []).join(CRLF);

/** A boundary no base64 line can contain ("=" and "_" never appear together in one). */
const boundary = (messageId: string) => `=_terno_${base64(messageId).replace(/[^A-Za-z0-9]/g, "").slice(0, 24)}_=`;

/**
 * The RFC 5322 source of a message without Node (the web sends Gmail through
 * the API with it; desktop keeps nodemailer): a single text/plain part, or
 * with html (plan 16) multipart/alternative, text first and the HTML last
 * (the preferred one). Bcc stays in the headers: the Gmail API reads
 * recipients from them and strips it.
 */
export function buildRawPortable(p: SendPayload, options: { now?: Date } = {}): Uint8Array {
  const attachments = checkedAttachments(p);
  const headers: string[] = [
    `From: ${formatAddress(p.from)}`,
    `To: ${p.to.map(formatAddress).join(", ")}`,
    ...(p.cc.length ? [`Cc: ${p.cc.map(formatAddress).join(", ")}`] : []),
    ...(p.bcc.length ? [`Bcc: ${p.bcc.map(formatAddress).join(", ")}`] : []),
    `Subject: ${encodeWord(p.subject)}`,
    `Date: ${rfc5322Date(options.now ?? new Date())}`,
    `Message-ID: <${oneLine(p.messageId)}>`,
    ...(p.inReplyTo ? [`In-Reply-To: <${oneLine(p.inReplyTo)}>`] : []),
    ...(p.references.length ? [`References: ${p.references.map((r) => `<${oneLine(r)}>`).join(" ")}`] : []),
    "X-Mailer: Terno",
    "MIME-Version: 1.0",
  ];
  let body: string;
  if (p.html) {
    const b = boundary(p.messageId);
    headers.push(`Content-Type: multipart/alternative; boundary="${b}"`);
    const part = (type: string, content: string) => [`--${b}`, `Content-Type: ${type}; charset=utf-8`, "Content-Transfer-Encoding: base64", "", base64Body(content)].join(CRLF);
    body = [part("text/plain", p.text), part("text/html", p.html), `--${b}--`].join(CRLF);
  } else {
    headers.push("Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64");
    body = base64Body(p.text);
  }
  if (attachments.length) {
    const contentAt = headers.findIndex((h) => h.startsWith("Content-Type:"));
    const contentHeaders = headers.splice(contentAt);
    const mixed = boundary(p.messageId) + "mixed";
    const parts = [contentHeaders.join(CRLF) + CRLF + CRLF + body];
    for (const a of attachments) {
      const filename = encodeWord(a.filename).replace(/["\\]/g, "\\$&");
      const cid = a.contentId?.replace(/[<>\r\n]/g, "");
      parts.push([`Content-Type: ${a.mime}`, `Content-Disposition: ${cid ? "inline" : "attachment"}; filename="${filename}"`, ...(cid ? [`Content-ID: <${cid}>`] : []), "Content-Transfer-Encoding: base64", "", (a.dataBase64.match(/.{1,76}/g) ?? []).join(CRLF)].join(CRLF));
    }
    headers.push(`Content-Type: multipart/mixed; boundary="${mixed}"`);
    body = parts.map((part) => `--${mixed}` + CRLF + part).join(CRLF) + CRLF + `--${mixed}--`;
  }
  const raw = new TextEncoder().encode(headers.join(CRLF) + CRLF + CRLF + body + CRLF);
  checkMimeSize(raw.byteLength);
  return raw;
}
