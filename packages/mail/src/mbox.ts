import { asciiEmail, ATTACHMENT_CHUNK, type Address } from "@terno/core";

/**
 * Plan 107: one message of an .mbox export, rebuilt from this computer's copy (never fetched again). mboxrd: a
 * `From - <asctime>` line, then the message with `>` added to every `^>*From ` line, then a blank line. Unlike
 * buildRawPortable it writes what was received (Reply-To, List-Id, the stored ids) and has no sending limits.
 * Everything is streamed: pieces of whole lines, at most MBOX_PIECE characters, so a 40 MB attachment is read
 * and encoded a stored chunk at a time and never sits whole in memory, and a stored body a stretch at a time.
 */

export interface MboxAttachment {
  filename: string;
  mime: string;
  size: number;
  contentId: string | null;
  /** its bytes are on this computer (a complete stored asset) */
  stored: boolean;
}

export interface MboxMessage {
  rfcMessageId: string | null;
  inReplyTo: string | null;
  references: readonly string[];
  from: Address;
  to: readonly Address[];
  cc: readonly Address[];
  replyTo: readonly Address[];
  date: number;
  subject: string;
  listId: string | null;
  bodyText: string | MboxBody | null;
  bodyHtml: string | MboxBody | null;
  /** the stored body isn't the whole of it (or there's none) */
  partial: boolean;
  attachments: readonly MboxAttachment[];
}

/**
 * A stored body part read a stretch at a time (Codex code review round 6 #4: a whole 20 MB body was read before the
 * first piece): about `size` of the store's units from `at`, never half a character; `next`: where the rest starts,
 * null at its end. Null: gone meanwhile (the part ends there, and the body counts as partial).
 */
export type MboxBody = (at: number, size: number) => Promise<{ text: string; next: number | null } | null>;

/** The store units a body read asks for. */
export const BODY_READ = 256 * 1024;

/** a stored attachment's chunk `index` (canonical base64 of ATTACHMENT_CHUNK bytes); null: gone */
export type MboxChunkReader = (attachment: number, index: number) => Promise<string | null>;

export interface MboxStats {
  missingAttachments: number;
  partialBody: boolean;
}

/**
 * The most a piece holds (UTF-16 units). A next can overshoot its budget by a piece's encoding: 256 KB of a 20 MB
 * body's short lines was ~10 ms of it (Codex code review round 6 #4).
 */
export const MBOX_PIECE = 128 * 1024;

const ASCII = /^[\x20-\x7e]*$/;
/** whole base64 lines (the store's chunks are canonical: only the last one is padded) */
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
const CHUNK_B64 = (ATTACHMENT_CHUNK / 3) * 4;
/** `=_` never occurs in base64 or quoted-printable text, and neither boundary is a prefix of the other */
const MIXED = "=_terno_mixed";
const ALT = "=_terno_alt";
const WORD_BYTES = 45;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const utf8 = new TextEncoder();

/** No header can be smuggled through a value. */
// oxlint-disable-next-line no-control-regex -- control characters are exactly what must go
const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");

const pad = (n: number, w = 2, c = "0") => String(n).padStart(w, c);

/** `Mon Jan  1 00:00:00 2024`, UTC (the envelope line's date) */
export function asctime(ms: number): string {
  const d = new Date(Number.isFinite(ms) ? ms : 0);
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCDate(), 2, " ")} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
}

/** RFC 5322 date, UTC */
export function rfc5322Date(ms: number): string {
  const d = new Date(Number.isFinite(ms) ? ms : 0);
  return `${DAYS[d.getUTCDay()]}, ${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`;
}

