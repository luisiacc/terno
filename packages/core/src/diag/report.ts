/**
 * The remote report: a Sentry event built from a record by allowlist, with
 * no free text at all. The exception's value is our code (never the
 * message); frames keep function, app-relative file, line and column; the
 * breadcrumbs carry codes and typed fields. What "Ver qué se envía" shows is
 * this object, and it is exactly what the transport sends.
 */
import type { ErrorRecord } from "./types";

export interface ReportOptions {
  /** random, kept on this machine, resettable; never derived from an address */
  installId: string;
  /** terno@<version>+<sha> */
  release: string;
  environment: string;
}

export interface ReportFrame {
  function?: string;
  filename: string;
  abs_path: string;
  lineno?: number;
  colno?: number;
  in_app: boolean;
}

export interface ReportEvent {
  event_id: string;
  timestamp: number;
  platform: "javascript";
  level: "error" | "fatal";
  release: string;
  environment: string;
  tags: Record<string, string>;
  contexts: {
    app: { app_version: string; build: string };
    os: { name: string; version?: string };
    device?: { arch?: string; memory_mb?: number };
    runtime?: { name: string; version?: string };
    terno: Record<string, string | number | boolean>;
  };
  exception: { values: { type: string; value: string; mechanism: { type: "terno"; handled: boolean }; stacktrace?: { frames: ReportFrame[] } }[] };
  breadcrumbs: { timestamp: number; category: string; message: string; level: "info" | "warning" | "error" | "fatal"; data?: Record<string, string | number | boolean> }[];
  user: { id: string };
  fingerprint: string[];
  debug_meta?: { images: { type: "sourcemap"; code_file: string; debug_id: string }[] };
}

const OS_NAME = { darwin: "macOS", win32: "Windows", linux: "Linux", web: "Web", other: "Other" } as const;
const LEVEL = { info: "info", warn: "warning", error: "error", fatal: "fatal" } as const;

export function buildReport(r: ErrorRecord, o: ReportOptions): ReportEvent {
  const ctx = r.context;
  const frames: ReportFrame[] = (r.error?.frames ?? [])
    .slice()
    // Sentry wants the outermost frame first
    .reverse()
    .map((f) => {
      const frame: ReportFrame = { filename: `app:///${f.file}`, abs_path: `app:///${f.file}`, in_app: !/^(node:|electron\/|internal\/|native)/.test(f.file) };
      if (f.fn) frame.function = f.fn;
      if (f.line !== undefined) frame.lineno = f.line;
      if (f.col !== undefined) frame.colno = f.col;
      return frame;
    });
  const terno: Record<string, string | number | boolean> = { kind: r.kind, proc: r.proc, ...r.fields };
  if (ctx.uptimeS !== undefined) terno.uptime_s = ctx.uptimeS;
  if (ctx.accounts) {
    terno.accounts_imap = ctx.accounts.imap;
    terno.accounts_gmail = ctx.accounts.gmail;
  }
  if (r.count) terno.repeats = r.count;
  const runtime = ctx.runtime ? /^([a-z]+)-(.+)$/.exec(ctx.runtime) : null;
  const tags: Record<string, string> = { proc: r.proc, code: r.code, kind: r.kind, session: ctx.session, channel: ctx.channel };
  if (ctx.engine) tags.engine = ctx.engine;
  if (ctx.locale) tags.locale = ctx.locale;
  const event: ReportEvent = {
    event_id: r.id,
    timestamp: Math.round(r.ts) / 1000,
    platform: "javascript",
    level: r.fatal ? "fatal" : "error",
    release: o.release,
    environment: o.environment,
    tags,
    contexts: {
      app: { app_version: ctx.version, build: ctx.build },
      os: ctx.osVersion ? { name: OS_NAME[ctx.os], version: ctx.osVersion } : { name: OS_NAME[ctx.os] },
      terno,
    },
    exception: {
      values: [{ type: r.error?.name ?? kindName(r), value: r.code, mechanism: { type: "terno", handled: !r.fatal }, ...(frames.length ? { stacktrace: { frames } } : {}) }],
    },
    breadcrumbs: r.crumbs.map((c) => ({ timestamp: Math.round(c.ts) / 1000, category: c.cat, message: c.code, level: LEVEL[c.level], ...(c.fields ? { data: { ...c.fields } } : {}) })),
    user: { id: o.installId },
    // one issue per code and error class (the stack splits it further when it differs)
    fingerprint: ["{{ default }}", r.code],
  };
  if (ctx.arch || ctx.memMb !== undefined) event.contexts.device = { ...(ctx.arch ? { arch: ctx.arch } : {}), ...(ctx.memMb !== undefined ? { memory_mb: ctx.memMb } : {}) };
  if (runtime) event.contexts.runtime = { name: runtime[1]!, version: runtime[2] };
  const images = Object.entries(r.debugIds ?? {}).map(([file, debugId]) => ({ type: "sourcemap" as const, code_file: `app:///${file}`, debug_id: debugId }));
  if (images.length) event.debug_meta = { images };
  return event;
}

/** A crash without a JS error still needs an exception type: what happened, in words Sentry groups by. */
function kindName(r: ErrorRecord): string {
  return { error: "Error", crash: "Crash", unclean_exit: "UncleanExit", renderer_gone: "RendererGone", backend_exit: "BackendExit", child_gone: "ChildProcessGone" }[r.kind];
}

export function releaseName(version: string, sha: string): string {
  return `terno@${version}+${sha}`;
}
