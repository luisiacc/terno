import { AiError, DIGEST_PROMPT_VERSION, digestBudget, type AiTasks, type DigestOutputItem } from "@terno/ai";
import {
  addressKey,
  aiFeaturesAvailable,
  BRIEF_NOTICE_THREAD,
  DEFAULT_TODAY,
  DIGEST_CANDIDATES_MAX,
  DIGEST_KEEP_DAYS,
  DIGEST_WINDOW_MS,
  findCode,
  HANDOFF_ITEMS_MAX,
  languageName,
  NOT_NEWSLETTER_NAME_MAX,
  NOT_NEWSLETTERS_MAX,
  NOT_NEWSLETTERS_OVER,
  todayKey,
  nextPrepareAt,
  prepareTimeToday,
  nextTodayChange,
  laterBefore,
  placedThreads,
  placeItems,
  projectRows,
  refKey,
  todayBadge,
  withEventEnds,
  withNeeds,
  type DatedRow,
  type Counts,
  type DigestItem,
  type DigestRow,
  type FeedRowId,
  type HandoffItem,
  type ItemSeen,
  type NotNewsletter,
  type ProjectedRow,
  type PlacedItem,
  type FollowupRow,
  type CountedMail,
  type NeedingPromise,
  type TodayCounts,
  type ThreadSummary,
  type TodayItem,
  type TodayList,
  type TodaySection,
  HISTORY_PAGE,
  type HistoryKey,
  type TodayHistoryPage,
  type RowVisibility,
  waitingRowId,
  isSemantic,
  datedGroup,
} from "@terno/core";
import { captureError } from "@terno/core/diag";
import { RpcError, type AppSettings } from "@terno/core/rpc";
import { L } from "@terno/i18n";
import { ANSWERED_WITH_PROMISE, NEEDS_WALK, WAITING_MOMENTS_MAX, wantedAsDated, type WantedSnapshot, type DigestStored, type ItemChanges, type ItemSnapshots, type ScheduleSnapshots, type WaitingSnapshot } from "@terno/store";
import { DailyLimitError, MonthlyLimitError } from "./ai-limiter";
import type { BackendCore as Backend } from "./core";
import { readerZone } from "./promise-time";
import { progressReporter } from "./scope";
import { aiAllowed, readSettings } from "./settings";
import { withoutQuotes } from "./summaries";
import { withoutMuted } from "./dated-mutes";
import { historyPage } from "./today-history";
import { datedTarget, promiseTarget, waitingTarget, type RowTarget } from "./preferences";
import { TodayLinks } from "./today-links";
import { scheduleChanges, type ScheduleAsk } from "./today-schedule";
import { suspiciousSender, untrustedSenders, withoutUntrusted, type WrittenTo } from "./suspicious-sender";

/**
 * Plan 145: what needs you today, all of it local and live. Only the digest reads mail with a model, and it's its own
 * opt-in. One timer, none when there's nothing to prepare; nothing waits on the digest. Nothing logged carries mail.
 */
const WALK_PAGE = 1000;
const NOTIFY_WITHIN_MS = 2 * 3_600_000;
const NOTIFIED_KEY = "today:notified";
const MAX_DELAY = 24 * 3_600_000;
const AUTOMATED_FRESH_MS = 30_000;
const TRIES = 3;
const SUMMARY_LINE_CHARS = 160;
/** plan 166: the senders the user said aren't newsletters, in the store's own small values (both stores), never AppSettings */
const NOT_NEWSLETTERS_KEY = "today:notNewsletters";
/** plan 204: waiting rows past these show their snippet, so a long list reads no more summaries than a screen needs */
const SUMMARY_LINES_MAX = 100;
/** plan 210 (iteration 2): the acts on items kept for Undo */
const UNDO_KEPT = 50;

/** Plan 210 (iteration 2): an act's patch on a dated item and on a promise of yours, as each worker's own act had them. */
function patchesFor(action: "done" | "dismiss" | "later", now: number, until: number | undefined): { dated: ItemChanges["dated"][number]["patch"]; promise: ItemChanges["promises"][number]["patch"] } {
  if (action === "later") return { dated: { deferredUntil: until! }, promise: { state: "open", inboxState: "none", deferredUntil: until! } };
  const state = action === "done" ? "done" : "dismissed";
  return { dated: { state, closedReason: "user", closedAt: now }, promise: { state, inboxState: "none", closedReason: "user", closedAt: now } };
}

/** An entry stored before entries had an id (Codex review, round 2) is named by its address: one entry a sender. */
const entries = (list: readonly NotNewsletter[]): NotNewsletter[] => list.map((e) => (e.id ? e : { ...e, id: `key:${addressKey(e.email)}` }));

export interface TodayOps {
  archive(ids: number[], narrow: (chunk: number[]) => Promise<number[]>, progress: (done: number) => void): Promise<{ undoId: number | null }>;
}

interface Candidates {
  items: DigestItem[];
  /** the newest arrival read: the next digest starts after it */
  watermark: { at: number; id: number };
}

const dayBefore = (day: string, days: number): string => {
  const [y, m, d] = day.split("-").map(Number);
  return todayKey(new Date(y!, m! - 1, d! - days).getTime());
};

const firstSentence = (text: string): string => (/^.*?[.!?](?:\s|$)/su.exec(text)?.[0] ?? text).trim().slice(0, SUMMARY_LINE_CHARS);

/** Plan 161: the page in time order, newest first, as its dates read: not the order the model's batches came back in. */
const newestFirst = (items: readonly DigestItem[]): DigestItem[] => [...items].sort((a, b) => b.lastDate - a.lastDate || b.threadId - a.threadId);

const EMPTY_IDS: ReadonlySet<FeedRowId> = new Set();
/** plan 249: waiting conversations' senders kept (twice the waiting walk) */
const WAITING_WHO_MAX = 2 * NEEDS_WALK;

export class TodayService {
  private ops: TodayOps | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private armedAt: number | null = null;
  private stopped = false;
  private draining: Promise<void> | null = null;
  private controller = new AbortController();
  private automated: { at: number; candidates: Candidates } | null = null;
  private refreshing: Promise<void> | null = null;
  /** a key or a setting is what's wrong: nothing goes until they move */
  private paused = false;
  private leaving: { items: readonly DigestItem[]; stop: AbortController } | null = null;
  /** plan 166: moves with the list of senders that aren't newsletters, so a scan begun before a change isn't kept */
  private exclusions = 0;
  /** plan 204: the clock's one timer (revision 11) */
  private clock: ReturnType<typeof setTimeout> | null = null;
  private clockAt: number | null = null;
  /** plan 210 (iteration 2): duplicate membership, reconciled before any projection */
  private readonly links = new TodayLinks();
  /** plan 210 (iteration 2): the items' places, the list's and the count's, until the clock or the items move them */
  private placing: { dated: readonly DatedRow[]; promises: string; at: number; until: number; items: PlacedItem[] } | null = null;
  /** plan 210 (iteration 2): what each act on items changed, for its Undo */
  private readonly undo = new Map<string, ItemSnapshots>();
  /** plan 249: Undo of an act on an item the user's words brought */
  private readonly wantedUndo = new Map<string, WantedSnapshot[]>();
  private undoSeq = 0;
  /** plan 210 (iteration 4): what each change of a day and time changed, for its Undo (Change… is its own act) */
  private readonly scheduleUndo = new Map<string, ScheduleSnapshots>();
  /** plan 215: what each Done or Later on a conversation waiting on you changed, for its Undo */
  private readonly waitingSnapshots = new Map<string, WaitingSnapshot>();
  /** plan 204: the open dated items, until something changes them */
  private datedCache: { generation: number; rows: readonly DatedRow[] } | null = null;
  /** plan 249: each waiting conversation's sender and subject at its waiting moment, for the words' rules */
  private readonly waitingWho = new Map<string, { from: string; fromName: string; subject: string }>();
  /** plan 249: v16's rows with the words' wanted ones after them, as last built */
  private wantedCache: { generation: number; dated: readonly DatedRow[]; rows: readonly DatedRow[] } | null = null;
  private datedGeneration = 0;
  private clockSeq = 0;

  constructor(private readonly b: Backend) {}

  bind(ops: TodayOps): void {
    this.ops = ops;
  }

  get nextAt(): number | null {
    return this.armedAt;
  }

  /** Plan 150: Today's rule, with Dev mode's switch: off, no timer, no digest, no notice, no list. */
  private async available(settings: Parameters<typeof aiFeaturesAvailable>[0]): Promise<boolean> {
    return aiFeaturesAvailable(settings) && (await aiAllowed(this.b.store));
  }

  /** Plan 281: whether What matters' items exist at all (People shows nothing without them). */
  async offered(): Promise<boolean> {
    return this.available(await readSettings(this.b.store));
  }

  private async setting(): Promise<{ available: boolean; show: boolean; prepareAt: string; notify: boolean; digest: boolean }> {
    const s = await readSettings(this.b.store);
    const today = { ...DEFAULT_TODAY, ...s.today };
    return { ...today, available: await this.available(s) };
  }

