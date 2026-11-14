import { AiError, DATED_PROMPT_VERSION, DATED_TEXT_CHARS, costAt, datedBudget, fitDates, priceOf, type AiTasks, type DatedResult } from "@terno/ai";
import { DATED_ITEMS_MAX, DATED_KINDS, DATED_OPEN_SHOWN, DATED_SCAN_DAYS, DATED_SCAN_MAX, datedTiming, dayEnd, hasTimeCue, normalizeText, withoutQuotes, type AiErrorKind, type DatedKind, type DatedRow } from "@terno/core";
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
  statusChanged(status: { blockedBy: { kind: AiErrorKind; message: string } | null }): void;
  log(level: "info" | "warn" | "error", message: string, extra?: unknown): void;
}

const inWords = (ms: number, language: string): string => {
  try {
    return new Intl.DateTimeFormat(language === "es" ? "es" : "en-GB", { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(ms);
  } catch {
    return new Date(ms).toISOString();
  }
};

/** Normalized, as a person retyping it would: a quote must really be in the mail. */
const norm = (text: string) => normalizeText(text).replace(/\s+/g, " ").trim().toLowerCase();
const KINDS: ReadonlySet<string> = new Set(DATED_KINDS);

/**
 * §3's local checks, before anything's stored: the quote is the mail's (its text or subject), the kind is one of ours, a
 * day parses and is worth keeping (`datedTiming`), at most `DATED_ITEMS_MAX`, one per kind and day; a settlement names an
 * item it was shown and quotes the mail. Pure.
 */
export function checkDates(result: { items: readonly (Omit<DatedResult["items"][number], "kind"> & { kind: string })[]; settled: DatedResult["settled"] }, input: { text: string; subject: string; arrivedAt: number; open: ReadonlyMap<string, DatedRow>; fromScan: boolean; now: number }): { rows: DatedWrite[]; settled: { id: number; revision: number }[] } {
  const said = `${norm(input.subject)}\n${norm(input.text)}`;
  const quoted = (words: string) => {
    const w = norm(words);
    return w.length >= 3 && said.includes(w);
  };
  const rows: DatedWrite[] = [];
  const seen = new Set<string>();
  for (const item of result.items) {
    if (rows.length >= DATED_ITEMS_MAX) break;
    if (!KINDS.has(item.kind) || !item.text.trim() || !quoted(item.quote)) continue;
    const timing = datedTiming({ kind: item.kind as DatedKind, due: item.due, time: item.time, arrivedAt: input.arrivedAt });
    if (!timing) continue;
    // the 14-day check keeps nothing already over (§6)
    if (input.fromScan && timing.dated && dayEnd(timing.dueDay) <= input.now) continue;
    const key = `${item.kind}:${timing.dueDay}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ kind: item.kind as DatedKind, item: rows.length, text: item.text.trim(), quote: item.quote.trim(), ...timing });
  }
  const settled = result.settled.flatMap((s) => {
    const row = input.open.get(s.label);
    return row && quoted(s.evidence) ? [{ id: row.id, revision: row.revision }] : [];
  });
  return { rows, settled };
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
  private leaving: { messageId: number; threadId: number; stop: AbortController } | null = null;

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
    const src = await this.host.store.dated.source(leaving.messageId);
    if (!src || src.spam || src.trash || src.threadSpam || src.threadId !== leaving.threadId) leaving.stop.abort();
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
    this.leaving = { messageId: src.id, threadId: src.threadId, stop };
    try {
      const ai = await this.host.forTask();
      const language = await this.readerLanguage(settings);
      const labels = new Map(open.map((r, i) => [`o${i + 1}`, r]));
      const budget = datedBudget(ai.contextTokens);
      const input = fitDates({ text, subject: src.subject, from: { name: src.fromName || src.fromEmail.split("@")[0]!, automated: src.automated }, receivedAt: inWords(src.date, language), open: [...labels].map(([label, r]) => ({ label, kind: r.kind, text: r.text })), language, outputTokens: budget.outputTokens }, budget.promptChars);
      // a change of provider or key, the setting, Spam meanwhile: each stops it, at the provider too
      const signal = AbortSignal.any([generation.signal, asked.signal, stop.signal]);
      if (signal.aborted) return await drop();
      const result = await ai.readDates(input, signal);
      if (signal.aborted) throw new AiError(L("errors.ai.cancelled"), "cancelled");
      const fromScan = mark.source === "scan";
      const now = this.host.now();
      const checked = checkDates(result, { text, subject: src.subject, arrivedAt: src.date, open: labels, fromScan, now });
      const outcome = await store.dated.finish({ messageId: src.id, threadId: src.threadId, fromScan, rows: checked.rows, settled: checked.settled, now, model: ai.model, provider: ai.providerId, promptVersion: DATED_PROMPT_VERSION, clearGeneration });
      this.attempts.delete(src.id);
      // a merge moved it under the request: read again on its new thread (revision 6)
      if (outcome === "moved") this.again = true;
      if (outcome === "written" && (checked.rows.length || checked.settled.length)) this.host.changed();
      return "next";
    } catch (error) {
      // Spam or Trash meanwhile: never asked about again
      if (stop.signal.aborted) return await drop();
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

  async scanOffer(): Promise<{ count: number; usd: number | null }> {
    const ids = await this.host.store.dated.scanCandidates(this.host.now() - DATED_SCAN_DAYS * 86_400_000, DATED_SCAN_MAX);
    const ai = await this.host.forTask().catch(() => null);
    const price = ai && !ai.local ? priceOf(ai.model) : null;
    return { count: ids.length, usd: ai?.local ? 0 : price ? costAt(price, SCAN_TOKENS) * ids.length : null };
  }

  /** Once: the offer's answer (`scanAnswered`, written by the window that asked) ends it, so nothing is read twice. */
  async scan(): Promise<number> {
    if (!this.isActive || (await this.host.settings()).dated.scanAnswered) return 0;
    const now = this.host.now();
    const ids = await this.host.store.dated.scanCandidates(now - DATED_SCAN_DAYS * 86_400_000, DATED_SCAN_MAX);
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

