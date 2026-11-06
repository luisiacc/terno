import { AiError, costAt, estimateInputTokens, priceOf, UNKNOWN_CLOUD_PRICE, worstCaseUsd, type CompletionRequest, type ModelPrice, type ModelTransport, type StreamEvent, type Usage } from "@terno/ai";
import { L } from "@terno/i18n";
import type { AiTaskName } from "@terno/core";
import type { AiUsageReport } from "@terno/core/rpc";
import type { MailStore } from "@terno/store";

/** A background task's share of the provider, across all of them. */
const BACKGROUND_PER_MINUTE = 20;
/** What one day may spend by itself, per task: nobody asked for each of these requests. */
export const DAILY_REQUESTS: Readonly<Record<BackgroundTask, number>> = { summary: 300, categorize: 200, voice: 60, followup: 200, reply: 100 };
/** A second ceiling, in input tokens, because a request's size varies. */
export const DAILY_INPUT_TOKENS: Readonly<Record<BackgroundTask, number>> = { summary: 1_500_000, categorize: 400_000, voice: 400_000, followup: 400_000, reply: 800_000 };
/** How much background work may wait for a permit, so a burst can't pile up in memory. */
const MAX_WAITING = 64;

export type BackgroundTask = "summary" | "categorize" | "voice" | "followup" | "reply";
export type LimiterTask = AiTaskName | "filter" | "voice" | "intent" | "reply";

interface Tally {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  /** how many of these requests' charges are estimates: an unknown price, or usage nobody reported */
  estimated?: number;
}

/**
 * By day (YYYY-MM-DD, local time) and task. Bounded: a month and a bit. `byHand`: a person's own request for what is
 * otherwise background work (a summary asked for): it counts as spent, never toward that work's ceilings.
 */
type UsageBook = Record<string, Partial<Record<LimiterTask | "byHand", Tally>>>;

const BOOK_KEY = "ai:usage";
const KEEP_DAYS = 40;
const FREE: ModelPrice = { input: 0, output: 0 };

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

/** What a request is charged before it goes, kept unless the provider reports what really happened. */
interface Reservation {
  day: string;
  task: LimiterTask | "byHand";
  inputTokens: number;
  outputTokens: number;
  usd: number;
  estimated: boolean;
}

interface WrapOptions {
  task: LimiterTask;
  model: string;
  local: boolean;
  foreground: boolean;
  /** plan 144 revision 1: nobody asked for each one, so it's charged and limited as background, but someone is reading: it doesn't queue behind the rest */
  ahead?: boolean;
}

/** A request that may go: what to settle afterward (none when a person's request couldn't even read the book), and its local slot. */
interface Admitted {
  reservation: Reservation | null;
  release: () => void;
}

export interface AiLimiterHost {
  readonly store: Pick<MailStore, "settings">;
  now(): number;
  /** the monthly ceiling on background AI in US dollars; 0: none */
  monthlyLimitUsd(): Promise<number>;
}

/** A model on this machine costs nothing; a cloud model nobody priced is counted dear rather than free. */
function priceFor(model: string, local: boolean): { price: ModelPrice; known: boolean } {
  if (local) return { price: FREE, known: true };
  const price = priceOf(model);
  return price ? { price, known: true } : { price: UNKNOWN_CLOUD_PRICE, known: false };
}

/** A server that says it used nothing has told us nothing: the worst case stands, as if it hadn't said. */
const reported = (usage: Usage | undefined): usage is Usage => !!usage && usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) > 0;

/**
 * Every request to a provider passes here. It keeps background work within its
 * share, keeps a local model to one request at a time (foreground first), and
 * counts what was spent, so a daily or monthly ceiling can stop work nobody is
 * watching. A person's own request is never refused, only counted.
 *
 * The count is a reservation: a request is charged its worst case, durably,
 * before it leaves, and the charge becomes what it really cost only if the
 * provider says. So concurrent requests can't share one remaining allowance,
 * and a lost response, a failure or a crash mid-request stays counted.
 */
