/** A fixed-size ring: push is O(1) with no allocation once full; toArray is oldest first. */
export class Ring<T> {
  private readonly items: (T | undefined)[];
  private next = 0;
  private filled = false;
  /** pushes since creation (a mirror sends only what changed) */
  pushed = 0;

  constructor(readonly capacity: number) {
    this.items = Array.from<T | undefined>({ length: capacity });
  }

  push(item: T): void {
    this.items[this.next] = item;
    this.next = (this.next + 1) % this.capacity;
    if (this.next === 0) this.filled = true;
    this.pushed++;
  }

  get size(): number {
    return this.filled ? this.capacity : this.next;
  }

  toArray(): T[] {
    const out: T[] = [];
    const start = this.filled ? this.next : 0;
    for (let i = 0; i < this.size; i++) out.push(this.items[(start + i) % this.capacity] as T);
    return out;
  }

  clear(): void {
    this.items.fill(undefined);
    this.next = 0;
    this.filled = false;
  }
}
