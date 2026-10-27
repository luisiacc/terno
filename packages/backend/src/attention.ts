/**
 * Plan 41: the Dock's unread count and system notifications for important
 * new mail. The badge rides on the sidebar's counts (no query of its own).
 * Notifications take what a sync pass of an already-synced account inserted
 * as live mail and screen it once the pass is over (its flags, Sent and
 * filters settled), in bounded chunks: only what is still news and
 * important is kept, in a bounded queue, so a flood of newsletters never
 * pushes it out. Mail whose body hasn't arrived waits while a filter reads
 * bodies (it may still archive it). The queue is read again and said in one
 * notice at most every NOTICE_GAP_MS. Nothing is collected, read or timed
 * while they're off.
 */
import { importance, redact, stillNew, summarize, type Counts, type MailNotice } from "@terno/core";
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
/** a live pass inserting more than this isn't news: the newest (by id) are screened */
export const MAX_PENDING = 2000;
/** ids per store read */
export const READ_CHUNK = 200;
/** important mail waiting for its notice (the gap): the newest are kept, one read when it's said */
export const MAX_IMPORTANT = READ_CHUNK;
/** passes a message whose body hasn't arrived waits for it while a filter reads bodies, then it's let go quietly */
export const BODY_WAITS = 3;

export interface AttentionOptions {
  store: Pick<MailStore, "settings" | "secrets" | "sync" | "filters">;
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
  /** bumped per account when it's forgotten (removed, closed): what it brought before is dropped wherever it is */
  private readonly epochs = new Map<number, number>();
  /** screened: still news and important, waiting for the notice */
  private readonly important = new Map<number, { accountId: number; epoch: number; date: number }>();
  /** important, but its body hasn't arrived and a filter reads bodies: looked at again after the account's next pass */
  private readonly waiting = new Map<number, { accountId: number; waits: number }>();
  /** screens run one at a time, in the order passes ended */
  private screening: Promise<void> = Promise.resolve();
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
    const epoch = this.epochOf(accountId);
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
        if (generation !== this.generation || epoch !== this.epochOf(accountId)) return;
        trim(ids);
        if (ids.size === 0 && ![...this.waiting.values()].some((w) => w.accountId === accountId)) return;
        const screen = () => this.screen(accountId, epoch, generation, ids);
        this.screening = this.screening.then(screen, screen).catch((error: unknown) => void captureError(error, { code: "notify.failed" }));
      },
    };
  }

  /** A pass of this account completed. */
  prime(accountId: number): void {
    this.primedAccounts.add(accountId);
  }

  /** The account closed or went away: its next start is a first pass again, and nothing it brought is said. */
  forget(accountId: number): void {
    this.primedAccounts.delete(accountId);
    this.epochs.set(accountId, this.epochOf(accountId) + 1);
    for (const [id, m] of this.important) if (m.accountId === accountId) this.important.delete(id);
    for (const [id, w] of this.waiting) if (w.accountId === accountId) this.waiting.delete(id);
  }

  private epochOf(accountId: number): number {
    return this.epochs.get(accountId) ?? 0;
  }

  /** Whether an enabled filter reads bodies (it may still archive or read mail whose body hasn't come). */
  private async bodyFilters(): Promise<boolean> {
    return (await this.o.store.filters.list()).some((f) => f.enabled && f.rule.conditions.some((c) => c.field === "body"));
  }

  /** Keeps it waiting for its body (one more pass), or lets it go quietly after BODY_WAITS. */
  private wait(id: number, accountId: number, waits: number): void {
    if (waits + 1 < BODY_WAITS) this.waiting.set(id, { accountId, waits: waits + 1 });
  }

  /**
   * A finished pass's ids, plus what waited for its body (taken when this
   * screen runs: two screens never both retry it, Codex re-review #1), read
   * back in chunks; what's still news and important is merged into the
   * queue at the end, trimmed in the same step (a flush never sees more than
   * the bound, re-review #2).
   */
  private async screen(accountId: number, epoch: number, generation: number, passIds: ReadonlySet<number>): Promise<void> {
    const current = () => generation === this.generation && epoch === this.epochOf(accountId) && !this.stopped;
    if (!current()) return;
    const retries = new Map<number, number>();
    for (const [id, w] of this.waiting) {
      if (w.accountId !== accountId) continue;
      retries.set(id, w.waits);
      this.waiting.delete(id);
    }
    const ids = [...new Set([...passIds, ...retries.keys()])].sort((a, b) => b - a);
    if (ids.length === 0) return;
    const bodyFilters = await this.bodyFilters();
    const found = new Map<number, { accountId: number; epoch: number; date: number }>();
    for (let i = 0; i < ids.length; i += READ_CHUNK) {
      if (i > 0) await this.o.yieldTurn?.();
      if (!current()) return;
      const chunk = ids.slice(i, i + READ_CHUNK);
      const rows = await this.o.store.sync.arrivals(chunk);
      if (!current()) return;
      const now = this.o.now();
      for (const m of rows) {
        if (!stillNew(m, now) || importance(m) === null) continue;
        // a filter may still archive or read it once its body is here
        if (bodyFilters && m.bodyPending) this.wait(m.id, accountId, retries.get(m.id) ?? 0);
        else found.set(m.id, { accountId, epoch, date: m.date });
      }
    }
    if (!current()) return;
    for (const [id, m] of found) this.important.set(id, m);
    if (this.important.size > MAX_IMPORTANT) {
      const keep = [...this.important].sort((a, b) => b[1].date - a[1].date || b[0] - a[0]).slice(0, MAX_IMPORTANT);
      this.important.clear();
      for (const [id, m] of keep) this.important.set(id, m);
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.timer !== null || this.flushing || this.important.size === 0 || this.stopped) return;
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

  /** The queue read once more (read elsewhere, archived, its account gone meanwhile), then one notice for all of it. */
  private async flush(): Promise<void> {
    const generation = this.generation;
    const queued = new Map(this.important);
    this.important.clear();
    const rows = await this.o.store.sync.arrivals([...queued.keys()]);
    // a filter that reads bodies, turned on since the screen: mail whose body hasn't come waits for it (Codex re-review #3)
    const bodyFilters = await this.bodyFilters();
    if (generation !== this.generation || this.stopped) return;
    const now = this.o.now();
    const news = rows.filter((m) => {
      const q = queued.get(m.id);
      if (!q || q.epoch !== this.epochOf(q.accountId) || !stillNew(m, now) || importance(m) === null) return false;
      if (bodyFilters && m.bodyPending) {
        this.wait(m.id, q.accountId, 0);
        return false;
      }
      return true;
    });
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
    this.important.clear();
    this.waiting.clear();
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
