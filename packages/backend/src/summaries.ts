import { AiError, deliveryOf, SUMMARY_PROMPT_VERSION, summaryBudget, summaryPrompt, type AiTasks, type SummaryReader, type ThreadText } from "@terno/ai";
import { withoutQuotes, type AiErrorKind, type AiProviderId, type AiSummarizeResult, type AiSummariesStatus, type AiSummary, type AiSummaryRead } from "@terno/core";
export { withoutQuotes };
import { captureError } from "@terno/core/diag";
import { RpcError, type AppSettings } from "@terno/core/rpc";
import { DEFAULT_LOCALE, isLocaleId, L, type LocaleId } from "@terno/i18n";
import { NEW_MAIL_MS, SUMMARY_MAX_ROWS, summaryBlocked, type AiSummaryRow, type MailStore, type SummarySources, type SummarySourceMessage } from "@terno/store";
import { DailyLimitError, MonthlyLimitError } from "./ai-limiter";
import { toRpcError } from "./ai-service";
import { UI_LOCALE_KEY } from "./forwarding";

/** Attempts a queued summary gets at a passing failure before it's failed. */
const MAX_ATTEMPTS = 3;
const PAGE = 50;
/** How long a provider that failed is left alone, with work still queued. */
const RETRY_WAIT_MS = 60_000;
/** A thread with less new text than this keeps its text: a summary of three lines is longer than the mail. */
const MIN_WORDS = 60;
const WORD_READ_CHARS = 4000;

/** What's sent: plan 132 §4.3, in rough tokens of 4 characters. */
const CHARS_PER_TOKEN = 4;
const NEWEST_TOKENS = 4000;
const OTHER_TOKENS = 400;
const OTHERS = 12;
/** the rest of a long conversation, from, date and snippet: a thread of a thousand can't send a thousand */
const REST = 40;
/** the last message's quotes too, up to this: when it's the reader's, what it quotes can be the only copy here */
const LAST_TOKENS = 1500;
/** a window smaller than this keeps every message's own words before anyone's quotes */
const ROOM_FOR_QUOTES = 32_000;
/** a quoted reply is mostly quote: read enough of it to have 400 tokens left */
const QUOTED_READ_FACTOR = 4;

export interface SummaryHost {
  readonly store: MailStore;
  now(): number;
  settings(): Promise<AppSettings>;
  /** plan 157: the switch, and AI being there at all: off, nothing is marked, queued or sent */
  runs(settings: AppSettings): boolean;
  forTask(o: { foreground: boolean }): Promise<AiTasks>;
  begin(requestId: string, clientId: string): { signal: AbortSignal; release: () => void };
  /** tells open readers, never MCP */
  ready(threadId: number): void;
  log(level: "info" | "warn" | "error", message: string, extra?: unknown): void;
}

const wordsIn = (text: string) => (text.match(/\S+/g) ?? []).length;

const day = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const nameOf = (m: SummarySourceMessage) => (m.fromName ? `${m.fromName} <${m.fromEmail}>` : m.fromEmail);

/**
 * Serialized, a small window can still be too full: tags, addresses and every snippet count. What goes first is what
 * says least: the oldest headers, then the oldest of the others, and only then the newest message's own words.
 */
function fit(subject: string, thread: ThreadText[], newestAt: number, room: number, reader: SummaryReader): { subject: string; thread: ThreadText[] } {
  if (room === Infinity) return { subject, thread };
  // a subject can't take the whole window from the words it heads
  const head = subject.slice(0, Math.floor(room / 8));
  let kept = thread;
  let newest = kept[newestAt]!;
  const size = () => summaryPrompt({ subject: head, thread: kept, reader }).length;
  while (size() > room && kept.length > 1) {
    const at = kept[0] === newest ? 1 : 0;
    kept = kept.filter((_, i) => i !== at);
  }
  // the names go before the words: where the reader was on it stays (`readerOn`), and a card about nothing helps nobody
  if (size() > room) {
    newest = { ...newest, to: undefined, cc: undefined };
    kept = [newest];
  }
  const over = size() - room;
  if (over > 0) {
    newest = { ...newest, text: newest.text.slice(0, Math.max(0, newest.text.length - over)) };
    kept = [newest];
  }
  return { subject: head, thread: kept };
}

