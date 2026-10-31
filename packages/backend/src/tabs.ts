import { captureError, log } from "@terno/core/diag";
import { SliceSizer } from "./slicer";
import { FACTS_SLICE, type FactsHost } from "./facts";

/** At most one view refresh a second while it runs (the Inbox and the tabs fill in), and one at the end. */
const ANNOUNCE_EVERY_MS = 1000;

/**
 * Plan 86's backfill: the Gmail tabs of mail stored before them, in the
 * store's slices (each one unit of work, sized by the time slices take),
 * once. Started with the backend; nothing to do is one probe, and no timer.
 * Stopping waits for the slice in flight; the next start resumes from the
 * store's progress.
 */
export class TabsBackfill {
  private running: Promise<void> | null = null;
  private stopped = false;
  private readonly sizer = new SliceSizer(FACTS_SLICE);

  constructor(private readonly host: FactsHost) {}

  start(): void {
    if (this.stopped || this.running) return;
    this.running = this.run().finally(() => {
      this.running = null;
    });
  }

  /** Resolves when the run is over: tests and the seeded hosts. */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.running?.catch(() => {});
  }

  private async run(): Promise<void> {
    const store = this.host.store;
    if (!store.isOpen || (await store.tabs.idle())) return;
    const started = performance.now();
    let announced = started;
    try {
      while (!this.stopped && store.isOpen) {
        const t0 = performance.now();
        const r = await store.tabs.backfill({ limit: this.sizer.size });
        this.sizer.record(r.processed, performance.now() - t0);
        if (!r.more) break;
        if (performance.now() - announced >= ANNOUNCE_EVERY_MS) {
          announced = performance.now();
          this.host.notifyChanged([], true);
        }
        await this.host.platform.yield();
        await store.settle?.();
      }
    } catch (error) {
      if (!store.isOpen) return;
      // the progress is saved per slice: the next start goes on from there
      captureError(error, { code: "tabs.backfill_failed" });
      this.host.log("warn", "the tabs backfill failed; it resumes on the next start", error instanceof Error ? error.message : error);
      return;
    }
    if (this.stopped || !store.isOpen) return;
    log.info("tabs.backfilled", { durationMs: Math.round(performance.now() - started) });
    this.host.notifyChanged([], true);
  }
}
