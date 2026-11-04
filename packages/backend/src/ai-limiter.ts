import { AiError, costOf, type CompletionRequest, type ModelTransport, type StreamEvent, type Usage } from "@terno/ai";
import { L } from "@terno/i18n";
import type { AiTaskName } from "@terno/core";
import type { AiUsageReport } from "@terno/core/rpc";
import type { MailStore } from "@terno/store";

/** A background task's share of the provider, across all of them. */
const BACKGROUND_PER_MINUTE = 20;
/** What one day may spend by itself, per task: nobody asked for each of these requests. */
export const DAILY_REQUESTS: Readonly<Record<BackgroundTask, number>> = { summary: 300, categorize: 200, voice: 60 };
/** A second ceiling, in input tokens, because a request's size varies. */
export const DAILY_INPUT_TOKENS: Readonly<Record<BackgroundTask, number>> = { summary: 1_500_000, categorize: 400_000, voice: 400_000 };
/** How much background work may wait for a permit, so a burst can't pile up in memory. */
const MAX_WAITING = 64;

export type BackgroundTask = "summary" | "categorize" | "voice";
export type LimiterTask = AiTaskName | "filter" | "voice" | "intent";

interface Tally {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

/**
 * By day (YYYY-MM-DD, local time) and task. Bounded: a month and a bit. `byHand`: a person's own request for what is
 * otherwise background work (a summary asked for): it counts as spent, never toward that work's ceilings.
 */
type UsageBook = Record<string, Partial<Record<LimiterTask | "byHand", Tally>>>;

const BOOK_KEY = "ai:usage";
const KEEP_DAYS = 40;

export class DailyLimitError extends AiError {
  constructor() {
    super(L("errors.ai.dailyLimit"), "rate_limited");
    this.name = "DailyLimitError";
  }
}

export class MonthlyLimitError extends AiError {
  constructor() {
    super(L("errors.ai.monthlyLimit"), "rate_limited");
    this.name = "MonthlyLimitError";
  }
}

const emptyTally = (): Tally => ({ requests: 0, inputTokens: 0, outputTokens: 0, usd: 0 });

function dayOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

interface Waiter {
  grant: () => void;
  foreground: boolean;
}

export interface AiLimiterHost {
  readonly store: Pick<MailStore, "settings">;
  now(): number;
  /** the monthly ceiling on background AI in US dollars; 0: none */
  monthlyLimitUsd(): Promise<number>;
}

/**
 * Every request to a provider passes here. It keeps background work within its
 * share, keeps a local model to one request at a time (foreground first), and
 * counts what was spent, so a daily or monthly ceiling can stop work nobody is
 * watching. A person's own request is never refused, only counted.
 */
export class AiLimiter {
  private readonly sent: number[] = [];
  private readonly localQueue: Waiter[] = [];
  private localBusy = false;
  private waitingBackground = 0;
  private book: UsageBook | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly host: AiLimiterHost) {}

  wrap(transport: ModelTransport, o: { task: LimiterTask; model: string; local: boolean; foreground: boolean }): ModelTransport {
    const before = async (req: CompletionRequest) => {
      if (!o.foreground) await this.admitBackground(o.task as BackgroundTask, req.signal);
      return o.local ? this.takeLocal(o.foreground, req.signal) : () => {};
    };
    const counted = o.foreground && o.task in DAILY_REQUESTS ? "byHand" : o.task;
    const wrapped: ModelTransport = {
      ...transport,
      complete: async (req) => {
        const release = await before(req);
        try {
          const completion = await transport.complete(req);
          void this.record(counted, o.model, completion.usage);
          return completion;
        } catch (error) {
          void this.record(counted, o.model, undefined);
          throw error;
        } finally {
          release();
        }
      },
    };
    if (transport.stream) {
      const inner = transport.stream.bind(transport);
      const record = (usage: Usage | undefined) => this.record(counted, o.model, usage);
      wrapped.stream = async function* (req: CompletionRequest): AsyncGenerator<StreamEvent> {
        const release = await before(req);
        let usage: Usage | undefined;
        try {
          for await (const event of inner(req)) {
            if (event.type === "done") usage = event.usage;
            yield event;
          }
        } finally {
          void record(usage);
          release();
        }
      };
    }
    return wrapped;
  }

