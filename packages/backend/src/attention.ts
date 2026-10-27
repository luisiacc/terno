/**
 * Plan 38: the Dock's unread count and system notifications for important
 * new mail. The badge rides on the sidebar's counts (no query of its own).
 * Notifications take what a sync pass of an already-synced account inserted
 * as live mail, look at it once the pass is over (its flags, filters and
 * bodies settled), read it back in bounded chunks, and say it in one notice
 * at most every NOTICE_GAP_MS. Nothing is collected, read or timed while
 * they're off.
 */
import { importance, redact, stillNew, summarize, type ArrivalRow, type Counts, type MailNotice } from "@terno/core";
import { captureError, log } from "@terno/core/diag";
import type { MailStore } from "@terno/store";
import { readAttention } from "./settings";

/** Where a host shows them itself (desktop main); without one, notices go to the page as the `notify` event (the web). */
export interface AttentionHost {
  /** the Inbox's unread count to show (0: none) */
  badge(count: number): void;
  notify(notice: MailNotice): void;
}

/** after a pass ends: other accounts' passes that end meanwhile join the same notice */
export const GATHER_MS = 1000;
/** at most one notification this often; what comes meanwhile is merged into the next */
export const NOTICE_GAP_MS = 15_000;
/** a live pass inserting more than this isn't news: the newest (by id) are kept */
export const MAX_PENDING = 2000;
/** ids per store read */
export const READ_CHUNK = 200;

export interface AttentionOptions {
  store: Pick<MailStore, "settings" | "secrets" | "sync">;
  host: AttentionHost | null;
  /** the web: notices to the page */
  emit(notice: MailNotice): void;
  /** the sidebar's publisher (coalesced): at start it reports the counts the badge needs */
  publishCounts(): void;
  /** the backend's clock: what "just arrived" is measured against (tests freeze it) */
  now(): number;
  /** a turn for the event loop between reads (the backend's slicer) */
  yieldTurn?(): Promise<void>;
  /** the gather and the gap run on real elapsed time (a monotonic clock), whatever `now` says; tests fake it */
  timers?: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void; now(): number };
}

/** What one sync pass inserted as live mail, handed over when the pass ends. */
export interface PassArrivals {
  add(messageIds: readonly number[]): void;
  end(): void;
}

const NONE: PassArrivals = { add() {}, end() {} };

export class Attention {
  private dockBadge = true;
  private notifications = true;
  private preview = true;
  /** bumped when notifications go off or the backend stops: work started before delivers nothing */
  private generation = 0;
  /** what the host shows now (null: nothing sent yet, so the first count always goes) */
  private shown: number | null = null;
  private last: Counts | null = null;
  /** accounts that completed a pass in this backend's life: only their later passes bring news */
  private readonly primedAccounts = new Set<number>();
  private readonly pending = new Set<number>();
  private timer: unknown = null;
  private lastNoticeAt = -Infinity;
  private flushing: Promise<void> | null = null;
  private seq = 0;
  private stopped = false;
  private readonly timers: NonNullable<AttentionOptions["timers"]>;

  constructor(private readonly o: AttentionOptions) {
    this.timers = o.timers ?? {
      setTimeout: (fn, ms) => {
        const h = setTimeout(fn, ms);
        (h as { unref?: () => void }).unref?.();
        return h;
      },
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      now: () => performance.now(),
    };
  }

  /** Settings before any sync, then the counts through the sidebar's publisher: a restarted backend puts the badge back. */
  async start(): Promise<void> {
    await this.refresh();
    if (this.o.host) this.o.publishCounts();
  }

  /** Settings changed (or at start): the badge follows at once; turned off, notifications drop what was pending. */
  async refresh(): Promise<void> {
    const s = await readAttention(this.o.store);
    this.dockBadge = s.dockBadge;
    this.preview = s.notificationPreview;
    if (this.notifications && !s.notifications) this.drop();
    this.notifications = s.notifications;
    if (this.last) this.counts(this.last);
    else if (!this.dockBadge) this.show(0);
  }

  /** The sidebar's counts, just computed: the badge shows their Inbox number when it changed. */
  counts(c: Counts): void {
    this.last = c;
    this.show(this.dockBadge ? c.inboxUnread : 0);
  }

  private show(n: number): void {
    if (!this.o.host || this.stopped || n === this.shown) return;
    this.shown = n;
    this.o.host.badge(n);
  }

  /**
   * A pass of this account starts: what it inserts as live mail is news if
   * notifications are on and the account already completed a pass in this
   * life (no first sync, no catch-up at launch).
   */
  beginPass(accountId: number): PassArrivals {
    if (!this.notifications || this.stopped || !this.primedAccounts.has(accountId)) return NONE;
    const generation = this.generation;
    const ids = new Set<number>();
    let ended = false;
    return {
      add: (messageIds) => {
        if (ended) return;
        for (const id of messageIds) ids.add(id);
        if (ids.size > MAX_PENDING * 2) trim(ids);
      },
      end: () => {
        if (ended) return;
        ended = true;
        if (generation !== this.generation || ids.size === 0) return;
        trim(ids);
        for (const id of ids) this.pending.add(id);
        trim(this.pending);
        this.schedule();
      },
    };
  }

  /** A pass of this account completed. */
  prime(accountId: number): void {
    this.primedAccounts.add(accountId);
  }

  /** The account closed or went away: its next start is a first pass again. */
  forget(accountId: number): void {
    this.primedAccounts.delete(accountId);
  }

  private schedule(): void {
    if (this.timer !== null || this.flushing || this.pending.size === 0 || this.stopped) return;
    const now = this.timers.now();
    const at = Math.max(now + GATHER_MS, this.lastNoticeAt + NOTICE_GAP_MS);
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      this.flushing = this.flush()
        .catch((error: unknown) => {
          captureError(error, { code: "notify.failed" });
        })
        .finally(() => {
          this.flushing = null;
          this.schedule();
        });
    }, at - now);
  }

  /** One look at what's pending, read back in chunks: still news and important, then one notice for all of it. */
  private async flush(): Promise<void> {
    const generation = this.generation;
    const ids = [...this.pending].sort((a, b) => b - a);
    this.pending.clear();
    const news: ArrivalRow[] = [];
    for (let i = 0; i < ids.length; i += READ_CHUNK) {
      if (generation !== this.generation) return;
      if (i > 0) await this.o.yieldTurn?.();
      const rows = await this.o.store.sync.arrivals(ids.slice(i, i + READ_CHUNK));
      const now = this.o.now();
      for (const m of rows) if (stillNew(m, now) && importance(m) !== null) news.push(m);
    }
    if (generation !== this.generation) return;
    const now = this.o.now();
    const notice = summarize(news, `mail-${now.toString(36)}-${++this.seq}`);
    if (!notice) return;
    this.lastNoticeAt = this.timers.now();
    // "Show sender and subject" off: nothing about the mail leaves the backend
    const out = this.preview ? notice : redact(notice);
    if (this.o.host) return this.o.host.notify(out);
    // desktop main records it when the banner shows; here it's the page's to show
    log.info("notify.shown", { count: out.count });
    this.o.emit(out);
  }

  private drop(): void {
    this.generation++;
    this.pending.clear();
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  stop(): void {
    this.stopped = true;
    this.drop();
  }
}

/** Keeps the MAX_PENDING highest ids (ids grow with insertion: the latest arrivals). */
function trim(ids: Set<number>): void {
  if (ids.size <= MAX_PENDING) return;
  const keep = [...ids].sort((a, b) => b - a).slice(0, MAX_PENDING);
  ids.clear();
  for (const id of keep) ids.add(id);
}
