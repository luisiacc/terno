import { captureError, log } from "@terno/core/diag";
import type { MailStore, Platform } from "@terno/store";
import { SliceSizer, type SliceBudget } from "./slicer";

/**
 * Plan 17's backfill of the thread facts (who a conversation is from, what
 * waits for your reply), for mail stored before them and threads requeued
 * since. Woken at start and by every change; it runs store slices (each one
 * unit of work, sized by the time slices take) until nothing is left, then
 * sleeps: no timer, so idle stays idle. Stopping waits for the slice in
 * flight; the next start resumes where the store's progress says.
 */

/** The backend's slice budget: what a slice should take before interactive work gets its turn. */
export const FACTS_SLICE: SliceBudget = { targetMs: 8, initial: 64, floor: 1, ceiling: 20_000 };
/** At most one view refresh a second while it runs (lists and the People filter fill in), and one at the end. */
const ANNOUNCE_EVERY_MS = 1000;
/** Failures in a row before it gives up for the session. */
const MAX_FAILURES = 3;

export interface FactsHost {
  readonly store: MailStore;
  readonly platform: Pick<Platform, "yield">;
  notifyChanged(threadIds: Iterable<number>, views?: boolean): void;
  log(level: "info" | "warn" | "error", message: string, extra?: unknown): void;
}

export class FactsBackfill {
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private failures = 0;
  /** message-id windows and threads cost differently: one sizer each */
  private readonly sizers: Record<"senders" | "threads", SliceSizer>;

  constructor(
    private readonly host: FactsHost,
    budget: SliceBudget = FACTS_SLICE,
  ) {
    this.sizers = { senders: new SliceSizer(budget), threads: new SliceSizer(budget) };
  }

  /** Work may be waiting (start, a change): run until none is left. Coalesces wakes while running. */
  wake(): void {
    if (this.stopped || this.failures >= MAX_FAILURES) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = this.run().finally(() => {
      this.running = null;
      if (this.again && !this.stopped) {
        this.again = false;
        this.wake();
      }
    });
  }

  /** Resolves when the current run (and any it queued) is over: tests and the seeded hosts. */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.running?.catch(() => {});
  }

  private async run(): Promise<void> {
    const store = this.host.store;
    if (!store.isOpen || (await store.facts.idle())) return;
    const started = performance.now();
    let announced = started;
    let phase: "senders" | "threads" = "threads";
    let threads = 0;
    try {
      while (!this.stopped && store.isOpen) {
        const sizer = this.sizers[phase];
        const t0 = performance.now();
        const r = await store.facts.backfill({ limit: sizer.size });
        sizer.record(r.processed, performance.now() - t0);
        if (r.phase !== "senders") threads += r.processed;
        this.failures = 0;
        if (!r.more) break;
        phase = r.phase === "senders" ? "senders" : "threads";
        if (performance.now() - announced >= ANNOUNCE_EVERY_MS) {
          announced = performance.now();
          this.host.notifyChanged([], true);
        }
        await this.host.platform.yield();
        await store.settle?.();
      }
    } catch (error) {
      if (!store.isOpen) return;
      this.failures++;
      captureError(error, { code: "facts.backfill_failed", fields: { count: this.failures } });
      this.host.log("warn", "the facts backfill failed; it resumes on the next change", error instanceof Error ? error.message : error);
      return;
    }
    if (this.stopped || !store.isOpen) return;
    log.info("facts.backfilled", { count: threads, durationMs: Math.round(performance.now() - started) });
    // the lists and the waiting count, now that every thread's facts are known
    this.host.notifyChanged([], true);
  }
}
