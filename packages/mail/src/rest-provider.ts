// What the REST providers (Gmail's API, Microsoft Graph) share: a request's deadline, the download pool, and how a
// downloaded message's own content can fail (a repair, a hold, the pass's). Lifted out of gmail-api.ts (plan 259
// stage 2a) with no change in behaviour; no Node APIs.
import { L } from "@terno/i18n";
import { ResponseBodyLimitError } from "./http-body";
import { captureReasonOf, IncomingProcessingError } from "./incoming-processing";
import { ProviderError } from "./types";

/**
 * Runs `work` over `items`, `width` at a time (Gmail: 6; Graph: Outlook's 4 per mailbox). The first failure stops the
 * items not yet begun and is thrown once those running settle.
 */
export async function download<T>(items: T[], work: (item: T) => Promise<void>, width = 6): Promise<void> {
  let next = 0;
  let failure: { error: unknown } | undefined;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    while (!failure && next < items.length) {
      const item = items[next++]!;
      try {
        await work(item);
      } catch (error) {
        failure ??= { error };
      }
    }
  }));
  if (failure) throw failure.error;
}

/** A read that hasn't finished in a minute is on a dead socket (undici's own wait is 5 minutes). */
export const READ_TIMEOUT_MS = 60_000;
/** A send may upload 35 MB over a slow link; past this its outcome is unknown (never retried). */
export const SEND_TIMEOUT_MS = 15 * 60_000;
export const NEVER = new AbortController().signal;

/**
 * One request's signal: aborted by its deadline, by reset (`reset`) or by the caller. `done()`
 * clears the timer and the listeners (an `AbortSignal.timeout` would keep a timer per request alive).
 */
export interface RequestDeadline {
  signal: AbortSignal;
  pause(): () => void;
  stopClock(): void;
  done(): void;
}

export function deadlineSignal(reset: AbortSignal, caller: AbortSignal | undefined, ms: number): RequestDeadline {
  const ctl = new AbortController();
  const abort = (reason: unknown) => ctl.abort(reason);
  const onReset = () => abort(reset.reason);
  const onCaller = () => abort(caller?.reason);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let remaining = ms, started = 0, paused = 0;
  let finished = false;
  const stopClock = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
    remaining = Math.max(0, remaining - (performance.now() - started));
  };
  const arm = () => {
    if (finished || paused || ctl.signal.aborted) return;
    started = performance.now();
    timer = setTimeout(() => { timer = undefined; abort(new DOMException(`no answer in ${ms} ms`, "TimeoutError")); }, remaining);
  };
  if (reset.aborted) onReset();
  else reset.addEventListener("abort", onReset, { once: true });
  if (caller?.aborted) onCaller();
  else caller?.addEventListener("abort", onCaller, { once: true });
  arm();
  return {
    signal: ctl.signal,
    pause() {
      if (finished) return () => {};
      stopClock(); paused++;
      let resumed = false;
      return () => { if (!resumed) { resumed = true; paused--; arm(); } };
    },
    stopClock() { stopClock(); finished = true; },
    done() {
      stopClock(); finished = true;
      reset.removeEventListener("abort", onReset);
      caller?.removeEventListener("abort", onCaller);
    },
  };
}

export class IncomingCaptureRefusal extends ProviderError {
  constructor(readonly reason: import("@terno/core").CaptureReason) { super(L("errors.mail.processingComplex"), false); }
  override get expected(): boolean { return true; }
}

export class IncomingResourceError extends ProviderError {
  constructor(readonly code: string, message: ReturnType<typeof L>) { super(message, false); }
  override get expected(): boolean { return true; }
}

/**
 * Plan 265: what one message's own content decides (its siblings read fine): on the paths that bring new mail, held for
 * the pass's end rather than failing its siblings. Worker faults, network, quota and sign-in are the pass's.
 */
// (plan 267: every parser limit is a repair now, IncomingCaptureRefusal; what's left has no repair reason)
export const MESSAGE_FAILURES = new Set(["input-limit", "worker-timeout", "envelope-unavailable"]);

