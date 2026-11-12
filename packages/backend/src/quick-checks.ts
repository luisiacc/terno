/**
 * Plan 176: someone who brings Terno to the front is often waiting for a message (a code, a link). For a
 * minute after a window gains focus, the accounts that don't hear of new mail by push are checked every 5 s
 * instead of waiting for the poll (every 40 s). All the timer state lives here, so the policy is tested without a
 * backend; which accounts a check reaches is the core's (`hooks.check`).
 *
 * - a window gaining focus starts the minute over; the first check is at once, or 5 s after the last one
 *   (switching windows quickly isn't a burst of requests);
 * - the checks end when the minute is up or no window has focus (a blur, a closed window);
 * - focus is tracked per client: two windows' focus and blur arrive on different ports, in either order.
 *
 * Nothing runs outside the minute after a focus: no timer exists then.
 */

/** how often an account without push is checked while the window has just gained focus */
export const QUICK_CHECK_EVERY_MS = 5_000;
/** how long after a focus the quick checks go on */
export const QUICK_CHECKS_FOR_MS = 60_000;

type Timer = ReturnType<typeof setTimeout>;

export interface QuickCheckOptions {
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => Timer;
  clearTimeout?: (t: Timer) => void;
  everyMs?: number;
  forMs?: number;
}

export class QuickChecks {
  private readonly focused = new Set<string>();
  private until = Number.NEGATIVE_INFINITY;
  private lastAt = Number.NEGATIVE_INFINITY;
  private timer: Timer | null = null;
  private stopped = false;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => Timer;
  private readonly clearTimer: (t: Timer) => void;
  private readonly everyMs: number;
  private readonly forMs: number;

  constructor(
    private readonly hooks: { check(): void },
    o: QuickCheckOptions = {},
  ) {
    this.now = o.now ?? Date.now;
    this.setTimer = o.setTimeout ?? ((fn, ms) => {
      const t = setTimeout(fn, ms);
      // never what keeps a Node host alive
      (t as { unref?: () => void }).unref?.();
      return t;
    });
    this.clearTimer = o.clearTimeout ?? ((t) => clearTimeout(t));
    this.everyMs = o.everyMs ?? QUICK_CHECK_EVERY_MS;
    this.forMs = o.forMs ?? QUICK_CHECKS_FOR_MS;
  }

  /** A client's window gained (true) or lost (false) focus. */
  focus(clientId: string, focused: boolean): void {
    if (this.stopped) return;
    if (!focused) {
      this.focused.delete(clientId);
      if (!this.focused.size) this.cancel();
      return;
    }
    this.focused.add(clientId);
    this.until = this.now() + this.forMs;
    if (!this.timer) this.schedule(Math.max(0, this.lastAt + this.everyMs - this.now()));
  }

  /** the client went (a closed window, a reloaded page): it has no focus any more */
  disconnected(clientId: string): void {
    this.focus(clientId, false);
  }

  /** a window has focus and the minute isn't over: a check may go (one that read the store meanwhile asks again) */
  get running(): boolean {
    return !this.stopped && this.focused.size > 0 && this.now() <= this.until;
  }

  /** a check is scheduled (tests: nothing spins outside the minute) */
  get active(): boolean {
    return this.timer !== null;
  }

  stop(): void {
    this.stopped = true;
    this.focused.clear();
    this.cancel();
  }

  private schedule(ms: number): void {
    this.timer = this.setTimer(() => this.run(), ms);
  }

  private cancel(): void {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }

  private run(): void {
    this.timer = null;
    if (this.stopped || !this.focused.size || this.now() > this.until) return;
    this.lastAt = this.now();
    this.hooks.check();
    if (this.lastAt + this.everyMs <= this.until) this.schedule(this.everyMs);
  }
}
