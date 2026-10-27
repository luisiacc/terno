/**
 * Every diagnostic code, with the fields it may carry. A code is a dotted
 * constant (`area.event`); a field not declared for its code is a type error,
 * and dropped at runtime. Add codes here, never ad hoc at a call site.
 */
import type { FieldName, FieldValueOf } from "./fields";

const c = <const F extends readonly FieldName[]>(...fields: F) => ({ fields });

export const CODES = {
  // lifecycle (any process)
  "app.start": c("packaged"),
  "app.quit": c(),
  "app.unclean_exit": c(),
  "process.uncaught": c("errorClass", "source"),
  "process.unhandled_rejection": c("errorClass", "source"),
  "diag.ipc_dropped": c("count", "reason", "source"),
  "diag.selftest": c("source"),

  // main: the backend utility process, renderers, child processes
  "backend.started": c("attempt"),
  "backend.ready": c("attempt", "durationMs"),
  "backend.exited": c("exitCode", "attempt", "deliberate"),
  "backend.restart_scheduled": c("attempt", "delayMs"),
  "backend.stopped": c("attempt"),
  "backend.fatal": c("errorClass"),
  "backend.init_failed": c("errorClass"),
  "renderer.gone": c("reason", "exitCode"),
  "renderer.unresponsive": c(),
  "child.gone": c("childType", "reason", "exitCode"),
  // plan 20: main's network watcher (scutil) stopped or gave up
  "net.watch_failed": c("errno", "exitCode", "attempt"),
  "keychain.secret_failed": c("op", "errorClass"),
  "appearance.save_failed": c("errno"),
  "legacy.storage_failed": c("errorClass"),
  "export.done": c("count", "durationMs"),
  "export.failed": c("errno", "errorClass"),
  "report.sent": c("count"),
  "report.dropped": c("reason", "count"),

  // main: quitting (drafts, then the backend) and updates
  "shutdown.done": c("outcome", "durationMs", "trigger"),
  "shutdown.drafts_timeout": c("count"),
  "update.check": c("updateChannel", "trigger"),
  "update.available": c("updateChannel", "toVersion"),
  "update.not_available": c("updateChannel"),
  "update.downloaded": c("toVersion", "durationMs"),
  "update.ready": c("toVersion"),
  "update.failed": c("stage", "errorClass", "errno", "status"),
  "update.blocked": c("reason"),
  "update.unsupported": c("unsupported"),
  "update.install": c("toVersion", "trigger"),
  "update.deferred": c("reason"),
  "update.applied": c("fromVersion", "toVersion"),
  "update.not_applied": c("fromVersion", "toVersion"),

  // a free-form line from code that predates codes (the store, the search engine): kept locally, scrubbed
  "log.message": c("source"),

  // backend
  "rpc.handler_threw": c("method", "rpcCode", "errorClass"),
  "rpc.call": c("method", "durationMs", "ok", "rpcCode"),
  "sync.done": c("accountKind", "durationMs"),
  "sync.failed": c("accountKind", "errorClass", "retryable", "expected"),
  // plan 20: networks and reconnects (why and when only: never a host, an address or an interface)
  "sync.retry": c("accountKind", "attempt", "delayMs"),
  "net.changed": c("netReason", "online"),
  "push.lost": c("accountKind"),
  "push.restored": c("accountKind", "durationMs"),
  "ops.failed": c("opKind", "errorClass", "retryable", "ambiguous", "expected"),
  "ops.crashed": c("opKind", "errorClass"),
  "ops.recovered": c("count"),
  "send.failed": c("errorClass", "retryable", "ambiguous", "expected"),
  "send.done": c("durationMs"),
  "categorize.rebuild_failed": c("errorClass"),
  "categorize.persist_failed": c("errorClass"),
  "ai.assist_failed": c("aiKind", "errorClass"),
  "ai.unexpected": c("op", "errorClass"),
  "ai.failed": c("aiKind", "op"),
  "keychain.migration_failed": c("errorClass"),
  "move.resume_failed": c("errorClass"),
  // plan 17: the thread facts' backfill (a slice failed; three in a row stop it for the session)
  "facts.backfill_failed": c("errorClass", "count"),
  "facts.backfilled": c("count", "durationMs"),
  "import.restore_failed": c("errorClass"),
  "secret.unreadable": c("op"),
  "agents.socket_failed": c("errno"),
  "search.failed": c("errorClass"),
  // autocomplete (plan 18): counts, sizes and durations only
  "autocomplete.built": c("model", "count", "durationMs"),
  "autocomplete.restored": c("model", "count", "durationMs", "bytes"),
  "autocomplete.snapshot": c("model", "durationMs", "bytes"),
  "autocomplete.evicted": c("model", "count"),
  "autocomplete.rebuild": c("model", "errorClass"),
  "autocomplete.disabled": c("model", "errorClass"),
  // notifications (plan 38): how many messages a notice stood for, never a name or a subject
  "notify.shown": c("count"),
  "notify.failed": c("errorClass"),
  // sender icons (plan 22): counts, sizes and durations only, never a domain, an address or a URL
  "icons.batch": c("count", "durationMs"),
  "icons.trimmed": c("count", "bytes"),
  "icons.people": c("count", "durationMs", "status"),

  // renderer
  "ui.boundary": c("area", "errorClass"),
  "ui.dialog": c("dialog"),
  "ui.settings_tab": c("tab"),
  "nav.view": c("view"),
  "nav.thread": c("threadId"),
  "action.thread": c("action", "count"),
  "action.send": c(),
  "action.failed": c("action", "count", "rpcCode", "errorClass"),
  "compose.send_failed": c("errorClass", "rpcCode", "expected"),
  "print.failed": c("action", "errorClass", "reason"),
  "print.load_timeout": c("action"),
  "settings.update_failed": c("rpcCode", "errorClass"),
  "boot.failed": c("errorClass", "rpcCode"),
  "engine.stopped": c("attempt"),
  "engine.restarted": c(),
  "worker.failed": c("fatalCode", "errorClass"),

  // web worker and MCP
  "worker.open_failed": c("fatalCode", "engine"),
  "mcp.tool_failed": c("tool", "rpcCode", "errorClass"),
  "mcp.start_failed": c("errorClass"),
} as const;

export type DiagCode = keyof typeof CODES;
type FieldsOfCode<C extends DiagCode> = (typeof CODES)[C]["fields"][number];
/** The fields one code may carry, each with its own type. */
export type FieldsFor<C extends DiagCode> = { [K in FieldsOfCode<C>]?: FieldValueOf<K> };

export function isDiagCode(code: unknown): code is DiagCode {
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(CODES, code);
}

export function fieldsOf(code: DiagCode): readonly FieldName[] {
  return CODES[code].fields;
}
