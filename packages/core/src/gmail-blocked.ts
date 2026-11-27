/**
 * Plan 293 (CASA 5.2.1): the files Gmail won't send, checked before a Gmail account tries. Gmail documents them at
 * https://support.google.com/mail/answer/6590 (read 2026-11-27): "To protect your account from potential viruses and
 * harmful software, Gmail doesn't allow you to attach: certain types of files, including their compressed form (like
 * .gz or .bz2 files) or when found within archives (like .zip or .tgz files) […] password-protected archives with
 * archived content", and "Gmail blocks messages that may spread viruses, like messages that include executable
 * files". Only that is checked: the list exactly as the page gives it, and executables by their content, so a renamed
 * one is caught too. Malicious macros are Gmail's call (nothing here can tell malice). What can't be inspected (a
 * malformed or ZIP64 archive, more entries than the bound) is allowed: Gmail decides, Terno never guesses.
 */

/** The page's list, in its order. */
export const GMAIL_BLOCKED_EXTENSIONS: readonly string[] = [
  "ade", "adp", "apk", "appx", "appxbundle", "bat", "cab", "chm", "cmd", "com", "cpl", "diagcab", "diagcfg", "diagpkg", "dll", "dmg", "ex", "ex_", "exe", "hta", "img", "ins", "iso", "isp", "jar", "jnlp", "js", "jse", "lib", "lnk", "mde", "mjs", "msc", "msi", "msix", "msixbundle", "msp", "mst", "nsh", "pif", "ps1", "scr", "sct", "shb", "sys", "vb", "vbe", "vbs", "vhd", "vxd", "wsc", "wsf", "wsh", "xll",
];
const BLOCKED = new Set(GMAIL_BLOCKED_EXTENSIONS);
/** the page's compressed forms */
const COMPRESSED = new Set(["gz", "bz2"]);

export type GmailBlock =
  /** a listed type, or its compressed form (`ext` is the listed one) */
  | { reason: "type"; ext: string }
  /** an archive holding a listed type */
  | { reason: "archive"; ext: string }
  /** a password-protected archive with files in it */
  | { reason: "protected" }
  /** a program, whatever its name says (Windows, Linux or macOS executable, or an extensionless script) */
  | { reason: "executable" };

/** How much of a file the check reads: the whole of an archive it opens, else its first bytes. */
export const GMAIL_HEAD_BYTES = 64 * 1024;
/** bounds on what an archive may cost to open */
const MAX_ENTRIES = 10_000;
const MAX_UNPACKED = 64 * 1024 * 1024;

const extensionsOf = (name: string): string[] => {
  const base = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1).toLowerCase();
  const parts = base.split(".");
  return parts.length > 1 ? parts.slice(1) : [];
};

/** A listed extension the name ends in, directly or under .gz / .bz2. */
function listedType(name: string): string | null {
  const exts = extensionsOf(name);
  const last = exts.at(-1);
  if (!last) return null;
  if (BLOCKED.has(last)) return last;
  const under = exts.at(-2);
  return last && COMPRESSED.has(last) && under && BLOCKED.has(under) ? under : null;
}

type ArchiveKind = "zip" | "tar" | "tgz";
function archiveKind(name: string): ArchiveKind | null {
  const exts = extensionsOf(name);
  const last = exts.at(-1), before = exts.at(-2);
  if (last === "zip") return "zip";
  if (last === "tgz" || (last === "gz" && before === "tar")) return "tgz";
  if (last === "tar") return "tar";
  return null;
}

/** Whether the check needs the whole file (an archive it opens) or only its first GMAIL_HEAD_BYTES. */
export function gmailNeedsWholeFile(name: string): boolean {
  return archiveKind(name) !== null;
}

