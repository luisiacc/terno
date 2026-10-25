/**
 * The coordinated shutdown every quit goes through, and an update's restart
 * too (plan 11 §8.3). Kept apart from Electron so it's unit-tested in Node.
 *
 * 1. Every window flushes its drafts (saved through the backend, which is
 *    still running) and acknowledges; a window that doesn't within
 *    DRAFTS_DEADLINE_MS is counted and not waited for.
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
export type ShutdownOutcome = BackendOutcome | "timeout";

export interface ShutdownDeps {
  /** one promise per window that can flush, resolved by its acknowledgement */
  flushWindows(): Promise<void>[];
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

  const acks = deps.flushWindows().map((p) => within(deps, p.then(() => true, () => true), draftsMs, false));
  const draftsTimedOut = (await Promise.all(acks)).filter((ok) => !ok).length;

  const backend = deps.shutdownBackend({ deadlineMs: sendMs, force: o.force });
  if (!backend) return { outcome: "closed", draftsTimedOut };
  const outcome = await within<ShutdownOutcome>(deps, backend.catch(() => "timeout" as const), sendMs + graceMs, "timeout");
  return { outcome, draftsTimedOut };
}
