/**
 * The process's diagnostics: `log`, `breadcrumb` and `captureError`, usable
 * from any module before or after the host installs its sink (main, the
 * backend, a renderer, the web worker, MCP). Nothing here throws, does I/O or
 * waits: entries are sanitized against their code's schema and handed to the
 * sink, which batches, writes and forwards.
 */
import { CODES, type DiagCode, type FieldsFor } from "./codes";
import { appRelative, errorClass, isExpected, normalizeError, type NormalizedError } from "./error";
import { sanitizeField, type Fields } from "./fields";
import { Ring } from "./ring";
import { scrubText } from "./scrub";
import type { Channel, Crumb, CrumbCategory, DiagContext, DiagEntry, ErrorRecord, Level, Proc, RecordKind } from "./types";

export interface DiagSink {
  /** every entry, already sanitized (hosts batch and write) */
  write(entry: DiagEntry): void;
  /** an unexpected error or a crash: the host keeps the record and decides on reporting */
  capture(record: ErrorRecord): void;
  /** the ring, mirrored every couple of seconds so a hard crash still has its trail */
  mirror?(crumbs: Crumb[]): void;
  /** fatal: whatever is pending goes out now (synchronously where the platform can) */
  flush?(): void;
}

export interface DiagOptions {
  proc: Proc;
  version: string;
  build: string;
  channel: Channel;
  /** one run of the app (main hands its own to the processes it starts) */
  session?: string;
  sink?: DiagSink;
  /** machine and run details for records (os, locale, memory, accounts…) */
  context?: () => Partial<DiagContext>;
  now?: () => number;
  ringSize?: number;
  /** mirror the ring every this many ms, or after this many new crumbs */
  mirrorEveryMs?: number;
  mirrorEvery?: number;
}

/** A random 32-hex id (a report's event id). */
export function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?(): string } }).crypto;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, "");
  let s = "";
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

const CATEGORY: Record<string, CrumbCategory> = { nav: "nav", action: "action", sync: "sync", rpc: "rpc", ui: "ui", send: "action", compose: "action", print: "action", ops: "sync" };
const categoryOf = (code: string): CrumbCategory => CATEGORY[code.slice(0, code.indexOf("."))] ?? "lifecycle";

/** Fields of `code` that fit its schema; everything else is dropped (no key survives that the code didn't declare). */
export function sanitizeFields(code: DiagCode, fields: unknown): Fields | undefined {
  if (!fields || typeof fields !== "object") return undefined;
  let out: Fields | undefined;
  for (const name of CODES[code].fields) {
    const raw = (fields as Record<string, unknown>)[name];
    if (raw === undefined) continue;
    const v = sanitizeField(name, raw);
    if (v !== undefined) (out ??= {})[name] = v;
  }
  return out;
}

interface State {
  o: Required<Pick<DiagOptions, "proc" | "version" | "build" | "channel" | "session" | "now" | "mirrorEveryMs" | "mirrorEvery">> & DiagOptions;
  ring: Ring<Crumb>;
  /** entries logged before a sink was installed (bounded) */
  early: DiagEntry[];
  mirroredAt: number;
  mirroredPushes: number;
  /** a trailing mirror, armed only while crumbs wait (an idle process has no timer) */
  mirrorTimer: ReturnType<typeof setTimeout> | null;
  started: number;
  /** fingerprint → last capture time: the same failure in a loop is one record, counted */
  seen: Map<string, { at: number; record: ErrorRecord }>;
  capturesThisMinute: { minute: number; n: number };
}

let state: State = makeState({ proc: "renderer", version: "0", build: "0", channel: "dev" });

function makeState(o: DiagOptions): State {
  const now = o.now ?? Date.now;
  return {
    o: { ...o, session: o.session ?? newId(), now, mirrorEveryMs: o.mirrorEveryMs ?? 2000, mirrorEvery: o.mirrorEvery ?? 20 },
    ring: new Ring<Crumb>(o.ringSize ?? 100),
    early: [],
    mirroredAt: now(),
    mirroredPushes: 0,
    mirrorTimer: null,
    started: now(),
    seen: new Map(),
    capturesThisMinute: { minute: 0, n: 0 },
  };
}