export class AiLimiter {
  private readonly sent: number[] = [];
  private readonly localQueue: Waiter[] = [];
  private localBusy = false;
  private waitingBackground = 0;
  private book: UsageBook | null = null;
  private loading: Promise<UsageBook> | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly host: AiLimiterHost) {}

  wrap(transport: ModelTransport, o: WrapOptions): ModelTransport {
    const counted = o.foreground && o.task in DAILY_REQUESTS ? "byHand" : o.task;
    const wrapped: ModelTransport = {
      ...transport,
      complete: async (req) => {
        const { reservation, release } = await this.admit(o, counted, req);
        try {
          const completion = await transport.complete(req);
          this.settle(reservation, o, completion.usage);
          return completion;
        } finally {
          release();
        }
      },
    };
    if (transport.stream) {
      const inner = transport.stream.bind(transport);
      const admit = (req: CompletionRequest) => this.admit(o, counted, req);
      const settle = (reservation: Reservation | null, usage: Usage | undefined) => this.settle(reservation, o, usage);
      wrapped.stream = async function* (req: CompletionRequest): AsyncGenerator<StreamEvent> {
        const { reservation, release } = await admit(req);
        let usage: Usage | undefined;
        try {
          for await (const event of inner(req)) {
            if (event.type === "done") usage = event.usage;
            yield event;
          }
        } finally {
          settle(reservation, usage);
          release();
        }
      };
    }
    return wrapped;
  }

  /**
   * Background work is refused early when it can't fit, waits its turn, and is
   * asked again after waiting, since the book moved meanwhile. The last check
   * and the charge happen with no await between them.
   */
  private async admit(o: WrapOptions, counted: LimiterTask | "byHand", req: CompletionRequest): Promise<Admitted> {
    const { price } = priceFor(o.model, o.local);
    const worst = { inputTokens: estimateInputTokens(req), outputTokens: req.maxTokens, usd: worstCaseUsd(price, req) };
    const task = o.task as BackgroundTask;
    if (!o.foreground) {
      const book = await this.bookFor(false);
      this.checkCeilings(book!, task, worst, await this.host.monthlyLimitUsd());
      if (!o.ahead) await this.takeMinuteSlot(req.signal);
    }
    const release = o.local ? await this.takeLocal(o.foreground || o.ahead === true, req.signal) : () => {};
    try {
      if (req.signal.aborted) throw new AiError(L("errors.ai.cancelled"), "cancelled");
      const book = await this.bookFor(o.foreground);
      if (!o.foreground) this.checkCeilings(book!, task, worst, await this.host.monthlyLimitUsd());
      if (!book) return { reservation: null, release };
      const reservation = this.reserve(book, counted, worst, !o.local);
      // written before anything leaves, so a crash mid-request stays counted
      await this.persist().catch(() => {
        if (o.foreground) return;
        this.unreserve(book, reservation);
        throw this.notSaved();
      });
      return { reservation, release };
    } catch (error) {
      release();
      throw error;
    }
  }

  private notSaved(): AiError {
    return new AiError(L("errors.ai.usageNotSaved"), "unavailable");
  }

  /** A person's request goes even when the book can't be read; background work can't be held to a ceiling it can't see. */
  private async bookFor(foreground: boolean): Promise<UsageBook | null> {
    try {
      return await this.load();
    } catch {
      if (foreground) return null;
      throw this.notSaved();
    }
  }

  private checkCeilings(book: UsageBook, task: BackgroundTask, worst: Pick<Reservation, "inputTokens" | "usd">, ceiling: number): void {
    const today = book[dayOf(this.host.now())]?.[task] ?? emptyTally();
    if (today.requests + 1 > DAILY_REQUESTS[task] || today.inputTokens + worst.inputTokens > DAILY_INPUT_TOKENS[task]) throw new DailyLimitError();
    if (ceiling > 0 && this.monthBackgroundUsd(book) + worst.usd > ceiling) throw new MonthlyLimitError();
  }

  private reserve(book: UsageBook, task: LimiterTask | "byHand", worst: Pick<Reservation, "inputTokens" | "outputTokens" | "usd">, estimated: boolean): Reservation {
    const day = dayOf(this.host.now());
    const tally = ((book[day] ??= {})[task] ??= emptyTally());
    tally.requests++;
    tally.inputTokens += worst.inputTokens;
    tally.outputTokens += worst.outputTokens;
    tally.usd += worst.usd;
    if (estimated) tally.estimated = (tally.estimated ?? 0) + 1;
    const days = Object.keys(book).sort();
    while (days.length > KEEP_DAYS) delete book[days.shift()!];
    return { day, task, ...worst, estimated };
  }

  /** It never left: nothing was spent. */
  private unreserve(book: UsageBook, r: Reservation): void {
    const tally = book[r.day]?.[r.task];
    if (!tally) return;
    tally.requests = Math.max(0, tally.requests - 1);
    this.adjust(tally, -r.inputTokens, -r.outputTokens, -r.usd);
    if (r.estimated) tally.estimated = Math.max(0, (tally.estimated ?? 0) - 1);
  }

  private adjust(tally: Tally, inputTokens: number, outputTokens: number, usd: number): void {
    tally.inputTokens = Math.max(0, tally.inputTokens + inputTokens);
    tally.outputTokens = Math.max(0, tally.outputTokens + outputTokens);
    tally.usd = Math.max(0, tally.usd + usd);
  }

  /** The provider said what happened: the reservation becomes that. With nothing reported, the worst case stands. */
  private settle(r: Reservation | null, o: WrapOptions, usage: Usage | undefined): void {
    if (!r || !reported(usage)) return;
    const tally = this.book?.[r.day]?.[r.task];
    if (!tally) return;
    const { price, known } = priceFor(o.model, o.local);
    this.adjust(tally, usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) - r.inputTokens, usage.outputTokens - r.outputTokens, costAt(price, usage) - r.usd);
    if (r.estimated && known) tally.estimated = Math.max(0, (tally.estimated ?? 0) - 1);
    // a failed write leaves the worst case on disk, which errs the safe way
    void this.persist().catch(() => {});
  }

  /** Waits for a slot in the minute. */
  private async takeMinuteSlot(signal: AbortSignal): Promise<void> {
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

  /** One read however many ask at once: a second copy of the book would lose what the first has charged. */
  private load(): Promise<UsageBook> {
    if (this.book) return Promise.resolve(this.book);
    this.loading ??= this.host.store.settings.get<UsageBook>(BOOK_KEY, {}).then(
      (book) => {
        this.loading = null;
        return (this.book = book);
      },
      (error: unknown) => {
        this.loading = null;
        throw error;
      },
    );
    return this.loading;
  }

  /** The whole book as it is when its turn comes, so an awaited write holds every charge made before it. */
  private persist(): Promise<void> {
    const write = this.writing.then(() => this.host.store.settings.set(BOOK_KEY, this.book));
    this.writing = write.catch(() => {});
    return write;
  }

  private monthBackgroundUsd(book: UsageBook): number {
    const month = dayOf(this.host.now()).slice(0, 7);
    let usd = 0;
    for (const [day, tasks] of Object.entries(book)) {
      if (!day.startsWith(month)) continue;
      // whatever runs by itself: the registry above, so a new background task can't spend past the ceiling unseen
      for (const task of Object.keys(DAILY_REQUESTS) as BackgroundTask[]) usd += tasks[task]?.usd ?? 0;
    }
    return usd;
  }

  async report(): Promise<AiUsageReport> {
    const book = await this.load();
    const today = dayOf(this.host.now());
    const month = today.slice(0, 7);
    const report: AiUsageReport = { today: { requests: 0, usd: 0 }, month: { requests: 0, usd: 0 }, monthBackgroundUsd: this.monthBackgroundUsd(book), monthAsk: { requests: 0, usd: 0 }, estimated: false };
    for (const [day, tasks] of Object.entries(book)) {
      if (day.startsWith(month) && tasks.ask) {
        report.monthAsk.requests += tasks.ask.requests;
        report.monthAsk.usd += tasks.ask.usd;
      }
      for (const tally of Object.values(tasks)) {
        if (day === today) {
          report.today.requests += tally.requests;
          report.today.usd += tally.usd;
        }
        if (day.startsWith(month)) {
          report.month.requests += tally.requests;
          report.month.usd += tally.usd;
          if ((tally.estimated ?? 0) > 0) report.estimated = true;
        }
      }
    }
    return report;
  }
}