/**
 * Plan 265: failures held for a pass's end (the first is thrown): each message stays unstored, so the step that held
 * it saves no progress past it. `count` tells a step its own holds from an earlier step's (a repair retried first).
 */
export interface Held { error?: unknown; count: number }

/** A message whose content failed to process, as the provider's error; `invalid`: the provider's malformed-answer error. */
export function processingError(error: IncomingProcessingError | ResponseBodyLimitError, invalid: () => ProviderError): ProviderError {
  // plan 267: a message's own structure past the parser's limits (parts, depth, headers, addresses) is a repair
  const reason = error instanceof IncomingProcessingError ? captureReasonOf(error) : undefined;
  if (reason) return new IncomingCaptureRefusal(reason);
  if (error instanceof ResponseBodyLimitError || error.code === "input-limit" || error.code === "result-limit") return new IncomingResourceError("input-limit", L("errors.mail.processingLimit"));
  if (error.code.startsWith("malformed-")) return invalid();
  if (error.code === "worker-timeout") return new IncomingResourceError(error.code, L("errors.mail.processingTimedOut"));
  if (error.code.startsWith("mime-limit-") || error.code === "envelope-unavailable") return new IncomingResourceError(error.code, L("errors.mail.processingComplex"));
  return new IncomingResourceError(error.code, L("errors.mail.processingUnavailable"));
}

function afterMimeField(bytes: Uint8Array, start: number, field: string): number {
  let end = start;
  while (end - start < field.length && (bytes[end]! | 32) === field.charCodeAt(end - start)) end++;
  if (end - start !== field.length) return -1;
  while (bytes[end] === 32 || bytes[end] === 9 || bytes[end] === 10 || bytes[end] === 13) end++;
  return bytes[end] === 58 ? end + 1 : -1;
}

function literalMimeTypeEnd(bytes: Uint8Array, start: number, type: string): number {
  for (let offset = 0; offset < type.length; offset++) if ((bytes[start + offset]! | 32) !== type.charCodeAt(offset)) return -1;
  return start + type.length;
}

/** A small, plain message cheap enough to parse on the loop rather than in the incoming worker. */
export function inlineCandidate(bytes: Uint8Array): boolean {
  let lines = 0, line = 0, parts = 0, tags = 0, entities = 0, nesting = 0, declarations = 0;
  for (let index = 0; index < bytes.length; index++) {
    const value = bytes[index]!;
    if ((value | 32) === 99) {
      if (afterMimeField(bytes, index, "content-transfer-encoding") >= 0) return false;
      let start = afterMimeField(bytes, index, "content-type");
      if (start >= 0) {
        while (bytes[start] === 32 || bytes[start] === 9 || bytes[start] === 10 || bytes[start] === 13) start++;
        const plain = literalMimeTypeEnd(bytes, start, "text/plain");
        let end = plain >= 0 ? plain : literalMimeTypeEnd(bytes, start, "text/html");
        if (end < 0) return false;
        while (bytes[end] === 32 || bytes[end] === 9) end++;
        if (end !== bytes.length && bytes[end] !== 59 && bytes[end] !== 10 && bytes[end] !== 13) return false;
      }
    }
    if (value === 10) {
      if (++lines > 128) return false;
      line = 0;
      if (bytes[index + 1] === 45 && bytes[index + 2] === 45 && ++parts > 16) return false;
    } else if (++line > 4096) return false;
    if (value === 60 && ++tags > 32) return false;
    if (value === 38 && ++entities > 256) return false;
    if ((value === 40 || value === 123 || value === 91) && ++nesting > 32) return false;
    if ((value === 58 || value === 59) && ++declarations > 64) return false;
    if ((value | 32) === 109 && (bytes[index + 1]! | 32) === 101 && (bytes[index + 2]! | 32) === 115 && (bytes[index + 3]! | 32) === 115 && (bytes[index + 4]! | 32) === 97 && (bytes[index + 5]! | 32) === 103 && (bytes[index + 6]! | 32) === 101) {
      let end = index + 7;
      while (bytes[end] === 32 || bytes[end] === 9 || bytes[end] === 10 || bytes[end] === 13) end++;
      if (bytes[end] === 47) return false;
    }
  }
  return true;
}
