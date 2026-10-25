import type { Revision } from "../search";
import type { SliceClock } from "./slices";

/**
 * The portable snapshot container: typed arrays laid out 8-byte aligned
 * behind a JSON header, with a checksum over everything after it, so a
 * truncated, torn or bit-flipped file is detected and never trusted.
 *
 *   [0..4)   magic "UIS1"
 *   [4..8)   u32 header length H
 *   [8..12)  u32 checksum of bytes [12, end)
 *   [12..12+H) header JSON { tokenizer, format, identity, revision, meta, sections }
 *   pad to 8, then the sections, each 8-byte aligned
 */
export type Section = Uint8Array | Uint16Array | Uint32Array | Int32Array | Float64Array | { strings: readonly string[] };

export interface SnapshotKind {
  tokenizer: number;
  format: number;
  identity: string;
}

type ArrayType = "u8" | "u16" | "u32" | "i32" | "f64";
interface Entry {
  name: string;
  type: ArrayType;
  offset: number;
  length: number;
}

const MAGIC = [0x55, 0x49, 0x53, 0x31];
const CTORS = { u8: Uint8Array, u16: Uint16Array, u32: Uint32Array, i32: Int32Array, f64: Float64Array } as const;

function typeOf(a: Exclude<Section, { strings: readonly string[] }>): ArrayType {
  if (a instanceof Uint8Array) return "u8";
  if (a instanceof Uint16Array) return "u16";
  if (a instanceof Uint32Array) return "u32";
  if (a instanceof Int32Array) return "i32";
  return "f64";
}

const align8 = (n: number) => (n + 7) & ~7;

/** JSON as ASCII bytes (non-ASCII escaped), so no text codec is needed on any platform. */
function ascii(json: string): Uint8Array {
  const escaped = json.replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return Uint8Array.from(escaped, (c) => c.charCodeAt(0));
}

/** FNV-style word hash: any single changed word changes the result; sliced. */
async function checksum(bytes: Uint8Array, from: number, clock: SliceClock): Promise<number> {
  const words = new Uint32Array(bytes.buffer as ArrayBuffer, bytes.byteOffset + from, (bytes.length - from) >>> 2);
  // four independent lanes (twice as fast as one); each is a bijection per word, so any one changed word changes it
  let h1 = 0x811c9dc5 ^ words.length;
  let h2 = 0x9e3779b9;
  let h3 = 0x85ebca6b;
  let h4 = 0xc2b2ae35;
  const P = 0x01000193;
  const CHUNK = 1 << 18;
  const whole = words.length & ~3;
  for (let i = 0; i < whole; i += CHUNK) {
    const end = Math.min(whole, i + CHUNK);
    for (let j = i; j < end; j += 4) {
      h1 = Math.imul(h1 ^ words[j]!, P);
      h2 = Math.imul(h2 ^ words[j + 1]!, P);
      h3 = Math.imul(h3 ^ words[j + 2]!, P);
      h4 = Math.imul(h4 ^ words[j + 3]!, P);
    }
    await clock.tick();
  }
  for (let j = whole; j < words.length; j++) h1 = Math.imul(h1 ^ words[j]!, P);
  const rotl = (x: number, r: number) => (x << r) | (x >>> (32 - r));
  let h = h1 ^ rotl(h2, 7) ^ rotl(h3, 13) ^ rotl(h4, 19);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return h >>> 0;
}

/** Copies `src` into `dst` at `at` in chunks, yielding between them. */
export async function copySliced(dst: Uint8Array, at: number, src: Uint8Array, clock: SliceClock): Promise<void> {
  const CHUNK = 1 << 21;
  for (let i = 0; i < src.length; i += CHUNK) {
    dst.set(src.subarray(i, Math.min(src.length, i + CHUNK)), at + i);
    await clock.tick();
  }
}

/**
 * Lays the sections out in one new buffer, in slices: the sections must not
 * change until it resolves. Seal it before writing it anywhere.
 */
export async function packSnapshot(kind: SnapshotKind, revision: Revision, meta: Record<string, unknown>, sections: Record<string, Section>, clock: SliceClock): Promise<Uint8Array> {
  const arrays: [string, Exclude<Section, { strings: readonly string[] }>][] = [];
  for (const [name, s] of Object.entries(sections)) {
    if ("strings" in s) {
      const lens = new Uint32Array(s.strings.length);
      let total = 0;
      for (let i = 0; i < s.strings.length; i++) total += lens[i] = s.strings[i]!.length;
      const chars = new Uint16Array(total);
      let at = 0;
      for (let k = 0; k < s.strings.length; k++) {
        const str = s.strings[k]!;
        for (let i = 0; i < str.length; i++) chars[at++] = str.charCodeAt(i);
        if ((k & 4095) === 0) await clock.tick();
      }
      arrays.push([`${name}.len`, lens], [`${name}.chars`, chars]);
    } else arrays.push([name, s]);
  }
  const entries: Entry[] = [];
  let size = 0;
  for (const [name, a] of arrays) {
    entries.push({ name, type: typeOf(a), offset: size, length: a.length });
    size = align8(size + a.byteLength);
  }
  const header = ascii(JSON.stringify({ ...kind, revision, meta, sections: entries }));
  const base = align8(12 + header.length);
  const out = new Uint8Array(base + size);
  out.set(MAGIC, 0);
  const view = new DataView(out.buffer);
  view.setUint32(4, header.length, true);
  out.set(header, 12);
  for (let i = 0; i < arrays.length; i++) {
    const a = arrays[i]![1];
    await copySliced(out, base + entries[i]!.offset, new Uint8Array(a.buffer, a.byteOffset, a.byteLength), clock);
  }
  return out;
}

