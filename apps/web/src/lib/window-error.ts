/**
 * What a window `error` event reports (plan 231). Its error when it carries one. None for the Resize Observer's loop
 * notice: the spec reports a loop it deferred to the next frame as an error event with no error object, and nothing
 * failed. Any other event without an error gets a stand-in named for it, with no stack (it would only be the listener's)
 * and no message (event text is never kept).
 */
const RESIZE_LOOP = new Set(["ResizeObserver loop completed with undelivered notifications.", "ResizeObserver loop limit exceeded"]);

export const IGNORED = Symbol("ignored");

export function windowError(e: { error?: unknown; message?: string }): unknown {
  if (e.error !== null && e.error !== undefined) return e.error;
  if (RESIZE_LOOP.has(e.message ?? "")) return IGNORED;
  const stand = new Error();
  stand.name = "ErrorEvent";
  stand.stack = "";
  return stand;
}
