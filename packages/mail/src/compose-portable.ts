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

/**
 * The RFC 5322 source of a plain-text message without Node (the web sends
 * Gmail through the API with it; desktop keeps nodemailer). Bcc stays in
 * the headers: the Gmail API reads recipients from them and strips it.
 */
export function buildRawPortable(p: SendPayload, options: { now?: Date } = {}): Uint8Array {
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
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
  ];
  const body = (base64(p.text.replace(/\r?\n/g, CRLF)).match(/.{1,76}/g) ?? []).join(CRLF);
  return new TextEncoder().encode(headers.join(CRLF) + CRLF + CRLF + body + CRLF);
}
