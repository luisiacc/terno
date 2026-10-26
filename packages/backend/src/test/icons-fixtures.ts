/** Real images for the sender-icon tests and the e2e stub (plan 22): solid squares, any size. */
import { crc32, deflateSync } from "node:zlib";

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/** A w × h PNG in one color (RGBA). `extra` chunks go before the image data (an acTL makes it "animated"). */
export function pngBytes(w: number, h = w, rgba: [number, number, number, number] = [229, 9, 20, 255], extra: { type: string; data: Uint8Array }[] = []): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const row = Buffer.alloc(1 + w * 4);
  for (let x = 0; x < w; x++) row.set(rgba, 1 + x * 4);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const out = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    ...extra.map((e) => chunk(e.type, e.data)),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array()),
  ]);
  return new Uint8Array(out);
}

/** An ICO holding the given PNGs (and optionally a BMP entry of `bmp` px). */
export function icoBytes(pngs: { px: number; bytes: Uint8Array }[], bmp?: number): Uint8Array {
  const images: { px: number; data: Uint8Array }[] = pngs.map((p) => ({ px: p.px, data: p.bytes }));
  if (bmp) {
    const header = Buffer.alloc(40);
    header.writeUInt32LE(40, 0);
    header.writeInt32LE(bmp, 4);
    header.writeInt32LE(bmp * 2, 8);
    header.writeUInt16LE(1, 12);
    header.writeUInt16LE(32, 14);
    images.push({ px: bmp, data: new Uint8Array(Buffer.concat([header, Buffer.alloc(bmp * bmp * 4 + Math.ceil(bmp / 32) * 4 * bmp)])) });
  }
  const dir = Buffer.alloc(6 + images.length * 16);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(images.length, 4);
  let offset = dir.length;
  images.forEach((img, i) => {
    const e = 6 + i * 16;
    dir[e] = img.px >= 256 ? 0 : img.px;
    dir[e + 1] = img.px >= 256 ? 0 : img.px;
    dir.writeUInt16LE(1, e + 4);
    dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(img.data.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += img.data.length;
  });
  return new Uint8Array(Buffer.concat([dir, ...images.map((i) => Buffer.from(i.data))]));
}

export const SAFE_SVG = `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 32 32"><defs><linearGradient id="g"><stop offset="0" stop-color="#e50914"/></linearGradient></defs><rect width="32" height="32" fill="url(#g)"/><use href="#g"/></svg>`;
