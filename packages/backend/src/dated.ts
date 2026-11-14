import { AiError, DATED_PROMPT_VERSION, DATED_TEXT_CHARS, costAt, datedBudget, fitDates, priceOf, type AiTasks, type DatedResult } from "@terno/ai";
import { addressKey, saysNoReplyNeeded, DATED_ITEMS_MAX, DATED_KINDS, DATED_OPEN_SHOWN, followupDue, validFollowupDate, type FollowupRow, DATED_SCAN_DAYS, DATED_SCAN_MAX, datedOver, datedTiming, dayEnd, hasTimeCue, laterBefore, normalizeText, withoutQuotes, type AiErrorKind, type DatedKind, type DatedRow } from "@terno/core";
import { captureError } from "@terno/core/diag";
import { RpcError, type AppSettings } from "@terno/core/rpc";
import { DEFAULT_LOCALE, isLocaleId, L, type LocaleId } from "@terno/i18n";
import { type DatedMark, type DatedSnapshot, type DatedSource, type DatedWrite, type MailStore } from "@terno/store";
import { DailyLimitError, MonthlyLimitError } from "./ai-limiter";
import { UI_LOCALE_KEY } from "./forwarding";

/**
 * Plan 204 §3: the dated reader. Reads live mail the user got (and, with a yes, the last 14 days), oldest first, and keeps
 * what has a date that matters, after local checks. Plan 142's worker's shape: one request at a time, no timers when
 * empty, a minute's hold after a provider fails, Clear AI data refuses late writes. Nothing logged carries mail.
 */

const PAGE = 50;
const MAX_ATTEMPTS = 3;
const RETRY_WAIT_MS = 60_000;
const UNDO_KEPT = 50;
/** what a message costs to read, for the check's estimate: ~600 tokens in, ~100 out */
const SCAN_TOKENS = { inputTokens: 600, outputTokens: 100 };
/** the 14-day check walks this many received messages at most, to find the `DATED_SCAN_MAX` worth reading (Codex code review) */
const SCAN_WALK = 3000;

export interface DatedHost {
  readonly store: MailStore;
  now(): number;
  settings(): Promise<AppSettings>;
  /** the gate (plans 147, 150): AI can run at all */
  allowed(settings: AppSettings): Promise<boolean>;
  forTask(): Promise<AiTasks>;
  /** a request a change of provider aborts */
  begin(requestId: string, clientId: string): { signal: AbortSignal; release: () => void };
  /** what Today holds changed: the list and the count read again */
  changed(): void;
  /** a promise of yours got a new day: follow-ups look again (their snapshot to the windows, their timer) */
  promisesMoved(): void;
  statusChanged(status: { blockedBy: { kind: AiErrorKind; message: string } | null }): void;
  /** work over a list in the backend's slices */
  runBudgeted<T>(items: readonly T[], work: (chunk: T[]) => void | Promise<void>): Promise<void>;
  log(level: "info" | "warn" | "error", message: string, extra?: unknown): void;
}