/** Who's reading: the thread's account, under the name their own mail or their correspondents use for it. */
function readerOf(sources: SummarySources, own: ReadonlySet<string>): SummaryReader {
  const named = sources.messages.find((m) => m.own && m.fromName)?.fromName ?? sources.messages.flatMap((m) => [...m.to, ...m.cc]).find((r) => r.name && own.has(r.email.trim().toLowerCase()))?.name ?? "";
  return { name: named, email: sources.accountEmail };
}

/** What goes to the model, and which message each label stands for. */
async function assemble(store: MailStore, sources: SummarySources, contextTokens: number | null): Promise<{ subject: string; thread: ThreadText[]; reader: SummaryReader; labels: Map<string, number> }> {
  const messages = sources.messages.filter((m) => !m.trash && !m.spam);
  // an alias shows up as the address their own mail came from
  const own = new Set([...sources.ownEmails, ...sources.messages.filter((m) => m.own).map((m) => m.fromEmail.trim().toLowerCase())]);
  const reader = readerOf(sources, own);
  const newest = [...messages].reverse().find((m) => !m.own) ?? messages[messages.length - 1]!;
  const others = messages.filter((m) => m !== newest).slice(-OTHERS);
  // a small window: the newest message first, the others share what's left (plan 133 §1.3's way of sizing down)
  const room = summaryBudget(contextTokens).promptChars;
  const newestLimit = Math.min(NEWEST_TOKENS * CHARS_PER_TOKEN, Math.floor(room * 0.6));
  const otherLimit = Math.min(OTHER_TOKENS * CHARS_PER_TOKEN, Math.floor((room * 0.3) / Math.max(1, others.length)));
  const last = messages[messages.length - 1]!;
  const lastLimit = Math.min(LAST_TOKENS * CHARS_PER_TOKEN, Math.floor(room * 0.2));
  const texts = await store.aiSummaries.text([
    { messageId: newest.id, limit: newestLimit },
    ...others.map((m) => ({ messageId: m.id, limit: m === last ? newestLimit : otherLimit * QUOTED_READ_FACTOR })),
  ]);
  const rest = new Set(messages.filter((m) => m !== newest && !others.includes(m)).slice(-REST).map((m) => m.id));
  const chosen = messages.filter((m) => m === newest || others.includes(m) || rest.has(m.id));
  const drafted = chosen.map((m): ThreadText => {
    const stored = texts.get(m.id);
    const authored = stored == null ? null : withoutQuotes(stored).slice(0, otherLimit);
    // their own words come first, whatever the quote's size; what it quotes follows in the room left
    const text = m === newest ? stored : stored == null ? null : m === last && room >= ROOM_FOR_QUOTES && stored !== authored ? `${authored}\n\n${stored.slice(0, lastLimit)}` : authored;
    return { label: `m${m.id}`, from: nameOf(m), ...deliveryOf(m, own), date: day(m.date), own: m.own, text: text || m.snippet };
  });
  const { subject, thread: fitted } = fit(sources.subject, drafted, chosen.indexOf(newest), room, reader);
  const labels = new Map<string, number>();
  // labelled last: what's dropped leaves no gap in what the model can cite
  const thread = fitted.map((t, i): ThreadText => {
    const label = `m${i + 1}`;
    labels.set(label, Number(t.label.slice(1)));
    return { ...t, label };
  });
  return { subject, thread, reader, labels };
}

