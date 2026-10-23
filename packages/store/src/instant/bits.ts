/** Dense bitsets over doc or thread slots, as Uint32Array words. */

export function words(bits: number): number {
  return (bits + 31) >>> 5;
}

export function has(set: Uint32Array, i: number): boolean {
  return ((set[i >>> 5]! >>> (i & 31)) & 1) !== 0;
}

export function setBit(set: Uint32Array, i: number): void {
  set[i >>> 5]! |= 1 << (i & 31);
}

export function clearBit(set: Uint32Array, i: number): void {
  set[i >>> 5]! &= ~(1 << (i & 31));
}

/** a &= b (b may be shorter: missing words are empty) */
export function andInto(a: Uint32Array, b: Uint32Array): Uint32Array {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) a[i]! &= b[i]!;
  a.fill(0, n);
  return a;
}

/** a &= ~b */
export function andNotInto(a: Uint32Array, b: Uint32Array): Uint32Array {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) a[i]! &= ~b[i]!;
  return a;
}

/** a |= b */
export function orInto(a: Uint32Array, b: Uint32Array): Uint32Array {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) a[i]! |= b[i]!;
  return a;
}

/** a copy with `length` words (truncated or zero-extended) */
export function copyWords(a: Uint32Array, length = a.length): Uint32Array {
  const out = new Uint32Array(length);
  out.set(a.length > length ? a.subarray(0, length) : a);
  return out;
}

export function popcount(set: Uint32Array): number {
  let c = 0;
  for (let i = 0; i < set.length; i++) {
    let v = set[i]!;
    if (v === 0) continue;
    v -= (v >>> 1) & 0x55555555;
    v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
    c += (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  }
  return c;
}

/** Calls fn for every set bit in ascending order; fn returning true stops the scan. */
export function scanBits(set: Uint32Array, fn: (i: number) => boolean | void): void {
  for (let w = 0; w < set.length; w++) {
    let word = set[w]!;
    while (word !== 0) {
      const low = word & -word;
      const i = (w << 5) | (31 - Math.clz32(low));
      word ^= low;
      if (fn(i) === true) return;
    }
  }
}
