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
 *
 * Plan 273: which mail is worth one follows the first screen, as the badge
 * does. With What matters first and shown, it's mail What matters counts
 * (`whatMatters`); mail its reader hasn't read yet waits for that reading.
 * Otherwise plan 41's importance.
 */
import { badgeCount, importance, ruleAwaitsBody, redact, stillNew, summarize, type ArrivalRow, type Counts, type FirstScreen, type MailNotice } from "@terno/core";
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
/** plan 273: how long after it was first looked at mail may still be said (it waited for What matters' reader): later isn't news */
export const READING_WAIT_MS = 5 * 60_000;
/** plan 273: the reader's latest looks remembered (by message), so a look during a judgement is never lost */
export const LOOKS_KEPT = 1000;
/** plan 273: a judgement the reader or a setting overtook is made again, at most this many times */
const JUDGE_TRIES = 3;

/** Plan 273: with What matters first, of these arrivals those it counts and those its reader has still to read; null: it isn't shown */
export type WhatMattersVerdict = (arrivals: readonly { id: number; threadId: number }[]) => Promise<{ counted: ReadonlySet<number>; reading: ReadonlySet<number> } | null>;

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
  /** plan 273: What matters' verdict, asked only while it's the first screen */
  whatMatters?: WhatMattersVerdict;
}

/** Plan 273: what becomes of a message still news: said, waiting for its body, waiting for What matters' reader (absent: nothing). */
type Verdict = "say" | "body" | "reading";
/** mail on its way to a notice: whose, the account's life it came in, its date */
interface Held {
  accountId: number;
  epoch: number;
  date: number;
  /** plan 273: once it waited for What matters' reader, the moment (monotonic) past which it's no longer said, whatever queue it's in */
  until: number | null;
}

/** What one sync pass inserted as live mail, handed over when the pass ends. */
export interface PassArrivals {
  add(messageIds: readonly number[]): void;
  end(): void;
}

const NONE: PassArrivals = { add() {}, end() {} };