  /** at start, on wake, on a settings change, when it fires */
  async arm(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.armedAt = null;
    if (this.stopped) return;
    const s = await this.setting();
    if (!s.available || (!s.digest && !s.notify)) return;
    const next = nextPrepareAt(s.prepareAt, this.b.now());
    this.armedAt = next;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick().catch((error: unknown) => captureError(error, { code: "ai.failed" }));
    }, Math.min(MAX_DELAY, Math.max(0, next - this.b.now())));
    // never keeps a quitting process alive
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** At the time, or at the first start or wake after it the same day. */
  async tick(): Promise<void> {
    if (this.stopped) return;
    const s = await this.setting();
    const now = this.b.now();
    await this.purgeGone({ quiet: true });
    if (s.available && now >= prepareTimeToday(s.prepareAt, now)) {
      const day = todayKey(now);
      if (s.digest && !(await this.b.store.today.digest.get(day))) await this.begin(day);
      if (s.notify) await this.notify(day, s.prepareAt);
    }
    if (s.available && s.digest) void this.drain().catch((error: unknown) => captureError(error, { code: "ai.failed" }));
    await this.arm();
  }

  async start(): Promise<void> {
    await this.tick();
    await this.armClock();
  }

  wake(): void {
    void this.tick().catch((error: unknown) => captureError(error, { code: "ai.failed" }));
    // a machine that slept past a moment the list changes at
    this.changed();
  }

  /** What's underway is told to stop, and has before the store closes. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.armedAt = null;
    this.clockSeq++;
    if (this.clock) clearTimeout(this.clock);
    this.clock = null;
    this.clockAt = null;
    this.controller.abort();
    await this.draining?.catch(() => {});
    await this.refreshing?.catch(() => {});
  }

  /** Called as a digest request is about to leave, after any wait. */
  async holdingUp(): Promise<void> {
    const leaving = this.leaving;
    if (!leaving) return;
    if ((await this.stillListed(leaving.items)).length !== leaving.items.length) leaving.stop.abort();
  }

  /**
   * Plan 211: an account's switch moved: a digest batch on its way that carries mail no longer allowed stops (the next one
   * goes without it), the automated list is read again, and an open digest page reads its row again (it hears only
   * `todayDigest`). `changed()` (the caller's) redraws the rest.
   */
  accountsChanged(): void {
    if (this.automated) this.automated = { ...this.automated, at: 0 };
    void this.holdingUp().catch((error: unknown) => captureError(error, { code: "ai.failed" }));
    this.ended(todayKey(this.b.now()));
  }

  /**
   * Plan 211: of these, those whose thread's account `keep` lets in. Read (one batched read of the threads) only while
   * some account is out (`any`): none, the usual case, reads nothing. A thread gone keeps its row: its other checks drop it.
   */
  private async ofAccounts<T>(items: readonly T[], threadOf: (item: T) => number, keep: (accountId: number) => boolean, any: boolean): Promise<T[]> {
    if (!any || !items.length) return [...items];
    const accounts = new Map((await this.b.store.filters.actionFacts([...new Set(items.map(threadOf))])).map((f) => [f.id, f.accountId]));
    return items.filter((item) => {
      const account = accounts.get(threadOf(item));
      return account === undefined || keep(account);
    });
  }

  /** Plan 211: what the AI made (dated items, promises, the digest's lines) shows only where the account's AI and feed are on. */
  private aiMade<T extends { threadId: number }>(items: readonly T[]): Promise<T[]> {
    const { gate } = this.b;
    return this.ofAccounts(items, (i) => i.threadId, (a) => gate.reads(a), gate.readsOff.length > 0);
  }

  /** Plan 211: what's local (Needs you, your reminders, the automated list) follows the account's What matters switch alone. */
  private local<T>(items: readonly T[], threadOf: (item: T) => number): Promise<T[]> {
    const { gate } = this.b;
    return this.ofAccounts(items, threadOf, (a) => gate.feed(a), gate.feedOff.length > 0);
  }

  /** The digest off, or AI gone: what's underway stops and writes nothing. */
  settingsChanged(): void {
    this.paused = false;
    void this.setting()
      .then((s) => {
        if (!s.available || !s.digest) this.cancelRun();
        this.changed();
        return this.tick();
      })
      .catch((error: unknown) => captureError(error, { code: "ai.failed" }));
  }

  private cancelRun(): void {
    this.controller.abort();
    this.controller = new AbortController();
  }

  async clear(): Promise<void> {
    this.cancelRun();
    this.automated = null;
    await this.b.store.today.digest.clear();
    this.b.server.emit("todayDigest", { day: "" }, { origins: ["renderer", "dev"] });
  }

  // ─── candidates ──────────────────────────────────────────────────────────

  /**
   * By arrival, newest first, within its bound: an empty result can't walk the mailbox (revision 11). Plan 211: only of
   * accounts `keep` lets in (the digest's AI: AI and What matters on; the automated list: What matters on).
   */
  private async candidates(since: { at: number; id: number } | null, keep: (accountId: number) => boolean): Promise<Candidates> {
    const { store } = this.b;
    const now = this.b.now();
    const floor = Math.max(now - DIGEST_WINDOW_MS, since?.at ?? 0);
    const walk = store.filters.messageWalk();
    // plan 166: read once a scan; a sender said not to be a newsletter takes no place among the 40, and reaches no model
    const excluded = await this.excludedKeys();
    const items: DigestItem[] = [];
    const seen = new Set<number>();
    let watermark = since ?? { at: floor, id: 0 };
    let first = true;
    for (;;) {
      const page = await walk.next(WALK_PAGE);
      if (!page.length) break;
      if (first) {
        first = false;
        const [newest] = page;
        const at = (await store.today.digestFacts([newest!])).oldest;
        if (at !== null && (since === null || newest! > since.id)) watermark = { at, id: newest! };
      }
      const { facts, oldest } = await store.today.digestFacts(page);
      for (const f of facts) {
        if (f.arrivedAt < floor || (since && f.messageId <= since.id) || seen.has(f.threadId) || !keep(f.accountId)) continue;
        // a sign-in code isn't reading, and it isn't something to archive unread
        // plan 261: the stored code reads the whole text; the snippet's still counts for mail stored before it
        if (f.code || findCode(f.subject, f.snippet)) continue;
        // after the fourth panel round: a sender named like a security desk is no newsletter to skim, nor a model's to read
        if (excluded.has(addressKey(f.fromEmail)) || (suspiciousSender(f.fromEmail) && (await untrustedSenders([f.fromEmail], this.writtenTo)).size)) continue;
        seen.add(f.threadId);
        items.push({ threadId: f.threadId, messageId: f.messageId, lastDate: f.lastDate, messageCount: f.messageCount, from: f.from, fromEmail: f.fromEmail, subject: f.subject, line: null });
        if (items.length >= DIGEST_CANDIDATES_MAX) return { items, watermark };
      }
      if (oldest === null || oldest < floor || (since && page[page.length - 1]! <= since.id)) break;
      await this.b.yieldTurn();
    }
    return { items, watermark };
  }

  private async begin(day: string): Promise<void> {
    const { digest } = this.b.store.today;
    const generation = digest.clearGeneration();
    const previous = await digest.latest(day);
    const { items, watermark } = await this.candidates(previous?.watermark.id ? previous.watermark : null, (a) => this.b.gate.reads(a));
    // a day with nothing writes nothing and sends nothing
    if (items.length) await digest.begin(day, watermark, items, generation);
    await digest.prune(dayBefore(day, DIGEST_KEEP_DAYS));
  }

  // ─── the worker ──────────────────────────────────────────────────────────

  /** One at a time, and anything a quit left pending goes on from what's checkpointed (revision 6). */
  drain(o: { foreground?: boolean } = {}): Promise<void> {
    if (this.draining) return this.draining;
    if (this.paused && !o.foreground) return Promise.resolve();
    this.draining = (async () => {
      try {
        for (const day of await this.b.store.today.digest.pendingDays()) {
          if (!(await this.run(day, o))) break;
        }
      } finally {
        this.draining = null;
      }
    })();
    return this.draining;
  }

  private ended(day: string): void {
    this.b.server.emit("todayDigest", { day }, { origins: ["renderer", "dev"] });
  }

  /** False: stop for now (a limit, a pause, the digest off). */
  private async run(day: string, o: { foreground?: boolean }): Promise<boolean> {
    const { store } = this.b;
    const { digest } = store.today;
    const generation = digest.clearGeneration();
    const read = await digest.get(day);
    if (!read || read.state !== "pending") return true;
    let row: DigestStored = read;
    const { signal } = this.controller;
    let ai: AiTasks | null = null;
    try {
      for (;;) {
        if (signal.aborted) return false;
        const s = await this.setting();
        if (!s.available || !s.digest) return false;
        // read anew each time: Settings may have moved since the last batch
        ai = await this.b.aiService.forTask("digest", { foreground: o.foreground === true });
        // what's been deleted, moved to Spam, or changed since it was listed goes no further, and isn't kept (revision 2)
        row = (await digest.get(day)) ?? row;
        // plan 166: and a sender said not to be a newsletter, before a token goes on it; what's kept carries its sender
        const pending = await this.stillListed(row.pending);
        const dropped = pending.length !== row.pending.length;
        row = { ...row, pending };
        if (dropped && !(await digest.write(row, generation))) return false;
        if (!row.pending.length) break;
        const { batch: size, textChars } = digestBudget(ai.contextTokens);
        const batch: DigestItem[] = row.pending.slice(0, size);
        const labelled = await Promise.all(batch.map(async (item, i) => ({ item, label: `d${i + 1}`, text: await this.textOf(item) })));
        const language = languageName(await this.b.summaries.readerLanguage()) ?? "English";
        // as the request leaves, after any wait, each is read again: what no longer holds stops it here, repairs included
        const batchStop = new AbortController();
        this.leaving = { items: batch, stop: batchStop };
        let out: DigestOutputItem[];
        try {
          out = await ai.digestNewsletters({ language, textChars, items: labelled.map(({ item, label, text }) => ({ label, from: item.from, subject: item.subject, text })) }, AbortSignal.any([signal, batchStop.signal]));
        } catch (error) {
          // it isn't a failure: those go, and the rest are asked about without them
          if (batchStop.signal.aborted && !signal.aborted) continue;
          throw error;
        } finally {
          this.leaving = null;
        }
        // read again: off while this was out means nothing it brought back is kept
        const after = await this.setting();
        if (signal.aborted || !after.available || !after.digest) return false;
        const byLabel = new Map(out.filter((x) => x.kind === "newsletter" && x.line).map((x) => [x.label, x.line]));
        // `other`, and what it forgot, fall out
        const stillThere = new Set((await this.stillListed(batch)).map((i) => i.threadId));
        const kept = labelled.flatMap(({ item, label }) => (byLabel.has(label) && stillThere.has(item.threadId) ? [{ ...item, line: byLabel.get(label)! }] : []));
        // what's there now: a purge while this was out stays purged, and nothing it took out comes back
        const current = (await digest.get(day)) ?? row;
        const done = new Set(batch.map((i) => i.threadId));
        row = { ...current, items: [...current.items, ...kept], pending: current.pending.filter((i) => !done.has(i.threadId)), model: ai.model, provider: ai.providerId, promptVersion: DIGEST_PROMPT_VERSION };
        if (!(await digest.write(row, generation))) return false;
        await this.b.yieldTurn();
      }
      const done: DigestStored = { ...row, state: "ready", attempts: 0, errorKind: null, generatedAt: this.b.now() };
      if (await digest.write(done, generation)) this.ended(day);
      return true;
    } catch (error) {
      if (error instanceof DailyLimitError || error instanceof MonthlyLimitError) {
        this.b.log("info", "digest stopped at a limit", {});
        return false;
      }
      const kind = error instanceof AiError ? error.kind : "unavailable";
      // plan 162 (Codex review): stored apart, so the page says the provider answered with an error, not that it was out of reach
      const said = error instanceof AiError && kind === "unavailable" && (error.i18n?.key === "errors.ai.providerError" || error.i18n?.key === "errors.ai.notFound") ? (error.i18n.key === "errors.ai.notFound" ? "provider_not_found" : "provider_error") : kind;
      if (kind === "cancelled") return false;
      if (!(error instanceof AiError)) captureError(error, { code: "ai.failed" });
      this.b.log("info", "digest failed", { aiKind: kind });
      // plan 132's table: a key or a setting pauses it, spending no attempt, until Settings move
      if (kind === "auth" || kind === "not_configured" || kind === "blocked") {
        this.paused = true;
        // a key without permission is stored apart from a rejected one, so the page says which
        await digest.write({ ...row, errorKind: kind === "auth" && error instanceof AiError && error.i18n?.key === "errors.ai.noPermission" ? "provider_no_permission" : kind }, generation);
        this.ended(day);
        return false;
      }
      const attempts = row.attempts + 1;
      // what no retry helps ends here and says so; what may pass gets a few more goes, on the next start or wake
      const final = kind === "invalid_output" || kind === "refused" || kind === "unsupported" || attempts >= TRIES;
      await digest.write({ ...row, attempts, errorKind: said, state: final ? "failed" : "pending" }, generation);
      if (final) this.ended(day);
      return false;
    }
  }

  /** As listed, and (plan 166) from a sender still allowed in: run as each request leaves, repairs included. Each with its sender. */
  private readonly writtenTo: WrittenTo = (keys) => this.b.store.dated.trusted(keys);

  private async stillListed(listed: readonly DigestItem[]): Promise<DigestItem[]> {
    if (!listed.length) return [];
    const [items, excluded] = await Promise.all([this.withSenders(listed), this.excludedKeys()]);
    const facts = new Map((await this.b.store.filters.actionFacts(items.map((i) => i.threadId))).map((f) => [f.id, f]));
    // Codex's second pass: a digest checkpointed before the guard, resumed, sends and keeps no suspicious sender's message
    const untrusted = await untrustedSenders(items.map((i) => i.fromEmail ?? ""), this.writtenTo);
    return items.filter((i) => {
      const f = facts.get(i.threadId);
      const key = addressKey(i.fromEmail ?? "");
      // plan 211: and an account whose AI or What matters went off since it was listed
      return f && !f.inSpam && !f.inTrash && f.lastDate === i.lastDate && f.messageCount === i.messageCount && !excluded.has(key) && !untrusted.has(key) && this.b.gate.reads(f.accountId);
    });
  }

  /** Plan 166 (Codex critique): an item stored before items carried a sender gets its own message's, not its thread's last. */
  private async withSenders(items: readonly DigestItem[]): Promise<DigestItem[]> {
    const missing = items.filter((i) => i.fromEmail === undefined).map((i) => i.messageId);
    if (!missing.length) return [...items];
    const found = await this.b.store.today.senders(missing);
    return items.map((i) => (i.fromEmail === undefined ? { ...i, fromEmail: found.get(i.messageId) ?? "" } : i));
  }

  // ─── not a newsletter (plan 166) ─────────────────────────────────────────

  private async readNotNewsletters(): Promise<NotNewsletter[]> {
    return entries(await this.b.store.settings.get<NotNewsletter[]>(NOT_NEWSLETTERS_KEY, []));
  }

  /** Plan 240: a sender always shown is out of the digest and Automated mail too: their conversations are in Needs you. */
  private async excludedKeys(): Promise<Set<string>> {
    const [not, shown] = await Promise.all([this.readNotNewsletters(), this.b.store.today.shown.list()]);
    return new Set([...not.map((e) => addressKey(e.email)), ...shown.map((s) => s.key)]);
  }

  /** Plan 240: the senders always shown moved: the digest's exclusions, and What matters' rows (who's trusted) read again. */
  shownChanged(): void {
    this.exclusionsChanged();
    this.changed();
  }

  /** Newest first. */
  async notNewsletters(): Promise<NotNewsletter[]> {
    return [...(await this.readNotNewsletters())].sort((a, b) => b.at - a.at);
  }

  /**
   * Senders out of every digest and Automated mail (plan 235: several at once, from the page's ticks). One unit, so two at
   * once can't lose one; one already listed adds nothing; at the cap the oldest go, and are said.
   */
  async notNewsletter(p: { senders: readonly { email: string; name: string }[] }): Promise<{ added: NotNewsletter[]; evicted: NotNewsletter[] }> {
    const now = this.b.now();
    const r = await this.b.store.settings.update<NotNewsletter[], { added: NotNewsletter[]; evicted: NotNewsletter[] }>(NOT_NEWSLETTERS_KEY, [], (stored) => {
      const value = entries(stored);
      const listed = new Set(value.map((e) => addressKey(e.email)));
      const added: NotNewsletter[] = [];
      for (const s of p.senders) {
        const key = addressKey(s.email);
        if (listed.has(key)) continue;
        listed.add(key);
        // after every other (Codex review, round 2): the list's order holds within a millisecond and through a clock set back,
        // so the cap never drops one just said
        const at = Math.max(now, ...value.map((e) => e.at + 1));
        const entry: NotNewsletter = { id: globalThis.crypto.randomUUID(), email: s.email.trim(), name: s.name.trim().slice(0, NOT_NEWSLETTER_NAME_MAX), at };
        value.push(entry);
        added.push(entry);
      }
      const evicted: NotNewsletter[] = [];
      // the oldest first (Undos putting entries back may have left it up to NOT_NEWSLETTERS_OVER over)
      while (value.length > NOT_NEWSLETTERS_MAX) {
        const oldest = value.reduce((a, e) => (e.at < a.at ? e : a));
        evicted.push(oldest);
        value.splice(value.indexOf(oldest), 1);
      }
      return { value, result: { added, evicted } };
    });
    if (r.added.length) this.exclusionsChanged();
    return r;
  }

  /** A sender back in. With `id`, only that entry. */
  async newsletterAgain(p: { email: string; id?: string }): Promise<{ removed: NotNewsletter | null }> {
    const key = addressKey(p.email);
    const r = await this.b.store.settings.update<NotNewsletter[], NotNewsletter | null>(NOT_NEWSLETTERS_KEY, [], (stored) => {
      const list = entries(stored);
      const found = list.find((e) => addressKey(e.email) === key && (p.id === undefined || e.id === p.id)) ?? null;
      return { value: found ? list.filter((e) => e !== found) : list, result: found };
    });
    if (r) this.exclusionsChanged();
    return { removed: r };
  }

  /**
   * An Undo, whole in one unit: off what it added (only that entry, an old Undo can't take off one said again since), and
   * back what it took off or the cap dropped, as they were. A sender listed again meanwhile isn't listed twice.
   */
  async notNewslettersUndo(p: { remove?: readonly { email: string; id: string }[]; restore: readonly NotNewsletter[] }): Promise<{ restored: number }> {
    const r = await this.b.store.settings.update<NotNewsletter[], { changed: boolean; restored: number }>(NOT_NEWSLETTERS_KEY, [], (stored) => {
      const list = entries(stored);
      const off = new Set((p.remove ?? []).map((e) => e.id));
      let value = list.filter((e) => !off.has(e.id));
      let changed = value.length !== list.length;
      let restored = 0;
      for (const e of p.restore) {
        if (value.some((x) => addressKey(x.email) === addressKey(e.email))) continue;
        // bounded (Codex review, round 2): Undos racing other windows can't grow it past the cap by more than this, so what
        // the next addition drops always fits its own Undo
        if (value.length >= NOT_NEWSLETTERS_MAX + NOT_NEWSLETTERS_OVER) break;
        value = [...value, { ...e, name: e.name.slice(0, NOT_NEWSLETTER_NAME_MAX) }];
        restored++;
        changed = true;
      }
      return { value, result: { changed, restored } };
    });
    if (r.changed) this.exclusionsChanged();
    return { restored: r.restored };
  }

  /** What's shown reads the list again: the page, Today's header and Settings follow the event. */
  private exclusionsChanged(): void {
    this.exclusions++;
    // what's automated stays shown (filtered at read: never empty for a moment) and is scanned again on the next read
    if (this.automated) this.automated = { ...this.automated, at: 0 };
    this.ended(todayKey(this.b.now()));
  }

  /** What's gone from the mail goes from every stored digest too: nothing shown outlives what it quotes. */
  async purgeGone(o: { quiet?: boolean } = {}): Promise<void> {
    const { digest } = this.b.store.today;
    this.automated = null;
    const generation = digest.clearGeneration();
    for (const row of await digest.all()) {
      const all = [...row.items, ...row.pending];
      if (!all.length) continue;
      // by the message it quotes: an older one can keep the thread alive
      const here = new Set(await this.b.store.today.messagesHere(all.map((i) => i.messageId)));
      if (all.every((i) => here.has(i.messageId))) continue;
      await digest.write({ ...row, items: row.items.filter((i) => here.has(i.messageId)), pending: row.pending.filter((i) => here.has(i.messageId)) }, generation);
    }
    if (!o.quiet) this.ended(todayKey(this.b.now()));
  }

  /** Its opening, visible text only; the snippet if the body isn't here yet. */
  private async textOf(item: DigestItem): Promise<string> {
    const context = await this.b.store.writing.threadContext(item.threadId, { maxBodies: 1, maxChars: 2400 });
    const message = context?.messages.find((m) => m.id === item.messageId);
    if (message?.text) return withoutQuotes(message.text);
    return (await this.b.store.threads.summaries([item.threadId]))[0]?.snippet ?? "";
  }

  async retry(): Promise<void> {
    const { digest } = this.b.store.today;
    const day = todayKey(this.b.now());
    const row = await digest.get(day);
    this.paused = false;
    if (!row) await this.begin(day);
    else if (row.state === "failed" || row.errorKind) await digest.write({ ...row, state: "pending", attempts: 0, errorKind: null }, digest.clearGeneration());
    await this.drain({ foreground: true });
  }

  // ─── the list ────────────────────────────────────────────────────────────

  /**
   * Plan 210 (iteration 2, Codex's design): the one projection, the list's, the sidebar's count's and the morning notice's,
   * from bounded batched reads (never one a row): the open dated items (cached until they change) and promises, their
   * duplicate membership reconciled first (`TodayLinks`), placed (`placeItems`); then what's waiting on you (`needsYou`
   * over the newest `NEEDS_WALK`), your reminders due today (the list's only), and which of the placed items'
   * conversations are in Spam or Trash; then rows and the counts' buckets (`projectRows`). The list reads its rows'
   * conversations once, what says Spam and Trash too (`threads`); the count asks only that (`liveAmong`).
   */
  private async project(now: number, settings: AppSettings, o: { count?: boolean; counted?: boolean; /** plan 281: People's ask: no reminders (they're nobody's) */ noReminders?: boolean } = {}): Promise<{ rows: ProjectedRow[]; counts: TodayCounts; counted?: CountedMail; threads: ReadonlyMap<number, ThreadSummary>; hidden?: ReadonlySet<FeedRowId> }> {
    const { store } = this.b;
    const read = async () => [settings.dated?.enabled ? await this.datedRows() : [], settings.followups?.enabled ? (await store.followups.active()).filter((r) => r.kind === "promise") : []] as const;
    const version = this.links.version;
    let [dated, promises] = await read();
    // what a new item is the same as, before any row shows it twice (written once, then read like any fact); a membership
    // written by another read meanwhile makes this one's stale too
    if ((await this.links.reconcile(store, dated, promises)) || this.links.version !== version) {
      this.datedGeneration++;
      [dated, promises] = await read();
    }
    // plan 211: a promise of an account with AI or What matters off isn't shown nor counted (the dated rows' cache did theirs)
    // plans 218, 277: a promise whose conversation is in Trash or Spam shows nowhere (the follow-ups' last look says which)
    const away = promises.length ? await this.b.followups.awayAmong(promises.map((p) => p.threadId)) : new Set<number>();
    // plan 249: what the user's words brought joins after the links are reconciled (it's never linked, answered or merged)
    const placing = settings.dated?.enabled ? await this.withWanted(dated) : dated;
    const items = this.placed(placing, await this.needs(dated, await this.aiMade(promises)), now, o.count === true, away);
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);
    // plan 210 (iteration 4, revision 8): your reminders due today are Today's to do, drawn and counted alike; the count reads
    // them as stored (a few, at most `REMINDERS_MAX`), the list as the reminders' own look has them (answered ones ended)
    const due = (o.noReminders ? [] : o.count ? await store.reminders.list() : (await this.b.reminders.refresh()).reminders).filter((r) => r.dueAt <= endOfDay.getTime()).map((r) => ({ threadId: r.threadId, dueAt: r.dueAt }));
    // plan 211: your reminders and what's waiting on you are local: they follow the account's What matters switch alone
    const reminders = await this.local(due, (r) => r.threadId);
    const ids = [...placedThreads(items), ...reminders.map((r) => r.threadId)];
    const page = await this.local(await store.today.waitingPage({ now, after: null, limit: NEEDS_WALK }), (w) => w.id);
    // plan 215: each row's waiting message, its record's revision and Later's moment (the list's); the count reads only the
    // deferrals still ahead and (plan 216) the Removes, which keep a row out of Waiting on you, and nothing while there's none
    const acts = await store.today.waiting.rows(page.map((w) => ({ threadId: w.id, since: w.waitingSince })), now, { messages: !o.count });
    const waiting = acts.size || !o.count ? page.map((w) => {
      const a = acts.get(w.id);
      return a ? { ...w, message: a.message, rev: a.rev, deferredUntil: a.until, ...(a.removed && { removed: true }) } : w;
    }) : page;
    // plan 249: the user's words, applied after the facts (none for the empty box: nothing is built)
    const visibility = await this.visibility(items, waiting, o.count === true);
    // (the zone's read only for the rows' words: an Intl formatter is dear on every count)
    const fact = { now, waiting, reminders, zone: o.count ? "" : readerZone(), ...(visibility && { visibility: visibility.rows }) };
    if (o.count) {
      const live = await store.today.liveAmong([...new Set(ids)]);
      return { ...projectRows(items, { ...fact, live: (id) => live.has(id) }, o), threads: new Map() };
    }
    // (the waiting conversations' summaries the words read already are used, not read twice: the Astra review)
    const known = visibility?.threads ?? new Map<number, ThreadSummary>();
    const threads = new Map(known);
    const toRead = [...new Set([...ids, ...waiting.map((w) => w.id)])].filter((id) => !known.has(id));
    for (const t of toRead.length ? await store.threads.summaries(toRead) : []) threads.set(t.id, t);
    const live = (id: number) => {
      const t = threads.get(id);
      return !!t && !t.inSpam && !t.inTrash;
    };
    return { ...projectRows(items, { ...fact, live }, o), threads, hidden: visibility?.hidden ?? EMPTY_IDS };
  }

  /**
   * Plan 249: the open wanted items whose rules are current (a show of the words now), as dated rows (negative ids), after
   * v16's; the same array while nothing changed, so the count's cache holds. None (and nothing read) with no show rule.
   */
  private async withWanted(dated: readonly DatedRow[]): Promise<readonly DatedRow[]> {
    const rules = await this.b.words.rules();
    if (!rules.some((r) => r.effect === "show")) return dated;
    const generation = this.datedGeneration;
    if (this.wantedCache?.generation === generation && this.wantedCache.dated === dated) return this.wantedCache.rows;
    const shows = new Set(rules.filter((r) => r.effect === "show").map((r) => r.key));
    const open = (await this.b.store.whatMatters.wanted.active()).filter((w) => w.rules.some((k) => shows.has(k))).map(wantedAsDated);
    // as v16's are: a muted sender's or kind's hidden, an untrusted sender's never shown, an account not reading none
    const mine = open.length ? await this.aiMade(await withoutUntrusted(withoutMuted(open, await this.b.mutes.muted()), (keys) => this.b.store.dated.trusted(keys))) : [];
    const rows = mine.length ? [...dated, ...mine] : dated;
    if (generation === this.datedGeneration) this.wantedCache = { generation, dated, rows };
    return rows;
  }

  /**
   * Plan 249: the projection's view of the user's words: each placed item hidden when the words hide every entry of it and
   * first when they put one first; each waiting conversation by its own message. Null for the empty box.
   */
  private async visibility(items: readonly PlacedItem[], waiting: readonly { id: number; waitingSince: number; removed?: boolean }[], count: boolean): Promise<{ rows: RowVisibility; hidden: Set<FeedRowId>; threads: Map<number, ThreadSummary> } | null> {
    const rules = await this.b.words.rules();
    // shows alone hide and order nothing: no row is looked at (most of what a projection does here is skipped)
    if (!rules.some((r) => r.effect !== "show")) return null;
    const targets = new Map<string, RowTarget>();
    const ofEntry = new Map<object, RowTarget>();
    for (const p of items)
      for (const e of p.item.entries) {
        const t = e.source === "dated" ? datedTarget(e.row) : promiseTarget(e.row);
        targets.set(t.key, t);
        ofEntry.set(e.row, t);
      }
    // a waiting conversation the rules may reach (an `only` reaches every row, the Codex code review), but none a placed item
    // already stands for or that was removed: those never show as waiting rows, so they're never judged (the Astra review)
    const ofWaiting = new Map<number, RowTarget>();
    const threads = new Map<number, ThreadSummary>();
    const reachWaiting = rules.filter((r) => r.effect === "only" || (r.effect !== "show" && (!r.kinds?.length || r.kinds.includes("waiting"))));
    // (as `projectRows` counts a conversation represented: an item that isn't a Plan, placed outside Coming up)
    const placedThreads = new Set(items.filter((p) => p.at.group !== "comingUp" && !(p.item.lead.source === "dated" && datedGroup(p.item.lead.row.kind) === "plans")).map((p) => p.item.lead.row.threadId));
    const candidates = reachWaiting.length ? waiting.filter((w) => !w.removed && !placedThreads.has(w.id)) : [];
    if (candidates.length) {
      // their sender and subject only when a rule asks who or what (kinds alone don't: the count stays without summaries)
      const needs = reachWaiting.some((r) => r.senders?.length || r.names?.length || isSemantic(r));
      // a waiting conversation's sender and subject are its waiting message's: kept by that moment across projections,
      // read only for the new ones (the Fable review: the count read 2,000 summaries each time)
      const at = (w: { id: number; waitingSince: number }) => `${w.id}:${w.waitingSince}`;
      const missing = needs ? candidates.filter((w) => !this.waitingWho.has(at(w))) : [];
      if (missing.length) {
        if (this.waitingWho.size + missing.length > WAITING_WHO_MAX) this.waitingWho.clear();
        const since = new Map(missing.map((w) => [w.id, w.waitingSince]));
        for (const t of await this.b.store.threads.summaries(missing.map((w) => w.id))) {
          threads.set(t.id, t);
          this.waitingWho.set(at({ id: t.id, waitingSince: since.get(t.id)! }), { from: t.fromEmail, fromName: t.fromName, subject: t.subject });
        }
      }
      for (const w of candidates) {
        const who = needs ? this.waitingWho.get(at(w)) : undefined;
        if (needs && !who) continue;
        const t = waitingTarget({ id: w.id, waitingSince: w.waitingSince, from: who?.from ?? "", ...(who?.fromName ? { fromName: who.fromName } : {}), subject: who?.subject ?? "" });
        targets.set(t.key, t);
        ofWaiting.set(w.id, t);
      }
    }
    const seen = await this.b.words.visibility([...targets.values()], { ask: true, from: count ? "count" : "list" });
    if (!seen) return null;
    const hidden = new Set<FeedRowId>();
    return {
      hidden,
      threads,
      rows: {
        item: (l) => {
          let hide = true;
          let first = false;
          for (const e of l.entries) {
            const d = seen.decide(ofEntry.get(e.row)!);
            hide &&= d.hide;
            first ||= d.first;
          }
          if (hide) hidden.add(l.id);
          return { hide, first: !hide && first };
        },
        waiting: (w) => {
          const t = ofWaiting.get(w.id);
          const d = t ? seen.decide(t) : { hide: false, first: false };
          if (d.hide) hidden.add(waitingRowId(w.id));
          return d;
        },
      },
    };
  }

  /**
   * Plan 249: a conversation's items as its reader line shows them (`dated.ofThread`): v16's, then what the user's words
   * brought there (a show still current), less what the words hide (a history line's own closed item stays).
   */
  async conversationItems(threadId: number, include?: number): Promise<DatedRow[]> {
    // (a wanted row opened names itself by its negative id: the words' own rows below hold it)
    const rows = await this.b.dated.ofThread(threadId, include !== undefined && include > 0 ? include : undefined);
    const rules = await this.b.words.rules();
    if (!rules.length) return rows;
    const shows = new Set(rules.filter((r) => r.effect === "show").map((r) => r.key));
    const wanted = shows.size ? (await this.b.store.whatMatters.wanted.ofThread(threadId)).filter((w) => w.rules.some((k) => shows.has(k))).map(wantedAsDated) : [];
    const mine = wanted.length ? await withoutUntrusted(withoutMuted(wanted, await this.b.mutes.muted()), (keys) => this.b.store.dated.trusted(keys)) : [];
    const all = [...rows, ...mine];
    const targets = all.map(datedTarget);
    const seen = await this.b.words.visibility(targets, { ask: false });
    return seen ? all.filter((r, i) => r.state !== "open" || r.id === include || !seen.decide(targets[i]!).hide) : all;
  }

  /** Plan 249: the "Changed" lines of rows the user's words hide aren't lines either (the Codex code review) */
  private async keptChanged(changed: Awaited<ReturnType<TodayService["changedItems"]>>): Promise<Awaited<ReturnType<TodayService["changedItems"]>>> {
    if (!changed || !(await this.b.words.rules()).some((r) => r.effect !== "show")) return changed;
    return { dated: await this.historyKept("dated", [...changed.dated]), promises: await this.historyKept("promise", [...changed.promises]) };
  }

  /** Plan 249: the history's rows the user's words keep (verdicts read a batch at a time; never withheld). */
  private async historyKept<R extends DatedRow | FollowupRow>(source: "dated" | "promise", rows: R[]): Promise<R[]> {
    const targets = rows.map((r) => (source === "dated" ? datedTarget(r as DatedRow) : promiseTarget(r as FollowupRow)));
    const seen = await this.b.words.visibility(targets, { ask: false });
    if (!seen) return rows;
    return rows.filter((_, i) => !seen.decide({ ...targets[i]!, since: 0 }).hide);
  }

  /**
   * Where the items sit changes only at the moments `nextTodayChange` knows (and midnight): between them, and while the items
   * are the same (the cached dated rows, the promises as read), the count reuses it: the count runs on every mailbox change.
   * The list places afresh (it's read when something changed, and finding the next moment would cost it as much again).
   */
  private placed(dated: readonly DatedRow[], promises: readonly NeedingPromise[], now: number, count: boolean, away: ReadonlySet<number>): PlacedItem[] {
    if (!count) return placeItems(dated, promises, now, { away });
    const key = promises.map((r) => `${r.id}.${r.revision}.${r.state}.${r.dueAt}.${r.deferredUntil ?? ""}.${r.sameAs ?? ""}.${r.answers ?? ""}.${r.needed ?? ""}${away.has(r.threadId) ? ".away" : ""}`).join();
    const was = this.placing;
    if (was && was.dated === dated && was.promises === key && now >= was.at && now < was.until) return was.items;
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    const until = Math.min(nextTodayChange(dated, promises, now) ?? Infinity, midnight.getTime());
    const items = placeItems(dated, promises, now, { count, away });
    this.placing = { dated, promises: key, at: now, until, items };
    return items;
  }

  /**
   * Plan 210 (iteration 3, the Codex review's revision 2): each promise with the day of the request it answers, the
   * requests read in one batch: those among the open dated items as they are, the rest (closed, or past the bound) by id.
   * Most promises answer none: nothing is read.
   */
  private async needs(dated: readonly DatedRow[], promises: readonly FollowupRow[]): Promise<NeedingPromise[]> {
    if (!promises.some((p) => p.answers != null)) return [...promises];
    const known = new Map(dated.map((r) => [r.id, r]));
    const missing = new Set(promises.flatMap((p) => (p.answers != null && !known.has(p.answers) ? [p.answers] : [])));
    // (one read for all of them; the members that join them aren't wanted here)
    if (missing.size) for (const r of (await this.b.store.today.members([...missing].map((id) => refKey({ source: "dated", id })))).dated) if (missing.has(r.id)) known.set(r.id, r);
    return withNeeds(promises, known);
  }

  /**
   * Plan 273: with What matters first, what a notice for new mail may say: of these arrivals, those a counted row stands for
   * (read from them, or their conversation waiting on you), and of the rest those the reader has still to read. The marks
   * are read before the projection, so a reading that commits between the two is in the projection, never lost. Null while
   * What matters isn't shown: the Inbox leads (`leadScreen`).
   */
  async noticeVerdict(arrivals: readonly { id: number; threadId: number }[]): Promise<{ counted: Set<number>; reading: Set<number> } | null> {
    const { store } = this.b;
    const settings = await readSettings(store);
    if (!{ ...DEFAULT_TODAY, ...settings.today }.show || !(await this.available(settings))) return null;
    const counted = new Set<number>();
    const reading = new Set<number>();
    if (!arrivals.length) return { counted, reading };
    const marked = await store.dated.marks.among(arrivals.map((m) => m.id));
    const mail = (await this.project(this.b.now(), settings, { count: true, counted: true })).counted;
    for (const m of arrivals) {
      if (mail?.messages.has(m.id) || mail?.waiting.has(m.threadId)) counted.add(m.id);
      else if (marked.has(m.id)) reading.add(m.id);
    }
    return { counted, reading };
  }

  /** Plan 210 (iteration 2): the header's, the sidebar's and the notice's numbers, as the list has them. */
  private async counts(now: number, settings: AppSettings): Promise<TodayCounts> {
    return (await this.project(now, settings, { count: true })).counts;
  }

  /**
   * The open dated items, read once until something changes them: the count runs on every mailbox change, and the read
   * is a few ms at the 1,000 bound. What changes them calls `changed()` (the reader, an act, Clear AI data) or changes the
   * mailbox (a merge, a deleted thread: `touched()`).
   */
  private async datedRows(): Promise<readonly DatedRow[]> {
    const generation = this.datedGeneration;
    if (this.datedCache?.generation === generation) return this.datedCache.rows;
    const { dated } = this.b.store;
    // Codex's second pass: an item stored from a suspicious sender before the guard isn't shown nor counted; plan 210
    // (iteration 4): nor one of a muted sender or kind (hidden, not closed: Unmute brings it back), the mutes read once here
    const [open, muted] = await Promise.all([dated.active(), this.b.mutes.muted()]);
    // an ask's event is found among every open item before any is hidden: muting events never ends their "Reply C to
    // confirm" (Codex's code review of iteration 4); plan 211: an account with AI or What matters off shows none (its
    // switch moving bumps the generation)
    const rows = await this.aiMade(await withoutUntrusted(withoutMuted(withEventEnds(open), muted), (keys) => dated.trusted(keys)));
    if (generation === this.datedGeneration) this.datedCache = { generation, rows };
    return rows;
  }

  /** The mailbox changed: a merge or a delete may have moved or removed an item's thread. */
  touched(): void {
    this.datedGeneration++;
    // plan 281: what's built from the rows (People's grouping) is read again on its next ask
    this.revision++;
  }

  /**
   * Plan 210: the history's lines strictly after `after` (a next page), or from the top (to `through`, a reload keeping
   * its depth; else a page). Iteration 2: a line per closed item, whatever else its conversation has open; a row the
   * feed holds in the open part (`held`, by its id) has none.
   */
  async history(o: { after: HistoryKey | null; through?: HistoryKey | null; limit?: number; held: readonly FeedRowId[] }): Promise<TodayHistoryPage> {
    const { store } = this.b;
    const now = this.b.now();
    const settings = await readSettings(store);
    // plan 210 (the owner): finished items hidden, no history is read at all
    if (!(await this.available(settings)) || settings.today?.finished === false) return { items: [], next: null };
    // plan 211: every history line is an item the AI made: an account with AI or What matters off has none; plan 215, but a
    // waiting conversation's Done, What matters' own, which follows its switch alone (as its row did)
    const { gate } = this.b;
    return historyPage(store, { now, after: o.after, through: o.through ?? null, limit: o.limit ?? HISTORY_PAGE, held: new Set(o.held), dated: settings.dated?.enabled === true, promises: settings.followups?.enabled === true, waiting: true, changed: await this.keptChanged(await this.changedItems(settings)), shows: (accountId) => gate.reads(accountId), showsWaiting: (accountId) => gate.feed(accountId), yieldTurn: () => this.b.yieldTurn(), sliceMs: this.b.options.sliceBudgetMs, ...((await this.b.words.rules()).some((r) => r.effect !== "show") && { keep: (source, rows) => this.historyKept(source, rows) }) });
  }

  /**
   * Plan 210 (iteration 2): the open part, a row per item in the projection's order, a section per group (and per day for a
   * day of its own and Coming up), with the header's numbers; the history after it when asked (the feed). `held`: the rows
   * the feed keeps in place while they're open or checked (it keeps their last words itself), never a history line.
   */
  async list(held: readonly FeedRowId[], ask: { history?: { through: HistoryKey | null } } = {}): Promise<TodayList> {
    const { store } = this.b;
    const now = this.b.now();
    const settings = await readSettings(store);
    const none = { missed: 0, today: 0, waiting: 0, overdue: 0 };
    if (!(await this.available(settings))) return { sections: [], digest: null, now, counts: none };
    // Trash and Spam hide a row, and it comes back with its thread (the projection read it from these summaries)
    const { rows: shown, counts, threads, hidden } = await this.project(now, settings);
    // a waiting row's line is its current summary, read together, for the first rows only
    const lined = shown.filter((r) => r.waiting).slice(0, SUMMARY_LINES_MAX).map((r) => r.threadId);
    const lines = new Map(await Promise.all(lined.map(async (id) => [id, await this.summaryLine(id)] as const)));
    const items = await this.itemsOf(shown, threads);
    const sections: TodaySection[] = [];
    for (const [i, r] of shown.entries()) {
      const item = items[i]!;
      const summary = r.waiting ? lines.get(r.threadId)?.summary : undefined;
      if (summary !== undefined) item.summary = summary;
      const last = sections.at(-1);
      const day = r.day ?? undefined;
      // plan 210 (iteration 3): Today's "Waiting on you" is a section of its own, after Today's
      if (last?.kind === r.group && last.day === day && last.part === r.part) last.items.push(item);
      else {
        const section: TodaySection = { kind: r.group, items: [item] };
        if (day) section.day = day;
        if (r.part) section.part = r.part;
        if (r.bucket) section.bucket = r.bucket;
        sections.push(section);
      }
    }
    const history = ask.history && settings.today?.finished !== false ? await this.history({ after: null, through: ask.history.through, held }) : undefined;
    // plan 249 (the Codex review's revision 5): held rows the user's words now hide, so the feed lets them go
    // and a held row the words brought that isn't shown any more (its last show rule went: it's never projected to be hidden)
    const shownIds = new Set(shown.map((r) => r.id));
    const gone = held.filter((id) => hidden?.has(id) || (id.startsWith("dated:-") && !shownIds.has(id)));
    return { sections, digest: await this.digestRow(), now, counts, ...(history ? { history } : {}), ...(gone.length ? { hidden: gone } : {}) };
  }

  /**
   * Plan 281: What matters' open part as items, in its order (the order of urgency), for People: no reminders, no summary
   * lines, no digest, no history. Nothing when it isn't offered.
   */
  async openItems(): Promise<TodayItem[]> {
    const settings = await readSettings(this.b.store);
    if (!(await this.available(settings))) return [];
    const { rows, threads } = await this.project(this.b.now(), settings, { noReminders: true });
    return this.itemsOf(rows, threads);
  }

  /**
   * The projected rows as items. Plan 210 (iteration 3, revision 10): each dated row's own sender: the conversation's latest
   * when it's theirs (most are), else its message's, one read for those.
   */
  private async itemsOf(shown: readonly ProjectedRow[], threads: ReadonlyMap<number, ThreadSummary>): Promise<TodayItem[]> {
    const senders: ({ name: string; email: string } | undefined)[] = [];
    const elsewhere: number[] = [];
    for (const r of shown) {
      const t = r.source ? threads.get(r.threadId) : undefined;
      const theirs = t && addressKey(t.fromEmail) === r.source!.senderKey;
      senders.push(theirs ? { name: t.fromName, email: t.fromEmail } : undefined);
      if (r.source && !theirs) elsewhere.push(r.source.messageId);
    }
    const from = elsewhere.length ? await this.b.store.today.fromOf(elsewhere) : null;
    return shown.map((r, i) => {
      const sender = senders[i] ?? (r.source && from ? from.get(r.source.messageId) : undefined);
      const item: TodayItem = { id: r.id, thread: threads.get(r.threadId)!, why: r.why };
      if (r.also) item.also = r.also;
      if (sender) item.from = sender;
      return item;
    });
  }

  /** A conversation's current stored summary, its first sentence (plan 281: People's "Last time" too); never a new request. */
  async summaryLine(threadId: number): Promise<{ summary?: string }> {
    const { store } = this.b;
    const row = await store.aiSummaries.get(threadId);
    if (!row || row.state !== "ready" || !row.bodyJson) return {};
    const sources = await store.aiSummaries.sources(threadId);
    // plan 211: a summary isn't shown for an account with AI off
    if (!sources || sources.stamp !== row.sourceStamp || !this.b.gate.ai(sources.accountId)) return {};
    const body = JSON.parse(row.bodyJson) as { summary?: string };
    return body.summary ? { summary: firstSentence(body.summary) } : {};
  }

  /** What the row and the page show. Without the digest: what's automated, kept fresh behind the list, which never waits for it. */
  async digestRow(): Promise<DigestRow | null> {
    const { store } = this.b;
    const s = await this.setting();
    if (!s.available) return null;
    const day = todayKey(this.b.now());
    // plan 166: left out at read too, both ways, so a scan or a digest from before a change can't show a sender said not to be one
    const excluded = await this.excludedKeys();
    const allowed = async (items: readonly DigestItem[]) => {
      const out = await untrustedSenders(items.map((i) => i.fromEmail ?? ""), this.writtenTo);
      return items.filter((i) => !excluded.has(addressKey(i.fromEmail ?? "")) && !out.has(addressKey(i.fromEmail ?? "")));
    };
    if (!s.digest) {
      if (!this.automated || this.b.now() - this.automated.at > AUTOMATED_FRESH_MS) this.refreshAutomated();
      // plan 211: filtered at read too (a list scanned before a switch moved shows none of that account for a moment)
      const items = await this.local(await allowed(this.automated?.candidates.items ?? []), (i) => i.threadId);
      if (!items.length) return null;
      return { day, state: "ready", items: newestFirst(items), automated: true, ...(await this.states(items)) };
    }
    const row = await store.today.digest.get(day);
    const shown = row && (row.state !== "pending" || row.items.length) ? row : await store.today.digest.latest(day);
    if (!shown) return row ? { day, state: "pending", items: [], automated: false, liveIds: [] } : null;
    // deleted since: nothing shown outlives what it quotes, and what's stored goes too
    const here = new Set(await store.today.messagesHere(shown.items.map((i) => i.messageId)));
    const kept = shown.items.filter((i) => here.has(i.messageId));
    if (kept.length !== shown.items.length) void this.purgeGone().catch((error: unknown) => captureError(error, { code: "ai.failed" }));
    const items = await this.aiMade(await allowed(await this.withSenders(kept)));
    const paused = row?.state === "pending" && row.errorKind !== null && this.paused;
    return { day: row?.state === "pending" ? day : shown.day, state: paused ? "failed" : (row?.state ?? shown.state), items: newestFirst(items), automated: false, ...(await this.states(items)), errorKind: paused ? row!.errorKind : shown.errorKind, model: shown.model, provider: shown.provider };
  }

  /** which listed threads are still to archive (in the Inbox, unread), and which were opened (in the Inbox, read) */
  private async states(items: readonly DigestItem[]): Promise<{ liveIds: number[]; readIds: number[] }> {
    const ids = items.map((i) => i.threadId);
    const [liveIds, readIds] = await Promise.all([this.b.store.today.digestLive(ids), this.b.store.today.digestRead(ids)]);
    return { liveIds, readIds };
  }

  private refreshAutomated(): void {
    if (this.refreshing) return;
    const before = this.automated?.candidates.items.map((i) => i.threadId).join();
    const exclusions = this.exclusions;
    this.refreshing = this.candidates(null, (a) => this.b.gate.feed(a))
      .then((candidates) => {
        // plan 166: begun before a sender was left out (or let back in): not kept, and the next read scans again
        if (exclusions !== this.exclusions) return;
        this.automated = { at: this.b.now(), candidates };
        if (candidates.items.map((i) => i.threadId).join() !== before) this.ended(todayKey(this.b.now()));
      })
      .catch((error: unknown) => captureError(error, { code: "ai.failed" }))
      .finally(() => {
        this.refreshing = null;
      })
      .then(() => undefined);
  }

  /**
   * Only what the page listed, each only if it's still as the page saw it: a new message or a star since keeps it (revisions
   * 1, 2). Read mail only when the page showed it read and the person ticked it (`read`, plan 235).
   */
  async archive(p: { items: readonly { threadId: number; lastDate: number; messageCount: number; fromEmail?: string; read?: boolean }[]; jobId?: string }): Promise<{ undoId: number | null; archived: number; archivedIds: number[]; changed: number; spared: number }> {
    const { store } = this.b;
    const listed = new Map(p.items.map((i) => [i.threadId, i]));
    const targets = [...listed.keys()];
    let changed = 0;
    let spared = 0;
    let archived = 0;
    const archivedIds: number[] = [];
    const narrow = async (chunk: number[]) => {
      const facts = new Map((await store.filters.actionFacts(chunk)).map((f) => [f.id, f]));
      // plan 166: as each chunk goes: a sender said not to be a newsletter meanwhile is left alone, and not counted
      const excluded = await this.excludedKeys();
      const out: number[] = [];
      for (const id of chunk) {
        const f = facts.get(id);
        const item = listed.get(id)!;
        if (item.fromEmail !== undefined && excluded.has(addressKey(item.fromEmail))) continue;
        if (!f || !f.inInbox || f.lastDate !== item.lastDate || f.messageCount !== item.messageCount) changed++;
        // plan 145 archives only unread mail: one read since the page was drawn stays, and is counted as left alone (plan 161).
        // Plan 235: unless the page showed it read and the person ticked it anyway
        else if (f.starred || f.replied || (!f.unread && item.read !== true)) spared++;
        else out.push(id);
      }
      archived += out.length;
      archivedIds.push(...out);
      return out;
    };
    const progress = progressReporter(this.b, p.jobId, targets.length);
    progress(0);
    const r = await this.ops!.archive(targets, narrow, progress);
    progress(targets.length);
    return { undoId: r.undoId, archived, archivedIds, changed, spared };
  }

  /**
   * The sidebar's number (plan 210, iteration 2, the owner): Missed and Today's, the rows `todayCounted` counts under them,
   * from the list's own projection (a row per item: two of one conversation count twice). Null during plan 17's backfill.
   */
  async withCount(counts: Counts): Promise<Counts> {
    const s = await this.setting().catch(() => null);
    if (!s?.available || !s.show) return counts;
    if (counts.inboxWaiting === null || counts.inboxWaiting === undefined) return { ...counts, today: null };
    return { ...counts, today: todayBadge(await this.counts(this.b.now(), await readSettings(this.b.store))) };
  }

  // ─── plan 210 (iteration 2): an act on a row is on every item it is ──────

  /**
   * Done, Remove and Later on an item, and on every item it's the same thing as (a merged row's members, whichever was
   * named), at once: each named one at the revision it was seen at, the others as they are now (they're the same thing),
   * all or none. Its Undo puts every one back. A promise of yours goes through here from anywhere (the feed, the
   * conversation's card), so a duplicate is never left behind.
   */
  /**
   * The items an act on a row is (Codex code review of iteration 2: read alone with the matcher, `links.exclusive`): every
   * item it's the same thing as, the named ones whatever their state (one closed since is stale), the others while they're
   * open; with `answering`, the open requests (every reading) the row's promises answer, which Done finishes with them.
   */
  private async rowItems(seen: readonly ItemSeen[], answering: boolean): Promise<{ at: Map<string, number>; datedNow: DatedRow[]; promisesNow: FollowupRow[]; answered: DatedRow[] }> {
    const { store } = this.b;
    const named = await Promise.all(seen.map((r) => (r.source === "dated" ? store.dated.get(r.id) : store.followups.get(r.id))));
    if (named.some((r) => !r)) throw new RpcError("STALE", L(seen[0]?.source === "promise" ? "errors.followups.changed" : "errors.dated.changed"));
    const { dated, promises } = await store.today.members(named.map((r, i) => r!.sameAs ?? refKey(seen[i]!)));
    const at = new Map(seen.map((r) => [refKey(r), r.revision]));
    const datedNow = dated.filter((r) => at.has(refKey({ source: "dated", id: r.id })) || r.state === "open");
    const promisesNow = promises.filter((r) => at.has(refKey({ source: "promise", id: r.id })) || r.state === "open" || r.state === "due");
    // plan 210 (iteration 3, the Codex review's revision 3): Done on a promise finishes the request it answers with it (its
    // Undo puts both back); Remove and Later are the promise's alone. Hidden from the history: the promise's line says it
    const asking = answering ? [...new Set(promisesNow.flatMap((p) => (p.answers != null ? [p.answers] : [])))] : [];
    const asked = (await Promise.all(asking.map((id) => store.dated.get(id)))).filter((r): r is DatedRow => r?.state === "open");
    // (Codex code review of iteration 3) the request's item, every reading of it: the projection hides them with the
    // promise (`withoutAnswered`), so they're settled with it, at once, and come back with its Undo
    const actedOn = new Set(datedNow.map((r) => r.id));
    const answered = asked.length ? (await store.today.members(asked.map((r) => r.sameAs ?? refKey({ source: "dated", id: r.id })))).dated.filter((r) => r.state === "open" && !actedOn.has(r.id)) : [];
    return { at, datedNow, promisesNow, answered };
  }

  async act(seen: readonly ItemSeen[], action: "done" | "dismiss" | "later", until?: number): Promise<{ undoId: string | null }> {
    const { store } = this.b;
    const now = this.b.now();
    // plan 249: an item the user's words brought (a negative id) is its own, linked to nothing: the wanted store acts on it
    if (seen.some((r) => r.source === "dated" && r.id < 0)) return this.actWanted(seen, action, until);
    const stale = () => new RpcError("STALE", L(seen[0]?.source === "promise" ? "errors.followups.changed" : "errors.dated.changed"));
    if (action === "later" && (until === undefined || until <= now)) throw new RpcError("BAD_REQUEST", L("errors.dated.later"));
    // (Codex code review of iteration 2) alone with the matcher: no member joins between reading the members and the write
    const before = await this.links.exclusive(async () => {
      const { at, datedNow, promisesNow, answered } = await this.rowItems(seen, action === "done");
      // the third panel round: Later's own rule on each dated one (a timed item still ahead, before its moment; a Plan, its end)
      if (action === "later" && datedNow.some((r) => (laterBefore(r, now) ?? Infinity) <= until!)) throw new RpcError("BAD_REQUEST", L("errors.dated.laterLate"));
      const patch = patchesFor(action, now, until);
      return store.today.act({
        dated: [
          ...datedNow.map((r) => ({ id: r.id, revision: at.get(refKey({ source: "dated", id: r.id })) ?? r.revision, patch: patch.dated })),
          ...answered.map((r) => ({ id: r.id, revision: r.revision, patch: { state: "settled" as const, closedReason: ANSWERED_WITH_PROMISE, closedAt: now } })),
        ],
        promises: promisesNow.map((r) => ({ id: r.id, revision: at.get(refKey({ source: "promise", id: r.id })) ?? r.revision, patch: patch.promise })),
      });
    });
    if (!before) throw stale();
    const undoId = `t${++this.undoSeq}`;
    this.undo.set(undoId, before);
    while (this.undo.size > UNDO_KEPT) this.undo.delete(this.undo.keys().next().value!);
    this.changed();
    if (before.promises.length) await this.b.followups.look();
    return { undoId };
  }

  /**
   * Plan 210 (iteration 4): Hand to…: what the row's hand-off will close when its forward is confirmed, resolved as Done on
   * it would be (its members, what its promises answer), each at its revision now; and the message its forward forwards
   * (the named item's own). Nothing changes here: the forward's confirmed send closes them (`handoffConfirmed`). A reply's
   * row hands its other promises (`others`, its `TodayWhy.with`) with it, as its Done takes them, each named at the revision
   * shown, so the confirmation closes all of them or none (iteration 4, merge).
   */
  async handoff(seen: ItemSeen, others: readonly ItemSeen[] = []): Promise<{ threadId: number; messageId: number; items: HandoffItem[]; text: string; dueAt: number | null; timed: boolean; partOfDay: NonNullable<DatedRow["partOfDay"]> | null }> {
    const { store } = this.b;
    const stale = () => new RpcError("STALE", L(seen.source === "promise" ? "errors.followups.changed" : "errors.dated.changed"));
    if (seen.source === "dated" && seen.id < 0) throw new RpcError("BAD_REQUEST", L("errors.whatMatters.wantedFixed"));
    return this.links.exclusive(async () => {
      const { at, datedNow, promisesNow, answered } = await this.rowItems([seen, ...others], true);
      const own = seen.source === "dated" ? datedNow.find((r) => r.id === seen.id) : promisesNow.find((r) => r.id === seen.id);
      // handed as it was seen: one changed or closed since is stale, as an act on it would be (the row's other promises too)
      if (!own || own.revision !== seen.revision || !(own.state === "open" || own.state === "due")) throw stale();
      if (others.some((o) => !promisesNow.some((r) => r.id === o.id && r.revision === o.revision && (r.state === "open" || r.state === "due")))) throw stale();
      const named = (source: "dated" | "promise", id: number) => at.has(refKey({ source, id }));
      const items: HandoffItem[] = [
        ...datedNow.map((r) => ({ source: "dated" as const, id: r.id, revision: r.revision, ...(named("dated", r.id) && { named: true }) })),
        ...promisesNow.map((r) => ({ source: "promise" as const, id: r.id, revision: r.revision, ...(named("promise", r.id) && { named: true }) })),
        ...answered.map((r) => ({ source: "dated" as const, id: r.id, revision: r.revision, answered: true })),
      ];
      if (items.length > HANDOFF_ITEMS_MAX) throw new RpcError("BAD_REQUEST", L("whatMatters.handTo.tooMany"));
      const thread = (await store.threads.summaries([own.threadId]))[0];
      // a conversation in Spam or Trash, or gone, isn't handed on from What matters
      if (!thread || thread.inSpam || thread.inTrash) throw stale();
      // round 14's faults: its time or its part of the day with its day, for the line ("by today 1:00 PM")
      return { threadId: own.threadId, messageId: own.messageId, items, text: own.text, dueAt: own.dated ? own.dueAt : null, timed: own.dated && !!own.timed, partOfDay: own.dated ? (own.partOfDay ?? null) : null };
    });
  }

  /** Plan 210 (iteration 4): a forward's confirmed send closed its hand-off's items: the list, the count and Follow-ups follow. */
  handed(): void {
    this.changed();
    void this.b.followups.look().catch((error: unknown) => captureError(error, { code: "ai.failed" }));
  }

  /** Plan 249: Done, Remove or Later on items the user's words brought, each at the revision seen, all or none, with Undo. */
  private async actWanted(seen: readonly ItemSeen[], action: "done" | "dismiss" | "later", until?: number): Promise<{ undoId: string | null }> {
    const now = this.b.now();
    const stale = () => new RpcError("STALE", L("errors.dated.changed"));
    if (action === "later" && (until === undefined || until <= now)) throw new RpcError("BAD_REQUEST", L("errors.dated.later"));
    if (seen.some((r) => r.source !== "dated" || r.id >= 0)) throw stale();
    const state = action === "done" ? "done" : "dismissed";
    const patch = action === "later" ? { deferredUntil: until! } : { state, closedReason: "user", closedAt: now } as const;
    const before = await this.b.store.whatMatters.wanted.act(seen.map((r) => ({ id: -r.id, revision: r.revision, patch })));
    if (!before) throw stale();
    const undoId = `n${++this.undoSeq}`;
    this.wantedUndo.set(undoId, before);
    while (this.wantedUndo.size > UNDO_KEPT) this.wantedUndo.delete(this.wantedUndo.keys().next().value!);
    this.changed();
    return { undoId };
  }

  /** An act's Undo: every item back as it was, or none when one changed since. */
  async undoAct(undoId: string): Promise<void> {
    const wanted = this.wantedUndo.get(undoId);
    if (wanted) {
      this.wantedUndo.delete(undoId);
      if (!(await this.b.store.whatMatters.wanted.restore(wanted))) throw new RpcError("STALE", L("errors.dated.changed"));
      this.changed();
      return;
    }
    const before = this.undo.get(undoId);
    if (!before) return;
    this.undo.delete(undoId);
    await this.b.store.today.restore(before);
    this.changed();
    if (before.promises.length) await this.b.followups.look();
  }

  // ─── plan 210 (iteration 4): Change… ────────────────────────────────────

  /**
   * The owner's "Change…": a dated item's or a promise's new day and time (or the move a later mail proposed for it), on it
   * and every item it's the same thing as, the named one at the revision it was seen at, all or none (`scheduleChanges`).
   * Its schedule is the user's from then on: a later mail's move is kept as a proposal (both stores' finish). Its Undo
   * puts every field back exactly.
   */
  async schedule(seen: ItemSeen, ask: ScheduleAsk): Promise<{ undoId: string }> {
    const { store } = this.b;
    const now = this.b.now();
    const stale = () => new RpcError("STALE", L(seen.source === "promise" ? "errors.followups.changed" : "errors.dated.changed"));
    // plan 249: an item the words brought keeps the mail's day (Later moves when it shows)
    if (seen.source === "dated" && seen.id < 0) throw new RpcError("BAD_REQUEST", L("errors.whatMatters.wantedFixed"));
    // alone with the matcher, as an act: no member joins between reading the members and the write
    const before = await this.links.exclusive(async () => {
      const named = seen.source === "dated" ? await store.dated.get(seen.id) : await store.followups.get(seen.id);
      if (!named || (seen.source === "promise" && (named as FollowupRow).kind !== "promise")) throw stale();
      const members = await store.today.members([named.sameAs ?? refKey(seen)]);
      return store.today.schedule(scheduleChanges(seen, named, members, ask, now));
    });
    if (!before) throw stale();
    const undoId = `s${++this.undoSeq}`;
    this.scheduleUndo.set(undoId, before);
    while (this.scheduleUndo.size > UNDO_KEPT) this.scheduleUndo.delete(this.scheduleUndo.keys().next().value!);
    this.changed();
    if (before.promises.length) await this.b.followups.look();
    return { undoId };
  }

  /** A change's Undo: every item's schedule, Later, change and proposal back as they were, or none when one changed since. */
  async undoSchedule(undoId: string): Promise<void> {
    const before = this.scheduleUndo.get(undoId);
    if (!before) return;
    this.scheduleUndo.delete(undoId);
    if (!(await this.b.store.today.unschedule(before))) throw new RpcError("STALE", L(before.dated.length ? "errors.dated.changed" : "errors.followups.changed"));
    this.changed();
    if (before.promises.length) await this.b.followups.look();
  }

  // ─── plan 215: Done and Later on a conversation waiting on you ─────────

  /**
   * Done ("no reply needed") or Later on a "Waiting on you" row, at the waiting date and the record's revision it was drawn
   * at (stale otherwise: a newer message since, another window's choice). Done clears the conversation's waiting fact
   * everywhere (the Inbox's Waiting filter and count, search, the badge: its thread is announced changed) and stops a reply
   * being prepared for it; Later only puts the row off in What matters, until its moment; plan 216, Remove takes it off What
   * matters alone (the Inbox's Waiting, Reply ready and the reader's requests as they were). Its Undo puts it back exactly.
   */
  async waitingAct(o: { threadId: number; since: number; message: number; rev: number; action: "done" | "later" | "remove"; until?: number }): Promise<{ undoId: string }> {
    const now = this.b.now();
    if (o.action === "later" && (o.until === undefined || o.until <= now)) throw new RpcError("BAD_REQUEST", L("errors.dated.later"));
    const state = o.action === "remove" ? "removed" : o.action;
    const before = await this.b.store.today.waiting.act({ threadId: o.threadId, since: o.since, message: o.message, rev: o.rev, state, until: o.action === "later" ? o.until! : null, now });
    if (!before) throw new RpcError("STALE", L("errors.dated.changed"));
    const undoId = `w${++this.undoSeq}`;
    this.waitingSnapshots.set(undoId, before);
    while (this.waitingSnapshots.size > UNDO_KEPT) this.waitingSnapshots.delete(this.waitingSnapshots.keys().next().value!);
    if (o.action === "remove") this.changed();
    else this.waitingMoved(o.threadId, o.action === "done");
    return { undoId };
  }

  /** Its Undo: the record as it was, or STALE when it changed since (another act on it, a newer choice elsewhere). */
  async waitingUndo(undoId: string): Promise<void> {
    const before = this.waitingSnapshots.get(undoId);
    if (!before) throw new RpcError("STALE", L("errors.dated.changed"));
    this.waitingSnapshots.delete(undoId);
    const thread = await this.b.store.today.waiting.restore(before);
    if (thread === null) throw new RpcError("STALE", L("errors.dated.changed"));
    this.waitingMoved(thread, false);
  }

  /** A waiting record moved: the conversation's fact may have (Done, an Undo), and What matters' rows and clock did. */
  private waitingMoved(threadId: number, done: boolean): void {
    this.b.notifyChanged([threadId]);
    // a reply being prepared for a conversation that no longer waits stops (its eligibility is read again now)
    if (done) void this.b.replies.holdingUp().catch(() => {});
    this.changed();
  }

  /** Earlier's "Changed" lines: the open items the user changed (shown, as the open part reads them), at most the bound's. */
  private async changedItems(settings: AppSettings): Promise<{ dated: DatedRow[]; promises: FollowupRow[] }> {
    const dated = settings.dated?.enabled ? (await this.datedRows()).filter((r) => r.changedAt != null) : [];
    const changed = settings.followups?.enabled ? (await this.b.store.followups.active()).filter((r) => r.kind === "promise" && r.changedAt != null) : [];
    // plans 218, 277: not one whose conversation is in Trash or Spam
    const away = changed.length ? await this.b.followups.awayAmong(changed.map((r) => r.threadId)) : new Set<number>();
    const promises = away.size ? changed.filter((r) => !away.has(r.threadId)) : changed;
    return { dated, promises };
  }

  // ─── plan 204: what changes by itself ────────────────────────────────────

  /** Plan 281: bumped with every `todayChanged` and every mail change, so what's built from the rows (People's grouping) knows it's stale. */
  revision = 0;

  private emitChanged(): void {
    this.revision++;
    this.b.server.emit("todayChanged", {}, { origins: ["renderer", "dev"] });
  }

  /** An item read, settled or acted on, a setting: the list and the count read again, and the clock re-arms. */
  changed(): void {
    this.datedGeneration++;
    if (this.stopped) return;
    this.emitChanged();
    this.b.countsChanged();
    void this.armClock().catch((error: unknown) => captureError(error, { code: "ai.failed" }));
  }

  /**
   * Plan 249: the user's words judged rows: only what shows changed, so the list and the count project again (no item
   * re-read, the clock untouched: the Astra review).
   */
  verdictsChanged(): void {
    if (this.stopped) return;
    this.emitChanged();
    this.b.countsChanged();
  }

  /**
   * Plan 210 (iteration 4): your reminders changed (set, cleared, come due: the reminders' own look says so, only when they
   * did): the list and the count read again. No item moved, so the cached items and the clock stay (midnight, which brings
   * tomorrow's reminders into today, is the clock's already).
   */
  remindersChanged(): void {
    if (this.stopped) return;
    this.emitChanged();
    this.b.countsChanged();
  }

  /** Revision 11: one timer for the next moment Today changes by the clock alone; none when there's no such moment. */
  async armClock(): Promise<void> {
    // Codex code review: only the newest call arms, so two at once can't leave a timer behind
    const seq = ++this.clockSeq;
    if (this.clock) clearTimeout(this.clock);
    this.clock = null;
    this.clockAt = null;
    if (this.stopped) return;
    const { store } = this.b;
    const settings = await readSettings(store);
    if (!(await this.available(settings))) return;
    const v16 = settings.dated?.enabled ? await this.datedRows() : [];
    const promises = settings.followups?.enabled ? await this.needs(v16, await store.followups.active()) : [];
    // plan 249: what the words brought changes by the clock too (a Later's return, a Plan's end)
    const items = settings.dated?.enabled ? await this.withWanted(v16) : v16;
    const now = this.b.now();
    // plan 210 (Codex code review): midnight too, whatever shows: what's waiting says "since Wed", the history "Done today",
    // and neither is an item the clock knows. Once a day, never a poll
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    // plan 215: a conversation put off with Later comes back at its moment
    const next = Math.min(nextTodayChange(items, promises, now, await store.today.waiting.moments(now, WAITING_MOMENTS_MAX)) ?? Infinity, midnight.getTime());
    if (this.stopped || seq !== this.clockSeq) return;
    if (this.clock) clearTimeout(this.clock);
    this.clockAt = next;
    this.clock = setTimeout(() => {
      this.clock = null;
      this.clockAt = null;
      // a day's bounds with nothing to read: what's over is retired (Codex code review); a promise too (plan 210, iteration 3)
      void this.b.dated.daily().catch(() => {});
      // plan 249: and what the user's words brought
      void this.b.words.daily().catch(() => {});
      void this.b.followups.retire().catch(() => {});
      this.changed();
    }, Math.min(MAX_DELAY, Math.max(0, next - now)));
    (this.clock as { unref?: () => void }).unref?.();
  }

  /** For tests: when the clock fires next. */
  get clockNextAt(): number | null {
    return this.clockAt;
  }

  private async notify(day: string, prepareAt: string): Promise<void> {
    const { store } = this.b;
    const now = this.b.now();
    if (now - prepareTimeToday(prepareAt, now) > NOTIFY_WITHIN_MS) return;
    if ((await store.settings.get<string>(NOTIFIED_KEY, "")) === day) return;
    // the badge's number (plan 210, iteration 2: Missed and Today's), from the same projection
    const count = todayBadge(await this.counts(now, await readSettings(store)));
    if (!count) return;
    await store.settings.set(NOTIFIED_KEY, day);
    // how many, and never who or what
    this.b.attention.remind({ id: `brief-${day}`, count, threadId: BRIEF_NOTICE_THREAD, senders: [], senderCount: 0, subject: "", snippet: "", kind: "brief" });
  }
}

