/**
 * What an icon really is (plan 22). The bytes decide, never the server's
 * content-type: PNG, JPEG, WebP, ICO and SVG by their signatures, with their
 * dimensions read from the header. Anything else, anything animated, too
 * small, too large to decode cheaply or (SVG) able to run or load something
 * is refused.
 */
export type IconMime = "image/png" | "image/jpeg" | "image/webp" | "image/x-icon" | "image/svg+xml";

export interface IconImage {
  mime: IconMime;
  bytes: Uint8Array;
  /** the smaller side in px (SVG: scalable, reported as 512) */
  px: number;
}

export type Refusal = "unknown-format" | "animated" | "too-small" | "too-large" | "malformed" | "unsafe-svg";

export const MIN_PX = 16;
/** decoded at most 1024 × 1024 × 4 bytes */
export const MAX_PX = 1024;
/** what is kept per icon (the download cap is larger: a favicon.ico holds several images, one is kept) */
export const MAX_STORED = 64 * 1024;
const SVG_MAX_ELEMENTS = 1500;
const SCALABLE_PX = 512;

const u16le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8);
const u32le = (b: Uint8Array, i: number) => (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0;
const u16be = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const u32be = (b: Uint8Array, i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const isPng = (b: Uint8Array, at = 0) => b.length >= at + 24 && PNG_SIG.every((v, i) => b[at + i] === v);

function png(b: Uint8Array): { w: number; h: number } | Refusal {
  if (ascii(b, 12, 4) !== "IHDR") return "malformed";
  const w = u32be(b, 16);
  const h = u32be(b, 20);
  // an acTL chunk before the image data is an animated PNG
  for (let i = 8; i + 8 <= b.length; ) {
    const len = u32be(b, i);
    const type = ascii(b, i + 4, 4);
    if (type === "acTL") return "animated";
    if (type === "IDAT" || type === "IEND") break;
    i += 12 + len;
  }
  return { w, h };
}

function jpeg(b: Uint8Array): { w: number; h: number } | Refusal {
  for (let i = 2; i + 9 < b.length; ) {
    if (b[i] !== 0xff) return "malformed";
    const marker = b[i + 1]!;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2;
      continue;
    }
    const len = u16be(b, i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { h: u16be(b, i + 5), w: u16be(b, i + 7) };
    if (len < 2) return "malformed";
    i += 2 + len;
  }
  return "malformed";
}

function webp(b: Uint8Array): { w: number; h: number } | Refusal {
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8 " && b.length >= 30) return { w: u16le(b, 26) & 0x3fff, h: u16le(b, 28) & 0x3fff };
  if (chunk === "VP8L" && b.length >= 25) {
    const [b0, b1, b2, b3] = [b[21]!, b[22]!, b[23]!, b[24]!];
    return { w: 1 + (((b1 & 0x3f) << 8) | b0), h: 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) };
  }
  if (chunk === "VP8X" && b.length >= 30) {
    if (b[20]! & 0x02) return "animated";
    return { w: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), h: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)) };
  }
  return "malformed";
}

function sized(mime: IconMime, bytes: Uint8Array, d: { w: number; h: number } | Refusal): IconImage | Refusal {
  if (typeof d === "string") return d;
  const px = Math.min(d.w, d.h);
  if (px < MIN_PX) return "too-small";
  if (d.w > MAX_PX || d.h > MAX_PX) return "too-large";
  if (bytes.length > MAX_STORED) return "too-large";
  return { mime, bytes, px };
}

/**
 * An ICO's directory, validated (count, offsets and lengths inside the file);
 * the largest image that fits MAX_STORED is kept: a PNG entry as a PNG, a BMP
 * entry re-wrapped as a one-image ICO.
 */