const inWords = (ms: number, language: string): string => {
  try {
    return new Intl.DateTimeFormat(language === "es" ? "es" : "en-GB", { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(ms);
  } catch {
    return new Date(ms).toISOString();
  }
};

/**
 * Normalized, as a person retyping it would: a quote must really be in the mail. Punctuation is left out (the eval: a
 * model joins two lines with a period, "Amount due: $84.20. Please pay by…"); the words, their order and the digits stay.
 */
const norm = (text: string) => normalizeText(text).toLowerCase().replace(/[^\p{L}\p{N}$€£%]+/gu, " ").trim();
const KINDS: ReadonlySet<string> = new Set(DATED_KINDS);

/** One item a message per kind, day and time (revision 8: a keynote at 9:30 and a tech check at 4:00 are two). */
const itemKey = (kind: string, t: { dueDay: string; dueAt: number; timed: boolean }) => `${kind}:${t.dueDay}:${t.timed ? t.dueAt : ""}`;

/** A name's words, as a quote's are read: "Lucía Romero" → ["lucia", "romero"]; an initial or a bare letter isn't one. */
const nameWords = (name: string) => norm(name).split(" ").filter((w) => w.length >= 2);

/** How far before an ask's quote the reader's name may be ("Nora, could you…" quoted from "could you"): a few words. */
const NAMED_BEFORE_CHARS = 24;

/**
 * The third panel round (revision 1): who an ask may be from and to, read here and not only from the model: a person
 * (`senderIsPerson`, never a list, bulk or no-reply address), and the reader addressed in To or named where the mail asks.
 * `said` is the mail as `norm` reads it.
 */
function askAllowed(quote: string, said: string, o: { sender?: { person: boolean }; reader?: { name: string; addressed: "to" | "cc" | "none" } }): boolean {
  if (!o.sender?.person || !o.reader) return false;
  if (o.reader.addressed === "to") return true;
  const q = norm(quote);
  const at = said.indexOf(q);
  const where = ` ${at < 0 ? q : said.slice(Math.max(0, at - NAMED_BEFORE_CHARS), at + q.length)} `;
  return nameWords(o.reader.name).some((w) => where.includes(` ${w} `));
}

/**
 * §3's local checks, before anything's stored: the quote is the mail's (its text or subject), the kind is one of ours, a
 * day parses and is worth keeping (`datedTiming`), at most `DATED_ITEMS_MAX`, one per kind, day and time; an ask only from
 * a person to the reader (`askAllowed`), and one with a day, so allowed, is the request it is (`respond`); a settlement names
 * an item it was shown and quotes the mail; a move gives a new day or, for a timed item, a new moment. Pure.
 */
export function checkDates(result: { items: readonly (Omit<DatedResult["items"][number], "kind"> & { kind: string })[]; settled: DatedResult["settled"]; moved?: DatedResult["moved"] }, input: { text: string; subject: string; arrivedAt: number; open: ReadonlyMap<string, DatedRow>; promises?: ReadonlyMap<string, Pick<FollowupRow, "id" | "revision">>; fromScan: boolean; now: number; sender?: { person: boolean }; reader?: { name: string; addressed: "to" | "cc" | "none" } }): { rows: DatedWrite[]; settled: { id: number; revision: number }[]; moved: { id: number; dueDay: string; dueAt: number; timed: boolean; actAt: number }[]; movedPromises: { id: number; revision: number; dueAt: number }[] } {
  const said = `${norm(input.subject)}\n${norm(input.text)}`;
  const quoted = (words: string) => {
    const w = norm(words);
    return w.length >= 3 && said.includes(w);
  };
  const settled = result.settled.flatMap((s) => {
    const row = input.open.get(s.label);
    return row && quoted(s.evidence) ? [{ id: row.id, revision: row.revision }] : [];
  });
  // after the panel: a new day for an open item, quoted, from this message's own day; one it settles isn't moved
  const settledIds = new Set(settled.map((s) => s.id));
  // Codex code review (round 4): a day for an open ask ("I need it by Friday") makes it the request it now is: the ask is
  // settled and a `respond` with its words and that day is this message's
  const answered: DatedResult["items"] = [];
  for (const m of result.moved ?? []) {
    const row = input.open.get(m.label);
    if (!row || row.kind !== "ask" || settledIds.has(row.id) || !quoted(m.evidence)) continue;
    settled.push({ id: row.id, revision: row.revision });
    settledIds.add(row.id);
    answered.push({ kind: "respond", text: row.text, quote: m.evidence, due: m.due, time: m.time });
  }
  const moved = (result.moved ?? []).flatMap((m) => {
    const row = input.open.get(m.label);
    if (!row || row.kind === "ask" || settledIds.has(row.id) || !quoted(m.evidence)) return [];
    const timing = datedTiming({ kind: row.kind, due: m.due, time: m.time, arrivedAt: input.arrivedAt });
    // the fourth panel round (revision 5): a new moment on the same day moves it too ("the game is moved earlier to 8:00");
    // the same day with no time keeps the item's own; an untimed item's 9:00 is a default, so "at 9:00" gives it a time
    const changed = timing && (timing.dueDay !== row.dueDay || (timing.timed && (!row.timed || timing.dueAt !== row.dueAt)));
    return changed ? [{ id: row.id, kind: row.kind, dueDay: timing.dueDay, dueAt: timing.dueAt, timed: timing.timed, actAt: timing.actAt }] : [];
  });
  const rows: DatedWrite[] = [];
  // a moved item keeps its id: the same kind on its new day isn't added again (Codex review of the fixes)
  const seen = new Set<string>(moved.map((m) => itemKey(m.kind, m)));
  // revision 2 of the fourth round: an ask with a day is an ask first (a person, to the reader), then the request it is
  const datedAsk = (i: { kind: string; due: string | null; quote: string }) => i.kind === "ask" && !!i.due && askAllowed(i.quote, said, input);
  // the eval: a person's request with a day is the `respond`, never also an undated ask beside it
  const requested = [...answered, ...result.items].some((i) => (i.kind === "respond" || datedAsk(i)) && quoted(i.quote));
  // the fourth panel read: a person who says no answer is needed ("No need to reply now") asks nothing
  const noReply = saysNoReplyNeeded(input.text);
  for (const item of [...answered, ...result.items]) {
    if (rows.length >= DATED_ITEMS_MAX) break;
    if (!KINDS.has(item.kind) || !item.text.trim() || !quoted(item.quote)) continue;
    // an ask is never a dated kind's substitute: one with a day is a request with a day, if it's an ask at all
    if (item.kind === "ask" && item.due && !datedAsk(item)) continue;
    const kind = (item.kind === "ask" && item.due ? "respond" : item.kind) as DatedKind;
    if (kind === "ask" && (requested || noReply || !askAllowed(item.quote, said, input))) continue;
    const timing = datedTiming({ kind, due: item.due, time: item.time, arrivedAt: input.arrivedAt });
    if (!timing) continue;
    // the 14-day check keeps nothing already over (§6)
    if (input.fromScan && timing.dated && dayEnd(timing.dueDay) <= input.now) continue;
    const key = itemKey(kind, timing);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ kind, item: rows.length, text: item.text.trim(), quote: item.quote.trim(), ...timing });
  }
  // a promise of yours: its day from this message (the person you made it to), as follow-ups place a dated promise
  const movedPromises = (result.moved ?? []).flatMap((m) => {
    const p = input.promises?.get(m.label);
    const day = p && quoted(m.evidence) ? validFollowupDate(m.due, input.arrivedAt) : null;
    return p && day ? [{ id: p.id, revision: p.revision, dueAt: followupDue({ kind: "promise", sentAt: input.arrivedAt, due: day, nudgeAfterDays: 0 }).dueAt }] : [];
  });
  return { rows, settled, moved: moved.map(({ kind: _kind, ...m }) => m), movedPromises };
}

