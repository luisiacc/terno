/**
 * The coordinated shutdown every quit goes through, and an update's restart
 * too (plan 11 §8.3). Kept apart from Electron so it's unit-tested in Node.
 *
 * 1. Every window flushes its drafts (saved through the backend, which is
 *    still running) and acknowledges; a window that doesn't within
 *    DRAFTS_DEADLINE_MS is counted. Updates hold editing until closure, or
 *    release the hold when any acknowledgement/deadline defers installation.
 * 2. The backend stops starting ops, gives a send in flight until
 *    SEND_DEADLINE_MS, closes the database (WAL checkpointed) and answers.
 *    For a plain quit (`force`) it closes even if a send is still going (the
 *    send is then recovered as "unknown", never resent, as after a crash);
 *    for an update it keeps running and answers "sending": the install waits.
 * 3. A backend that never answers is given up on after the send deadline
 *    plus a grace period ("timeout"); the caller kills it.
 */

export const DRAFTS_DEADLINE_MS = 5_000;
export const SEND_DEADLINE_MS = 30_000;
export const BACKEND_GRACE_MS = 5_000;

export type BackendOutcome = "closed" | "forced" | "sending";
export type ShutdownOutcome = BackendOutcome | "timeout" | "unsaved";

export interface ShutdownDeps {
  /** One ACK per window; hold=true keeps editing paused until release or committed closure. */
  flushWindows(hold: boolean): Promise<void | boolean>[];
  releaseWindows?(): void;
  /** asks the backend to shut down; null when there is no backend running */
  shutdownBackend(o: { deadlineMs: number; force: boolean }): Promise<BackendOutcome> | null;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ShutdownResult {
  outcome: ShutdownOutcome;
  /** windows that didn't acknowledge their drafts in time */
  draftsTimedOut: number;
}

export interface ShutdownOptions {
  force: boolean;
  draftsDeadlineMs?: number;
  sendDeadlineMs?: number;
  graceMs?: number;
}

/** The promise, or `fallback` after `ms` (the timer never outlives the race). */
function within<T>(deps: ShutdownDeps, p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let handle: unknown;
  const timeout = new Promise<T>((resolve) => (handle = deps.setTimeout(() => resolve(fallback), ms)));
  return Promise.race([p, timeout]).finally(() => deps.clearTimeout(handle));
}

export async function coordinateShutdown(deps: ShutdownDeps, o: ShutdownOptions): Promise<ShutdownResult> {
  const draftsMs = o.draftsDeadlineMs ?? DRAFTS_DEADLINE_MS;
  const sendMs = o.sendDeadlineMs ?? SEND_DEADLINE_MS;
  const graceMs = o.graceMs ?? BACKEND_GRACE_MS;

  let committed = false;
  try {
    const acks = deps.flushWindows(!o.force).map((p) => within<"saved" | "unsaved" | "timeout">(deps, p.then((saved) => saved === false ? "unsaved" : "saved", () => "unsaved"), draftsMs, "timeout"));
    const results = await Promise.all(acks);
    const draftsTimedOut = results.filter((result) => result === "timeout").length;
    if (!o.force && results.some((result) => result !== "saved")) return { outcome: "unsaved", draftsTimedOut };

    const backend = deps.shutdownBackend({ deadlineMs: sendMs, force: o.force });
    if (!backend) { committed = true; return { outcome: "closed", draftsTimedOut }; }
    const outcome = await within<ShutdownOutcome>(deps, backend.catch(() => "timeout" as const), sendMs + graceMs, "timeout");
    committed = outcome === "closed" || outcome === "forced";
    return { outcome, draftsTimedOut };
  } catch {
    return { outcome: "timeout", draftsTimedOut: 0 };
  } finally { if (!committed) deps.releaseWindows?.(); }
}