/**
 * Installs the process's sink and identity. Entries logged before (module
 * load, early boot) are kept in the ring and handed over now.
 */
export function installDiag(options: DiagOptions): void {
  if (state.mirrorTimer) clearTimeout(state.mirrorTimer);
  const early = state.early;
  const crumbs = state.ring.toArray();
  state = makeState(options);
  for (const c of crumbs) state.ring.push(c);
  // what was carried over isn't news: only crumbs from here on call for a mirror
  state.mirroredPushes = state.ring.pushed;
  for (const e of early) safe(() => options.sink?.write({ ...e, session: state.o.session, version: options.version, build: options.build, proc: options.proc }));
}

export function setDiagSink(sink: DiagSink | undefined): void {
  state.o.sink = sink;
}

export function diagSession(): string {
  return state.o.session;
}

export function diagOptions(): Readonly<DiagOptions> {
  return state.o;
}

function safe(fn: () => void): void {
  try {
    fn();
  } catch {
    // a logging failure never throws and never reports itself
  }
}

function emit(level: Level, code: DiagCode, fields: unknown, detail?: unknown, err?: NormalizedError): void {
  safe(() => {
    const s = state;
    const ts = s.o.now();
    const clean = sanitizeFields(code, fields);
    const entry: DiagEntry = { ts, level, proc: s.o.proc, code, session: s.o.session, version: s.o.version, build: s.o.build };
    if (clean) entry.fields = clean;
    if (detail !== undefined) entry.msg = scrubText(detail);
    if (err) entry.err = err;
    pushCrumb(s, { ts, cat: categoryOf(code), code, level, ...(clean ? { fields: clean } : {}) });
    if (s.o.sink) s.o.sink.write(entry);
    else if (s.early.length < 200) s.early.push(entry);
  });
}

function pushCrumb(s: State, crumb: Crumb): void {
  s.ring.push(crumb);
  const sink = s.o.sink;
  if (!sink?.mirror) return;
  if (s.ring.pushed - s.mirroredPushes >= s.o.mirrorEvery || crumb.ts - s.mirroredAt >= s.o.mirrorEveryMs) mirrorNow(s);
  else s.mirrorTimer ??= unref(setTimeout(() => safe(() => mirrorNow(s)), s.o.mirrorEveryMs));
}

/** Node: a pending mirror never keeps a process alive. */
const unref = <T,>(t: T): T => ((t as { unref?: () => void }).unref?.(), t);

function mirrorNow(s: State): void {
  if (s.mirrorTimer) clearTimeout(s.mirrorTimer);
  s.mirrorTimer = null;
  s.mirroredAt = s.o.now();
  s.mirroredPushes = s.ring.pushed;
  s.o.sink?.mirror?.(s.ring.toArray());
}

/** Structured log lines: a code and its typed fields; info and above also become breadcrumbs. */
export const log = {
  info<C extends DiagCode>(code: C, fields?: FieldsFor<C>, detail?: unknown): void {
    emit("info", code, fields, detail);
  },
  warn<C extends DiagCode>(code: C, fields?: FieldsFor<C>, detail?: unknown): void {
    emit("warn", code, fields, detail);
  },
  error<C extends DiagCode>(code: C, fields?: FieldsFor<C>, detail?: unknown): void {
    emit("error", code, fields, detail);
  },
};

/** A trail entry only (no log line): navigation, actions, RPC timings. O(1), no I/O. */
export function breadcrumb<C extends DiagCode>(cat: CrumbCategory, code: C, fields?: FieldsFor<C>): void {
  safe(() => {
    const s = state;
    const clean = sanitizeFields(code, fields);
    pushCrumb(s, { ts: s.o.now(), cat, code, level: "info", ...(clean ? { fields: clean } : {}) });
  });
}

/** Forgets which failures were seen this minute (tests that capture the same failure on purpose). */
export function resetRepeats(): void {
  state.seen.clear();
  state.capturesThisMinute = { minute: 0, n: 0 };
}

export function breadcrumbs(): Crumb[] {
  return state.ring.toArray();
}

/** Mirrors now whatever hasn't been (a process about to stop). */
export function mirrorBreadcrumbs(): void {
  safe(() => {
    if (state.ring.pushed !== state.mirroredPushes) mirrorNow(state);
  });
}