export class DatedWorker {
  private active = false;
  private stopped = false;
  private running = false;
  private again = false;
  private generation = new AbortController();
  private paused: { kind: AiErrorKind; message: string } | null = null;
  private limited: string | null = null;
  private heldUntil = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly attempts = new Map<number, number>();
  private readonly undo = new Map<string, { snapshot: DatedSnapshot; expectRevision: number }[]>();
  private undoSeq = 0;
  private prunedDay: string | null = null;
  /** the request on its way out: checked again as it leaves the limiter, repairs included (revision 3) */
  private leaving: { messageId: number; threadId: number; senderKey: string; date: number; open: readonly number[]; stop: AbortController } | null = null;

  constructor(private readonly host: DatedHost) {}

  get isActive(): boolean {
    return this.active && !this.stopped;
  }
  get blockedBy(): { kind: AiErrorKind; message: string } | null {
    return this.paused;
  }
  /** a live timer waiting on a provider (null otherwise); for tests */
  get retrying(): ReturnType<typeof setTimeout> | null {
    return this.retryTimer;
  }

  /** Ingest's question: mark live mail for it? From when (mail from before it went on isn't marked). */
  async wanted(): Promise<{ since: number | null } | undefined> {
    if (!this.isActive) return undefined;
    const settings = await this.host.settings();
    return settings.dated.enabled && (await this.host.allowed(settings)) ? { since: settings.dated.enabledAt } : undefined;
  }

  async start(): Promise<void> {
    const settings = await this.host.settings();
    this.active = settings.dated.enabled;
    if (this.stopped) return;
    if (this.active) this.wake();
  }

  /** Once a day with nothing to read too: the day's bounds, and what's over retired. */
  async daily(): Promise<void> {
    if (!this.isActive) return;
    if (!this.running) await this.bounds();
    // round 2: at every moment the clock wakes for, not only the day's first: a Plan ends at 9:40 too
    await this.retire();
  }

