import { L } from "@terno/i18n";
import { ProviderError } from "./types";

export interface IncomingReadAdmission {
  acquire(accountId: number, signal: AbortSignal, reset?: AbortSignal): Promise<() => void>;
}

interface Waiter {
  signal: AbortSignal;
  reset?: AbortSignal;
  resolve(release: () => void): void;
  reject(reason: unknown): void;
  abort(): void;
}

/** Backend-owned incoming read capacity. A waiting job retains no response or mail bytes. */
export class IncomingReads implements IncomingReadAdmission {
  private active = 0;
  private queued = 0;
  private closed = false;
  private readonly accounts = new Map<number, Waiter[]>();
  private readonly order: number[] = [];

  constructor(private readonly capacity = 6, private readonly queueLimit = 256) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || !Number.isSafeInteger(queueLimit) || queueLimit < 0) throw new RangeError("Invalid incoming capacity");
  }

  acquire(accountId: number, signal: AbortSignal, reset?: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (reset?.aborted) return Promise.reject(reset.reason);
    if (this.closed) return Promise.reject(new DOMException("Mail processing stopped", "AbortError"));
    if (this.active < this.capacity && !this.queued) return Promise.resolve(this.lease());
    if (this.queued >= this.queueLimit) return Promise.reject(new IncomingCapacityError());
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { signal, reset, resolve, reject, abort: () => {
        this.remove(accountId, waiter);
        reject(signal.aborted ? signal.reason : reset?.reason);
        this.pump();
      } };
      const queue = this.accounts.get(accountId);
      if (queue) queue.push(waiter);
      else { this.accounts.set(accountId, [waiter]); this.order.push(accountId); }
      this.queued++;
      signal.addEventListener("abort", waiter.abort, { once: true });
      if (reset && reset !== signal) reset.addEventListener("abort", waiter.abort, { once: true });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const queue of this.accounts.values()) for (const waiter of queue) {
      this.unlisten(waiter);
      waiter.reject(new DOMException("Mail processing stopped", "AbortError"));
    }
    this.accounts.clear();
    this.order.length = 0;
    this.queued = 0;
  }

  private lease(): () => void {
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.pump();
    };
  }

  private remove(accountId: number, waiter: Waiter): void {
    const queue = this.accounts.get(accountId);
    const index = queue?.indexOf(waiter) ?? -1;
    if (!queue || index < 0) return;
    queue.splice(index, 1);
    this.queued--;
    this.unlisten(waiter);
    if (!queue.length) {
      this.accounts.delete(accountId);
      this.order.splice(this.order.indexOf(accountId), 1);
    }
  }

  private unlisten(waiter: Waiter): void {
    waiter.signal.removeEventListener("abort", waiter.abort);
    if (waiter.reset && waiter.reset !== waiter.signal) waiter.reset.removeEventListener("abort", waiter.abort);
  }

  private pump(): void {
    while (!this.closed && this.active < this.capacity && this.order.length) {
      const accountId = this.order[0]!;
      const queue = this.accounts.get(accountId)!;
      const waiter = queue[0]!;
      this.remove(accountId, waiter);
      if (queue.length) this.order.push(this.order.shift()!);
      if (waiter.signal.aborted) waiter.reject(waiter.signal.reason);
      else if (waiter.reset?.aborted) waiter.reject(waiter.reset.reason);
      else waiter.resolve(this.lease());
    }
  }
}

/** Local capacity refusal is neither an offline verdict nor a refused sign-in. */
export class IncomingCapacityError extends ProviderError {
  constructor() { super(L("errors.mail.processingBusy"), false); this.name = "IncomingCapacityError"; }
  override get expected(): boolean { return true; }
}

/** One backend owns read slots, a promoted pipeline and completed-small byte credits. */
export class IncomingPipeline extends IncomingReads {
  private readonly promoted = new IncomingReads(1);
  private retained = 0;
  private pipelineClosed = false;

  promote(accountId: number, signal: AbortSignal, reset?: AbortSignal): Promise<() => void> {
    return this.promoted.acquire(accountId, signal, reset);
  }

  retainCompleted(bytes: number): (() => void) | undefined {
    if (this.pipelineClosed) throw new DOMException("Mail processing stopped", "AbortError");
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError("Invalid incoming byte charge");
    if (this.retained + bytes > 4 * 1024 * 1024) return;
    this.retained += bytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.retained -= bytes;
    };
  }

  override close(): void {
    this.pipelineClosed = true;
    this.promoted.close();
    super.close();
  }
}
