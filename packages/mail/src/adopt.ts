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
  /**
   * each envelope's candidates as sorted runs, each with how many were taken (a head offset: never a shift of the
   * rest, Codex R5): one run per add, its ids ascending, so candidates added later never move the ones waiting
   * (Codex R13, R14: neither a splice each nor a merge of the whole bucket); a take is the oldest of the runs' heads
   */
  private readonly byKey = new Map<string, Run[]>();
  readonly ids = new Set<number>();
  /** taken or found by their own key this pass: never candidates again, even if a reset lists them later (Codex R13) */
  private readonly claimed = new Set<number>();

  constructor(rows: readonly Envelope[] = []) {
    const runs = new Map<Run[], Run>();
    for (const r of [...rows].sort((a, b) => a.id - b.id)) this.insert(r, runs);
  }

  /**
   * These messages' envelopes added, a slice at a time with the event loop free between slices (Codex R12: 50,000
   * candidates read and indexed in one go stalled it): ids ascending, so each run stays oldest first.
   */
  async add(ids: Iterable<number>, envelopes: (ids: number[]) => Promise<readonly Envelope[]>, slice = 1000): Promise<void> {
    // a typed array's sort (no Set: a repeated id is skipped as the slices are cut)
    const sorted = Float64Array.from(ids).sort();
    const runs = new Map<Run[], Run>();
    for (let i = 0; i < sorted.length; i += slice) {
      if (i > 0) await new Promise((resolve) => setTimeout(resolve, 0));
      const chunk: number[] = [];
      for (let j = i; j < Math.min(i + slice, sorted.length); j++) if (j === 0 || sorted[j] !== sorted[j - 1]) chunk.push(sorted[j]!);
      const rows = [...(await envelopes(chunk))].sort((a, b) => a.id - b.id);
      for (const r of rows) this.insert(r, runs);
    }
  }

  /** a candidate onto this add's run of its envelope (each envelope's candidates are taken oldest first: a reset re-binds them in the order they were stored) */
  private insert(r: Envelope, runs: Map<Run[], Run>): void {
    if (this.ids.has(r.id) || this.claimed.has(r.id)) return;
    this.ids.add(r.id);
    const key = keyOf(r);
    let bucket = this.byKey.get(key);
    if (!bucket) this.byKey.set(key, (bucket = []));
    let run = runs.get(bucket);
    if (!run) {
      // the bucket's last run, if everything in it is older, goes on; else a new run
      const last = bucket.at(-1);
      run = last && last.ids.at(-1)! < r.id ? last : { ids: [], head: 0 };
      if (run !== last) bucket.push(run);
      runs.set(bucket, run);
    }
    run.ids.push(r.id);
  }

  get size(): number {
    return this.ids.size;
  }

  /** The first candidate with this envelope that `usable` accepts (not already in the folder), taken out of the index. */
  async take(e: Omit<Envelope, "id">, usable: (id: number) => Promise<boolean>): Promise<number | null> {
    const bucket = this.byKey.get(keyOf(e));
    while (bucket?.length) {
      let at = 0;
      for (let i = 1; i < bucket.length; i++) if (bucket[i]!.ids[bucket[i]!.head]! < bucket[at]!.ids[bucket[at]!.head]!) at = i;
      const run = bucket[at]!;
      const id = run.ids[run.head++]!;
      if (run.head === run.ids.length) bucket.splice(at, 1);
      if (!this.ids.delete(id)) continue;
      if (await usable(id)) {
        this.claimed.add(id);
        return id;
      }
    }
    return null;
  }

  /** A message found by its own key elsewhere in the pass: no longer a candidate. */
  drop(id: number): void {
    this.ids.delete(id);
    this.claimed.add(id);
  }
}

interface Run {
  ids: number[];
  head: number;
}
