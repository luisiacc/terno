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
 * Plan 191: an agent waiting for mail on one account watches it for the wait's length. A watch shares the one
 * cadence with focus (never two checks in 5 s), and covers only its account.
 *
 * Nothing runs outside the minute after a focus or a watch: no timer exists then.
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
  /** plan 191: an agent's wait, by its key: the account it covers, and until when */
  private readonly watches = new Map<string, { accountId: number; until: number }>();
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
      if (!this.focused.size && !this.watchesOn()) this.cancel();
      return;
    }
    this.focused.add(clientId);
    this.until = this.now() + this.forMs;
    this.start();
  }

  /** Plan 191: check this account for `forMs` (an agent waiting for its mail), until then or `unwatch`. */
  watch(key: string, accountId: number, forMs: number): void {
    if (this.stopped) return;
    this.watches.set(key, { accountId, until: this.now() + forMs });
    this.start();
  }

  unwatch(key: string): void {
    if (!this.watches.delete(key)) return;
    if (!this.focusOn() && !this.watchesOn()) this.cancel();
  }

  /** the client went (a closed window, a reloaded page): it has no focus any more */
  disconnected(clientId: string): void {
    this.focus(clientId, false);
  }

  /**
   * A check of this account may go: a window has focus and its minute isn't over, or a wait watches the account
   * (one that read the store meanwhile asks again).
   */
  covers(accountId: number): boolean {
    if (this.stopped) return false;
    if (this.focusOn()) return true;
    const now = this.now();
    for (const w of this.watches.values()) if (w.accountId === accountId && now <= w.until) return true;
    return false;
  }

  /** a check is scheduled (tests: nothing spins outside the minute) */
  get active(): boolean {
    return this.timer !== null;
  }

  stop(): void {
    this.stopped = true;
    this.focused.clear();
    this.watches.clear();
    this.cancel();
  }

  private focusOn(): boolean {
    return this.focused.size > 0 && this.now() <= this.until;
  }

  /** a watch not over yet (those that are go now) */
  private watchesOn(): boolean {
    const now = this.now();
    for (const [key, w] of this.watches) if (now > w.until) this.watches.delete(key);
    return this.watches.size > 0;
  }

  /** the latest moment a check is still wanted */
  private end(): number {
    let end = this.focused.size ? this.until : Number.NEGATIVE_INFINITY;
    for (const w of this.watches.values()) end = Math.max(end, w.until);
    return end;
  }

  /** a check at once, or 5 s after the last one (switching windows, or a wait after a focus, isn't a burst) */
  private start(): void {
    if (!this.timer) this.schedule(Math.max(0, this.lastAt + this.everyMs - this.now()));
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
    if (this.stopped || (!this.focusOn() && !this.watchesOn())) return;
    this.lastAt = this.now();
    this.hooks.check();
    if (this.lastAt + this.everyMs <= this.end()) this.schedule(this.everyMs);
  }
}