function base64Text(text: string): string {
  const bytes = utf8.encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** RFC 2047 encoded words (each ≤ 75 characters, never splitting a character) when the value isn't plain ASCII. */
export function encodeWords(value: string): string[] {
  const v = oneLine(value);
  if (ASCII.test(v)) return v ? [v] : [];
  const words: string[] = [];
  let chunk = "";
  let size = 0;
  for (const ch of v) {
    const n = utf8.encode(ch).length;
    if (size + n > WORD_BYTES && chunk) {
      words.push(`=?UTF-8?B?${base64Text(chunk)}?=`);
      chunk = "";
      size = 0;
    }
    chunk += ch;
    size += n;
  }
  if (chunk) words.push(`=?UTF-8?B?${base64Text(chunk)}?=`);
  return words;
}

/** `Name: a b c`, folded at the spaces between words so lines stay within 78 where they can. */
function header(name: string, words: readonly string[], sep = " "): string {
  let line = `${name}:`;
  let out = "";
  for (const [i, w] of words.entries()) {
    const joint = i === 0 ? " " : sep;
    if (i > 0 && line.length + joint.length + w.length > 78) {
      out += `${line}${joint.trimEnd()}\n`;
      line = ` ${w}`;
    } else line += `${joint}${w}`;
  }
  return `${out}${line}\n`;
}

const textHeader = (name: string, value: string) => {
  const v = oneLine(value).trim();
  return header(name, ASCII.test(v) ? v.split(/ +/).filter(Boolean) : encodeWords(v));
};

const angle = (id: string) => `<${oneLine(id).replace(/[<>\s]/g, "")}>`;

function address(a: Address): string {
  const email = asciiEmail(oneLine(a.email).replace(/[<>\s]/g, ""));
  const name = oneLine(a.name).trim();
  if (!name) return email;
  if (!ASCII.test(name)) return `${encodeWords(name).join(" ")} <${email}>`;
  return `${/[()<>[\]:;@\\,."]/.test(name) ? `"${name.replace(/["\\]/g, "\\$&")}"` : name} <${email}>`;
}

const addresses = (name: string, list: readonly Address[]) => {
  const items = list.filter((a) => a.email.trim()).map(address);
  return items.length ? header(name, items, ", ") : "";
};

/** A MIME type as a token pair, else octet-stream. */
const mimeType = (mime: string) => (/^[\w.+-]+\/[\w.+-]+$/.test(mime) ? mime.toLowerCase() : "application/octet-stream");

