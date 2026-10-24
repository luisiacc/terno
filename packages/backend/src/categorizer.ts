import { CategorizerModel, FEATURES_V } from "@terno/core";
import type { ExampleKey, MailStore, ModelDelta, Platform } from "@terno/store";
import { readAutoCategorize } from "./settings";

export interface CategorizerHost {
  readonly store: MailStore;
  readonly platform: Platform;
  now(): number;
  runSliced<T>(items: readonly T[], initialSize: number, work: (chunk: T[]) => void | Promise<void>): Promise<void>;
  log(level: "info" | "warn" | "error", message: string, extra?: unknown): void;
  notifyChanged(threadIds: Iterable<number>, views?: boolean): void;
}

const DAY = 86_400_000;
/** decay is recomputed (and the background refreshed) at most this often */
const REBUILD_EVERY_MS = 7 * DAY;
const BACKFILL_MIN = 200;
/** a rebuild yields after this much work */
const SLICE_MS = 8;
/** quiet time after the last backfill slice before the background is rebuilt */
const BACKFILL_SETTLE_MS = 20_000;

function scanned(d: ModelDelta, readTo: ExampleKey | "all" | null): boolean {
  if (d.op !== "train" && d.op !== "untrain") return true;
  if (readTo === "all") return true;
  if (readTo === null) return false;
  return d.key[0] < readTo[0] || (d.key[0] === readTo[0] && d.key[1] <= readTo[1]);
}

function applyDelta(m: CategorizerModel, d: ModelDelta): void {
  switch (d.op) {
    case "train":
      m.train(d.example);
      break;
    case "untrain":
      m.untrain(d.example);
      break;
    case "unbackground":
      m.removeBackground(d.threadId);
      break;
    case "background":
      m.addBackground(d.threadId, d.features);
      break;
  }
}

/**
 * Owns the in-memory model. The database is the source of truth: every
 * change is written by a store command first, and its ModelDeltas are
 * applied here only after that transaction committed. Until a model is
 * ready (first start, stale snapshot) classification is simply skipped.
 */
