/**
 * Plan 20: when to try an account's server again, and what a network change does. All the timer
 * state of reconnecting lives here, so the policy is tested without a backend:
 *
 * - a sync that failed retryably goes again after 2 s, 5 s, 15 s, 30 s, 1 min, 2 min, then every
 *   5 min, each ±20 % (accounts and clients that lost the same server don't come back in lockstep);
 *   a success, a network change or the user starts the schedule over;
 * - offline (the host says so): one probe per account every 5 min (the OS can be wrong), nothing
 *   else; the online event cuts it short;
 * - online, or the network changed (a VPN, Wi-Fi, a wake): settled 300 ms so the sources coalesce,
 *   then every socket is presumed dead (`reconnect`) and every account syncs, 0–250 ms apart.
 *
 * Nothing runs while nothing fails: no timer exists unless an account is in backoff or offline.
 */

export type NetReason = "network" | "wake" | "online" | "offline" | "user" | "focus" | "other";

export const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000] as const;
/** offline, and the cap of the schedule */
export const OFFLINE_RETRY_MS = 300_000;
export const SETTLE_MS = 300;
export const SYNC_JITTER_MS = 250;
/** a window regaining focus retries offline accounts at most this often */
export const FOCUS_RETRY_EVERY_MS = 15_000;
/** an op's network failure this soon after a network change is part of that change (its attempt given back) */
export const CHANGE_WINDOW_MS = 60_000;

type Timer = ReturnType<typeof setTimeout>;

export interface ConnectivityHooks {
  /** one sync pass of the account (coalesced by the caller) */
  sync(accountId: number): void;
  /** online, or the network changed: sockets are presumed dead, push reconnects, parked ops resume */
  reconnect(reason: NetReason): void;
  /** the host went offline: push and the ops worker pause, accounts show offline */
  offline(): void;
}

export interface ConnectivityOptions {
  online?: boolean;
  now?: () => number;
  random?: () => number;
  setTimeout?: (fn: () => void, ms: number) => Timer;
  clearTimeout?: (t: Timer) => void;
  /** tests: a shorter schedule */
  delays?: readonly number[];
  /** false: count failures and say when, but schedule nothing (a host that syncs by hand: autoSync off) */
  retries?: boolean;
  offlineRetryMs?: number;
  settleMs?: number;
}

interface AccountRetry {
  failures: number;
  timer: Timer | null;
  at: number | null;
}

export class Connectivity {
  /** what the host last said (a success while "offline" proves it wrong: the caller says online then) */
  online: boolean;
  /** bumped by every reconnect: a pass that started before it failed because of it, which doesn't count */
  epoch = 0;
  private lastChangeAt = Number.NEGATIVE_INFINITY;
  private readonly accounts = new Map<number, AccountRetry>();
  private settleTimer: Timer | null = null;
  private settleReason: NetReason | null = null;
  private readonly jitters = new Set<Timer>();
  private lastFocusAt = Number.NEGATIVE_INFINITY;
  private stopped = false;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => Timer;
  private readonly clearTimer: (t: Timer) => void;
  private readonly delays: readonly number[];
  private readonly offlineRetryMs: number;
  private readonly settleMs: number;
  private readonly retries: boolean;

  constructor(
    private readonly hooks: ConnectivityHooks,
    o: ConnectivityOptions = {},
  ) {
    this.online = o.online ?? true;
    this.now = o.now ?? Date.now;
    this.random = o.random ?? Math.random;
    this.setTimer = o.setTimeout ?? ((fn, ms) => {
      const t = setTimeout(fn, ms);
      // never what keeps a Node host alive
      (t as { unref?: () => void }).unref?.();
      return t;
    });
    this.clearTimer = o.clearTimeout ?? ((t) => clearTimeout(t));
    this.delays = o.delays ?? RETRY_DELAYS_MS;
    this.offlineRetryMs = o.offlineRetryMs ?? OFFLINE_RETRY_MS;
    this.settleMs = o.settleMs ?? SETTLE_MS;
    this.retries = o.retries ?? true;
  }

  track(accountId: number): void {
    if (!this.accounts.has(accountId)) this.accounts.set(accountId, { failures: 0, timer: null, at: null });
  }

  /** the account is gone: nothing of it may fire later */
  untrack(accountId: number): void {
    const a = this.accounts.get(accountId);
    if (a?.timer) this.clearTimer(a.timer);
    this.accounts.delete(accountId);
  }

  tracked(accountId: number): boolean {
    return this.accounts.has(accountId);
  }

  /** consecutive retryable failures (0: healthy) */
  failures(accountId: number): number {
    return this.accounts.get(accountId)?.failures ?? 0;
  }

  /** a retry is scheduled: the poll leaves the account alone */
  pending(accountId: number): boolean {
    return Boolean(this.accounts.get(accountId)?.timer);
  }

  retryAt(accountId: number): number | null {
    return this.accounts.get(accountId)?.at ?? null;
  }

  /**
   * An op of this account couldn't reach its server: is that an outage (the host is offline, the
   * account's own sync fails, or the network just changed) rather than that one server's problem?
   */
  inOutage(accountId: number): boolean {
    return !this.online || this.failures(accountId) > 0 || this.now() - this.lastChangeAt < CHANGE_WINDOW_MS;
  }

