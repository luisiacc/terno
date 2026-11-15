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
  type DatedRow,
  type Counts,
  type DigestItem,
  type DigestRow,
  type FeedRowId,
  type ItemSeen,
  type NotNewsletter,
  type ProjectedRow,
  type PlacedItem,
  type FollowupRow,
  type TodayCounts,
  type ThreadSummary,
  type TodayItem,
  type TodayList,
  type TodaySection,
  HISTORY_PAGE,
  type HistoryKey,
  type TodayHistoryPage,
} from "@terno/core";
import { captureError } from "@terno/core/diag";
import { RpcError, type AppSettings } from "@terno/core/rpc";
import { L } from "@terno/i18n";
import { NEEDS_WALK, type DigestStored, type ItemChanges, type ItemSnapshots } from "@terno/store";
import { DailyLimitError, MonthlyLimitError } from "./ai-limiter";
import type { BackendCore as Backend } from "./core";
import { readerZone } from "./promise-time";
import { progressReporter } from "./scope";
import { aiAllowed, readSettings } from "./settings";
import { withoutQuotes } from "./summaries";
import { historyPage } from "./today-history";
import { TodayLinks } from "./today-links";
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
  private undoSeq = 0;
  /** plan 204: the open dated items, until something changes them */
  private datedCache: { generation: number; rows: readonly DatedRow[] } | null = null;
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

  /** By arrival, newest first, within its bound: an empty result can't walk the mailbox (revision 11). */
  private async candidates(since: { at: number; id: number } | null): Promise<Candidates> {
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
        if (f.arrivedAt < floor || (since && f.messageId <= since.id) || seen.has(f.threadId)) continue;
        // a sign-in code isn't reading, and it isn't something to archive unread
        if (findCode(f.subject, f.snippet)) continue;
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
    const { items, watermark } = await this.candidates(previous?.watermark.id ? previous.watermark : null);
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
  private readonly writtenTo: WrittenTo = (keys) => this.b.store.dated.written(keys);

  private async stillListed(listed: readonly DigestItem[]): Promise<DigestItem[]> {
    if (!listed.length) return [];
    const [items, excluded] = await Promise.all([this.withSenders(listed), this.excludedKeys()]);
    const facts = new Map((await this.b.store.filters.actionFacts(items.map((i) => i.threadId))).map((f) => [f.id, f]));
    // Codex's second pass: a digest checkpointed before the guard, resumed, sends and keeps no suspicious sender's message
    const untrusted = await untrustedSenders(items.map((i) => i.fromEmail ?? ""), this.writtenTo);
    return items.filter((i) => {
      const f = facts.get(i.threadId);
      const key = addressKey(i.fromEmail ?? "");
      return f && !f.inSpam && !f.inTrash && f.lastDate === i.lastDate && f.messageCount === i.messageCount && !excluded.has(key) && !untrusted.has(key);
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

  private async excludedKeys(): Promise<Set<string>> {
    return new Set((await this.readNotNewsletters()).map((e) => addressKey(e.email)));
  }

  /** Newest first. */
  async notNewsletters(): Promise<NotNewsletter[]> {
    return [...(await this.readNotNewsletters())].sort((a, b) => b.at - a.at);
  }

  /** A sender out of every digest. One unit, so two at once can't lose one; at the cap the oldest go, and are said. */
  async notNewsletter(p: { email: string; name: string }): Promise<{ added: NotNewsletter | null; evicted: NotNewsletter[] }> {
    const key = addressKey(p.email);
    const now = this.b.now();
    const r = await this.b.store.settings.update<NotNewsletter[], { added: NotNewsletter | null; evicted: NotNewsletter[] }>(NOT_NEWSLETTERS_KEY, [], (stored) => {
      const list = entries(stored);
      if (list.some((e) => addressKey(e.email) === key)) return { value: list, result: { added: null, evicted: [] } };
      // after every other (Codex review, round 2): the list's order holds within a millisecond and through a clock set back,
      // so the cap never drops the one just said
      const at = Math.max(now, ...list.map((e) => e.at + 1));
      const added: NotNewsletter = { id: globalThis.crypto.randomUUID(), email: p.email.trim(), name: p.name.trim().slice(0, NOT_NEWSLETTER_NAME_MAX), at };
      const value = [...list, added];
      const evicted: NotNewsletter[] = [];
      // the oldest first (Undos putting entries back may have left it up to NOT_NEWSLETTERS_OVER over)
      while (value.length > NOT_NEWSLETTERS_MAX) {
        const oldest = value.reduce((a, e) => (e.at < a.at ? e : a));
        evicted.push(oldest);
        value.splice(value.indexOf(oldest), 1);
      }
      return { value, result: { added, evicted } };
    });
    if (r.added) this.exclusionsChanged();
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
  async notNewslettersUndo(p: { remove?: { email: string; id: string }; restore: readonly NotNewsletter[] }): Promise<{ restored: number }> {
    const r = await this.b.store.settings.update<NotNewsletter[], { changed: boolean; restored: number }>(NOT_NEWSLETTERS_KEY, [], (stored) => {
      const list = entries(stored);
      let value = p.remove ? list.filter((e) => e.id !== p.remove!.id) : [...list];
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
  private async project(now: number, settings: AppSettings, o: { count?: boolean } = {}): Promise<{ rows: ProjectedRow[]; counts: TodayCounts; threads: ReadonlyMap<number, ThreadSummary> }> {
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
    const items = this.placed(dated, promises, now, o.count === true);
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);
    const reminders = o.count ? [] : (await this.b.reminders.refresh()).reminders.filter((r) => r.dueAt <= endOfDay.getTime()).map((r) => ({ threadId: r.threadId, dueAt: r.dueAt }));
    const ids = [...placedThreads(items), ...reminders.map((r) => r.threadId)];
    const waiting = await store.today.waitingPage({ now, after: null, limit: NEEDS_WALK });
    // (the zone's read only for the rows' words: an Intl formatter is dear on every count)
    const fact = { now, waiting, reminders, zone: o.count ? "" : readerZone() };
    if (o.count) {
      const live = await store.today.liveAmong([...new Set(ids)]);
      return { ...projectRows(items, { ...fact, live: (id) => live.has(id) }, o), threads: new Map() };
    }
    const threads = new Map((await store.threads.summaries([...new Set([...ids, ...waiting.map((w) => w.id)])])).map((t) => [t.id, t]));
    const live = (id: number) => {
      const t = threads.get(id);
      return !!t && !t.inSpam && !t.inTrash;
    };
    return { ...projectRows(items, { ...fact, live }, o), threads };
  }

  /**
   * Where the items sit changes only at the moments `nextTodayChange` knows (and midnight): between them, and while the items
   * are the same (the cached dated rows, the promises as read), the count reuses it: the count runs on every mailbox change.
   * The list places afresh (it's read when something changed, and finding the next moment would cost it as much again).
   */
  private placed(dated: readonly DatedRow[], promises: readonly FollowupRow[], now: number, count: boolean): PlacedItem[] {
    if (!count) return placeItems(dated, promises, now);
    const key = promises.map((r) => `${r.id}.${r.revision}.${r.state}.${r.dueAt}.${r.deferredUntil ?? ""}.${r.sameAs ?? ""}`).join();
    const was = this.placing;
    if (was && was.dated === dated && was.promises === key && now >= was.at && now < was.until) return was.items;
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    const until = Math.min(nextTodayChange(dated, promises, now) ?? Infinity, midnight.getTime());
    const items = placeItems(dated, promises, now, { count });
    this.placing = { dated, promises: key, at: now, until, items };
    return items;
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
    // Codex's second pass: an item stored from a suspicious sender before the guard isn't shown nor counted
    const rows = await withoutUntrusted(await dated.active(), (keys) => dated.written(keys));
    if (generation === this.datedGeneration) this.datedCache = { generation, rows };
    return rows;
  }

  /** The mailbox changed: a merge or a delete may have moved or removed an item's thread. */
  touched(): void {
    this.datedGeneration++;
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
    return historyPage(store, { now, after: o.after, through: o.through ?? null, limit: o.limit ?? HISTORY_PAGE, held: new Set(o.held), dated: settings.dated?.enabled === true, promises: settings.followups?.enabled === true, yieldTurn: () => this.b.yieldTurn(), sliceMs: this.b.options.sliceBudgetMs });
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
    const none = { missed: 0, today: 0, thisWeek: 0 };
    if (!(await this.available(settings))) return { sections: [], digest: null, now, counts: none };
    // Trash and Spam hide a row, and it comes back with its thread (the projection read it from these summaries)
    const { rows: shown, counts, threads } = await this.project(now, settings);
    // a waiting row's line is its current summary, read together, for the first rows only
    const lined = shown.filter((r) => r.waiting).slice(0, SUMMARY_LINES_MAX).map((r) => r.threadId);
    const lines = new Map(await Promise.all(lined.map(async (id) => [id, await this.summaryLine(id)] as const)));
    const sections: TodaySection[] = [];
    for (const r of shown) {
      const item: TodayItem = { id: r.id, thread: threads.get(r.threadId)!, why: r.why, ...(r.waiting ? lines.get(r.threadId) : {}), ...(r.also ? { also: r.also } : {}) };
      const last = sections.at(-1);
      const day = r.day ?? undefined;
      if (last?.kind === r.group && last.day === day) last.items.push(item);
      else sections.push({ kind: r.group, ...(day ? { day } : {}), items: [item] });
    }
    const history = ask.history && settings.today?.finished !== false ? await this.history({ after: null, through: ask.history.through, held }) : undefined;
    return { sections, digest: await this.digestRow(), now, counts, ...(history ? { history } : {}) };
  }

  private async summaryLine(threadId: number): Promise<{ summary?: string }> {
    const { store } = this.b;
    const row = await store.aiSummaries.get(threadId);
    if (!row || row.state !== "ready" || !row.bodyJson) return {};
    const sources = await store.aiSummaries.sources(threadId);
    if (!sources || sources.stamp !== row.sourceStamp) return {};
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
      const items = await allowed(this.automated?.candidates.items ?? []);
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
    const items = await allowed(await this.withSenders(kept));
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
    this.refreshing = this.candidates(null)
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

  /** Only what the page listed, each only if it's still as the page saw it: a new message or a star since keeps it (revisions 1, 2). */
  async archive(p: { items: readonly { threadId: number; lastDate: number; messageCount: number; fromEmail?: string }[]; jobId?: string }): Promise<{ undoId: number | null; archived: number; archivedIds: number[]; changed: number; spared: number }> {
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
        // plan 145 archives only unread mail: one read since the page was drawn stays, and is counted as left alone (plan 161)
        else if (f.starred || f.replied || !f.unread) spared++;
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
  async act(seen: readonly ItemSeen[], action: "done" | "dismiss" | "later", until?: number): Promise<{ undoId: string | null }> {
    const { store } = this.b;
    const now = this.b.now();
    const stale = () => new RpcError("STALE", L(seen[0]?.source === "promise" ? "errors.followups.changed" : "errors.dated.changed"));
    if (action === "later" && (until === undefined || until <= now)) throw new RpcError("BAD_REQUEST", L("errors.dated.later"));
    // (Codex code review of iteration 2) alone with the matcher: no member joins between reading the members and the write
    const before = await this.links.exclusive(async () => {
      const named = await Promise.all(seen.map((r) => (r.source === "dated" ? store.dated.get(r.id) : store.followups.get(r.id))));
      if (named.some((r) => !r)) throw stale();
      const { dated, promises } = await store.today.members(named.map((r, i) => r!.sameAs ?? refKey(seen[i]!)));
      const at = new Map(seen.map((r) => [refKey(r), r.revision]));
      // the named ones whatever their state (one closed since is stale), the others while they're open
      const datedNow = dated.filter((r) => at.has(refKey({ source: "dated", id: r.id })) || r.state === "open");
      const promisesNow = promises.filter((r) => at.has(refKey({ source: "promise", id: r.id })) || r.state === "open" || r.state === "due");
      // the third panel round: Later's own rule on each dated one (a timed item still ahead, before its moment; a Plan, its end)
      if (action === "later" && datedNow.some((r) => (laterBefore(r, now) ?? Infinity) <= until!)) throw new RpcError("BAD_REQUEST", L("errors.dated.laterLate"));
      const patch = patchesFor(action, now, until);
      return store.today.act({
        dated: datedNow.map((r) => ({ id: r.id, revision: at.get(refKey({ source: "dated", id: r.id })) ?? r.revision, patch: patch.dated })),
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

  /** An act's Undo: every item back as it was, or none when one changed since. */
  async undoAct(undoId: string): Promise<void> {
    const before = this.undo.get(undoId);
    if (!before) return;
    this.undo.delete(undoId);
    await this.b.store.today.restore(before);
    this.changed();
    if (before.promises.length) await this.b.followups.look();
  }

  // ─── plan 204: what changes by itself ────────────────────────────────────

  /** An item read, settled or acted on, a setting: the list and the count read again, and the clock re-arms. */
  changed(): void {
    this.datedGeneration++;
    if (this.stopped) return;
    this.b.server.emit("todayChanged", {}, { origins: ["renderer", "dev"] });
    this.b.countsChanged();
    void this.armClock().catch((error: unknown) => captureError(error, { code: "ai.failed" }));
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
    const items = settings.dated?.enabled ? await this.datedRows() : [];
    const promises = settings.followups?.enabled ? await store.followups.active() : [];
    const now = this.b.now();
    // plan 210 (Codex code review): midnight too, whatever shows: what's waiting says "since Wed", the history "Done today",
    // and neither is an item the clock knows. Once a day, never a poll
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    const next = Math.min(nextTodayChange(items, promises, now) ?? Infinity, midnight.getTime());
    if (this.stopped || seq !== this.clockSeq) return;
    if (this.clock) clearTimeout(this.clock);
    this.clockAt = next;
    this.clock = setTimeout(() => {
      this.clock = null;
      this.clockAt = null;
      // a day's bounds with nothing to read: what's over is retired (Codex code review)
      void this.b.dated.daily().catch(() => {});
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