/** Writes the checksum into a packed snapshot (in slices). */
export async function sealSnapshot(packed: Uint8Array, clock: SliceClock): Promise<Uint8Array> {
  new DataView(packed.buffer, packed.byteOffset).setUint32(8, await checksum(packed, 12, clock), true);
  return packed;
}

export interface SectionReader {
  u8(name: string): Uint8Array<ArrayBuffer>;
  u16(name: string): Uint16Array<ArrayBuffer>;
  u32(name: string): Uint32Array<ArrayBuffer>;
  i32(name: string): Int32Array<ArrayBuffer>;
  f64(name: string): Float64Array<ArrayBuffer>;
  strings(name: string): string[];
}

/** The snapshot's revision, meta and sections, or null if it is damaged or of another kind. */
export async function readSnapshot(
  input: Uint8Array,
  expect: SnapshotKind,
  clock: SliceClock,
): Promise<{ revision: Revision; meta: Record<string, unknown>; sections: SectionReader } | null> {
  if (input.length < 16 || MAGIC.some((b, i) => input[i] !== b)) return null;
  // typed views need the container 8-byte aligned in its buffer
  const bytes = input.byteOffset % 8 === 0 ? input : input.slice();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const hl = view.getUint32(4, true);
  const base = align8(12 + hl);
  if (base > bytes.length || bytes.length % 4 !== 0) return null;
  let header: SnapshotKind & { revision: Revision; meta: Record<string, unknown>; sections: Entry[] };
  try {
    header = JSON.parse(String.fromCharCode(...bytes.subarray(12, 12 + hl)));
  } catch {
    return null;
  }
  if (header.tokenizer !== expect.tokenizer || header.format !== expect.format || header.identity !== expect.identity) return null;
  const rev = header.revision;
  if (!rev || typeof rev.epoch !== "string" || !Number.isInteger(rev.seq) || rev.seq < 0 || !Array.isArray(header.sections)) return null;
  if ((await checksum(bytes, 12, clock)) !== view.getUint32(8, true)) return null;
  const byName = new Map<string, Entry>();
  for (const e of header.sections) {
    const C = CTORS[e.type];
    if (!C || !Number.isInteger(e.offset) || !Number.isInteger(e.length) || e.offset % 8 !== 0) return null;
    if (base + e.offset + e.length * C.BYTES_PER_ELEMENT > bytes.length) return null;
    byName.set(e.name, e);
  }
  const get = <T extends ArrayType>(name: string, type: T): InstanceType<(typeof CTORS)[T]> => {
    const e = byName.get(name);
    if (!e || e.type !== type) throw new Error(`snapshot section ${name} missing`);
    return new CTORS[type](bytes.buffer as ArrayBuffer, bytes.byteOffset + base + e.offset, e.length) as InstanceType<(typeof CTORS)[T]>;
  };
  const sections: SectionReader = {
    u8: (n) => get(n, "u8"),
    u16: (n) => get(n, "u16"),
    u32: (n) => get(n, "u32"),
    i32: (n) => get(n, "i32"),
    f64: (n) => get(n, "f64"),
    strings: (n) => {
      const lens = get(`${n}.len`, "u32");
      const chars = get(`${n}.chars`, "u16");
      // one string for all of them, then slices: decoding each on its own is several times slower
      const parts: string[] = [];
      // apply, not a spread: spreading a typed array goes through its iterator (4× slower)
      for (let c = 0; c < chars.length; c += 8192) parts.push(String.fromCharCode.apply(null, chars.subarray(c, Math.min(chars.length, c + 8192)) as unknown as number[]));
      const all = parts.join("");
      const out: string[] = [];
      let at = 0;
      for (let i = 0; i < lens.length; i++) {
        const end = at + lens[i]!;
        if (end > all.length) throw new Error("snapshot strings truncated");
        out.push(all.slice(at, end));
        at = end;
      }
      if (at !== all.length) throw new Error("snapshot strings misaligned");
      return out;
    },
  };
  return { revision: { epoch: rev.epoch, seq: rev.seq }, meta: header.meta ?? {}, sections };
}
