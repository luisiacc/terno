/**
 * When the backend utility process dies: restart it after 0.5, 1, 2, 4 and
 * 8 s, then stop and let the user decide (a visible "Reintentar"). A backend
 * that stayed up for a minute starts the count again. Pure, so it is tested
 * without Electron.
 */
export const BACKOFF_MS = [500, 1000, 2000, 4000, 8000] as const;
export const HEALTHY_MS = 60_000;

export class RestartPolicy {
  private attempts = 0;
  private upSince = 0;

  started(now: number): void {
    this.upSince = now;
  }

  /** The delay before the next start, or null: stop trying. */
  exited(now: number): number | null {
    if (now - this.upSince >= HEALTHY_MS) this.attempts = 0;
    if (this.attempts >= BACKOFF_MS.length) return null;
    return BACKOFF_MS[this.attempts++]!;
  }

  /** "Reintentar": a fresh series. */
  reset(): void {
    this.attempts = 0;
  }

  get attempt(): number {
    return this.attempts;
  }
}

/**
 * The bounds on what a renderer may push: 256 KB per batch, 200 entries per
 * second (a token bucket), counted when exceeded.
 */
export const IPC_MAX_BATCH_BYTES = 256 * 1024;
export const IPC_ENTRIES_PER_SECOND = 200;

export class RateLimit {
  private tokens: number;
  private at: number;
  dropped = 0;

  constructor(
    private readonly perSecond: number,
    now: number,
  ) {
    this.tokens = perSecond;
    this.at = now;
  }

  /** How many of n may pass now; the rest are counted as dropped. */
  take(n: number, now: number): number {
    this.tokens = Math.min(this.perSecond, this.tokens + ((now - this.at) / 1000) * this.perSecond);
    this.at = now;
    const ok = Math.max(0, Math.min(n, Math.floor(this.tokens)));
    this.tokens -= ok;
    this.dropped += n - ok;
    return ok;
  }
}