export interface CaptureOptions<C extends DiagCode> {
  code: C;
  fields?: FieldsFor<C>;
  /** the process can't go on (uncaught exception): the record is flushed now */
  fatal?: boolean;
  /** overrides the classification (isExpected) */
  expected?: boolean;
  kind?: RecordKind;
}

/** Same failure, same place: one record per minute at most, counted. */
const REPEAT_MS = 60_000;
const MAX_PER_MINUTE = 20;

/**
 * Logs an error with its code; an unexpected one becomes a record (with the
 * breadcrumbs and context) that the host keeps and may report. Returns the
 * record's id, or null when it was expected or folded into an earlier one.
 */
export function captureError<C extends DiagCode>(error: unknown, o: CaptureOptions<C>): string | null {
  let id: string | null = null;
  safe(() => {
    const s = state;
    const normalized = normalizeError(error);
    const expected = o.expected ?? isExpected(error);
    const fields = { errorClass: errorClass(error), ...o.fields } as unknown as FieldsFor<C>;
    emit(expected ? "warn" : o.fatal ? "fatal" : "error", o.code, fields, normalized.message, { ...normalized, frames: normalized.frames.slice(0, 12) });
    if (expected) return;
    const now = s.o.now();
    const top = normalized.frames[0];
    const fingerprint = `${o.code}|${normalized.name}|${top?.file}:${top?.line}`;
    const prev = s.seen.get(fingerprint);
    if (!o.fatal && prev && now - prev.at < REPEAT_MS) {
      prev.record.count = (prev.record.count ?? 1) + 1;
      return;
    }
    const minute = Math.floor(now / 60_000);
    if (s.capturesThisMinute.minute !== minute) s.capturesThisMinute = { minute, n: 0 };
    if (!o.fatal && ++s.capturesThisMinute.n > MAX_PER_MINUTE) return;
    const record: ErrorRecord = {
      id: newId(),
      ts: now,
      kind: o.kind ?? (o.fatal ? "crash" : "error"),
      proc: s.o.proc,
      code: o.code,
      fatal: o.fatal === true,
      error: normalized,
      crumbs: s.ring.toArray(),
      context: diagContext(),
      debugIds: debugIdsFor(normalized.frames.map((f) => f.file)),
    };
    const clean = sanitizeFields(o.code, fields);
    if (clean) record.fields = clean;
    s.seen.set(fingerprint, { at: now, record });
    if (s.seen.size > 200) s.seen.delete(s.seen.keys().next().value!);
    s.o.sink?.capture(record);
    if (o.fatal) s.o.sink?.flush?.();
    id = record.id;
  });
  return id;
}

export function diagContext(): DiagContext {
  const s = state;
  const base: DiagContext = { version: s.o.version, build: s.o.build, channel: s.o.channel, session: s.o.session, os: "other", uptimeS: Math.round((s.o.now() - s.started) / 1000) };
  let extra: Partial<DiagContext> = {};
  try {
    extra = s.o.context?.() ?? {};
  } catch {
    // context is best effort
  }
  return { ...base, ...extra };
}

/**
 * Source-map debug ids this process's bundles registered at load (the build
 * injects `_sentryDebugIds[stack] = id` into every file), for the given
 * app-relative files.
 */
let debugIdCache: { n: number; byFile: Map<string, string> } = { n: -1, byFile: new Map() };
export function debugIdsFor(files: readonly string[]): Record<string, string> | undefined {
  const registry = (globalThis as { _sentryDebugIds?: Record<string, string> })._sentryDebugIds;
  if (!registry) return undefined;
  const keys = Object.keys(registry);
  if (keys.length !== debugIdCache.n) {
    const byFile = new Map<string, string>();
    for (const stack of keys) {
      const file = /\(?((?:[a-z]+:\/\/|\/)[^\s():]+):\d+:\d+\)?/.exec(stack.split("\n").find((l) => /:\d+:\d+/.test(l)) ?? "")?.[1];
      if (file) byFile.set(appRelative(file), registry[stack]!);
    }
    debugIdCache = { n: keys.length, byFile };
  }
  let out: Record<string, string> | undefined;
  for (const f of files) {
    const id = debugIdCache.byFile.get(f);
    if (id) (out ??= {})[f] = id;
  }
  return out;
}
