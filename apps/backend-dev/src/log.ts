import type { BackendOptions } from "@terno/backend";
import { isDiagCode, normalizeError, sanitizeFields } from "@terno/core/diag";

/** Legacy backend strings are not diagnostic codes, even in development. */
export const logBackend: NonNullable<BackendOptions["log"]> = (level, message, extra) => {
  const code = isDiagCode(message) ? message : "log.message";
  const error = extra instanceof Error;
  const fields = isDiagCode(message) ? (error ? undefined : sanitizeFields(code, extra)) : { source: "backend" };
  const detail = { ...(fields ? { fields } : {}), ...(error ? { err: normalizeError(extra) } : {}) };
  (level === "error" ? console.error : console.log)(`[backend] ${code}`, detail);
};
