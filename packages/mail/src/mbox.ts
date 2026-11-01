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
/** ASCII that can go as it is: never what a reader takes for an encoded word (Codex code review round 23 #2: a
 * subject `=?UTF-8?B?SGVsbG8=?=` came back `Hello`), which goes encoded like any other text */
const plain = (v: string) => ASCII.test(v) && !v.includes("=?");
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

/** UTF-8 bytes of a code point (a lone surrogate is written as U+FFFD, three) */
const utf8Length = (cp: number) => (cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4);

/**
 * RFC 2047 encoded words (each ≤ 75 characters, never splitting a character), made one at a time as they're asked
 * for: a long value is never encoded whole before its first line goes out (Codex code review round 21 #5: a
 * 100,000-character subject was one 336,000-character piece, 28 ms in one call).
 */
function* encodedWords(v: string): Generator<string, void> {
  let chunk = "";
  let size = 0;
  for (const ch of v) {
    const n = utf8Length(ch.codePointAt(0)!);
    if (size + n > WORD_BYTES && chunk) {
      yield `=?UTF-8?B?${base64Text(chunk)}?=`;
      chunk = "";
      size = 0;
    }
    chunk += ch;
    size += n;
  }
  if (chunk) yield `=?UTF-8?B?${base64Text(chunk)}?=`;
}

/** A word longer than this can't stay on one line (RFC 5322's 998): it goes as encoded words, which fold. */
const LONG = 900;
/** RFC 5322's longest line, its CRLF aside */
const LINE_MAX = 998;

/**
 * A text value's words: ASCII as it is, the rest (and an over-long word) as encoded words. A word carries the spaces
 * before it but the one `header()` puts back, so a run of them survives folding (Codex code review round 22 #2:
 * `Invoice  42` was read back as `Invoice 42`); unfolding only takes out the line break.
 */
function* textWords(value: string): Generator<string, void> {
  const v = oneLine(value).trim();
  if (!plain(v)) return yield* encodedWords(v);
  let encoded = false;
  let first = true;
  for (const [m] of v.matchAll(/ *[^ ]+/g)) {
    const w = first ? m : m.slice(1);
    first = false;
    // the space between two encoded words is dropped by a reader: one after another carries it inside
    if (w.length > LONG) yield* encodedWords(encoded ? ` ${w}` : w);
    else yield w;
    encoded = w.length > LONG;
  }
}

/** `Name: a b c` as lines, folded at the spaces between words so lines stay within 78 where they can. */
function* header(name: string, words: Iterable<string>): Generator<string, void> {
  let line = `${name}:`;
  let first = true;
  for (const w of words) {
    if (!first && line.length + 1 + w.length > 78) {
      yield `${line}\n`;
      line = ` ${w}`;
    } else line += ` ${w}`;
    first = false;
  }
  yield `${line}\n`;
}

const angle = (id: string) => `<${oneLine(id).replace(/[<>\s]/g, "")}>`;

/**
 * The longest identifier written (Message-ID, In-Reply-To, References' ids, List-Id, Content-ID), in characters
 * between its brackets: its line stays within RFC 5322's 998 (`In-Reply-To: <…>` is 15 more). Ingestion doesn't
 * bound them (Codex code review round 22 #1: a 200,000-character Message-ID was one 200,017-character piece); a real
 * one is well under 250. Longer is left out, named in `X-Terno-Omitted-Id`.
 */
const ID_MAX = 900;
/** References' ids, all told: the newest that fit are kept, the count left out in `X-Terno-Omitted-References` */
const REFERENCES_MAX = 8 * 1024;

/** `<id>`, or null when it's empty or over ID_MAX (one that long isn't cleaned: its length says enough) */
function boundedId(id: string): string | null {
  if (id.length > 4 * ID_MAX) return null;
  const a = angle(id);
  return a.length > 2 && a.length <= ID_MAX + 2 ? a : null;
}

/** an identifier header, or the diagnostic that names it left out */
function* idHeader(name: string, id: string): Generator<string, void> {
  const a = boundedId(id);
  yield a ? `${name}: ${a}\n` : `X-Terno-Omitted-Id: ${name}\n`;
}

/** References: the newest ids that fit REFERENCES_MAX, oldest first, folded a line an id at most */
function* referencesHeader(refs: readonly string[]): Generator<string, void> {
  const kept: string[] = [];
  let size = 0;
  for (let i = refs.length - 1; i >= 0; i--) {
    const a = boundedId(refs[i]!);
    if (a === null) continue;
    if (size + a.length > REFERENCES_MAX) break;
    kept.push(a);
    size += a.length + 1;
  }
  if (kept.length) yield* header("References", kept.reverse());
  if (kept.length < refs.length) yield `X-Terno-Omitted-References: ${refs.length - kept.length}\n`;
}