  /**
   * A sync pass that started at `epoch` failed retryably: schedules the next try. Null when it
   * doesn't count (a reconnect happened during the pass: the pass that follows it decides).
   */
  failed(accountId: number, epoch: number): { failures: number; at: number } | null {
    const a = this.accounts.get(accountId);
    if (!a || this.stopped || epoch !== this.epoch) return null;
    a.failures++;
    const base = this.online ? this.delays[Math.min(a.failures - 1, this.delays.length - 1)]! : this.offlineRetryMs;
    this.schedule(accountId, a, this.jitter(base));
    return { failures: a.failures, at: a.at! };
  }

  /** a pass worked (or failed for good): the schedule starts over */
  succeeded(accountId: number): void {
    const a = this.accounts.get(accountId);
    if (!a) return;
    if (a.timer) this.clearTimer(a.timer);
    a.timer = null;
    a.at = null;
    a.failures = 0;
  }

  /**
   * Offline, this account's next probe is at the cap (a pass that worked just before the host went
   * offline mustn't leave it without one: nothing else would ever try it again). When it is.
   */
  probeLater(accountId: number): number | null {
    const a = this.accounts.get(accountId);
    if (!a || this.stopped) return null;
    this.schedule(accountId, a, this.offlineRetryMs);
    return a.at;
  }

  /** The host's word on the network. Offline applies at once; online and changes settle first. */
  network(online: boolean, reason: NetReason): void {
    if (this.stopped) return;
    if (!online) {
      if (this.settleTimer) this.clearTimer(this.settleTimer);
      this.settleTimer = null;
      this.settleReason = null;
      if (!this.online) return;
      this.online = false;
      this.lastChangeAt = this.now();
      // one probe per account at the cap, however soon its retry was (the OS can be wrong about offline)
      for (const [id, a] of this.accounts) this.schedule(id, a, this.offlineRetryMs);
      this.hooks.offline();
      return;
    }
    // the most telling reason of a burst wins (a wake over a route change over "other")
    if (this.settleReason === null || rank(reason) > rank(this.settleReason)) this.settleReason = reason;
    if (this.settleTimer) this.clearTimer(this.settleTimer);
    this.settleTimer = this.setTimer(() => this.reconnectNow(), this.settleMs);
  }

  /**
   * "Retry now" (the user, every account or one) or a window regaining focus (offline accounts,
   * at most every 15 s): the schedule starts over and these accounts sync. Returns them.
   */
  retryNow(accountId: number | null, reason: "user" | "focus"): number[] {
    if (this.stopped) return [];
    if (reason === "focus") {
      if (this.now() - this.lastFocusAt < FOCUS_RETRY_EVERY_MS) return [];
      const failing = [...this.accounts].filter(([, a]) => a.failures > 0).map(([id]) => id);
      if (!failing.length) return [];
      this.lastFocusAt = this.now();
      for (const id of failing) this.restart(id);
      return failing;
    }
    const ids = accountId === null ? [...this.accounts.keys()] : this.accounts.has(accountId) ? [accountId] : [];
    for (const id of ids) this.restart(id);
    return ids;
  }

  stop(): void {
    this.stopped = true;
    if (this.settleTimer) this.clearTimer(this.settleTimer);
    this.settleTimer = null;
    for (const t of this.jitters) this.clearTimer(t);
    this.jitters.clear();
    for (const a of this.accounts.values()) if (a.timer) this.clearTimer(a.timer);
    this.accounts.clear();
  }

  /** timers alive now (tests: nothing spins) */
  get timers(): number {
    let n = this.jitters.size + (this.settleTimer ? 1 : 0);
    for (const a of this.accounts.values()) if (a.timer) n++;
    return n;
  }

  private reconnectNow(): void {
    this.settleTimer = null;
    const reason = this.settleReason ?? "other";
    this.settleReason = null;
    if (this.stopped) return;
    this.online = true;
    this.lastChangeAt = this.now();
    this.epoch++;
    // backoffs start over: the network that failed them is gone
    for (const a of this.accounts.values()) {
      if (a.timer) this.clearTimer(a.timer);
      a.timer = null;
      a.at = null;
      a.failures = 0;
    }
    this.hooks.reconnect(reason);
    for (const id of this.accounts.keys()) {
      const t = this.setTimer(() => {
        this.jitters.delete(t);
        if (!this.stopped && this.accounts.has(id)) this.hooks.sync(id);
      }, this.random() * SYNC_JITTER_MS);
      this.jitters.add(t);
    }
  }

  private restart(id: number): void {
    const a = this.accounts.get(id)!;
    if (a.timer) this.clearTimer(a.timer);
    a.timer = null;
    a.at = null;
    // the schedule starts over; the status stays honest until a pass works (the caller keeps "offline")
    a.failures = 0;
  }

  private schedule(id: number, a: AccountRetry, ms: number): void {
    if (a.timer) this.clearTimer(a.timer);
    a.timer = null;
    a.at = this.now() + ms;
    if (!this.retries) return;
    a.timer = this.setTimer(() => {
      a.timer = null;
      a.at = null;
      if (!this.stopped && this.accounts.get(id) === a) this.hooks.sync(id);
    }, ms);
  }

  private jitter(ms: number): number {
    return Math.round(ms * (0.8 + this.random() * 0.4));
  }
}

const RANK: Record<NetReason, number> = { other: 0, focus: 1, user: 2, online: 3, network: 4, wake: 5, offline: 6 };
const rank = (r: NetReason) => RANK[r];
