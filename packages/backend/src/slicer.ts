/**
 * Time-budgeted slices for bulk work: each slice is sized from how long the
 * previous ones actually took, so a busy machine (slow fsync, CPU
 * contention) gets smaller slices instead of longer stalls. A slice costs a
 * fixed part (a commit, a slow fsync) plus its items: the fixed part is read
 * off the line through the smallest and largest recent slices (never more
 * than the cheapest slice took), and the per-item cost is the
 * slowest of the last few slices once that is taken off (items vary: one
 * thread can cost ten times another, so a slow sample counts at once and is
 * forgotten only when it leaves the window). A slice that overran at least
 * halves the next and holds growth for a few slices, and growth is at most
 * ×1.25 (and at least +1) per slice, so quick slices can't buy a long one.
 * The floor guarantees progress; the ceiling keeps an idle machine's slices
 * bounded.
 */

export interface SliceBudget {
  /** what one slice should take */
  targetMs: number;
  /** the first slice, before anything was measured: a probe */
  initial: number;
  floor: number;
  ceiling: number;
}

/** Bulk paths (scope actions, moves and their undo, large filings): ~15 ms slices. */
export const BULK_SLICE: SliceBudget = { targetMs: 15, initial: 4, floor: 1, ceiling: 2000 };

/** Slices after an overrun during which the size doesn't grow. */
const HOLD_AFTER_OVERRUN = 4;
/** The per-item cost is the slowest of this many recent slices. */
const WINDOW = 8;

export class SliceSizer {
  private readonly samples: { n: number; ms: number }[] = [];
  private current: number;
  private hold = 0;

  constructor(private readonly budget: SliceBudget = BULK_SLICE) {
    this.current = this.clamp(budget.initial);
  }

  /** The size of the next slice. */
  get size(): number {
    return this.current;
  }

  /** A slice of `n` items took `ms`: sizes the next one. */
  record(n: number, ms: number): number {
    if (n <= 0) return this.current;
    this.samples.push({ n, ms });
    if (this.samples.length > WINDOW) this.samples.shift();
    const small = this.samples.reduce((a, x) => (x.n < a.n ? x : a));
    const large = this.samples.reduce((a, x) => (x.n > a.n ? x : a));
    const slope = large.n > small.n ? Math.max(0, (large.ms - small.ms) / (large.n - small.n)) : large.ms / large.n;
    // never more than the cheapest slice, nor most of the target: what is left is what items may take
    const fixed = Math.max(0, Math.min(small.ms - slope * small.n, ...this.samples.map((x) => x.ms), this.budget.targetMs * 0.6));
    const perItem = Math.max(...this.samples.map((x) => Math.max(0, x.ms - fixed) / x.n), 1e-4);
    const ideal = (this.budget.targetMs - fixed) / perItem;
    let next: number;
    if (ms > this.budget.targetMs) {
      next = Math.min(ideal, this.current / 2);
      this.hold = HOLD_AFTER_OVERRUN;
    } else if (this.hold > 0) {
      this.hold--;
      next = Math.min(ideal, this.current);
    } else {
      next = Math.min(ideal, Math.max(this.current + 1, this.current * 1.25));
    }
    this.current = this.clamp(Math.floor(next));
    return this.current;
  }

  private clamp(n: number): number {
    return Math.max(this.budget.floor, Math.min(this.budget.ceiling, Number.isFinite(n) ? n : this.budget.floor));
  }
}
