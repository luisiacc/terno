/**
 * RFC 2047 encoded words, leniently (plan 34). Only ever applied to a
 * phrase or a comment whose place in the header is already known, so what
 * an encoded word says can never become an address or a separator (the
 * Mailsploit class of spoofs: `=?UTF-8?Q?boss@corp.com_<boss@corp.com>?=
 * <attacker@evil>`). What other clients get wrong is tolerated: adjacent
 * words split mid-character, a word inside quotes, an unknown or mislabelled
 * charset, RFC 2231's `charset*lang`, a word missing its opening or closing
 * delimiter (repairOrphans).
 */

/** (structural: Node's types declare TextDecoder as a value only) */
type Decoder = { decode(input: Uint8Array): string };
const decoders = new Map<string, Decoder | null>();
const UTF8_FATAL: Decoder = new TextDecoder("utf-8", { fatal: true });
const CP1252: Decoder = new TextDecoder("windows-1252");

function decoderFor(label: string): Decoder | null {
  let d = decoders.get(label);
  if (d === undefined) {
    try {
      d = new TextDecoder(label);
    } catch {
      d = null;
    }
    decoders.set(label, d);
  }
  return d;
}

/** Bytes in a charset; UTF-8 that isn't (a mislabelled Latin-1 header) and unknown charsets fall back to UTF-8, then CP1252. */
export function decodeBytes(bytes: Uint8Array, charset: string): string {
  const label = charset.toLowerCase().split("*")[0]!.trim();
  const d = /^(utf-?8|unicode-1-1-utf-8)$/.test(label) ? null : decoderFor(label);
  if (d) return d.decode(bytes);
  try {
    return UTF8_FATAL.decode(bytes);
  } catch {
    return CP1252.decode(bytes);
  }
}

const utf8 = new TextEncoder();
const HEX = /^[0-9A-Fa-f]{2}$/;

/** Q encoding (`_` a space, `=XX` a byte); a raw 8-bit character stands for its UTF-8 bytes. */
function qBytes(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x5f) out.push(0x20);
    else if (c === 0x3d && HEX.test(text.slice(i + 1, i + 3))) {
      out.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (c < 0x80) out.push(c);
    else for (const b of utf8.encode(text[i]!)) out.push(b);
  }
  return Uint8Array.from(out);
}

function bBytes(text: string): Uint8Array | null {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, "");
  if (!clean) return new Uint8Array();
  try {
    const bin = atob(clean.padEnd(Math.ceil(clean.length / 4) * 4, "="));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

const wordBytes = (enc: string, text: string) => (enc === "Q" || enc === "q" ? qBytes(text) : bBytes(text));

/** A complete encoded word (Q text may hold spaces, against the RFC but common). */
const WORD = /=\?([^?\s]+)\?([QqBb])\?([^?]*)\?=/g;

/**
 * The text with its encoded words decoded. Words separated only by
 * whitespace are joined (RFC 2047 §6.2), and the bytes of neighbours in the
 * same charset are decoded together (UTF-8 split between two words).
 */
export function decodeEncodedWords(text: string, show: (decoded: string) => string = (s) => s): string {
  if (!text.includes("=?")) return text;
  let out = "";
  let last = 0;
  let pending: { charset: string; chunks: Uint8Array[] } | null = null;
  const flush = () => {
    if (!pending) return;
    const size = pending.chunks.reduce((n, c) => n + c.length, 0);
    const all = new Uint8Array(size);
    let at = 0;
    for (const c of pending.chunks) {
      all.set(c, at);
      at += c.length;
    }
    out += show(decodeBytes(all, pending.charset));
    pending = null;
  };
  for (const m of text.matchAll(WORD)) {
    const between = text.slice(last, m.index);
    const bytes = wordBytes(m[2]!, m[3]!);
    const charset = m[1]!.toLowerCase().split("*")[0]!;
    if (!bytes) {
      flush();
      out += between + m[0];
    } else if (pending && /^\s*$/.test(between)) {
      if (pending.charset === charset) pending.chunks.push(bytes);
      else {
        flush();
        pending = { charset, chunks: [bytes] };
      }
    } else {
      flush();
      out += between;
      pending = { charset, chunks: [bytes] };
    }
    last = m.index + m[0].length;
  }
  flush();
  return out + text.slice(last);
}

/** An encoded word that lost its end: `=?UTF-8?Q?Jos=C3=A9_P=C3=A9rez`. */
const ORPHAN_START = /=\?([^?\s]+)\?([QqBb])\?((?:(?!\?=).)*)$/;
/** A run that lost its start: `José_David_Sucre_L.?=`. */
const ORPHAN_END = /(^|\s)([^\s]*?)\?=(?=\s|$)/g;

/**
 * Encoded words some client cut in half: the half is decoded as Q (or B)
 * text in UTF-8 and its delimiters dropped. Only the run touching a stray
 * delimiter is touched; underscores anywhere else stay.
 */
export function repairOrphans(text: string): string {
  if (!text.includes("?=") && !text.includes("=?")) return text;
  let s = text.replace(ORPHAN_END, (_, lead: string, run: string) => lead + decodeBytes(qBytes(run), "utf-8"));
  const m = ORPHAN_START.exec(s);
  if (m) {
    const bytes = wordBytes(m[2]!, m[3]!);
    if (bytes) s = s.slice(0, m.index) + decodeBytes(bytes, m[1]!);
  }
  return s;
}

/** CP1252's characters 0x80–0x9F, by code point (the rest of Latin-1 maps to itself). */
const CP1252_HIGH: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e,
  0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

/** A UTF-8 lead byte read as CP1252, then a continuation byte read the same way: "Ã©" is how "é" looks then. */
export const MOJIBAKE = /[Â-ô][\u0080-¿ŒœŠšŸŽžƒˆ˜–—‘-‚“-„†-•…‰‹›€™]/;

/**
 * UTF-8 that went through a Latin-1/CP1252 reading on the way ("JosÃ© PÃ©rez"):
 * decoded again, only when every character fits a CP1252 byte and the bytes
 * are valid UTF-8 (text that merely has accents never is).
 */
export function repairMojibake(text: string): string {
  if (!MOJIBAKE.test(text)) return text;
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const b = c <= 0xff ? c : CP1252_HIGH[c];
    if (b === undefined) return text;
    bytes[i] = b;
  }
  try {
    return UTF8_FATAL.decode(bytes);
  } catch {
    return text;
  }
}