  /** Waits for a slot in the minute, after checking the day's and the month's ceilings. */
  private async admitBackground(task: BackgroundTask, signal: AbortSignal): Promise<void> {
    const book = await this.load();
    const today = book[dayOf(this.host.now())]?.[task] ?? emptyTally();
    if (today.requests >= DAILY_REQUESTS[task] || today.inputTokens >= DAILY_INPUT_TOKENS[task]) throw new DailyLimitError();
    const ceiling = await this.host.monthlyLimitUsd();
    if (ceiling > 0 && this.monthBackgroundUsd(book) >= ceiling) throw new MonthlyLimitError();
    if (this.waitingBackground >= MAX_WAITING) throw new AiError(L("errors.ai.rateLimited", { provider: "Terno" }), "rate_limited");
    this.waitingBackground++;
    try {
      for (;;) {
        signal.throwIfAborted();
        const now = this.host.now();
        while (this.sent.length && now - this.sent[0]! >= 60_000) this.sent.shift();
        if (this.sent.length < BACKGROUND_PER_MINUTE) {
          this.sent.push(now);
          return;
        }
        await this.sleep(Math.max(50, 60_000 - (now - this.sent[0]!)), signal);
      }
    } finally {
      this.waitingBackground--;
    }
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      (timer as { unref?: () => void }).unref?.();
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async takeLocal(foreground: boolean, signal: AbortSignal): Promise<() => void> {
    if (this.localBusy) {
      await new Promise<void>((resolve, reject) => {
        const waiter: Waiter = {
          foreground,
          grant: () => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          },
        };
        const onAbort = () => {
          this.localQueue.splice(this.localQueue.indexOf(waiter), 1);
          reject(signal.reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        if (foreground) {
          // behind other foreground work, ahead of the background
          const at = this.localQueue.findIndex((w) => !w.foreground);
          if (at < 0) this.localQueue.push(waiter);
          else this.localQueue.splice(at, 0, waiter);
        } else {
          this.localQueue.push(waiter);
        }
      });
    }
    this.localBusy = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.localBusy = false;
      const next = this.localQueue.shift();
      if (next) {
        this.localBusy = true;
        next.grant();
      }
    };
  }

  private async load(): Promise<UsageBook> {
    return (this.book ??= await this.host.store.settings.get<UsageBook>(BOOK_KEY, {}));
  }

  private monthBackgroundUsd(book: UsageBook): number {
    const month = dayOf(this.host.now()).slice(0, 7);
    let usd = 0;
    for (const [day, tasks] of Object.entries(book)) {
      if (!day.startsWith(month)) continue;
      for (const task of ["summary", "categorize", "voice"] as const) usd += tasks[task]?.usd ?? 0;
    }
    return usd;
  }

  /**
   * Counts a finished request. With no usage reported (a failure, or a server
   * that doesn't say) it still counts as a request, so a failing provider can't
   * be retried past the ceiling.
   */
  private async record(task: LimiterTask | "byHand", model: string, usage: Usage | undefined): Promise<void> {
    const book = await this.load();
    const day = dayOf(this.host.now());
    const tally = ((book[day] ??= {})[task] ??= emptyTally());
    tally.requests++;
    if (usage) {
      tally.inputTokens += usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
      tally.outputTokens += usage.outputTokens;
      tally.usd += costOf(model, usage) ?? 0;
    }
    const days = Object.keys(book).sort();
    while (days.length > KEEP_DAYS) delete book[days.shift()!];
    this.writing = this.writing.then(() => this.host.store.settings.set(BOOK_KEY, book)).catch(() => {});
    await this.writing;
  }

  async report(): Promise<AiUsageReport> {
    const book = await this.load();
    const today = dayOf(this.host.now());
    const month = today.slice(0, 7);
    const report: AiUsageReport = { today: { requests: 0, usd: 0 }, month: { requests: 0, usd: 0 }, monthBackgroundUsd: this.monthBackgroundUsd(book) };
    for (const [day, tasks] of Object.entries(book)) {
      for (const tally of Object.values(tasks)) {
        if (day === today) {
          report.today.requests += tally.requests;
          report.today.usd += tally.usd;
        }
        if (day.startsWith(month)) {
          report.month.requests += tally.requests;
          report.month.usd += tally.usd;
        }
      }
    }
    return report;
  }
}
