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
  NOT_NEWSLETTERS_MAX,
  todayKey,
  nextPrepareAt,
  prepareTimeToday,
  TODAY_NEEDS_MAX,
  type Counts,
  type DigestItem,
  type DigestRow,
  type FollowupRow,
  type NotNewsletter,
  type TodayItem,
  type TodayList,
  type TodaySection,
} from "@terno/core";
import { captureError } from "@terno/core/diag";
import type { DigestStored } from "@terno/store";
import { DailyLimitError, MonthlyLimitError } from "./ai-limiter";
import type { BackendCore as Backend } from "./core";
import { progressReporter } from "./scope";
import { aiAllowed, readSettings } from "./settings";
import { withoutQuotes } from "./summaries";

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
  }

  wake(): void {
    void this.tick().catch((error: unknown) => captureError(error, { code: "ai.failed" }));
  }

  /** What's underway is told to stop, and has before the store closes. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.armedAt = null;
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
        if (excluded.has(addressKey(f.fromEmail))) continue;
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
  private async stillListed(listed: readonly DigestItem[]): Promise<DigestItem[]> {
    if (!listed.length) return [];
    const [items, excluded] = await Promise.all([this.withSenders(listed), this.excludedKeys()]);
    const facts = new Map((await this.b.store.filters.actionFacts(items.map((i) => i.threadId))).map((f) => [f.id, f]));
    return items.filter((i) => {
      const f = facts.get(i.threadId);
      return f && !f.inSpam && !f.inTrash && f.lastDate === i.lastDate && f.messageCount === i.messageCount && !excluded.has(addressKey(i.fromEmail ?? ""));
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

  private readNotNewsletters(): Promise<NotNewsletter[]> {
    return this.b.store.settings.get<NotNewsletter[]>(NOT_NEWSLETTERS_KEY, []);
  }

  private async excludedKeys(): Promise<Set<string>> {
    return new Set((await this.readNotNewsletters()).map((e) => addressKey(e.email)));
  }

  /** Newest first. */
  async notNewsletters(): Promise<NotNewsletter[]> {
    return [...(await this.readNotNewsletters())].sort((a, b) => b.at - a.at);
  }

  /** A sender out of every digest. One unit, so two at once can't lose one; at the cap the oldest goes, and is said. */
  async notNewsletter(p: { email: string; name: string; at?: number }): Promise<{ added: NotNewsletter | null; evicted: NotNewsletter | null }> {
    const key = addressKey(p.email);
    const now = this.b.now();
    const r = await this.b.store.settings.update<NotNewsletter[], { added: NotNewsletter | null; evicted: NotNewsletter | null }>(NOT_NEWSLETTERS_KEY, [], (list) => {
      if (list.some((e) => addressKey(e.email) === key)) return { value: list, result: { added: null, evicted: null } };
      // `at` names the entry for its Undo: never one another entry has
      const at = p.at ?? Math.max(now, ...list.map((e) => e.at + 1));
      const added: NotNewsletter = { email: p.email.trim(), name: p.name.trim().slice(0, 200), at };
      let value = [...list, added];
      let evicted: NotNewsletter | null = null;
      if (value.length > NOT_NEWSLETTERS_MAX) {
        evicted = value.reduce((oldest, e) => (e.at < oldest.at ? e : oldest));
        value = value.filter((e) => e !== evicted);
      }
      return { value, result: { added, evicted } };
    });
    if (r.added) this.exclusionsChanged();
    return r;
  }

  /** A sender back in. With `at`, only that entry: an old Undo can't take off a sender said again since. */
  async newsletterAgain(p: { email: string; at?: number }): Promise<{ removed: NotNewsletter | null }> {
    const key = addressKey(p.email);
    const r = await this.b.store.settings.update<NotNewsletter[], NotNewsletter | null>(NOT_NEWSLETTERS_KEY, [], (list) => {
      const found = list.find((e) => addressKey(e.email) === key && (p.at === undefined || e.at === p.at)) ?? null;
      return { value: found ? list.filter((e) => e !== found) : list, result: found };
    });
    if (r) this.exclusionsChanged();
    return { removed: r };
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

  private dueFollowups(rows: readonly FollowupRow[], now: number): FollowupRow[] {
    return rows.filter((r) => r.state === "due" || (r.state === "open" && r.dueAt <= now));
  }

  async list(heldIds: readonly number[]): Promise<TodayList> {
    const { store } = this.b;
    const now = this.b.now();
    const settings = await readSettings(store);
    if (!(await this.available(settings))) return { sections: [], digest: null, now, held: [] };
    const taken = new Set<number>();
    const needs: TodayItem[] = [];
    const followups = settings.followups?.enabled ? this.dueFollowups(await store.followups.active(), now) : [];
    const promises = followups.filter((r) => r.kind === "promise").sort((a, b) => a.dueAt - b.dueAt);
    const nudges = followups.filter((r) => r.kind === "awaiting").sort((a, b) => a.dueAt - b.dueAt);
    const ordered = [...promises, ...nudges];
    const liveThreads = new Map((await store.threads.summaries([...new Set(ordered.map((r) => r.threadId))])).map((t) => [t.id, t]));
    for (const r of ordered) {
      const thread = liveThreads.get(r.threadId);
      if (!thread || thread.inSpam || thread.inTrash || taken.has(thread.id) || needs.length >= TODAY_NEEDS_MAX) continue;
      taken.add(thread.id);
      needs.push({ thread, why: { kind: r.kind === "promise" ? "promise" : "nudge", text: r.text, dueAt: r.dueAt, personName: r.personName, sentAt: r.sentAt } });
    }
    // the walk's own page: what's already above doesn't take a place
    let waitingShown = 0;
    let after: { lastDate: number; id: number } | null = null;
    while (needs.length < TODAY_NEEDS_MAX) {
      const page: { id: number; lastDate: number; hasSent: boolean }[] = await store.today.waitingPage({ now, after, limit: TODAY_NEEDS_MAX });
      if (!page.length) break;
      const fresh = page.filter((p) => !taken.has(p.id)).slice(0, TODAY_NEEDS_MAX - needs.length);
      const summaries = new Map((await store.threads.summaries(fresh.map((p) => p.id))).map((t) => [t.id, t]));
      for (const p of fresh) {
        const thread = summaries.get(p.id);
        if (!thread) continue;
        taken.add(p.id);
        waitingShown++;
        needs.push({ thread, why: { kind: "waiting", wrote: p.hasSent }, ...(await this.summaryLine(p.id)) });
      }
      after = page[page.length - 1]!;
      if (page.length < TODAY_NEEDS_MAX) break;
    }
    // Show all goes to plan 17's Waiting filter, which holds what's here and the rest
    const inboxWaiting = (await store.threads.counts(now)).inboxWaiting ?? 0;
    const more = Math.max(0, inboxWaiting - waitingShown);
    const sections: TodaySection[] = [];
    if (needs.length) sections.push({ kind: "needsYou", items: needs, more });
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);
    const reminders = (await this.b.reminders.refresh()).reminders.filter((r) => r.dueAt <= endOfDay.getTime() && !taken.has(r.threadId)).sort((a, b) => a.dueAt - b.dueAt);
    if (reminders.length) {
      const summaries = new Map((await store.threads.summaries(reminders.map((r) => r.threadId))).map((t) => [t.id, t]));
      const items: TodayItem[] = reminders.flatMap((r) => {
        const thread = summaries.get(r.threadId);
        if (!thread || thread.inTrash || thread.inSpam || taken.has(thread.id)) return [];
        // one section a thread, Needs you first (revision 5)
        taken.add(thread.id);
        return [{ thread, why: { kind: "reminder", dueAt: r.dueAt } } satisfies TodayItem];
      });
      if (items.length) sections.push({ kind: "reminders", items });
    }
    const missing = heldIds.filter((id) => id !== 0 && !taken.has(id));
    const held = missing.length ? await store.threads.summaries(missing) : [];
    return { sections, digest: await this.digestRow(), now, held };
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
    const allowed = (items: readonly DigestItem[]) => items.filter((i) => !excluded.has(addressKey(i.fromEmail ?? "")));
    if (!s.digest) {
      if (!this.automated || this.b.now() - this.automated.at > AUTOMATED_FRESH_MS) this.refreshAutomated();
      const items = allowed(this.automated?.candidates.items ?? []);
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
    const items = allowed(await this.withSenders(kept));
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

  /** The sidebar's number: threads, each once. Null during plan 17's backfill (revision 12). */
  async withCount(counts: Counts): Promise<Counts> {
    const { store } = this.b;
    const s = await this.setting().catch(() => null);
    if (!s?.available || !s.show) return counts;
    if (counts.inboxWaiting === null || counts.inboxWaiting === undefined) return { ...counts, today: null };
    const settings = await readSettings(store);
    const now = this.b.now();
    const needs = await store.today.needsCount(now);
    if (!settings.followups?.enabled) return { ...counts, today: needs };
    const due = [...new Set(this.dueFollowups(await store.followups.active(), now).map((r) => r.threadId))];
    if (!due.length) return { ...counts, today: needs };
    const live = (await store.threads.summaries(due)).filter((t) => !t.inSpam && !t.inTrash).map((t) => t.id);
    const already = new Set(await store.today.waitingAmong(live, now));
    return { ...counts, today: needs + live.filter((id) => !already.has(id)).length };
  }

  private async notify(day: string, prepareAt: string): Promise<void> {
    const { store } = this.b;
    const now = this.b.now();
    if (now - prepareTimeToday(prepareAt, now) > NOTIFY_WITHIN_MS) return;
    if ((await store.settings.get<string>(NOTIFIED_KEY, "")) === day) return;
    const list = await this.list([]);
    const needs = list.sections.find((x) => x.kind === "needsYou");
    if (!needs?.items.length) return;
    await store.settings.set(NOTIFIED_KEY, day);
    // how many, and never who or what
    this.b.attention.remind({ id: `brief-${day}`, count: needs.items.length + (needs.kind === "needsYou" ? needs.more : 0), threadId: BRIEF_NOTICE_THREAD, senders: [], senderCount: 0, subject: "", snippet: "", kind: "brief" });
  }
}

