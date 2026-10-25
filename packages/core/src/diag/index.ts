/**
 * Diagnostics shared by every process. A module logs with a code and typed
 * fields (`log.warn("sync.failed", { accountKind: "imap" })`), leaves
 * breadcrumbs, and hands unexpected errors to `captureError`; the host (main,
 * the backend, a renderer, the web worker, MCP) installs the sink that
 * writes, forwards and reports. See docs/plans/10-observability.md.
 */
export * from "./codes";
export * from "./consent";
export * from "./diag";
export * from "./error";
export * from "./fields";
export * from "./records";
export * from "./report";
export * from "./ring";
export * from "./rotating";
export * from "./scrub";
export * from "./types";
export * from "./validate";
