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
  "keychain.secret_failed": c("op", "errorClass"),
  "appearance.save_failed": c("errno"),
  "legacy.storage_failed": c("errorClass"),
  "export.done": c("count", "durationMs"),
  "export.failed": c("errno", "errorClass"),
  "report.sent": c("count"),
  "report.dropped": c("reason", "count"),

  // a free-form line from code that predates codes (the store, the search engine): kept locally, scrubbed
  "log.message": c("source"),

  // backend
  "rpc.handler_threw": c("method", "rpcCode", "errorClass"),
  "rpc.call": c("method", "durationMs", "ok", "rpcCode"),
  "sync.done": c("accountKind", "durationMs"),
  "sync.failed": c("accountKind", "errorClass", "retryable", "expected"),
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
  "import.restore_failed": c("errorClass"),
  "secret.unreadable": c("op"),
  "agents.socket_failed": c("errno"),
  "search.failed": c("errorClass"),

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