const u16 = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8);
const u32 = (b: Uint8Array, at: number) => (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;
const be32 = (b: Uint8Array, at: number) => ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;

/** A program by its first bytes: PE (MZ), ELF, Mach-O (thin or fat), or a #! script with no extension. */
function executable(name: string, head: Uint8Array): boolean {
  if (head.length < 2) return false;
  if (head[0] === 0x4d && head[1] === 0x5a) return true; // MZ: Windows PE
  if (head.length >= 4) {
    const magic = be32(head, 0);
    if (magic === 0x7f454c46) return true; // \x7FELF
    if (magic === 0xfeedface || magic === 0xfeedfacf || magic === 0xcefaedfe || magic === 0xcffaedfe) return true; // Mach-O
    // fat Mach-O shares CAFEBABE with a Java class file: a fat header counts architectures (a few), a class file's
    // version is 45 or more (what file(1) tells them apart by)
    if ((magic === 0xcafebabe || magic === 0xcafebabf) && head.length >= 8) {
      const n = be32(head, 4);
      if (n >= 1 && n < 20) return true;
    }
  }
  // a Unix script run as a program; deploy.sh or notes.py name their type, and Gmail lists neither
  return head[0] === 0x23 && head[1] === 0x21 && extensionsOf(name).length === 0;
}

/** A zip's entries from its central directory; null when it can't be read (ZIP64, malformed, too many). */
function zipEntries(b: Uint8Array): { name: string; encrypted: boolean }[] | null {
  const floor = Math.max(0, b.length - 65_557);
  let eocd = -1;
  for (let at = b.length - 22; at >= floor; at--) if (u32(b, at) === 0x06054b50) { eocd = at; break; }
  if (eocd < 0) return null;
  const count = u16(b, eocd + 10);
  const offset = u32(b, eocd + 16);
  if (count === 0xffff || offset === 0xffffffff || count > MAX_ENTRIES) return null;
  const entries: { name: string; encrypted: boolean }[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let at = offset;
  for (let i = 0; i < count; i++) {
    if (at + 46 > b.length || u32(b, at) !== 0x02014b50) return null;
    const flags = u16(b, at + 8), nameLength = u16(b, at + 28), extra = u16(b, at + 30), comment = u16(b, at + 32);
    if (at + 46 + nameLength > b.length) return null;
    entries.push({ name: decoder.decode(b.subarray(at + 46, at + 46 + nameLength)), encrypted: (flags & 1) === 1 });
    at += 46 + nameLength + extra + comment;
  }
  return entries;
}

/** A tar's file names; null when it can't be read. */
function tarEntries(b: Uint8Array): string[] | null {
  const names: string[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const text = (from: number, length: number) => {
    const slice = b.subarray(from, from + length);
    const end = slice.indexOf(0);
    return decoder.decode(end < 0 ? slice : slice.subarray(0, end));
  };
  for (let at = 0; at + 512 <= b.length; ) {
    if (b.subarray(at, at + 512).every((x) => x === 0)) return names;
    if (names.length >= MAX_ENTRIES) return null;
    const size = Number.parseInt(text(at + 124, 12).trim() || "0", 8);
    if (!Number.isFinite(size) || size < 0) return null;
    const prefix = text(at + 345, 155);
    const type = String.fromCharCode(b[at + 156] ?? 0);
    // regular files (and their old form); pax and GNU long-name headers carry no file of their own
    if (type === "0" || type === "\0" || type === "7") names.push(prefix ? `${prefix}/${text(at, 100)}` : text(at, 100));
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

/** The platform's streams (browser and Node alike), typed here: core is built without the DOM's library. */
interface ByteReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
}
interface ByteStream {
  pipeThrough(t: unknown): ByteStream;
  getReader(): ByteReader;
}
type Streams = {
  ReadableStream?: new (source: { start(c: { enqueue(b: Uint8Array): void; close(): void }): void }) => ByteStream;
  DecompressionStream?: new (format: "gzip") => unknown;
};

/** gunzip within the bound; null when it can't (not gzip, bigger than the bound, or no streams here) */
async function gunzip(b: Uint8Array): Promise<Uint8Array | null> {
  const { ReadableStream: Readable, DecompressionStream: Decompression } = globalThis as Streams;
  if (!Readable || !Decompression) return null;
  try {
    const reader = new Readable({ start(c) { c.enqueue(b); c.close(); } }).pipeThrough(new Decompression("gzip")).getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      size += value.byteLength;
      if (size > MAX_UNPACKED) {
        void reader.cancel().catch(() => {});
        return null;
      }
      parts.push(value);
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.byteLength;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * What stops Gmail sending this file, or null. `bytes`: the whole file when gmailNeedsWholeFile(name), else at least
 * its first GMAIL_HEAD_BYTES (more is fine).
 */
export async function gmailBlocked(name: string, bytes: Uint8Array): Promise<GmailBlock | null> {
  const listed = listedType(name);
  if (listed) return { reason: "type", ext: listed };
  if (executable(name, bytes.subarray(0, GMAIL_HEAD_BYTES))) return { reason: "executable" };
  const kind = archiveKind(name);
  if (kind === "zip") {
    const entries = zipEntries(bytes);
    if (!entries) return null;
    for (const e of entries) {
      if (e.name.endsWith("/")) continue;
      const inner = listedType(e.name);
      if (inner) return { reason: "archive", ext: inner };
    }
    if (entries.some((e) => e.encrypted && !e.name.endsWith("/"))) return { reason: "protected" };
    return null;
  }
  if (kind === "tar" || kind === "tgz") {
    const tar = kind === "tgz" ? await gunzip(bytes) : bytes;
    const names = tar && tarEntries(tar);
    if (!names) return null;
    for (const n of names) {
      const inner = listedType(n);
      if (inner) return { reason: "archive", ext: inner };
    }
  }
  return null;
}
