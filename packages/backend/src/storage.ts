import { removable, storageCutoff, StorageTally, type RemovableBucket, type StorageReport } from "@terno/core";
import { RpcError } from "@terno/core/rpc";
import { L } from "@terno/i18n";
import type { IncomingMessage } from "@terno/store";
import { BULK_SLICE, SliceSizer } from "./slicer";
import { progressReporter } from "./scope";
import type { BackendCore } from "./core";

/** Report reads: whole conversations a slice, sized by time (one of 50k messages is one indexed aggregate). */
const READ_SLICE = { ...BULK_SLICE, initial: 100, ceiling: 5000 };
/** Removal units, in messages (plan 69, Codex R5: never a whole large conversation in one unit). */
const REMOVE_SLICE = { ...BULK_SLICE, initial: 20, ceiling: 2000 };
/** Compaction units, in pages. */
const COMPACT_SLICE = { ...BULK_SLICE, initial: 64, ceiling: 8192 };

/**
 * Provider ids a removal took off this device, per account, until that account finishes a sync pass that started
 * after the removal ended: a pass that fetched one of them before it went must not put it back (Codex R1). Mail
 * that changes on the server later (moved in another app) downloads again, as it should. Bounded by what was
 * removed, and gone after the next pass.
 */
export class Evictions {
  private seq = 0;
  /** passes started at or below this ran while a removal did (null: none ran yet) */
  private endSeq = 0;
  private running = false;
  private readonly ids = new Map<number, Set<string>>();
  /**
   * A removal unit and a sync pass's ingest never overlap (Codex code review #4: an ingest stages attachments, and
   * yields, before its transaction): each waits for the other's in flight, and an ingest leaves out what was removed
   * as it enters.
   */
  private current: Promise<unknown> | null = null;
  private readonly writes = new Set<Promise<unknown>>();

  /** a sync pass starts: its number */
  pass(): number {
    return ++this.seq;
  }

  begin(): void {
    this.running = true;
  }

  record(removed: readonly { accountId: number; providerMsgIds: readonly string[] }[]): void {
    for (const r of removed) {
      let set = this.ids.get(r.accountId);
      if (!set) this.ids.set(r.accountId, (set = new Set()));
      for (const id of r.providerMsgIds) set.add(id);
    }
  }

  /** one removal unit, which records what it removed before it resolves */
  async unit<T>(fn: () => Promise<T>): Promise<T> {
    while (this.current || this.writes.size) await Promise.allSettled([this.current, ...this.writes]);
    const p = fn();
    this.current = p;
    try {
      return await p;
    } finally {
      if (this.current === p) this.current = null;
    }
  }

  /** a sync pass's slice: once no unit is in flight, what was removed is left out and `write` runs with it */
  async ingest<T>(accountId: number, pass: number, messages: IncomingMessage[], write: (admitted: IncomingMessage[]) => Promise<T>): Promise<T> {
    while (this.current) await this.current.catch(() => {});
    const p = write(this.admit(accountId, pass, messages));
    this.writes.add(p);
    try {
      return await p;
    } finally {
      this.writes.delete(p);
    }
  }

  end(): void {
    this.running = false;
    this.endSeq = this.seq;
  }

  /** what a pass may ingest: a pass that overlapped a removal drops what it removed */
  admit(accountId: number, pass: number, messages: IncomingMessage[]): IncomingMessage[] {
    const set = this.ids.get(accountId);
    if (!set || (!this.running && pass > this.endSeq)) return messages;
    return messages.filter((m) => !m.providerMsgId || !set.has(m.providerMsgId));
  }

  /** a pass finished: one that started after the removal ended means the account no longer needs its list */
  passDone(accountId: number, pass: number): void {
    if (!this.running && pass > this.endSeq) this.ids.delete(accountId);
  }

  get size(): number {
    let n = 0;
    for (const s of this.ids.values()) n += s.size;
    return n;
  }
}

async function timed<T>(sizer: SliceSizer, work: () => Promise<T>, count: (r: T) => number): Promise<T> {
  const started = performance.now();
  const r = await work();
  sizer.record(Math.max(1, count(r)), performance.now() - started);
  return r;
}

/** Every conversation once, in slices with a turn between them (Codex R5/R6: no slice past the budget). */
async function eachRow(b: BackendCore, visit: (rows: Awaited<ReturnType<BackendCore["store"]["storage"]["threads"]>>) => void): Promise<void> {
  const sizer = new SliceSizer(READ_SLICE);
  for (let after = 0; ; ) {
    const rows = await timed(sizer, () => b.store.storage.threads(after, sizer.size), (r) => r.length);
    if (!rows.length) return;
    visit(rows);
    after = rows.at(-1)!.id;
    await b.yieldTurn();
  }
}

