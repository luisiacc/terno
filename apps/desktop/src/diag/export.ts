/**
 * "Export Diagnostics": a .zip of Terno's own diagnostics folders only
 * (logs, crash records, rings), every line validated again on the way out,
 * plus system info and a README saying what is inside. Symlinks and anything
 * that isn't a regular file are skipped; native crash dumps go in only when
 * the user ticked the box (they can hold fragments of mail).
 */
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { sanitizeCrumbs, sanitizeEntry, sanitizeRecord, PROCS, type Proc } from "@terno/core/diag";
import type { DiagPaths } from "./store";

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

export interface ZipEntry {
  name: string;
  data: Buffer;
}

/** A minimal zip (deflate, no encryption, no zip64): enough for a few MB of text. */
export function zip(entries: ZipEntry[], date = new Date()): Buffer {
  const dosTime = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const packed = deflateRawSync(e.data);
    const crc = crc32(e.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

/** Regular files directly in (or under) dir, never through a symlink. */
function regularFiles(dir: string, depth = 0): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const n of names) {
    const p = join(dir, n);
    const st = lstatSync(p, { throwIfNoEntry: false });
    if (!st || st.isSymbolicLink()) continue;
    if (st.isDirectory() && depth < 3) out.push(...regularFiles(p, depth + 1));
    else if (st.isFile() && st.size <= MAX_FILE_BYTES) out.push(p);
  }
  return out;
}

/** A log file, line by line through the same validation as live entries. */
function cleanLog(text: string): string {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const raw = JSON.parse(line) as { proc?: unknown };
      const proc = PROCS.includes(raw.proc as Proc) ? (raw.proc as Proc) : null;
      const entry = proc && sanitizeEntry(raw, proc);
      if (entry) out.push(JSON.stringify(entry));
    } catch {
      // a torn line from a crash
    }
  }
  return out.length ? `${out.join("\n")}\n` : "";
}

export const README = `Terno diagnostics
=================

You created this file in Terno (Settings → General → Diagnostics, or Help →
Export Diagnostics). Nobody receives it unless you send it.

It contains:
- logs/: each process's log (main, mail engine, window). Every line is an event
  code with typed fields (accounts by kind, durations, error codes). Error
  messages are kept scrubbed: no addresses, subjects, passwords, tokens or paths
  with your user name.
- crashes/: one record per unexpected error or crash: the kind of error, the
  call stack in Terno's code and the last actions (codes and numeric ids only,
  never content).
- system.json: Terno's version and build, the system, architecture and language.
- native/ (only if you ticked it): memory dumps of native crashes. They can
  contain fragments of your mail.

It contains none of your mail, contacts, settings or keys.
`;

export interface ExportInput {
  paths: DiagPaths;
  system: Record<string, unknown>;
  /** Electron's crashDumps folder, when the user asked for native dumps */
  nativeDir?: string | null;
}

/** The archive's entries, every one validated again; bounded in total. */
export function collectExport(input: ExportInput): ZipEntry[] {
  const entries: ZipEntry[] = [
    { name: "README.txt", data: Buffer.from(README) },
    { name: "system.json", data: Buffer.from(JSON.stringify(input.system, null, 2)) },
  ];
  let total = 0;
  const add = (name: string, data: Buffer) => {
    if (!data.length || total + data.length > MAX_TOTAL_BYTES) return;
    total += data.length;
    entries.push({ name, data });
  };
  for (const file of regularFiles(input.paths.logs)) {
    if (!/\.jsonl(\.\d)?$/.test(file)) continue;
    add(`logs/${relative(input.paths.logs, file)}`, Buffer.from(cleanLog(readFileSync(file, "utf8"))));
  }
  for (const file of regularFiles(input.paths.crashes)) {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      if (file.endsWith("rings.json")) {
        const rings = Object.fromEntries(Object.entries((raw as { rings?: Record<string, unknown> }).rings ?? {}).map(([k, v]) => [k.replace(/[^a-z0-9#]/g, ""), sanitizeCrumbs(v)]));
        add("crashes/rings.json", Buffer.from(JSON.stringify({ rings }, null, 2)));
        continue;
      }
      const r = sanitizeRecord(raw);
      if (r) add(`crashes/${relative(input.paths.crashes, file)}`, Buffer.from(JSON.stringify(r, null, 2)));
    } catch {
      // unreadable: skipped
    }
  }
  if (input.nativeDir) {
    for (const file of regularFiles(input.nativeDir)) if (file.endsWith(".dmp")) add(`native/${relative(input.nativeDir, file)}`, readFileSync(file));
  }
  return entries;
}
