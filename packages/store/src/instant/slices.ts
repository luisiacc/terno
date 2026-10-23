/**
 * Cooperative time slicing for long index work (build, replay, compaction,
 * snapshots): callers tick() as they go and the clock yields to the event
 * loop once a slice has used its budget, so interactive work interleaves.
 */
export interface SliceOptions {
  /** a macrotask yield (setImmediate on Node); without it work runs to completion */
  yield?: () => Promise<void>;
  /** budget of one slice */
  sliceMs?: number;
  now?: () => number;
}

export class SliceClock {
  private started: number;
  private readonly yieldTo: (() => Promise<void>) | undefined;
  private readonly sliceMs: number;
  private readonly now: () => number;
  /** the longest stretch between yields so far (stall accounting) */
  longestMs = 0;

  constructor(o: SliceOptions) {
    this.yieldTo = o.yield;
    this.sliceMs = o.sliceMs ?? 6;
    this.now = o.now ?? (() => performance.now());
    this.started = this.now();
  }

  /** true when the current slice is used up */
  get due(): boolean {
    return this.yieldTo !== undefined && this.now() - this.started >= this.sliceMs;
  }

  /** yields if the slice is used up */
  async tick(): Promise<void> {
    if (this.due) await this.pause();
  }

  async pause(): Promise<void> {
    const ran = this.now() - this.started;
    if (ran > this.longestMs) this.longestMs = ran;
    if (this.yieldTo) await this.yieldTo();
    this.started = this.now();
  }
}

/**
 * Stable bottom-up merge sort of `items` by `before`, in slices. Array.sort
 * can't yield, and sorting a large vocabulary or thread order at once would
 * stall the event loop.
 */
export async function sortSliced(items: Int32Array<ArrayBuffer>, before: (a: number, b: number) => boolean, clock: SliceClock): Promise<Int32Array<ArrayBuffer>> {
  const n = items.length;
  let src = items;
  let dst = new Int32Array(n);
  // runs of 32 by insertion sort
  const RUN = 32;
  for (let lo = 0; lo < n; lo += RUN) {
    const hi = Math.min(n, lo + RUN);
    for (let i = lo + 1; i < hi; i++) {
      const x = src[i]!;
      let j = i - 1;
      while (j >= lo && before(x, src[j]!)) {
        src[j + 1] = src[j]!;
        j--;
      }
      src[j + 1] = x;
    }
    if ((lo & 4095) === 0) await clock.tick();
  }
  for (let width = RUN; width < n; width *= 2) {
    for (let lo = 0; lo < n; lo += 2 * width) {
      const mid = Math.min(n, lo + width);
      const hi = Math.min(n, lo + 2 * width);
      let i = lo;
      let j = mid;
      let k = lo;
      while (i < mid && j < hi) dst[k++] = before(src[j]!, src[i]!) ? src[j++]! : src[i++]!;
      while (i < mid) dst[k++] = src[i++]!;
      while (j < hi) dst[k++] = src[j++]!;
      if (clock.due) await clock.pause();
    }
    const t = src;
    src = dst;
    dst = t;
  }
  return src;
}
