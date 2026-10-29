/** A stored message's envelope, as a renamed folder's copy of it is recognised (plan 65). */
export interface Envelope {
  id: number;
  subject: string;
  fromEmail: string;
  date: number;
  size: number;
  rfcMessageId: string | null;
}

const keyOf = (e: Omit<Envelope, "id">) => `${e.rfcMessageId ?? ""}\u0000${e.subject}\u0000${e.fromEmail}\u0000${e.date}\u0000${e.size}`;

/**
 * Plan 65 (Codex R4): the messages of folders that vanished this pass (a rename), by envelope, built once and
 * consumed as their copies are found under the new name, so recovery is linear in the folder, never a scan of
 * every candidate per message.
 */
export class AdoptIndex {
  /** each envelope's candidates and how many were taken (a head offset: never a shift of the rest, Codex R5) */
  private readonly byKey = new Map<string, { ids: number[]; head: number }>();
  readonly ids = new Set<number>();

  constructor(rows: readonly Envelope[] = []) {
    for (const r of [...rows].sort((a, b) => a.id - b.id)) this.insert(r);
  }

  /**
   * These messages' envelopes added, a slice at a time with the event loop free between slices (Codex R12: 50,000
   * candidates read and indexed in one go stalled it): ids ascending, so each bucket stays oldest first.
   */
  async add(ids: Iterable<number>, envelopes: (ids: number[]) => Promise<readonly Envelope[]>, slice = 1000): Promise<void> {
    const sorted = Float64Array.from(new Set(ids)).sort();
    for (let i = 0; i < sorted.length; i += slice) {
      if (i > 0) await new Promise((resolve) => setTimeout(resolve, 0));
      const rows = [...(await envelopes([...sorted.subarray(i, i + slice)]))].sort((a, b) => a.id - b.id);
      for (const r of rows) this.insert(r);
    }
  }

  /** each envelope's candidates oldest first (a reset re-binds them in the order they were stored) */
  private insert(r: Envelope): void {
    if (this.ids.has(r.id)) return;
    this.ids.add(r.id);
    const key = keyOf(r);
    const bucket = this.byKey.get(key);
    if (!bucket) {
      this.byKey.set(key, { ids: [r.id], head: 0 });
      return;
    }
    // added later (a reset found mid-pass) and older than candidates still waiting: put in its place among them
    let at = bucket.ids.length;
    while (at > bucket.head && bucket.ids[at - 1]! > r.id) at--;
    bucket.ids.splice(at, 0, r.id);
  }

  get size(): number {
    return this.ids.size;
  }

  /** The first candidate with this envelope that `usable` accepts (not already in the folder), taken out of the index. */
  async take(e: Omit<Envelope, "id">, usable: (id: number) => Promise<boolean>): Promise<number | null> {
    const bucket = this.byKey.get(keyOf(e));
    while (bucket && bucket.head < bucket.ids.length) {
      const id = bucket.ids[bucket.head++]!;
      if (!this.ids.delete(id)) continue;
      if (await usable(id)) return id;
    }
    return null;
  }

  /** A message found by its own key elsewhere in the pass: no longer a candidate. */
  drop(id: number): void {
    this.ids.delete(id);
  }
}
