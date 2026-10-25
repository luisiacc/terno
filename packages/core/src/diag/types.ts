import type { DiagCode } from "./codes";
import type { ReportPolicy } from "./consent";
import type { NormalizedError } from "./error";
import type { Fields } from "./fields";

export type Proc = "main" | "backend" | "renderer" | "worker" | "mcp";
export type Level = "info" | "warn" | "error" | "fatal";
export type CrumbCategory = "nav" | "action" | "sync" | "rpc" | "lifecycle" | "ui";
export type RecordKind = "error" | "crash" | "unclean_exit" | "renderer_gone" | "backend_exit" | "child_gone";
export type Channel = "production" | "dev" | "test" | "demo";

export const PROCS: readonly Proc[] = ["main", "backend", "renderer", "worker", "mcp"];
export const LEVELS: readonly Level[] = ["info", "warn", "error", "fatal"];
export const CRUMB_CATEGORIES: readonly CrumbCategory[] = ["nav", "action", "sync", "rpc", "lifecycle", "ui"];
export const RECORD_KINDS: readonly RecordKind[] = ["error", "crash", "unclean_exit", "renderer_gone", "backend_exit", "child_gone"];
export const CHANNELS: readonly Channel[] = ["production", "dev", "test", "demo"];

/** One JSONL line of a process's log. */
export interface DiagEntry {
  ts: number;
  level: Level;
  proc: Proc;
  code: DiagCode;
  fields?: Fields;
  session: string;
  version: string;
  build: string;
  /** local only: a scrubbed detail (a legacy log line, an error's message) */
  msg?: string;
  /** local only: the error behind an error entry */
  err?: NormalizedError;
}

export interface Crumb {
  ts: number;
  cat: CrumbCategory;
  code: DiagCode;
  level: Level;
  fields?: Fields;
}

/** Who and where: everything a report says about the machine and the run. */
export interface DiagContext {
  version: string;
  build: string;
  channel: Channel;
  session: string;
  os: "darwin" | "win32" | "linux" | "web" | "other";
  osVersion?: string;
  arch?: "arm64" | "x64" | "ia32" | "other";
  locale?: string;
  /** electron-45.0.0, chrome-140, node-24.1.0 */
  runtime?: string;
  engine?: string;
  uptimeS?: number;
  memMb?: number;
  accounts?: { imap: number; gmail: number };
}

/**
 * A captured unexpected error, a crash, or an unclean exit: what is kept on
 * disk (a crash record) and what a report is built from.
 */
export interface ErrorRecord {
  /** 32 hex: the report's event id, also the record's durable id */
  id: string;
  ts: number;
  kind: RecordKind;
  proc: Proc;
  code: DiagCode;
  fields?: Fields;
  fatal: boolean;
  error?: NormalizedError;
  /** the process's breadcrumbs, oldest first (for a dead process: its last mirror) */
  crumbs: Crumb[];
  context: DiagContext;
  /** source-map debug ids of the frames' files, from the process that threw */
  debugIds?: Record<string, string>;
  /** the same failure again in this run (folded into one record) */
  count?: number;
}

/** A record the user hasn't acted on (sent or dismissed). */
export interface PendingReport {
  id: string;
  ts: number;
  kind: RecordKind;
  proc: Proc;
  code: string;
  fatal: boolean;
  sent: boolean;
  /** from an earlier run (a crash or an unclean exit found at start) */
  previousRun: boolean;
}

/** What the Diagnostics surfaces read: the build, the reporting policy, pending reports, the engine. */
export interface DiagView {
  build: { version: string; sha: string; channel: Channel; id: string };
  session: string;
  reporting: ReportPolicy & { offer: "ask" | "sent" | "local" };
  /** newest first */
  pending: PendingReport[];
  engine: "running" | "restarting" | "stopped";
  installId: string;
  /** a logs folder the user can open (desktop) */
  logs: boolean;
}