function fileParams(filename: string): { name: string; disposition: string } {
  const v = oneLine(filename).trim() || "attachment";
  if (ASCII.test(v)) {
    const q = `"${v.replace(/["\\]/g, "\\$&")}"`;
    return { name: `name=${q}`, disposition: `filename=${q}` };
  }
  // RFC 2231 for readers that follow it, an encoded word for the ones that don't
  const ext = `UTF-8''${encodeURIComponent(v).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
  const word = `"${encodeWords(v).join(" ")}"`;
  return { name: `name=${word}`, disposition: `filename=${word};\n filename*=${ext}` };
}

const HEX = "0123456789ABCDEF";
const escape = (b: number) => `=${HEX[b >> 4]}${HEX[b & 15]}`;

/** UTF-16 units of a line encoded at once (Codex code review #2: a 5 MB line was one 5.4 MB piece, 147 ms) */
const QP_SLICE = 16 * 1024;

/**
 * One text line as quoted-printable lines (≤ 76 characters; a leading "From " has its F encoded), a slice of
 * QP_SLICE at a time, so a line of any length is never encoded whole; fed a stretch at a time (a line longer than a
 * body read begins before its end is read), each stretch whole characters, the first at least "From ".
 */
class QpLine {
  private cur = "";
  private begun = false;
  *feed(part: string, ends: boolean): Generator<string, void> {
    const from = !this.begun && part.startsWith("From ");
    for (let s = 0; ; ) {
      let e = Math.min(part.length, s + QP_SLICE);
      // never between a surrogate pair
      if (e < part.length && (part.charCodeAt(e - 1) & 0xfc00) === 0xd800) e--;
      const bytes = utf8.encode(part.slice(s, e));
      const end = e === part.length;
      for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i]!;
        const last = ends && end && i === bytes.length - 1;
        let token: string;
        if (s === 0 && i === 0 && b === 0x46 && from) token = escape(b);
        else if ((b === 0x20 || b === 0x09) && !last) token = String.fromCharCode(b);
        else if (b >= 33 && b <= 126 && b !== 61) token = String.fromCharCode(b);
        else token = escape(b);
        if (this.cur.length + token.length > 75) {
          yield `${this.cur}=`;
          this.cur = "";
        }
        this.cur += token;
      }
      this.begun = true;
      if (end) break;
      s = e;
    }
    if (!ends) return;
    yield this.cur;
    this.cur = "";
    this.begun = false;
  }
}

export function* qpLines(line: string): Generator<string, void> {
  yield* new QpLine().feed(line, true);
}

export const qpLine = (line: string): string[] => [...qpLines(line)];

/** Collects whole lines into pieces of at most MBOX_PIECE characters, mboxrd-quoted. */
class Pieces {
  private parts: string[] = [];
  private size = 0;
  /** the envelope line, which is never quoted, goes first */
  constructor(private envelope: string) {
    this.size = envelope.length;
  }
  /** whether `n` more characters would overflow the piece (take it first) */
  full(n: number): boolean {
    return this.size > 0 && this.size + n > MBOX_PIECE;
  }
  add(lines: string): void {
    this.parts.push(lines);
    this.size += lines.length;
  }
  take(): string {
    const piece = this.envelope + this.parts.join("").replace(/^(>*From )/gm, ">$1");
    this.envelope = "";
    this.parts = [];
    this.size = 0;
    return piece;
  }
  get empty(): boolean {
    return this.size === 0;
  }
}

function* put(out: Pieces, lines: string): Generator<string, void> {
  if (out.full(lines.length)) yield out.take();
  out.add(lines);
}

/** a body held whole, read as a store's is: UTF-16 units, never half a surrogate pair */
export const stringBody = (s: string): MboxBody => async (at, size) => {
  let end = Math.min(s.length, at + size);
  if (end < s.length && end > at + 1 && (s.charCodeAt(end - 1) & 0xfc00) === 0xd800) end--;
  return { text: s.slice(at, end), next: end < s.length ? end : null };
};

/** whether a body read came back short (gone meanwhile) */
type Gone = { gone: boolean };

/**
 * A body's quoted-printable lines, fed a stretch at a time, a line at a time, so a large body's encoding is never one
 * string; found as it goes, never split whole (Codex code review round 5 #3: splitting a 10 MB body took 169 ms before
 * its first piece). A stretch is encoded synchronously: an await per line was most of an export's time.
 */
class QpBody {
  private batch = "";
  /** a short line's start, read with the next stretch */
  private rest = "";
  /** a long one's, begun */
  private line: QpLine | null = null;
  constructor(private out: Pieces) {}

  private *lines(it: Iterable<string>): Generator<string, void> {
    for (const l of it) {
      this.batch += `${l}\n`;
      if (this.batch.length >= 16 * 1024) {
        yield* put(this.out, this.batch);
        this.batch = "";
      }
    }
  }

  *stretch(more: string, last: boolean): Generator<string, void> {
    const text = this.rest + more;
    this.rest = "";
    const eol = /\r\n|\r|\n/g;
    let start = 0;
    for (let m = eol.exec(text); m; m = eol.exec(text)) {
      // a "\r" ending a stretch may be half a "\r\n": the next one says
      if (!last && m[0] === "\r" && eol.lastIndex === text.length) break;
      yield* this.lines((this.line ?? new QpLine()).feed(text.slice(start, m.index), true));
      this.line = null;
      start = eol.lastIndex;
    }
    let tail = text.slice(start);
    if (last) {
      yield* this.lines((this.line ?? new QpLine()).feed(tail, true));
      this.line = null;
      if (this.batch) yield* put(this.out, this.batch);
      this.batch = "";
      return;
    }
    // a long line's start is encoded now, short of a "\r" or half a surrogate pair at its end; a short one waits
    if (tail.length >= QP_SLICE) {
      const c = tail.charCodeAt(tail.length - 1);
      const cut = c === 13 || (c & 0xfc00) === 0xd800 ? tail.length - 1 : tail.length;
      yield* this.lines((this.line ??= new QpLine()).feed(tail.slice(0, cut), false));
      tail = tail.slice(cut);
    }
    this.rest = tail;
  }
}

/** a body read a stretch at a time (Codex code review round 6 #4: a whole 20 MB body was read before the first piece) */
async function* quotedPrintable(out: Pieces, body: MboxBody, state: Gone): AsyncGenerator<string, void> {
  const qp = new QpBody(out);
  for (let at: number | null = 0; ; ) {
    const r: Awaited<ReturnType<MboxBody>> = await body(at, BODY_READ);
    if (r === null) state.gone = true;
    at = r?.next ?? null;
    yield* qp.stretch(r?.text ?? "", at === null);
    if (at === null) return;
  }
}

async function* textPart(out: Pieces, type: "plain" | "html", body: string | MboxBody, state: Gone): AsyncGenerator<string, void> {
  yield* put(out, `Content-Type: text/${type}; charset=utf-8\nContent-Transfer-Encoding: quoted-printable\n\n`);
  yield* quotedPrintable(out, typeof body === "string" ? stringBody(body) : body, state);
}

/** The attachment's stored chunks as 76-character base64 lines; false: a chunk wasn't there (the part ends short). */
async function* base64Part(out: Pieces, a: MboxAttachment, index: number, read: MboxChunkReader): AsyncGenerator<string, boolean> {
  const chunks = Math.ceil(a.size / ATTACHMENT_CHUNK);
  let carry = "";
  for (let i = 0; i < chunks; i++) {
    const chunk = await read(index, i);
    if (chunk === null || !B64.test(chunk) || (i < chunks - 1 && chunk.length !== CHUNK_B64)) {
      if (carry) yield* put(out, `${carry}\n`);
      return false;
    }
    const s = carry + chunk;
    const whole = s.length - (s.length % 76);
    let lines = "";
    for (let p = 0; p < whole; p += 76) lines += `${s.slice(p, p + 76)}\n`;
    carry = s.slice(whole);
    if (lines) yield* put(out, lines);
  }
  if (carry) yield* put(out, `${carry}\n`);
  return true;
}

/**
 * One message, mboxrd-framed, as pieces of whole lines (≤ MBOX_PIECE each), ending with the blank line that
 * separates it from the next. Attachments not on this computer are named in `X-Terno-Missing-Attachment`.
 */
export async function* mboxMessage(m: MboxMessage, read: MboxChunkReader): AsyncGenerator<string, MboxStats> {
  const out = new Pieces(`From - ${asctime(m.date)}\n`);
  const stored = m.attachments.map((a, i) => ({ a, i })).filter((x) => x.a.stored);
  let missing = m.attachments.length - stored.length;
  const text = m.bodyText ?? (m.bodyHtml === null ? "" : null);
  const alternative = text !== null && m.bodyHtml !== null;
  let head = "";
  if (m.rfcMessageId) head += header("Message-ID", [angle(m.rfcMessageId)]);
  if (m.inReplyTo) head += header("In-Reply-To", [angle(m.inReplyTo)]);
  if (m.references.length) head += header("References", m.references.map(angle));
  head += addresses("From", [m.from]);
  head += addresses("To", m.to);
  head += addresses("Cc", m.cc);
  head += addresses("Reply-To", m.replyTo);
  head += header("Date", [rfc5322Date(m.date)]);
  head += textHeader("Subject", m.subject);
  if (m.listId) head += header("List-Id", [angle(m.listId)]);
  for (const { filename } of m.attachments.filter((a) => !a.stored)) head += textHeader("X-Terno-Missing-Attachment", filename || "attachment");
  if (m.partial) head += "X-Terno-Partial-Body: true\n";
  head += "MIME-Version: 1.0\n";
  if (stored.length) head += `Content-Type: multipart/mixed; boundary="${MIXED}"\n\n--${MIXED}\n`;
  yield* put(out, head);
  const state: Gone = { gone: false };
  if (alternative) {
    yield* put(out, `Content-Type: multipart/alternative; boundary="${ALT}"\n\n--${ALT}\n`);
    yield* textPart(out, "plain", text!, state);
    yield* put(out, `--${ALT}\n`);
    yield* textPart(out, "html", m.bodyHtml!, state);
    yield* put(out, `--${ALT}--\n`);
  } else yield* textPart(out, text === null ? "html" : "plain", text ?? m.bodyHtml!, state);
  for (const { a, i } of stored) {
    const params = fileParams(a.filename);
    const inline = a.contentId ? `Content-ID: ${angle(a.contentId)}\n` : "";
    yield* put(out, `--${MIXED}\nContent-Type: ${mimeType(a.mime)}; ${params.name}\nContent-Disposition: ${a.contentId ? "inline" : "attachment"}; ${params.disposition}\n${inline}Content-Transfer-Encoding: base64\n\n`);
    if (!(yield* base64Part(out, a, i, read))) missing++;
  }
  if (stored.length) yield* put(out, `--${MIXED}--\n`);
  yield* put(out, "\n");
  if (!out.empty) yield out.take();
  return { missingAttachments: missing, partialBody: m.partial || state.gone };
}
