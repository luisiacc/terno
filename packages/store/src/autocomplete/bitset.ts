/** A growable set of non-negative integers (message ids): 1 bit each, 37.5 KB for 300,000 ids. */
export class Bitset {
  private w = new Uint32Array(64);

  has(i: number): boolean {
    const k = i >>> 5;
    return k < this.w.length && (this.w[k]! & (1 << (i & 31))) !== 0;
  }

  set(i: number): void {
    const k = i >>> 5;
    if (k >= this.w.length) {
      const next = new Uint32Array(Math.max(k + 1, this.w.length * 2));
      next.set(this.w);
      this.w = next;
    }
    this.w[k]! |= 1 << (i & 31);
  }

  clear(i: number): void {
    const k = i >>> 5;
    if (k < this.w.length) this.w[k]! &= ~(1 << (i & 31));
  }

  get byteLength(): number {
    return this.w.byteLength;
  }

  /** the words, trimmed of trailing zeros (for a snapshot) */
  words(): Uint32Array {
    let end = this.w.length;
    while (end > 0 && this.w[end - 1] === 0) end--;
    return this.w.slice(0, end);
  }

  load(words: Uint32Array): void {
    this.w = new Uint32Array(Math.max(64, words.length));
    this.w.set(words);
  }

  reset(): void {
    this.w = new Uint32Array(64);
  }
}
