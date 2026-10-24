/**
 * Time-budgeted slices for bulk work: each slice is sized from how long the
 * previous ones actually took, so a busy machine (slow fsync, CPU
 * contention) gets smaller slices instead of longer stalls. The per-item
 * cost estimate takes a slower sample at once and forgets it slowly (items
 * vary: one thread can cost ten times another), a slice that overran at least
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

export class SliceSizer {
  private perItem: number | null = null;
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
    const rate = ms / n;
    this.perItem = this.perItem === null || rate > this.perItem ? rate : this.perItem * 0.9 + rate * 0.1;
    const ideal = this.budget.targetMs / Math.max(this.perItem, 1e-4);
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