export class StorageMaintenance {
  private reading: Promise<StorageReport> | null = null;
  private removing = false;

  constructor(private readonly b: BackendCore) {}

  /** One at a time: a second ask while one runs shares it (never across a removal's end). Nothing is kept once it is answered. */
  report(): Promise<StorageReport> {
    this.reading ??= this.read().finally(() => (this.reading = null));
    return this.reading;
  }

  private async read(): Promise<StorageReport> {
    const now = this.b.now();
    const tally = new StorageTally(now);
    await eachRow(this.b, (rows) => tally.add(rows));
    const storage = this.b.store.storage;
    return { disk: await storage.footprint(), compactPending: await storage.compactPending(), buckets: tally.result(), at: now };
  }

  async remove(p: { buckets: RemovableBucket[]; olderThanDays: number; jobId?: string }): Promise<{ threads: number; messages: number; compact: "done" | "onRestart" | "none" }> {
    if (this.removing) throw new RpcError("UNAVAILABLE", L("storage.busy"));
    this.removing = true;
    const { store } = this.b;
    const evictions = this.b.evictions;
    evictions.begin();
    try {
      const cutoff = storageCutoff(this.b.now(), p.olderThanDays);
      // resolved once; each unit re-checks what it removes (a star meanwhile stays)
      const targets: { id: number; messages: number }[] = [];
      await eachRow(this.b, (rows) => {
        for (const r of rows) if (removable(r, p.buckets, cutoff)) targets.push({ id: r.id, messages: r.messages });
      });
      const total = targets.reduce((n, t) => n + t.messages, 0);
      const progress = progressReporter(this.b, p.jobId, total);
      progress(0);
      const sizer = new SliceSizer(REMOVE_SLICE);
      let threads = 0;
      let messages = 0;
      /** conversations a unit began: they go on whatever view their rest is in now (Codex code review #5) */
      const continuing = new Set<number>();
      /** what the last unit left of the current pack */
      let left = 0;
      for (let i = 0; i < targets.length && !this.b.isStopped; ) {
        // conversations up to the unit's size in messages (at least one: a large one takes several units)
        const pack: number[] = [];
        for (let sum = 0, j = i; j < targets.length && (pack.length === 0 || sum + targets[j]!.messages <= sizer.size); j++) {
          pack.push(targets[j]!.id);
          sum += targets[j]!.messages;
        }
        // a large conversation goes in units of at least a fortieth of what is left of it: each unit recomputes what
        // remains, which can cost more than a slice, and units of one message would make that quadratic. This way the
        // whole is about forty recomputes of it (Codex code review #6)
        const maxMessages = Math.max(sizer.size, Math.ceil(left / 40));
        const r = await timed(
          sizer,
          () =>
            evictions.unit(async () => {
              const x = await store.storage.remove({ threadIds: pack, buckets: p.buckets, cutoff, maxMessages, continuing: pack.filter((id) => continuing.has(id)) });
              evictions.record(x.removed);
              return x;
            }),
          (x) => x.messages,
        );
        for (const t of r.partial) continuing.add(t);
        this.b.notifyChanged(r.touched);
        threads += r.threads;
        messages += r.messages;
        progress(Math.min(total, messages));
        // what is left of this pack (a large conversation) goes in the next unit; a pack nothing is left of is done
        if (!r.remaining || !r.messages) {
          i += pack.length;
          left = 0;
        } else left = r.remaining;
        await this.b.yieldTurn();
        await store.settle?.();
      }
      progress(total);
      // what only the removed mail pinned, a bounded unit at a time (Codex R3), then the pages it all took
      while (!this.b.isStopped && (await store.storage.collect(this.b.now()))) await this.b.yieldTurn();
      return { threads, messages, compact: messages ? await this.compact() : "none" };
    } finally {
      evictions.end();
      this.removing = false;
      // a report that began before this ended doesn't answer an ask made after it: the next one reads afresh
      this.reading = null;
    }
  }

  private async compact(): Promise<"done" | "onRestart" | "none"> {
    const sizer = new SliceSizer(COMPACT_SLICE);
    let gave = false;
    for (;;) {
      const r = await timed(sizer, () => this.b.store.storage.compact(sizer.size), () => sizer.size);
      if (r.onRestart) return "onRestart";
      if (!r.more) break;
      gave = true;
      await this.b.yieldTurn();
    }
    // the checkpoint gives the file's tail back (Codex R9)
    await this.b.store.settle?.();
    return gave || (await this.b.store.storage.footprint())?.free === 0 ? "done" : "none";
  }
}
