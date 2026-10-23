import { CategorizerModel, FEATURES_V } from "@unica/core";
import {
  backfillCandidates,
  backfillExamples,
  backgroundCandidates,
  examplesFingerprint,
  loadExamples,
  loadSnapshot,
  matureDecisions,
  ownAddresses,
  saveSnapshot,
  suggestBackfill,
  threadFeatures,
  type Db,
  type ModelDelta,
} from "@unica/db";
import { readAutoCategorize } from "./settings";

export interface CategorizerHost {
  readonly db: Db;
  now(): number;
  runSliced<T>(items: readonly T[], initialSize: number, work: (chunk: T[]) => void): Promise<void>;
  log(level: "info" | "warn" | "error", message: string, extra?: unknown): void;
  notifyChanged(threadIds: Iterable<number>, views?: boolean): void;
}

const DAY = 86_400_000;
/** decay is recomputed (and the background refreshed) at most this often */
const REBUILD_EVERY_MS = 7 * DAY;
const BACKFILL_MIN = 200;
/** quiet time after the last backfill slice before the background is rebuilt */
const BACKFILL_SETTLE_MS = 20_000;

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
  /** deltas committed while a rebuild was scanning; replayed onto the new model */
  private pending: ModelDelta[] | null = null;
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
  load(): boolean {
    const snap = loadSnapshot(this.host.db);
    if (!snap || snap.featuresV !== FEATURES_V || snap.fingerprint !== examplesFingerprint(this.host.db)) return false;
    const m = CategorizerModel.deserialize(snap.blob);
    if (!m) return false;
    this.current = m;
    return true;
  }

  apply(deltas: readonly ModelDelta[]): void {
    if (deltas.length === 0) return;
    if (this.host.db.inTransaction) throw new Error("model deltas must be applied after the transaction commits");
    this.pending?.push(...deltas);
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
      if (!this.host.db.raw.isOpen) return;
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

  /** Synchronous rebuild (seeding, tests). */
  rebuildSync(): CategorizerModel {
    const db = this.host.db;
    while (backfillExamples(db) > 0);
    const now = this.host.now();
    const m = new CategorizerModel({ decayRef: now });
    for (const ex of loadExamples(db)) m.train(ex);
    const own = ownAddresses(db);
    for (const [id, set] of threadFeatures(db, backgroundCandidates(db, now), own)) m.addBackground(id, set.encoded);
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
      const db = this.host.db;
      try {
        for (;;) {
          const n = backfillExamples(db, 500);
          if (n === 0) break;
          await new Promise((r) => setImmediate(r));
        }
        this.pending = [];
        const now = this.host.now();
        const m = new CategorizerModel({ decayRef: now });
        const examples = loadExamples(db);
        await this.host.runSliced(examples, 500, (chunk) => {
          for (const ex of chunk) m.train(ex);
        });
        const own = ownAddresses(db);
        await this.host.runSliced(backgroundCandidates(db, now), 100, (chunk) => {
          for (const [id, set] of threadFeatures(db, chunk, own)) m.addBackground(id, set.encoded);
        });
        for (const d of this.pending) applyDelta(m, d);
        this.current = m;
        this.dirty = true;
        this.pending = null;
        await this.suggestBackfill(m);
      } catch (error) {
        if (db.raw.isOpen) this.host.log("warn", "categorizer rebuild failed", error instanceof Error ? error.message : error);
      } finally {
        this.pending = null;
        this.rebuilding = null;
      }
    })();
    this.rebuilding = run;
    return run;
  }

  /** Old inbox mail that arrived as backfill gets its (never automatic) suggestions here, in slices. */
  private async suggestBackfill(m: CategorizerModel): Promise<void> {
    const db = this.host.db;
    const ids = backfillCandidates(db, this.host.now());
    await this.host.runSliced(ids, 50, (chunk) => {
      if (this.current !== m || !db.raw.isOpen) return;
      const r = suggestBackfill(db, { threadIds: chunk, now: this.host.now(), mode: readAutoCategorize(db), model: m });
      if (r.touched.size) this.host.notifyChanged(r.touched, false);
    });
  }

  persist(): void {
    const m = this.current;
    if (!m || !this.dirty || this.rebuilding) return;
    saveSnapshot(this.host.db, { featuresV: FEATURES_V, builtAt: m.decayRef, fingerprint: examplesFingerprint(this.host.db), blob: m.serialize() });
    this.dirty = false;
  }

  /** Background upkeep: mature auto decisions, refresh decay weekly, persist. */
  async idle(): Promise<void> {
    matureDecisions(this.host.db, this.host.now());
    const m = this.current;
    if (!m || this.host.now() - m.decayRef > REBUILD_EVERY_MS) await this.rebuild();
    this.persist();
  }
}