  stop(): void {
    this.stopped = true;
    this.generation.abort();
    this.clearRetry();
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /** New mail, a body, the network. A no-op when off, paused, or for a minute after a provider failed. */
  wake(o: { network?: boolean } = {}): void {
    if (!this.isActive || this.paused) return;
    if (o.network) this.heldUntil = 0;
    if (this.host.now() < this.heldUntil) return;
    const today = new Date(this.host.now()).toDateString();
    if (this.limited) {
      if (this.limited === today) return;
      this.limited = null;
    }
    void this.drain().catch((error: unknown) => {
      captureError(error, { code: "ai.failed" });
      this.host.log("warn", "dated reader stopped", error instanceof Error ? error.name : "error");
    });
  }

  settingsChanged(settings: AppSettings): void {
    const on = settings.dated.enabled;
    const off = this.active && !on;
    this.active = on;
    const wasPaused = this.paused !== null;
    this.paused = null;
    if (wasPaused) this.host.statusChanged(this.status());
    this.limited = null;
    this.heldUntil = 0;
    this.clearRetry();
    if (off) {
      this.generation.abort();
      this.generation = new AbortController();
      void this.host.store.dated.marks.clear().catch(() => {});
      this.host.changed();
      return;
    }
    this.host.changed();
    this.wake();
  }

  /** Called as a dated request is about to leave, after any wait: Spam, Trash or a moved message stop it there (revision 3). */
  async holdingUp(): Promise<void> {
    const leaving = this.leaving;
    if (!leaving || leaving.stop.signal.aborted) return;
    const { store } = this.host;
    const src = await store.dated.source(leaving.messageId);
    if (!src || src.spam || src.trash || src.threadSpam || src.threadId !== leaving.threadId) return leaving.stop.abort();
    // Codex code review: the open items it carries are material too; one whose conversation went to Spam stops it
    if (!leaving.open.length) return;
    const still = new Set((await store.dated.openFor({ threadId: leaving.threadId, senderKey: leaving.senderKey, before: leaving.date, limit: DATED_OPEN_SHOWN })).map((r) => r.id));
    if (leaving.open.some((id) => !still.has(id))) leaving.stop.abort();
  }

  private async drain(): Promise<void> {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.again = false;
        await this.bounds();
        await this.pass(this.generation);
      } while (this.again && this.isActive && !this.paused && !this.limited);
    } finally {
      this.running = false;
    }
  }

  private async bounds(): Promise<void> {
    const today = new Date(this.host.now()).toDateString();
    if (this.prunedDay === today) return;
    this.prunedDay = today;
    await this.host.store.dated.marks.prune(this.host.now());
    await this.host.store.dated.prune(this.host.now());
    await this.retire();
  }

  /**
   * Codex code review: what's over for good (a Plan that's ended, a deadline past Missed's days) is closed as `expired`, so
   * the open set, bounded at 1,000, holds only what can still show and never refuses new items for old ones.
   */
  async retire(): Promise<number> {
    const { store } = this.host;
    const now = this.host.now();
    const over = (await store.dated.active()).filter((r) => datedOver(r, now));
    let n = 0;
    await this.host.runBudgeted(over, async (chunk) => {
      for (const r of chunk) if (await store.dated.update(r.id, r.revision, { state: "dismissed", closedReason: "expired", closedAt: now }, { dueDay: r.dueDay, dueAt: r.dueAt })) n++;
    });
    if (n) this.host.changed();
    return n;
  }

  /** Oldest first; a message waiting for its body holds later ones from its thread and its sender (revision 5). */
  private async pass(generation: AbortController): Promise<void> {
    let after: { arrivedAt: number; messageId: number } | null = null;
    const heldThreads = new Set<number>();
    const heldSenders = new Set<string>();
    for (;;) {
      const page: DatedMark[] = await this.host.store.dated.marks.page(after, PAGE);
      if (!page.length) return;
      for (const mark of page) {
        if (generation !== this.generation || !this.isActive) return;
        after = { arrivedAt: mark.arrivedAt, messageId: mark.messageId };
        if (heldThreads.has(mark.threadId)) continue;
        const next = await this.consider(mark, generation, heldSenders);
        if (next === "stop") return;
        if (typeof next === "object") {
          heldThreads.add(mark.threadId);
          heldSenders.add(next.hold);
        }
      }
    }
  }

  private async consider(mark: DatedMark, generation: AbortController, heldSenders: ReadonlySet<string>): Promise<"next" | "stop" | { hold: string }> {
    const { store } = this.host;
    const clearGeneration = store.dated.clearGeneration();
    const settings = await this.host.settings();
    if (!settings.dated.enabled || !(await this.host.allowed(settings))) return "stop";
    const src = await store.dated.source(mark.messageId);
    const drop = async () => {
      await store.dated.marks.consume(mark.messageId);
      return "next" as const;
    };
    // the owner's rule: mail in Spam reaches no AI, the whole thread's
    if (!src || src.draft || src.sent || src.own || src.spam || src.trash || src.threadSpam) return drop();
    if (heldSenders.has(src.senderKey)) return { hold: src.senderKey };
    // what came before it went on is read only with the check's yes
    if (mark.source === "live" && settings.dated.enabledAt !== null && src.date < settings.dated.enabledAt) return drop();
    // revision 5: what could settle an open item is read before any cost filter
    const open = await store.dated.openFor({ threadId: src.threadId, senderKey: src.senderKey, before: src.date, limit: DATED_OPEN_SHOWN });
    if (!open.length && (src.tab === "social" || src.tab === "promotions")) return drop();
    if (src.bodyState !== "full" && !src.bodyUnavailable) return { hold: src.senderKey };
    const text = await this.text(src);
    // a cost filter, not a judgment (§3): a person's mail is read whatever its words
    if (!open.length && src.automated && !hasTimeCue(text, src.subject)) return drop();
    if (!text.trim() && !src.subject.trim()) return drop();
    const asked = this.host.begin(`dated:${mark.messageId}`, "dated-worker");
    const stop = new AbortController();
    this.leaving = { messageId: src.id, threadId: src.threadId, senderKey: src.senderKey, date: src.date, open: open.map((r) => r.id), stop };
    try {
      const ai = await this.host.forTask();
      const language = await this.readerLanguage(settings);
      const labels = new Map(open.map((r, i) => [`o${i + 1}`, r]));
      // the second panel round: your open promises on this thread, offered only to a message from the person you made them
      // to (they may move the day; nobody else may), to be moved, never settled (Codex review)
      const promised = (await store.followups.ofThread(src.threadId)).filter((p) => p.kind === "promise" && (p.state === "open" || p.state === "due") && p.personEmail && addressKey(p.personEmail) === src.senderKey && p.sentAt < src.date).slice(0, DATED_OPEN_SHOWN);
      const promises = new Map(promised.map((p, i) => [`p${i + 1}`, p]));
      const budget = datedBudget(ai.contextTokens);
      // names only: who the reader is and how it reached them, so a task for someone else stays theirs (the eval)
      const nameOf = (p: { name: string; email: string }) => p.name || p.email.split("@")[0]!;
      const reader = { name: (await store.accounts.get(src.accountId))?.displayName ?? "", addressed: src.readerIn };
      // the third panel round: "a person" as the ask's local check reads it (a role address you never wrote to isn't one)
      const input = fitDates({ text, subject: src.subject, from: { name: src.fromName || src.fromEmail.split("@")[0]!, automated: src.automated || !src.person }, reader, to: src.to.map(nameOf), cc: src.cc.map(nameOf), receivedAt: inWords(src.date, language), open: [...[...labels].map(([label, r]) => ({ label, kind: r.kind as DatedKind | "promise", text: r.text })), ...[...promises].map(([label, p]) => ({ label, kind: "promise" as const, text: p.text }))], language, outputTokens: budget.outputTokens }, budget.promptChars);
      // a change of provider or key, the setting, Spam meanwhile: each stops it, at the provider too
      const signal = AbortSignal.any([generation.signal, asked.signal, stop.signal]);
      if (signal.aborted) return await drop();
      const result = await ai.readDates(input, signal);
      if (signal.aborted) throw new AiError(L("errors.ai.cancelled"), "cancelled");
      const fromScan = mark.source === "scan";
      const now = this.host.now();
      // only what was really sent, after fitting to the window, may be named back (Codex review)
      const sent = new Set(input.open.map((o) => o.label));
      const checked = checkDates(result, { text, subject: src.subject, arrivedAt: src.date, open: new Map([...labels].filter(([l]) => sent.has(l))), promises: new Map([...promises].filter(([l]) => sent.has(l))), fromScan, now, sender: { person: src.person }, reader });
      const outcome = await store.dated.finish({ messageId: src.id, threadId: src.threadId, fromScan, rows: checked.rows, settled: checked.settled, moved: checked.moved, movedPromises: checked.movedPromises, now, model: ai.model, provider: ai.providerId, promptVersion: DATED_PROMPT_VERSION, clearGeneration });
      this.attempts.delete(src.id);
      // a merge moved it under the request: read again on its new thread (revision 6)
      if (outcome === "moved") this.again = true;
      if (outcome === "written" && checked.movedPromises.length) this.host.promisesMoved();
      if (outcome === "written" && (checked.rows.length || checked.settled.length || checked.moved.length || checked.movedPromises.length)) this.host.changed();
      return "next";
    } catch (error) {
      // Spam or Trash meanwhile: never asked about again; an open item gone to Spam: asked again without it
      if (stop.signal.aborted) {
        const now = await store.dated.source(src.id);
        if (now && !now.spam && !now.trash && !now.threadSpam && now.threadId === src.threadId) {
          this.again = true;
          return "stop";
        }
        return await drop();
      }
      return this.failed(mark, error);
    } finally {
      asked.release();
      if (this.leaving?.stop === stop) this.leaving = null;
    }
  }

  private async text(src: DatedSource): Promise<string> {
    const texts = await this.host.store.aiSummaries.text([{ messageId: src.id, limit: DATED_TEXT_CHARS * 2 }]);
    return withoutQuotes(texts.get(src.id) ?? "");
  }

  private async failed(mark: DatedMark, error: unknown): Promise<"next" | "stop"> {
    const { store } = this.host;
    if (error instanceof DailyLimitError || error instanceof MonthlyLimitError) {
      this.limited = new Date(this.host.now()).toDateString();
      return "stop";
    }
    if (!(error instanceof AiError)) captureError(error instanceof Error ? new Error(error.name) : new Error("error"), { code: "ai.failed" });
    const kind: AiErrorKind = error instanceof AiError ? error.kind : "unavailable";
    this.host.log("info", "dated read failed", { aiKind: kind });
    switch (kind) {
      case "cancelled":
        if (this.isActive) this.again = true;
        return "stop";
      case "auth":
      case "not_configured":
      case "blocked":
        this.paused = { kind, message: error instanceof Error ? error.message : String(error) };
        this.host.statusChanged(this.status());
        return "stop";
      case "invalid_output":
      case "refused":
      case "unsupported":
        await store.dated.marks.consume(mark.messageId);
        return "next";
      case "rate_limited":
      case "unavailable":
      case "timeout": {
        const tries = (this.attempts.get(mark.messageId) ?? 0) + 1;
        if (tries >= MAX_ATTEMPTS) {
          this.attempts.delete(mark.messageId);
          await store.dated.marks.consume(mark.messageId);
        } else this.attempts.set(mark.messageId, tries);
        this.heldUntil = this.host.now() + RETRY_WAIT_MS;
        if (kind === "rate_limited" && !this.retryTimer) {
          this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.wake({ network: true });
          }, RETRY_WAIT_MS);
          (this.retryTimer as { unref?: () => void }).unref?.();
        }
        return "stop";
      }
    }
  }

  private async readerLanguage(settings: AppSettings): Promise<LocaleId> {
    if (isLocaleId(settings.language)) return settings.language;
    const ui = await this.host.store.settings.get<string | null>(UI_LOCALE_KEY, null);
    return isLocaleId(ui) ? ui : DEFAULT_LOCALE;
  }

  // ─── what the user does (§5) ─────────────────────────────────────────────

  private remember(entries: { snapshot: DatedSnapshot; expectRevision: number }[]): string | null {
    if (!entries.length) return null;
    const id = `d${++this.undoSeq}`;
    this.undo.set(id, entries);
    while (this.undo.size > UNDO_KEPT) this.undo.delete(this.undo.keys().next().value!);
    return id;
  }

  /** Done, Dismiss and Later: one journal entry on the row, conditional on the revision the user saw. */
  async act(id: number, revision: number, action: "done" | "dismiss" | "later", until?: number): Promise<{ undoId: string | null; row: DatedRow | null }> {
    const now = this.host.now();
    if (action === "later" && (until === undefined || until <= now)) throw new RpcError("BAD_REQUEST", L("errors.dated.later"));
    // the third panel round: the menus' and the picker's own rule (a timed item still ahead, before its moment; a Plan, its end)
    if (action === "later") {
      const row = await this.host.store.dated.get(id);
      const limit = row ? laterBefore(row, now) : null;
      if (limit !== null && until! >= limit) throw new RpcError("BAD_REQUEST", L("errors.dated.laterLate"));
    }
    const patch: Parameters<MailStore["dated"]["update"]>[2] = action === "later" ? { deferredUntil: until! } : { state: action === "done" ? "done" : "dismissed", closedReason: "user", closedAt: now };
    const before = await this.host.store.dated.update(id, revision, patch);
    if (!before) throw new RpcError("STALE", L("errors.dated.changed"));
    this.host.changed();
    const row = await this.host.store.dated.get(id);
    return { undoId: this.remember([{ snapshot: before, expectRevision: before.revision + 1 }]), row };
  }

  async undoAct(undoId: string): Promise<void> {
    const entries = this.undo.get(undoId);
    if (!entries) return;
    this.undo.delete(undoId);
    await this.host.store.dated.restore(entries);
    this.host.changed();
  }

  async ofThread(threadId: number): Promise<DatedRow[]> {
    return this.host.store.dated.ofThread(threadId);
  }

  // ─── §6: the one-time check ──────────────────────────────────────────────

  /**
   * Codex code review: the check's messages are those the reader would ask about, chosen before its bound: newest first,
   * not Spam, Trash, Promotions or Social, and automated mail only with a time cue. Walked in the backend's slices.
   */
  private async scanPicks(now: number): Promise<number[]> {
    const { store } = this.host;
    const walked = await store.dated.scanCandidates(now - DATED_SCAN_DAYS * 86_400_000, SCAN_WALK);
    // newest first: whether each is worth reading by itself, and who and where it's from
    const seen: { s: DatedSource; worth: boolean }[] = [];
    await this.host.runBudgeted(walked, async (chunk) => {
      const sources = (await Promise.all(chunk.map((id) => store.dated.source(id)))).filter((s): s is DatedSource => !!s && !s.spam && !s.trash && !s.threadSpam && !s.draft && !s.sent && !s.own && s.tab !== "social" && s.tab !== "promotions");
      // round 2: a body not here yet can't be judged; it's read, and the worker waits for it (the filter errs towards reading)
      const judged = sources.filter((s) => s.automated && (s.bodyState === "full" || s.bodyUnavailable));
      const texts = judged.length ? await store.aiSummaries.text(judged.map((s) => ({ messageId: s.id, limit: DATED_TEXT_CHARS }))) : new Map<number, string | null>();
      for (const s of sources) seen.push({ s, worth: !s.automated || (s.bodyState !== "full" && !s.bodyUnavailable) || hasTimeCue(withoutQuotes(texts.get(s.id) ?? ""), s.subject) });
    });
    // round 2: a later message from the sender or the conversation of one it reads ("Paid in full") may settle it: it's read too
    const oldest = new Map<string, number>();
    for (const { s, worth } of seen) if (worth) for (const key of [`t${s.threadId}`, `s${s.senderKey}`]) oldest.set(key, Math.min(oldest.get(key) ?? Infinity, s.date));
    const settles = (s: DatedSource) => [`t${s.threadId}`, `s${s.senderKey}`].some((key) => (oldest.get(key) ?? Infinity) < s.date);
    return seen.filter(({ s, worth }) => worth || settles(s)).slice(0, DATED_SCAN_MAX).map(({ s }) => s.id);
  }

  async scanOffer(): Promise<{ count: number; usd: number | null }> {
    const ids = await this.scanPicks(this.host.now());
    const ai = await this.host.forTask().catch(() => null);
    const price = ai && !ai.local ? priceOf(ai.model) : null;
    return { count: ids.length, usd: ai?.local ? 0 : price ? costAt(price, SCAN_TOKENS) * ids.length : null };
  }

  /** Once: the offer's answer (`scanAnswered`, written by the window that asked) ends it, so nothing is read twice. */
  async scan(): Promise<number> {
    if (!this.isActive || (await this.host.settings()).dated.scanAnswered) return 0;
    const now = this.host.now();
    const ids = await this.scanPicks(now);
    const queued = await this.host.store.dated.marks.queueScan(ids, now);
    this.wake();
    return queued;
  }

  status(): { blockedBy: { kind: AiErrorKind; message: string } | null } {
    return { blockedBy: this.paused };
  }

  /** Clear AI data: nothing in flight may bring back what was cleared. */
  async clear(): Promise<void> {
    this.generation.abort();
    this.generation = new AbortController();
    this.undo.clear();
    await this.host.store.dated.clear();
    this.host.changed();
  }
}