export class Attention {
  private dockBadge = true;
  private firstScreen: FirstScreen | null = null;
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
  private readonly important = new Map<number, Held>();
  /** important, but its body hasn't arrived and a filter reads bodies: looked at again after the account's next pass */
  private readonly waiting = new Map<number, { accountId: number; waits: number; until: number | null }>();
  /** plan 273: still news, with What matters first, and its reader hasn't read it: looked at again when the reader looks at one */
  private readonly reading = new Map<number, Held>();
  /** plan 273: the reader's looks so far, and the latest each message had (bounded): one during a judgement isn't lost */
  private looks = 0;
  private readonly lookedAt = new Map<number, number>();
  /** plan 273: bumped when the first screen changes: a judgement made under the old one is made again */
  private policy = 0;
  /** plan 273: a look at the reader's waits is queued and hasn't started */
  private recheckQueued = false;
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
    // plan 273: what waits for What matters' reader was kept by its rule: another first screen lets it go
    if (s.firstScreen !== this.firstScreen) {
      this.reading.clear();
      this.policy++;
    }
    this.firstScreen = s.firstScreen;
    this.preview = s.notificationPreview;
    if (this.notifications && !s.notifications) this.drop();
    this.notifications = s.notifications;
    if (this.last) this.counts(this.last);
    else if (!this.dockBadge) this.show(0);
  }

  /** The sidebar's counts, just computed: the badge shows its one number (plan 207: the first screen's) when it changed. */
  counts(c: Counts): void {
    this.last = c;
    this.show(badgeCount(this.dockBadge, this.firstScreen, c, this.shown ?? 0));
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
    for (const [id, r] of this.reading) if (r.accountId === accountId) this.reading.delete(id);
  }

  private epochOf(accountId: number): number {
    return this.epochs.get(accountId) ?? 0;
  }

  /** Whether an enabled filter reads bodies (it may still archive or read mail whose body hasn't come). */
  private async bodyFilters(): Promise<boolean> {
    return (await this.o.store.filters.list()).some((f) => f.enabled && ruleAwaitsBody(f.rule));
  }

  /** Keeps it waiting for its body (one more pass), or lets it go quietly after BODY_WAITS. */
  private wait(id: number, accountId: number, waits: number, until: number | null): void {
    if (waits + 1 < BODY_WAITS) this.waiting.set(id, { accountId, waits: waits + 1, until });
  }

  /** Plan 273: not past the deadline a wait for What matters' reader set (none: plan 41's bounds alone). */
  private timely(until: number | null): boolean {
    return until === null || this.timers.now() <= until;
  }

  /**
   * Plan 273: what becomes of each of these messages (read back just now) by the rule the first screen leads with: What
   * matters' verdict while it's first and shown, else plan 41's importance, but never for one that waited for What matters
   * (`waited`: it was kept by What matters' rule, Codex code review #4). Mail no longer news gets nothing. A body filter holds
   * what's said until its body is here (it may still archive it). A verdict the first screen or the reader overtook (a
   * candidate looked at during it, not counted) is made again (Codex code review #1, #2). `seq`: the looks it saw.
   */
  private async judge(rows: readonly ArrivalRow[], bodyFilters: boolean, now: number, waited: (id: number) => boolean): Promise<{ verdicts: Map<number, Verdict>; seq: number }> {
    const verdicts = new Map<number, Verdict>();
    const fresh = rows.filter((m) => stillNew(m, now));
    let seq = this.looks;
    if (fresh.length === 0) return { verdicts, seq };
    let whatMatters: Awaited<ReturnType<WhatMattersVerdict>> = null;
    for (let tries = 0; tries < JUDGE_TRIES; tries++) {
      seq = this.looks;
      const policy = this.policy;
      whatMatters = this.firstScreen === "whatMatters" && this.o.whatMatters ? await this.o.whatMatters(fresh.map((m) => ({ id: m.id, threadId: m.threadId }))) : null;
      if (policy === this.policy && !fresh.some((m) => !whatMatters?.counted.has(m.id) && this.lookedSince(m.id, seq))) break;
    }
    for (const m of fresh) {
      const said = whatMatters ? whatMatters.counted.has(m.id) : !waited(m.id) && importance(m) !== null;
      if (said) verdicts.set(m.id, bodyFilters && m.bodyPending ? "body" : "say");
      else if (whatMatters?.reading.has(m.id)) verdicts.set(m.id, "reading");
    }
    return { verdicts, seq };
  }

  /** Plan 273: the reader looked at this message after `seq`. */
  private lookedSince(id: number, seq: number): boolean {
    return (this.lookedAt.get(id) ?? 0) > seq;
  }

  /** Plan 273: waits for What matters' reader (READING_WAIT_MS from the first wait); `trimReading` bounds them once a batch. */
  private waitReading(id: number, held: Held): void {
    this.reading.set(id, { ...held, until: held.until ?? this.timers.now() + READING_WAIT_MS });
  }

  /**
   * Plan 273: after a batch: the expired go first, then the newest MAX_IMPORTANT are kept (Codex code review #6, #8); one the
   * reader looked at since the judgement that put it here (`seq`) is looked at again.
   */
  private trimReading(seq: number): void {
    for (const [id, r] of this.reading) if (!this.timely(r.until)) this.reading.delete(id);
    if (this.reading.size > MAX_IMPORTANT) {
      const keep = [...this.reading].sort((a, b) => b[1].date - a[1].date || b[0] - a[0]).slice(0, MAX_IMPORTANT);
      this.reading.clear();
      for (const [k, v] of keep) this.reading.set(k, v);
    }
    for (const id of this.reading.keys())
      if (this.lookedSince(id, seq)) {
        this.queueRecheck();
        break;
      }
  }

  /**
   * Plan 273: What matters' reader looked at a message (read it, dropped it, or failed): if it's one a notice waits for,
   * what waits is looked at again (once for every look that comes while one is queued). Remembered for a judgement
   * running now. Nothing while notifications are off.
   */
  readerLooked(messageId: number): void {
    if (!this.notifications || this.stopped) return;
    this.lookedAt.delete(messageId);
    this.lookedAt.set(messageId, ++this.looks);
    if (this.lookedAt.size > LOOKS_KEPT) this.lookedAt.delete(this.lookedAt.keys().next().value!);
    if (this.reading.has(messageId)) this.queueRecheck();
  }

  private queueRecheck(): void {
    if (this.reading.size === 0 || this.recheckQueued || this.stopped) return;
    this.recheckQueued = true;
    const recheck = () => {
      this.recheckQueued = false;
      return this.recheck();
    };
    this.screening = this.screening.then(recheck, recheck).catch((error: unknown) => void captureError(error, { code: "notify.failed" }));
  }

  /** Plan 273: the reader's waits read back and judged by What matters alone: said, still waiting, or let go. */
  private async recheck(): Promise<void> {
    const generation = this.generation;
    const held = new Map<number, Held>();
    for (const [id, r] of this.reading) if (r.epoch === this.epochOf(r.accountId) && this.timely(r.until)) held.set(id, r);
    this.reading.clear();
    if (held.size === 0 || this.stopped) return;
    const [rows, bodyFilters] = await Promise.all([this.o.store.sync.arrivals([...held.keys()]), this.bodyFilters()]);
    if (generation !== this.generation || this.stopped) return;
    const { verdicts, seq } = await this.judge(rows, bodyFilters, this.o.now(), () => true);
    if (generation !== this.generation || this.stopped) return;
    for (const [id, verdict] of verdicts) {
      const h = held.get(id)!;
      if (h.epoch !== this.epochOf(h.accountId)) continue;
      if (verdict === "say") this.important.set(id, h);
      else if (verdict === "reading") this.waitReading(id, h);
      else this.wait(id, h.accountId, 0, h.until);
    }
    this.trimImportant();
    this.trimReading(seq);
    this.schedule();
  }

  private trimImportant(): void {
    if (this.important.size <= MAX_IMPORTANT) return;
    const keep = [...this.important].sort((a, b) => b[1].date - a[1].date || b[0] - a[0]).slice(0, MAX_IMPORTANT);
    this.important.clear();
    for (const [id, m] of keep) this.important.set(id, m);
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
    const retries = new Map<number, { waits: number; until: number | null }>();
    for (const [id, w] of this.waiting) {
      if (w.accountId !== accountId) continue;
      if (this.timely(w.until)) retries.set(id, w);
      this.waiting.delete(id);
    }
    const ids = [...new Set([...passIds, ...retries.keys()])].sort((a, b) => b - a);
    if (ids.length === 0) return;
    const bodyFilters = await this.bodyFilters();
    // still news, read in bounded chunks, then judged together (What matters' verdict is one projection, Codex critique #8);
    // every one kept for the rule that leads when they're judged (a first screen changed meanwhile: Codex code review #5)
    const fresh: ArrivalRow[] = [];
    for (let i = 0; i < ids.length; i += READ_CHUNK) {
      if (i > 0) await this.o.yieldTurn?.();
      if (!current()) return;
      const chunk = ids.slice(i, i + READ_CHUNK);
      const rows = await this.o.store.sync.arrivals(chunk);
      if (!current()) return;
      const now = this.o.now();
      for (const m of rows) if (stillNew(m, now)) fresh.push(m);
    }
    const { verdicts, seq } = await this.judge(fresh, bodyFilters, this.o.now(), (id) => retries.get(id)?.until != null);
    if (!current()) return;
    const dates = new Map(fresh.map((m) => [m.id, m.date]));
    for (const [id, verdict] of verdicts) {
      const retry = retries.get(id);
      const held: Held = { accountId, epoch, date: dates.get(id)!, until: retry?.until ?? null };
      if (verdict === "say") this.important.set(id, held);
      else if (verdict === "reading") this.waitReading(id, held);
      // a filter may still archive or read it once its body is here
      else this.wait(id, accountId, retry?.waits ?? 0, held.until);
    }
    this.trimImportant();
    this.trimReading(seq);
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
    // bodyFilters: one that reads bodies, turned on since the screen: mail whose body hasn't come waits for it (Codex re-review #3)
    const [rows, bodyFilters] = await Promise.all([this.o.store.sync.arrivals([...queued.keys()]), this.bodyFilters()]);
    if (generation !== this.generation || this.stopped) return;
    const now = this.o.now();
    // judged again by the rule that leads now (plan 273: a first screen changed, a row done, What matters' reader settled)
    const { verdicts, seq } = await this.judge(rows, bodyFilters, now, (id) => queued.get(id)?.until != null);
    if (generation !== this.generation || this.stopped) return;
    const news = rows.filter((m) => {
      const q = queued.get(m.id);
      // (plan 273: a wait for the reader's deadline holds whatever queue it went through: Codex critique #7)
      if (!q || q.epoch !== this.epochOf(q.accountId) || !this.timely(q.until)) return false;
      const verdict = verdicts.get(m.id);
      if (verdict === "body") this.wait(m.id, q.accountId, 0, q.until);
      else if (verdict === "reading") this.waitReading(m.id, q);
      return verdict === "say";
    });
    this.trimReading(seq);
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

  /** Plan 87: reminders that came due, said now (no gather or gap: the user asked for this moment), if notifications are on. */
  remind(notice: MailNotice): void {
    if (!this.notifications || this.stopped) return;
    const out = this.preview ? notice : redact(notice);
    if (this.o.host) return this.o.host.notify(out);
    log.info("notify.shown", { count: out.count });
    this.o.emit(out);
  }

  private drop(): void {
    this.generation++;
    this.important.clear();
    this.waiting.clear();
    this.reading.clear();
    this.lookedAt.clear();
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
