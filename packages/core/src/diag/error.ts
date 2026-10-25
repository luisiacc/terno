/**
 * Errors as diagnostics: the class name, a scrubbed message (local only) and
 * stack frames reduced to app-relative files, plus the line between what the
 * user can fix (expected: logged, never reported) and what is our bug.
 */
import { scrubText } from "./scrub";

export interface Frame {
  /** the function, as the (minified) code names it */
  fn?: string;
  /** app-relative: dist/main.cjs, renderer/assets/index-abc.js, node:internal/… */
  file: string;
  line?: number;
  col?: number;
}

export interface NormalizedError {
  name: string;
  /** scrubbed; kept in local logs and records, never in a remote report */
  message: string;
  /** innermost first, as V8 prints them */
  frames: Frame[];
}

const MAX_FRAMES = 40;
const CLASS = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const FN = /^[A-Za-z0-9_$.<>[\] -]{1,80}$/;
const FILE = /^[A-Za-z0-9_.@:/+-]{1,200}$/;

/**
 * A user error (wrong password, offline, invalid input): shown to the user,
 * logged at warn, never reported. Anything with `expected === true` counts
 * the same (ProviderAuthError, AiError, SettingsError, RpcError from a handler).
 */
export class UserFacingError extends Error {
  readonly expected = true;
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "UserFacingError";
  }
}

export function isExpected(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { expected?: unknown; name?: unknown };
  return e.expected === true || e.name === "AbortError";
}

export function errorClass(error: unknown): string {
  if (error instanceof Error) {
    const n = error.name && error.name !== "Error" ? error.name : (error.constructor?.name ?? "Error");
    return CLASS.test(n) ? n : "Error";
  }
  return error === null ? "Null" : `Non${typeof error === "object" ? "Object" : typeof error === "string" ? "String" : "Error"}`;
}

/**
 * The part of a path that is the app's own: what follows app.asar/, the
 * renderer's app:// origin, a web origin, or a known build directory. Anything
 * else keeps its base name only (an absolute path names the user's account).
 */
export function appRelative(file: string): string {
  let f = file.replace(/^file:\/\//, "");
  const app = /^app:\/\/[^/]+\/(.*)$/.exec(f);
  if (app) return clean(`renderer/${app[1]}`);
  const web = /^https?:\/\/[^/]+\/(.*)$/.exec(f);
  if (web) return clean(web[1]!.replace(/[?#].*$/, ""));
  if (/^(node:|electron\/|internal\/|native)/.test(f)) return clean(f);
  f = f.replace(/\\/g, "/");
  for (const marker of ["/app.asar/", "/app/", "/apps/desktop/", "/Resources/"]) {
    const at = f.lastIndexOf(marker);
    if (at >= 0) return clean(f.slice(at + marker.length));
  }
  for (const marker of ["/dist/", "/src/"]) {
    const at = f.lastIndexOf(marker);
    if (at >= 0) return clean(f.slice(at + 1));
  }
  return clean(f.slice(f.lastIndexOf("/") + 1));
}

const clean = (f: string) => (FILE.test(f) ? f : "<redacted>");

/** V8 ("at fn (file:1:2)") and Gecko/WebKit ("fn@file:1:2") stack lines. */
export function parseStack(stack: string): Frame[] {
  const frames: Frame[] = [];
  for (const raw of stack.split("\n")) {
    if (frames.length >= MAX_FRAMES) break;
    const line = raw.trim();
    let fn: string | undefined;
    let loc: string;
    const v8 = /^at (?:(.+?) \()?(.+?)\)?$/.exec(line);
    const gecko = !v8 && /^(.*?)@(.+)$/.exec(line);
    if (v8) {
      fn = v8[1];
      loc = v8[2]!;
    } else if (gecko) {
      fn = gecko[1] || undefined;
      loc = gecko[2]!;
    } else continue;
    // eval frames point at their caller: keep the outer location
    const evalAt = /\(eval at .*?\((.+?)\)/.exec(line);
    if (evalAt) loc = evalAt[1]!;
    const m = /^(.*?):(\d+)(?::(\d+))?$/.exec(loc);
    const frame: Frame = { file: appRelative(m ? m[1]! : loc) };
    if (m) {
      frame.line = Number(m[2]);
      if (m[3]) frame.col = Number(m[3]);
    }
    if (fn && FN.test(fn)) frame.fn = fn;
    frames.push(frame);
  }
  return frames;
}

export function normalizeError(error: unknown): NormalizedError {
  const name = errorClass(error);
  if (error instanceof Error) {
    return { name, message: scrubText(error.message), frames: typeof error.stack === "string" ? parseStack(error.stack) : [] };
  }
  // a thrown string or object: its text is scrubbed like a message, it has no stack
  return { name, message: scrubText(typeof error === "string" ? error : safeJson(error)), frames: [] };
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}