async function sha256(text: string): Promise<string> {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** What a row reads as, for the reader. */
function viewOf(row: AiSummaryRow): AiSummary | null {
  if (!row.bodyJson || !row.provider || !row.model || row.generatedAt === null) return null;
  try {
    const body = JSON.parse(row.bodyJson) as Pick<AiSummary, "summary" | "items">;
    return { threadId: row.threadId, summary: body.summary, items: body.items, provider: row.provider as AiProviderId, model: row.model, generatedAt: row.generatedAt };
  } catch {
    return null;
  }
}

type Run = { outcome: "written" | "moved" | "blocked" | "gone"; summary?: AiSummary };

/**
 * Plan 132: makes a thread's summary, as new mail arrives (a durable queue, drained through the limiter, oldest first,
 * only when something wakes it: no timers on an empty queue) or when the user asks (§7, ahead of the queue and outside
 * its ceilings). Every failure kind has a transition (revision 4):
 *
 * - runnable rows go in order, and a pass over the queue is one keyset walk, so what can't run yet can't stall the rest
 * - waiting for a body: stays pending, skipped; a body arriving wakes the worker
 * - `rate_limited`, `unavailable`, `timeout`: an attempt spent and the pass ends; 3 and it's failed
 * - `invalid_output`, `refused`, `unsupported`: failed at once
 * - `auth`, `not_configured`, `blocked`: paused, no attempt spent, until settings change
 * - the day's or month's limit: stopped, no attempt spent, until the next day's first wake-up or settings change
 * - `cancelled`: stays runnable, no attempt spent
 */
export class SummaryWorker {
  private active = false;
  private stopped = false;
  private running = false;
  private again = false;
  private generation = new AbortController();
  /** aborts everything in flight when the data is cleared, requests by hand included */
  private cleared = new AbortController();
  private paused: AiSummariesStatus["blockedBy"] = null;
  /** the day a limit stopped it: the next day's first wake-up looks again */
  private limited: { day: string; because: NonNullable<AiSummariesStatus["blockedBy"]> } | null = null;
  /** a provider failed: new mail doesn't ask it again before this */
  private heldUntil = 0;
  private prunedDay: string | null = null;
  private rateTimer: ReturnType<typeof setTimeout> | null = null;
  /** requests in flight, by thread: a request on the same thread joins instead of paying twice */
  private readonly inflight = new Map<number, Promise<Run>>();

  constructor(private readonly host: SummaryHost) {}

  /** ingest's one boolean: nothing is marked or queued unless this is on */
  get isActive(): boolean {
    return this.active && !this.stopped;
  }

  /** a live timer waiting on a provider (null on an empty queue); for tests */
  get timer(): ReturnType<typeof setTimeout> | null {
    return this.rateTimer;
  }

  async start(): Promise<void> {
    this.active = this.host.runs(await this.host.settings());
    if (this.stopped) return;
    if (this.active) this.wake();
    // what a quit left queued can't wait for AI to come back: that would send mail from before it
    else void this.host.store.aiSummaries.dropPending().catch(() => {});
  }

  stop(): void {
    this.stopped = true;
    this.generation.abort();
    this.clearTimer();
  }

  /**
   * Something changed that may let queued work run: new mail, a body. A no-op when off or stopped, and for a minute
   * after a provider failed (so a burst of mail can't spend every attempt in a moment). `network`: it's reachable
   * again, or the timer's up: that wait is over.
   */
  wake(o: { network?: boolean } = {}): void {
    if (!this.isActive || this.paused) return;
    if (o.network) this.heldUntil = 0;
    if (this.host.now() < this.heldUntil) return;
    if (this.limited) {
      if (this.limited.day === day(this.host.now())) return;
      this.limited = null;
    }
    void this.drain().catch((error: unknown) => {
      captureError(error, { code: "ai.failed" });
      this.host.log("warn", "summaries stopped", error instanceof Error ? error.message : error);
    });
  }

  /** Settings changed: a key or a provider may unblock it; off, or AI gone, drops the queue and what's running. */
  settingsChanged(settings: AppSettings): void {
    const on = this.host.runs(settings);
    const off = this.active && !on;
    this.active = on;
    this.paused = null;
    this.limited = null;
    this.heldUntil = 0;
    this.clearTimer();
    if (off) {
      this.generation.abort();
      this.generation = new AbortController();
      void this.host.store.aiSummaries.dropPending().catch(() => {});
      return;
    }
    this.wake();
  }

  async status(): Promise<AiSummariesStatus> {
    const [pending, failure] = await Promise.all([this.host.store.aiSummaries.pendingCount(), this.host.store.aiSummaries.lastFailure()]);
    return { pending, blockedBy: this.paused ?? this.limited?.because ?? null, lastError: (failure?.kind as AiErrorKind | undefined) ?? null };
  }

  private clearTimer(): void {
    if (this.rateTimer) clearTimeout(this.rateTimer);
    this.rateTimer = null;
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

  /** Once a day, in a background slice: what's past its moment goes, and the table stays within its size. */
  private async bounds(): Promise<void> {
    const today = day(this.host.now());
    if (this.prunedDay === today) return;
    this.prunedDay = today;
    await this.host.store.newMail.prune(this.host.now());
    await this.host.store.aiSummaries.prune(this.host.now(), SUMMARY_MAX_ROWS);
  }

  /** One keyset walk of the queue, stopping early when the provider can't take more. */
  private async pass(generation: AbortController): Promise<void> {
    let after: { createdAt: number; threadId: number } | null = null;
    for (;;) {
      const page: AiSummaryRow[] = await this.host.store.aiSummaries.pending(after, PAGE);
      if (!page.length) return;
      for (const row of page) {
        if (generation !== this.generation || !this.isActive) return;
        after = { createdAt: row.createdAt, threadId: row.threadId };
        if (this.inflight.has(row.threadId)) continue;
        if ((await this.consider(row, generation)) === "stop") return;
      }
    }
  }

  private async consider(row: AiSummaryRow, generation: AbortController): Promise<"next" | "stop"> {
    const { store } = this.host;
    const settings = await this.host.settings();
    if (!this.host.runs(settings)) return "stop";
    const sources = await store.aiSummaries.sources(row.threadId);
    // a cascade took the row with the thread
    if (!sources) return "next";
    const marks = sources.messages.filter((m) => m.markedAt !== null && !m.trash && !m.spam);
    const floor = Math.max(this.host.now() - NEW_MAIL_MS, settings.summaries.enabledAt ?? 0);
    if (summaryBlocked(sources) || !sources.inInbox || sources.tab > 0 || !marks.some((m) => m.markedAt! >= floor)) {
      await store.aiSummaries.drop(row.threadId, row.throughMessageId);
      return "next";
    }
    // it never fetches a body by itself beyond what sync does: a body arriving wakes it
    if (marks.some((m) => m.bodyState !== "full" && !m.bodyUnavailable)) return "next";
    const texts = await store.aiSummaries.text(marks.map((m) => ({ messageId: m.id, limit: WORD_READ_CHARS })));
    const words = marks.reduce((n, m) => n + wordsIn(withoutQuotes(texts.get(m.id) ?? "")), 0);
    if (words < MIN_WORDS) {
      await store.aiSummaries.drop(row.threadId, row.throughMessageId);
      return "next";
    }
    const { signal, release } = this.host.begin(`summary-worker:${row.threadId}`, "summary-worker");
    try {
      const { running, joined } = this.single(row.threadId, () => this.run(sources, row, { foreground: false, signal: AbortSignal.any([signal, generation.signal]) }));
      // someone asked by hand while this looked: theirs is this thread's request, and its result lands on the row
      if (joined) return "next";
      const run = await running;
      if (run.outcome === "blocked") await store.aiSummaries.drop(row.threadId, row.throughMessageId);
      // a newer message or a change of its sources: the row is still queued, behind this pass
      if (run.outcome === "moved") this.again = true;
      return "next";
    } catch (error) {
      return this.failed(row, error);
    } finally {
      release();
    }
  }

  private async failed(row: AiSummaryRow, error: unknown): Promise<"next" | "stop"> {
    const { store } = this.host;
    if (error instanceof DailyLimitError || error instanceof MonthlyLimitError) {
      const limit = error instanceof DailyLimitError ? "daily" : "monthly";
      this.limited = { day: day(this.host.now()), because: { kind: error.kind, message: error.message, ...(error.i18n ? { i18n: error.i18n } : {}), limit } };
      this.host.log("info", "summaries stopped at a limit", { limit });
      return "stop";
    }
    if (!(error instanceof AiError)) captureError(error, { code: "ai.failed" });
    const kind: AiErrorKind = error instanceof AiError ? error.kind : "unavailable";
    this.host.log("info", "summary failed", { aiKind: kind });
    switch (kind) {
      case "cancelled":
        return "stop";
      case "auth":
      case "not_configured":
      case "blocked": {
        const i18n = error instanceof AiError ? error.i18n : undefined;
        this.paused = { kind, message: error instanceof Error ? error.message : String(error), ...(i18n ? { i18n } : {}) };
        return "stop";
      }
      case "invalid_output":
      case "refused":
      case "unsupported":
        await store.aiSummaries.fail(row.threadId, kind, this.host.now());
        return "next";
      case "rate_limited":
      case "unavailable":
      case "timeout": {
        await store.aiSummaries.attempt(row.threadId, kind, MAX_ATTEMPTS, this.host.now());
        this.heldUntil = this.host.now() + RETRY_WAIT_MS;
        // the one timer: a provider that said "slow down" with work still queued (the network coming back wakes the rest)
        if (kind === "rate_limited" && !this.rateTimer) {
          this.rateTimer = setTimeout(() => {
            this.rateTimer = null;
            this.wake({ network: true });
          }, RETRY_WAIT_MS);
          (this.rateTimer as { unref?: () => void }).unref?.();
        }
        return "stop";
      }
    }
  }

  /** One request a thread at a time. Looks and takes the place with nothing awaited between, so two can't both pay. */
  private single(threadId: number, work: () => Promise<Run>): { running: Promise<Run>; joined: boolean } {
    const already = this.inflight.get(threadId);
    if (already) return { running: already, joined: true };
    const running = work().finally(() => {
      if (this.inflight.get(threadId) === running) this.inflight.delete(threadId);
    });
    this.inflight.set(threadId, running);
    return { running, joined: false };
  }

  /** Settings → Storage → Clear AI data: nothing in flight may bring back what was just cleared. */
  async clear(): Promise<void> {
    this.cleared.abort();
    this.cleared = new AbortController();
    this.generation.abort();
    this.generation = new AbortController();
    await this.host.store.aiSummaries.clear();
  }

  /** Assemble, reuse or ask, then write: the write re-checks everything the request took time over. */
  private async run(sources: SummarySources, row: AiSummaryRow | null, o: { foreground: boolean; signal: AbortSignal; ai?: AiTasks }): Promise<Run> {
    const { store } = this.host;
    // before anything it writes was read: a clear after this point makes the write refuse itself
    const clearGeneration = store.aiSummaries.clearGeneration();
    const signal = AbortSignal.any([o.signal, this.cleared.signal]);
    const ai = o.ai ?? (await this.host.forTask({ foreground: o.foreground }));
    const { subject, thread, reader, labels } = await assemble(store, sources, ai.contextTokens);
    const contentHash = await sha256(JSON.stringify({ subject, thread, reader }));
    const language = await this.readerLanguage();
    const base = { threadId: sources.threadId, stamp: sources.stamp, expectThrough: row?.throughMessageId ?? null, now: this.host.now(), clearGeneration };
    if (reusable(row, { contentHash, language, ai })) {
      const outcome = await store.aiSummaries.finish({ ...base, reuse: true });
      if (outcome === "written") this.host.ready(sources.threadId);
      return { outcome, summary: outcome === "written" ? (viewOf(row!) ?? undefined) : undefined };
    }
    const result = await ai.summarize({ subject, thread, reader, language, today: day(this.host.now()), outputTokens: summaryBudget(ai.contextTokens).outputTokens }, signal);
    // a late answer after a cancel, a clear, or the setting going off: nothing is written
    if (signal.aborted) throw new AiError(L("errors.ai.cancelled"), "cancelled");
    const items = result.items.flatMap((item) => {
      const messageId = labels.get(item.message);
      return messageId === undefined ? [] : [{ kind: item.kind, text: item.text, messageId }];
    });
    const bodyJson = JSON.stringify({ summary: result.summary, items });
    const outcome = await store.aiSummaries.finish({ ...base, now: this.host.now(), contentHash, promptVersion: SUMMARY_PROMPT_VERSION, language, model: ai.model, provider: ai.providerId, endpoint: ai.endpoint, bodyJson });
    if (outcome !== "written") {
      // a clear won the race: to the one who asked, that's a cancel, not a thread gone
      if (signal.aborted) throw new AiError(L("errors.ai.cancelled"), "cancelled");
      return { outcome };
    }
    this.host.ready(sources.threadId);
    return { outcome, summary: { threadId: sources.threadId, summary: result.summary, items, provider: ai.providerId, model: ai.model, generatedAt: base.now } };
  }

  /** What an open reader shows. Reading is never gated; spam and trash show nothing, and bring it back with Not spam. */
  async read(threadId: number): Promise<AiSummaryRead> {
    const row = await this.host.store.aiSummaries.get(threadId);
    if (!row?.bodyJson) return { state: "none" };
    const sources = await this.host.store.aiSummaries.sources(threadId);
    if (!sources || summaryBlocked(sources)) return { state: "none" };
    if (row.state !== "ready" || row.sourceStamp !== sources.stamp) return { state: "stale" };
    const summary = viewOf(row);
    return summary ? { state: "ready", summary } : { state: "none" };
  }

  /** §7: a summary by hand. Its limits are spam and trash, and the user's word on where it goes. */
  async request(threadId: number, requestId: string, clientId: string): Promise<AiSummarizeResult> {
    const { store } = this.host;
    const { signal, release } = this.host.begin(requestId, clientId);
    try {
      for (let tries = 0; ; tries++) {
        const sources = await store.aiSummaries.sources(threadId);
        if (!sources) throw new RpcError("NOT_FOUND", L("errors.threadGone"));
        if (summaryBlocked(sources) || !sources.messages.some((m) => !m.trash)) throw new RpcError("BAD_REQUEST", L("errors.ai.summaryBlocked"));
        // the reader is already fetching what's open: it asks again when the text arrives
        const included = sources.messages.filter((m) => !m.trash);
        const newest = [...included].reverse().find((m) => !m.own) ?? included[included.length - 1]!;
        if (newest.bodyState === "none" && !newest.bodyUnavailable) return { status: "waitingBody" };

        // the worker is on this thread right now: its answer is this answer
        const running = this.inflight.get(threadId);
        if (running) {
          const joined = await Promise.race([running.catch(() => null), aborted(signal)]);
          if (joined?.outcome === "written" && joined.summary) return { status: "ready", summary: joined.summary };
          continue;
        }

        const row = await store.aiSummaries.get(threadId);
        const ai = await this.host.forTask({ foreground: true });
        const { running: mine, joined } = this.single(threadId, () => this.run(sources, row, { foreground: true, signal, ai }));
        // another caller got there during the awaits above: same as finding it running at the top
        if (joined) {
          const settled = await Promise.race([mine.catch(() => null), aborted(signal)]);
          if (settled?.outcome === "written" && settled.summary) return { status: "ready", summary: settled.summary };
          continue;
        }
        const run = await mine;
        if (run.outcome === "written" && run.summary) return { status: "ready", summary: run.summary };
        if (run.outcome === "gone") throw new RpcError("NOT_FOUND", L("errors.threadGone"));
        if (run.outcome === "blocked") throw new RpcError("BAD_REQUEST", L("errors.ai.summaryBlocked"));
        // the conversation moved under the request: once more with what's there now, not forever
        if (tries >= 2) throw new AiError(L("errors.ai.summaryMoved"), "unavailable");
      }
    } catch (error) {
      throw toRpcError(error);
    } finally {
      release();
    }
  }

  /** The setting, or while that follows the system, what the window said: the backend can't see the system's. */
  async readerLanguage(): Promise<LocaleId> {
    const { language } = await this.host.settings();
    if (isLocaleId(language)) return language;
    const ui = await this.host.store.settings.get<string | null>(UI_LOCALE_KEY, null);
    return isLocaleId(ui) ? ui : DEFAULT_LOCALE;
  }
}

/** The same text, prompt and language on the same execution target (revision 5: the endpoint counts as much as the model). */
function reusable(row: AiSummaryRow | null, now: { contentHash: string; language: string; ai: AiTasks }): boolean {
  return !!row?.bodyJson && row.contentHash === now.contentHash && row.promptVersion === SUMMARY_PROMPT_VERSION && row.language === now.language && row.model === now.ai.model && row.provider === now.ai.providerId && row.endpoint === now.ai.endpoint;
}

function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () => reject(new AiError(L("errors.ai.cancelled"), "cancelled"));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
}