function ico(b: Uint8Array): IconImage | Refusal {
  const count = u16le(b, 4);
  if (count < 1 || count > 32 || b.length < 6 + count * 16) return "malformed";
  const entries: { w: number; h: number; off: number; len: number; dir: number }[] = [];
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 16;
    const len = u32le(b, e + 8);
    const off = u32le(b, e + 12);
    if (len < 40 || off < 6 + count * 16 || off + len > b.length) return "malformed";
    entries.push({ w: b[e]! || 256, h: b[e + 1]! || 256, off, len, dir: e });
  }
  entries.sort((x, y) => Math.min(y.w, y.h) - Math.min(x.w, x.h));
  let last: Refusal = "too-large";
  for (const e of entries) {
    const data = b.subarray(e.off, e.off + e.len);
    if (isPng(data)) {
      const r = sized("image/png", data.slice(), png(data));
      if (typeof r !== "string") return r;
      last = r;
      continue;
    }
    // a BMP entry (BITMAPINFOHEADER: 40 bytes, height doubled for the AND mask)
    if (u32le(data, 0) !== 40) {
      last = "malformed";
      continue;
    }
    const w = Math.abs(u32le(data, 4) | 0);
    const h = Math.abs(u32le(data, 8) | 0) / 2;
    if (w !== e.w || h !== e.h) {
      last = "malformed";
      continue;
    }
    const out = new Uint8Array(22 + data.length);
    out.set([0, 0, 1, 0, 1, 0]);
    // the entry as the directory had it (size, colors, planes, depth), then its new length and offset
    out.set(b.subarray(e.dir, e.dir + 8), 6);
    out[6] = e.w === 256 ? 0 : e.w;
    out[7] = e.h === 256 ? 0 : e.h;
    out.set([data.length & 0xff, (data.length >> 8) & 0xff, (data.length >> 16) & 0xff, data.length >>> 24], 14);
    out.set([22, 0, 0, 0], 18);
    out.set(data, 22);
    const r = sized("image/x-icon", out, { w: e.w, h: e.h });
    if (typeof r !== "string") return r;
    last = r;
  }
  return last;
}

/** Anything an SVG drawn as an image doesn't need, and anything that runs, loads or costs: refused, not rewritten. */
const SVG_UNSAFE: RegExp[] = [
  /<!DOCTYPE|<!ENTITY/i,
  /<\s*script\b/i,
  /<\s*foreignObject\b/i,
  /<\s*(iframe|embed|object|audio|video|image|feImage|filter|fe[A-Z]\w*|animate\w*|set|handler|listener)\b/,
  /\son[a-z]+\s*=/i,
  /javascript:/i,
  /data:/i,
  /@import/i,
  /url\(\s*['"]?\s*(?!#)/i,
  /(?:xlink:)?href\s*=\s*["']?\s*(?!#)[^"'\s>]/i,
];

function svg(b: Uint8Array): IconImage | Refusal {
  if (b.length > MAX_STORED) return "too-large";
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(b).replace(/^﻿/, "");
  } catch {
    return "malformed";
  }
  if (SVG_UNSAFE.some((re) => re.test(text))) return "unsafe-svg";
  if ((text.match(/<[a-zA-Z]/g)?.length ?? 0) > SVG_MAX_ELEMENTS) return "too-large";
  return { mime: "image/svg+xml", bytes: b, px: SCALABLE_PX };
}

/** The image's format by its bytes, or why it is refused. */
export function readIcon(b: Uint8Array): IconImage | Refusal {
  if (b.length < 12) return "unknown-format";
  if (isPng(b)) return sized("image/png", b, png(b));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return sized("image/jpeg", b, jpeg(b));
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return sized("image/webp", b, webp(b));
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return ico(b);
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "animated";
  // SVG: markup whose first element is <svg> (after an XML declaration, comments and whitespace)
  const head = new TextDecoder().decode(b.subarray(0, 512)).replace(/^﻿/, "");
  // (a DOCTYPE is recognized, so that it's refused as unsafe rather than unknown)
  if (/^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*|<!DOCTYPE[^>[]*(\[[\s\S]*?\])?\s*>\s*)*<svg[\s>]/i.test(head)) return svg(b);
  return "unknown-format";
}
