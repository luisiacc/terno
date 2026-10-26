import { checkedAttachments, checkMimeSize, yieldPreparation } from "./attachment-payload";
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

/** A boundary no base64 line can contain ("=" and "_" never appear together in one). */
const boundary = (messageId: string) => `=_terno_${base64(messageId).replace(/[^A-Za-z0-9]/g, "").slice(0, 24)}_=`;

/**
 * The RFC 5322 source of a message without Node (the web sends Gmail through
 * the API with it; desktop keeps nodemailer): a single text/plain part, or
 * with html (plan 16) multipart/alternative, text first and the HTML last
 * (the preferred one). Bcc stays in the headers: the Gmail API reads
 * recipients from them and strips it.
 */
export async function buildRawPortable(p: SendPayload, options: { now?: Date } = {}): Promise<Uint8Array> {
  const attachments = await checkedAttachments(p);
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
  const chunks: Uint8Array[] = [];
  const encoder = new TextEncoder();
  let size = 0;
  const write = (value: string) => {
    const bytes = encoder.encode(value);
    size += bytes.length;
    checkMimeSize(size);
    chunks.push(bytes);
  };
  const mixed = attachments.length ? boundary(p.messageId) + "mixed" : null;
  const alternative = p.html ? boundary(p.messageId) : null;
  const contentHeaders = alternative ? [`Content-Type: multipart/alternative; boundary="${alternative}"`] : ["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64"];
  write([...headers, ...(mixed ? [`Content-Type: multipart/mixed; boundary="${mixed}"`] : contentHeaders)].join(CRLF) + CRLF + CRLF);
  if (mixed) write(`--${mixed}` + CRLF + contentHeaders.join(CRLF) + CRLF + CRLF);
  if (alternative) {
    for (const [type, content] of [["text/plain", p.text], ["text/html", p.html!]]) {
      write(`--${alternative}` + CRLF + `Content-Type: ${type}; charset=utf-8` + CRLF + "Content-Transfer-Encoding: base64" + CRLF + CRLF);
      await writeFolded(textBase64(content!), write);
      write(CRLF);
    }
    write(`--${alternative}--`);
  } else {
    await writeFolded(textBase64(p.text), write);
  }
  for (const a of attachments) {
    const filename = encodeWord(a.filename).replace(/["\\]/g, "\\$&");
    const cid = a.contentId?.replace(/[<>\r\n]/g, "");
    write(CRLF + `--${mixed}` + CRLF + [`Content-Type: ${a.mime}`, `Content-Disposition: ${cid ? "inline" : "attachment"}; filename="${filename}"`, ...(cid ? [`Content-ID: <${cid}>`] : []), "Content-Transfer-Encoding: base64", "", ""].join(CRLF));
    await writeFolded(attachmentBase64(a.dataBase64), write);
  }
  if (mixed) write(CRLF + `--${mixed}--`);
  write(CRLF);
  // The only full wire allocation is capped; copies yield instead of joining a huge string.
  const raw = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    raw.set(chunk, offset);
    offset += chunk.length;
    await yieldPreparation();
  }
  return raw;
}

async function* attachmentBase64(value: string) {
  for (let i = 0; i < value.length; i += 16384) yield value.slice(i, i + 16384);
}

async function* textBase64(value: string) {
  const encoder = new TextEncoder();
  let rest = new Uint8Array(0);
  for (let i = 0; i < value.length;) {
    let end = Math.min(i + 8192, value.length);
    const last = value.charCodeAt(end - 1);
    if (end < value.length && (last === 13 || last >= 0xd800 && last <= 0xdbff)) end--;
    const encoded = encoder.encode(value.slice(i, end).replace(/\r?\n/g, CRLF));
    const bytes = new Uint8Array(rest.length + encoded.length);
    bytes.set(rest); bytes.set(encoded, rest.length);
    const full = bytes.length - bytes.length % 3;
    yield btoa(String.fromCharCode(...bytes.subarray(0, full)));
    rest = bytes.slice(full);
    i = end;
  }
  if (rest.length) yield btoa(String.fromCharCode(...rest));
}

async function writeFolded(source: AsyncIterable<string>, write: (value: string) => void) {
  let column = 0;
  for await (const chunk of source) {
    const lines: string[] = [];
    for (let i = 0; i < chunk.length;) {
      if (column === 76) { lines.push(CRLF); column = 0; }
      const end = Math.min(i + 76 - column, chunk.length);
      lines.push(chunk.slice(i, end));
      column += end - i;
      i = end;
    }
    write(lines.join(""));
    await yieldPreparation();
  }
}