/**
 * The longest addr-spec written, in characters. RFC 5321 caps one at 320 (64 for the local part, 255 for the domain)
 * and a path at 256; this is generous past both, and keeps its line within RFC 5322's 998. Ingestion doesn't bound
 * them (Codex code review round 25 #3: a 200,000-character address was one 200,020-character piece); longer is left
 * out, named in `X-Terno-Omitted-Address`.
 */
const ADDRESS_MAX = 900;

/** an addr-spec as written, "" when there's none, null when it's over ADDRESS_MAX (one that long isn't cleaned) */
function boundedEmail(email: string): string | null {
  if (email.length > 4 * ADDRESS_MAX) return null;
  const e = asciiEmail(oneLine(email).replace(/[<>\s]/g, ""));
  return e.length <= ADDRESS_MAX ? e : null;
}

/** Each address's words (its name's, then `<email>`), a comma after all but the last. */
function* addressWords(items: readonly { name: string; email: string }[]): Generator<string, void> {
  for (const [i, a] of items.entries()) {
    const email = a.email;
    const comma = i < items.length - 1 ? "," : "";
    const name = oneLine(a.name).trim();
    if (!name) {
      yield `${email}${comma}`;
      continue;
    }
    // measured as written: escaping can double a name (Codex code review round 26 #3: 800 quotes made a 1,606-character To line)
    const word = plain(name) && /[()<>[\]:;@\\,."]/.test(name) ? `"${name.replace(/["\\]/g, "\\$&")}"` : name;
    if (!plain(name) || word.length > LONG) yield* encodedWords(name);
    else yield word;
    yield `<${email}>${comma}`;
  }
}

/** an address header of the addresses that fit, and the diagnostic that names it for each left out */
function* addresses(name: string, list: readonly Address[]): Generator<string, void> {
  const items: { name: string; email: string }[] = [];
  let omitted = 0;
  for (const a of list) {
    const email = boundedEmail(a.email);
    if (email === null) omitted++;
    else if (email) items.push({ name: a.name, email });
  }
  if (items.length) yield* header(name, addressWords(items));
  for (let i = 0; i < omitted; i++) yield `X-Terno-Omitted-Address: ${name}\n`;
}

/** A MIME type as a token pair, else octet-stream. */
const mimeType = (mime: string) => (/^[\w.+-]+\/[\w.+-]+$/.test(mime) ? mime.toLowerCase() : "application/octet-stream");

/** `words`, each followed by `between` but the last (one word of look-ahead, so a long list is never held whole) */
function* joined(words: Iterable<string>, between: string, first = "", last = ""): Generator<string, void> {
  let held: string | null = null;
  for (const w of words) {
    if (held !== null) yield `${held}${between}`;
    held = held === null ? `${first}${w}` : w;
  }
  if (held !== null) yield `${held}${last}`;
}

/** A file name as RFC 2231 extended pieces of at most 60 characters, never splitting an escape. */
function* extendedName(v: string): Generator<string, void> {
  let piece = "";
  for (const ch of v) {
    let e: string;
    try {
      e = encodeURIComponent(ch).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    } catch {
      e = "%EF%BF%BD";
    }
    if (piece.length + e.length > 60 && piece) {
      yield piece;
      piece = "";
    }
    piece += e;
  }
  if (piece) yield piece;
}

/** An attachment's Content-Type and Content-Disposition lines, a long or non-ASCII name folded (round 21 #5). */
function* partHeaders(a: MboxAttachment, cid: string | null): Generator<string, void> {
  const v = oneLine(a.filename).trim() || "attachment";
  const type = mimeType(a.mime);
  const disposition = cid ? "inline" : "attachment";
  // measured as written, escapes and the header's own text with it (Codex code review round 26 #3: 800 quotes made
  // a 1,644-character Content-Disposition line)
  const q = plain(v) && v.length <= LONG ? `"${v.replace(/["\\]/g, "\\$&")}"` : null;
  const typeLine = q && `Content-Type: ${type}; name=${q}`;
  const dispositionLine = q && `Content-Disposition: ${disposition}; filename=${q}`;
  if (typeLine && dispositionLine && typeLine.length <= LINE_MAX && dispositionLine.length <= LINE_MAX) {
    yield `${typeLine}\n`;
    yield `${dispositionLine}\n`;
    return;
  }
  // encoded words for the readers that don't follow RFC 2231, folded inside their quotes; RFC 2231 (in continuations
  // when long) for those that do
  yield* header("Content-Type", (function* () {
    yield `${type};`;
    yield* joined(encodedWords(v), "", 'name="', '"');
  })());
  yield* header("Content-Disposition", (function* () {
    yield `${disposition};`;
    yield* joined(encodedWords(v), "", 'filename="', '";');
    const pieces = extendedName(v)[Symbol.iterator]();
    const one = pieces.next();
    const two = pieces.next();
    if (one.done) return;
    if (two.done) return yield `filename*=UTF-8''${one.value}`;
    yield* joined((function* () {
      yield `filename*0*=UTF-8''${one.value}`;
      let i = 1;
      for (let r: IteratorResult<string, void> = two; !r.done; r = pieces.next()) yield `filename*${i++}*=${r.value}`;
    })(), ";");
  })());
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
  /** a space or tab that ended the last stretch: whether it ends the line (encoded) is known with the next one */
  private held = "";
  *feed(part: string, ends: boolean): Generator<string, void> {
    if (this.held) { part = this.held + part; this.held = ""; }
    const from = !this.begun && part.startsWith("From ");
    // Codex code review round 10 #2: emitted as is and then ended by the next stretch, a decoder dropped it
    const tail = part.charCodeAt(part.length - 1);
    if (!ends && (tail === 0x20 || tail === 0x09)) { this.held = part.slice(-1); part = part.slice(0, -1); }
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

/** lines made as they're asked for, into the pieces a batch at a time */
function* putLines(out: Pieces, lines: Iterable<string>): Generator<string, void> {
  let batch = "";
  for (const l of lines) {
    batch += l;
    if (batch.length >= 16 * 1024) {
      yield* put(out, batch);
      batch = "";
    }
  }
  if (batch) yield* put(out, batch);
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
  // line by line into the pieces: a header of any length is never one string (Codex code review round 21 #5)
  yield* putLines(out, (function* () {
    if (m.rfcMessageId) yield* idHeader("Message-ID", m.rfcMessageId);
    if (m.inReplyTo) yield* idHeader("In-Reply-To", m.inReplyTo);
    if (m.references.length) yield* referencesHeader(m.references);
    yield* addresses("From", [m.from]);
    yield* addresses("To", m.to);
    yield* addresses("Cc", m.cc);
    yield* addresses("Reply-To", m.replyTo);
    yield* header("Date", [rfc5322Date(m.date)]);
    yield* header("Subject", textWords(m.subject));
    if (m.listId) yield* idHeader("List-Id", m.listId);
    for (const a of m.attachments) if (!a.stored) yield* header("X-Terno-Missing-Attachment", textWords(a.filename || "attachment"));
    if (m.partial) yield "X-Terno-Partial-Body: true\n";
    yield "MIME-Version: 1.0\n";
    if (stored.length) yield `Content-Type: multipart/mixed; boundary="${MIXED}"\n\n--${MIXED}\n`;
  })());
  const state: Gone = { gone: false };
  if (alternative) {
    yield* put(out, `Content-Type: multipart/alternative; boundary="${ALT}"\n\n--${ALT}\n`);
    yield* textPart(out, "plain", text!, state);
    yield* put(out, `--${ALT}\n`);
    yield* textPart(out, "html", m.bodyHtml!, state);
    yield* put(out, `--${ALT}--\n`);
  } else yield* textPart(out, text === null ? "html" : "plain", text ?? m.bodyHtml!, state);
  for (const { a, i } of stored) {
    yield* putLines(out, (function* () {
      yield `--${MIXED}\n`;
      // inline only with its Content-ID: without one a reader takes an inline text part for the body
      const cid = a.contentId ? boundedId(a.contentId) : null;
      yield* partHeaders(a, cid);
      if (cid) yield `Content-ID: ${cid}\n`;
      else if (a.contentId) yield "X-Terno-Omitted-Id: Content-ID\n";
      yield "Content-Transfer-Encoding: base64\n\n";
    })());
    if (!(yield* base64Part(out, a, i, read))) missing++;
  }
  if (stored.length) yield* put(out, `--${MIXED}--\n`);
  yield* put(out, "\n");
  if (!out.empty) yield out.take();
  return { missingAttachments: missing, partialBody: m.partial || state.gone };
}