export class Categorizer {
  private current: CategorizerModel | null = null;
  private rebuilding: Promise<void> | null = null;
  /** deltas committed while a rebuild was scanning, with how far the scan had read; replayed onto the new model */
  private pending: { delta: ModelDelta; readTo: ExampleKey | "all" | null }[] | null = null;
  /** last example key the running rebuild has read */
  private readTo: ExampleKey | "all" | null = null;
  private dirty = false;
  /** old mail that arrived since the last build (its background counts are missing) */
  private backfilled = 0;
  private backfillTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly host: CategorizerHost) {}

  get model(): CategorizerModel | null {
    return this.current;
  }

  get ready(): boolean {
    return this.current !== null;
  }

  /** Startup: adopt the persisted snapshot if it still matches the training set. */
  async load(): Promise<boolean> {
    const { snapshot: snap, fingerprint } = await this.host.store.categorize.loadSnapshot();
    if (!snap || snap.featuresV !== FEATURES_V || snap.fingerprint !== fingerprint) return false;
    const m = CategorizerModel.deserialize(snap.blob);
    if (!m) return false;
    this.current = m;
    return true;
  }

  /** Deltas a store command returned, i.e. after it committed. */
  apply(deltas: readonly ModelDelta[]): void {
    if (deltas.length === 0) return;
    if (this.pending) for (const delta of deltas) this.pending.push({ delta, readTo: this.readTo });
    const m = this.current;
    if (!m) return;
    for (const d of deltas) applyDelta(m, d);
    this.dirty = true;
  }

  /**
   * Old mail arrived (initial sync, backfill). Featurizing it for the
   * background inside every import slice would cost a tenth of ingestion
   * throughput, so the background catches up in one sliced rebuild once
   * the import settles.
   */
  noteBackfill(n: number): void {
    if (n === 0 || !this.current) return;
    this.backfilled += n;
    if (this.backfilled < Math.max(BACKFILL_MIN, this.current.backgroundSize * 0.05)) return;
    if (this.backfillTimer) clearTimeout(this.backfillTimer);
    this.backfillTimer = setTimeout(() => {
      this.backfillTimer = null;
      if (!this.host.store.isOpen) return;
      this.backfilled = 0;
      void this.rebuild();
    }, BACKFILL_SETTLE_MS);
    this.backfillTimer.unref?.();
  }

  stop(): void {
    if (this.backfillTimer) clearTimeout(this.backfillTimer);
  }

  dropCategory(categoryId: number): void {
    this.current?.dropCategory(categoryId);
    this.dirty = true;
  }

  /** Rebuild in one go, without yielding (seeding, tests). */
  async rebuildNow(): Promise<CategorizerModel> {
    const store = this.host.store;
    while ((await store.categorize.backfillExamples(2000)) > 0);
    const now = this.host.now();
    const m = new CategorizerModel({ decayRef: now });
    for (const ex of await store.categorize.examples()) m.train(ex);
    for (const [id, set] of await store.categorize.threadFeatures(await store.categorize.backgroundCandidates(now))) m.addBackground(id, set.encoded);
    this.current = m;
    this.dirty = true;
    return m;
  }

  /**
   * Rebuild in slices (decay, fresh background). Writes keep landing on the
   * current model meanwhile and are replayed onto the new one before it is
   * swapped in, so nothing committed during the scan is lost.
   */
  rebuild(): Promise<void> {
    if (this.rebuilding) return this.rebuilding;
    const run = (async () => {
      const store = this.host.store;
      try {
        for (;;) {
          const n = await store.categorize.backfillExamples(500);
          if (n === 0) break;
          await this.host.platform.yield();
          await store.settle?.();
        }
        this.pending = [];
        this.readTo = null;
        let cursor: ExampleKey | null = null;
        const now = this.host.now();
        const m = new CategorizerModel({ decayRef: now });
        // the training set in key order, a bounded slice at a time
        for (;;) {
          const started = performance.now();
          let page: Awaited<ReturnType<MailStore["categorize"]["examplesPage"]>> = [];
          do {
            page = await store.categorize.examplesPage(cursor, 250);
            for (const { example } of page) m.train(example);
            if (page.length) this.readTo = cursor = page[page.length - 1]!.key;
          } while (page.length === 250 && performance.now() - started < SLICE_MS);
          if (page.length < 250) break;
          await this.host.platform.yield();
        }
        this.readTo = "all";
        await this.host.runSliced(await store.categorize.backgroundCandidates(now), 100, async (chunk) => {
          for (const [id, set] of await store.categorize.threadFeatures(chunk)) m.addBackground(id, set.encoded);
        });
        // a write to a row the scan had not reached yet is already in the pages it read later
        for (const { delta, readTo } of this.pending) if (scanned(delta, readTo)) applyDelta(m, delta);
        this.current = m;
        this.dirty = true;
        this.pending = null;
        await this.suggestBackfill(m);
      } catch (error) {
        if (store.isOpen) this.host.log("warn", "categorizer rebuild failed", error instanceof Error ? error.message : error);
      } finally {
        this.pending = null;
        this.readTo = null;
        this.rebuilding = null;
      }
    })();
    this.rebuilding = run;
    return run;
  }

  /** Old inbox mail that arrived as backfill gets its (never automatic) suggestions here, in slices. */
  private async suggestBackfill(m: CategorizerModel): Promise<void> {
    const store = this.host.store;
    const ids = await store.categorize.backfillCandidates(this.host.now());
    await this.host.runSliced(ids, 50, async (chunk) => {
      if (this.current !== m || !store.isOpen) return;
      const r = await store.categorize.suggestBackfill({ threadIds: chunk, now: this.host.now(), mode: await readAutoCategorize(store), model: m });
      if (r.touched.length) this.host.notifyChanged(r.touched, false);
    });
  }

  async persist(): Promise<void> {
    const m = this.current;
    if (!m || !this.dirty || this.rebuilding) return;
    this.dirty = false;
    try {
      await this.host.store.categorize.saveSnapshot({ featuresV: FEATURES_V, builtAt: m.decayRef, blob: m.serialize() });
    } catch (error) {
      this.dirty = true;
      throw error;
    }
  }

  /** Background upkeep: mature auto decisions, refresh decay weekly, persist. */
  async idle(): Promise<void> {
    await this.host.store.categorize.matureDecisions(this.host.now());
    const m = this.current;
    if (!m || this.host.now() - m.decayRef > REBUILD_EVERY_MS) await this.rebuild();
    await this.persist();
  }
}
