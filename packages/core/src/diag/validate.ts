/**
 * What crosses a process boundary (renderer → main, backend → main, a record
 * read back from disk or an export) is checked again here: a compromised or
 * buggy sender can't forge fields, claim another process, or smuggle text.
 */
import { isDiagCode } from "./codes";
import { sanitizeFields } from "./diag";
import type { Frame, NormalizedError } from "./error";
import { CHANNELS, CRUMB_CATEGORIES, LEVELS, RECORD_KINDS, type Crumb, type DiagContext, type DiagEntry, type ErrorRecord, type Proc } from "./types";

const ID = /^[A-Za-z0-9_.+-]{1,64}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLASS = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const FN = /^[A-Za-z0-9_$.<>[\] -]{1,80}$/;
const FILE = /^[A-Za-z0-9_.@:/+-]{1,200}$/;
const LOCALE = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,2}$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown, min: number, max: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : undefined);
const str = (v: unknown, re: RegExp) => (typeof v === "string" && re.test(v) ? v : undefined);
const oneOf = <T extends string>(v: unknown, values: readonly T[]) => (values.includes(v as T) ? (v as T) : undefined);

export function sanitizeEntry(raw: unknown, proc: Proc): DiagEntry | null {
  if (!isObj(raw) || !isDiagCode(raw.code)) return null;
  const level = oneOf(raw.level, LEVELS);
  const ts = num(raw.ts, 0, 8.64e15);
  const session = str(raw.session, ID);
  const version = str(raw.version, ID);
  const build = str(raw.build, ID);
  if (!level || ts === undefined || !session || !version || !build) return null;
  const entry: DiagEntry = { ts, level, proc, code: raw.code, session, version, build };
  const fields = sanitizeFields(raw.code, raw.fields);
  if (fields) entry.fields = fields;
  const err = sanitizeError(raw.err, 12);
  if (err) entry.err = err;
  return entry;
}

export function sanitizeCrumbs(raw: unknown, max = 100): Crumb[] {
  if (!Array.isArray(raw)) return [];
  const out: Crumb[] = [];
  for (const c of raw.slice(-max)) {
    if (!isObj(c) || !isDiagCode(c.code)) continue;
    const cat = oneOf(c.cat, CRUMB_CATEGORIES);
    const level = oneOf(c.level, LEVELS) ?? "info";
    const ts = num(c.ts, 0, 8.64e15);
    if (!cat || ts === undefined) continue;
    const crumb: Crumb = { ts, cat, code: c.code, level };
    const fields = sanitizeFields(c.code, c.fields);
    if (fields) crumb.fields = fields;
    out.push(crumb);
  }
  return out;
}

export function sanitizeFrames(raw: unknown, max = 40): Frame[] {
  if (!Array.isArray(raw)) return [];
  const out: Frame[] = [];
  for (const f of raw.slice(0, max)) {
    if (!isObj(f)) continue;
    // app-relative only: an absolute or home path names the machine's user
    const file = typeof f.file === "string" && FILE.test(f.file) && !/^\/|(^|\/)(Users|home)\//.test(f.file) ? f.file : "<redacted>";
    const frame: Frame = { file };
    const fn = str(f.fn, FN);
    if (fn) frame.fn = fn;
    const line = num(f.line, 0, 10_000_000);
    const col = num(f.col, 0, 10_000_000);
    if (line !== undefined) frame.line = line;
    if (col !== undefined) frame.col = col;
    out.push(frame);
  }
  return out;
}

export function sanitizeError(raw: unknown, maxFrames = 40): NormalizedError | undefined {
  if (!isObj(raw)) return undefined;
  const err: NormalizedError = { name: str(raw.name, CLASS) ?? "Error", frames: sanitizeFrames(raw.frames, maxFrames) };
  const code = str(raw.code, /^[A-Za-z0-9_.-]{1,40}$/);
  if (code) err.code = code;
  const status = num(raw.status, 100, 599);
  if (status !== undefined) err.status = status;
  return err;
}

export function sanitizeContext(raw: unknown): DiagContext | null {
  if (!isObj(raw)) return null;
  const version = str(raw.version, ID);
  const build = str(raw.build, ID);
  const session = str(raw.session, ID);
  const channel = oneOf(raw.channel, CHANNELS);
  if (!version || !build || !session || !channel) return null;
  const ctx: DiagContext = { version, build, channel, session, os: oneOf(raw.os, ["darwin", "win32", "linux", "web", "other"] as const) ?? "other" };
  const osVersion = str(raw.osVersion, ID);
  if (osVersion) ctx.osVersion = osVersion;
  const arch = oneOf(raw.arch, ["arm64", "x64", "ia32", "other"] as const);
  if (arch) ctx.arch = arch;
  const locale = str(raw.locale, LOCALE);
  if (locale) ctx.locale = locale;
  const runtime = str(raw.runtime, ID);
  if (runtime) ctx.runtime = runtime;
  const engine = oneOf(raw.engine, ["node-sqlite", "wasm-opfs", "wasm-memory", "idb", "other"] as const);
  if (engine) ctx.engine = engine;
  const uptimeS = num(raw.uptimeS, 0, 1e9);
  if (uptimeS !== undefined) ctx.uptimeS = uptimeS;
  const memMb = num(raw.memMb, 0, 1e7);
  if (memMb !== undefined) ctx.memMb = memMb;
  if (isObj(raw.accounts)) ctx.accounts = { imap: num(raw.accounts.imap, 0, 1000) ?? 0, gmail: num(raw.accounts.gmail, 0, 1000) ?? 0 };
  return ctx;
}

export function sanitizeRecord(raw: unknown, proc?: Proc): ErrorRecord | null {
  if (!isObj(raw) || !isDiagCode(raw.code)) return null;
  const id = str(raw.id, HEX32);
  const ts = num(raw.ts, 0, 8.64e15);
  const kind = oneOf(raw.kind, RECORD_KINDS);
  const recordProc = proc ?? oneOf(raw.proc, ["main", "backend", "renderer", "worker", "mcp"] as const);
  const context = sanitizeContext(raw.context);
  if (!id || ts === undefined || !kind || !recordProc || !context) return null;
  const record: ErrorRecord = { id, ts, kind, proc: recordProc, code: raw.code, fatal: raw.fatal === true, crumbs: sanitizeCrumbs(raw.crumbs), context };
  const fields = sanitizeFields(raw.code, raw.fields);
  if (fields) record.fields = fields;
  const error = sanitizeError(raw.error);
  if (error) record.error = error;
  if (isObj(raw.debugIds)) {
    for (const [file, debugId] of Object.entries(raw.debugIds).slice(0, 40)) {
      if (FILE.test(file) && typeof debugId === "string" && UUID.test(debugId)) (record.debugIds ??= {})[file] = debugId.toLowerCase();
    }
  }
  const count = num(raw.count, 1, 1_000_000);
  if (count !== undefined && count > 1) record.count = count;
  return record;
}
