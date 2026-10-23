import type { Platform } from "../platform";
import { RevisionError, sameRevision, type Revision, type SearchFeed } from "../search";
import { InstantSearchEngine, type PhraseSource } from "./engine";

const MiB = 1024 * 1024;

/** Plans 03/04: desktop caps the index at 192 MiB steady, 256 MiB while building, compacting or snapshotting. */
export const DESKTOP_SEARCH_MEMORY = { steadyBytes: 192 * MiB, peakBytes: 256 * MiB };

export interface InstantSearchOptions {
  feed: SearchFeed;
  platform: Pick<Platform, "yield" | "files">;
  /** where the snapshot lives; null: none (in-memory databases) */
  snapshotPath: string | null;
  /** what a snapshot must have been written for (schema version, store kind) */
  identity: string;
  /** the exact phrase doclist (FTS5) for frequent words that are rarely adjacent */
  phrases?: PhraseSource;
  memory?: { steadyBytes: number; peakBytes: number };
  /** budget of one background slice */
  sliceMs?: number;
  /** quiet time after a commit before catching up, so a burst of writes applies together */
  settleMs?: number;
  /** the longest catching up waits for writes to settle (an import runs at full speed; FTS5 answers meanwhile) */
  maxLagMs?: number;
  /** a snapshot is written after this many applied changes, or this long after the first unsaved one */
  snapshotEvery?: { changes: number; ms: number };
  now?: () => number;
  log?: (level: "info" | "warn" | "error", message: string, extra?: unknown) => void;
}

export interface InstantSearchReport {
  state: "starting" | "restoring" | "building" | "catching-up" | "ready" | "disabled" | "closed";
  revision: Revision | null;
  allocatedBytes: number;
  build?: { ms: number; messages: number; threads: number; replayed: number };
  restore?: { ms: number; bytes: number };
  snapshot?: { ms: number; bytes: number; at: number };
  compactions: number;
  rebuilds: number;
  disabled?: string;
}

/**
 * Keeps an InstantSearchEngine current with the store's search feed, off the
 * interactive path: restores the snapshot or builds from a retained lease in
 * time-sliced chunks, replays committed batches after commit (a gap, another
 * epoch or a revision ahead of the head means rebuild), compacts, writes
 * snapshots atomically and gives up under memory pressure. The store asks
 * at(R) on every search and answers from FTS5 whenever the engine isn't
 * exactly at R.
 */
export class InstantSearch {
  private engine: InstantSearchEngine | null = null;
  private loop: Promise<void> | null = null;
  private stopped = false;
  private wakeUp: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending = false;
  private settling = false;
  private resting = false;
  private dirtyAt = 0;
  private firstDirtyAt = 0;
  private unsaved = 0;
  private unsavedSince = 0;
  private noCompaction = false;
  private retrySnapshotAt = 0;
  private failures = 0;
  private readonly memory: { steadyBytes: number; peakBytes: number };
  private readonly now: () => number;
  readonly report: InstantSearchReport = { state: "starting", revision: null, allocatedBytes: 0, compactions: 0, rebuilds: 0 };

  constructor(private readonly o: InstantSearchOptions) {
    this.memory = o.memory ?? DESKTOP_SEARCH_MEMORY;
    this.now = o.now ?? (() => Date.now());
  }

  /** Starts the background work (restore or build, then catch-up). */
  start(): void {
    // never inside the caller's own unit of work
    this.loop ??= this.o.platform.yield().then(() => this.run());
  }

  /** The engine, when it can answer exactly at `at`. */
  at(at: Revision): InstantSearchEngine | null {
    const e = this.engine;
    return e && e.currentAt(at) ? e : null;
  }

  /** A write committed: catch up once writes settle. */
  notify(): void {
    if (this.stopped) return;
    const now = this.now();
    this.pending = true;
    this.dirtyAt = now;
    if (!this.firstDirtyAt) this.firstDirtyAt = now;
    // a loop waiting for writes to settle looks again when its timer fires
    if (!this.settling) this.wake();
  }

  /** Tests and perf gates: resolves true once the engine is current at the feed's head, false if it gave up. */
  async settled(timeoutMs = 120_000): Promise<boolean> {
    const deadline = this.now() + timeoutMs;
    for (;;) {
      if (this.report.state === "disabled" || this.report.state === "closed") return false;
      const head = await this.o.feed.head();
      if (this.at(head)) return true;
      if (this.now() > deadline) throw new Error(`instant search didn't settle (${this.report.state})`);
      // a sleeping loop looks at the head again (one waiting for writes to settle keeps waiting)
      if (!this.settling) this.wake();
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  /** Perf gates: resolves once nothing is left to do (current, no writes pending, nothing to compact or save). */
  async idle(timeoutMs = 120_000): Promise<void> {
    const deadline = this.now() + timeoutMs;
    while (!(this.resting && !this.pending) && this.report.state !== "disabled" && this.report.state !== "closed") {
      if (this.now() > deadline) throw new Error(`instant search didn't come to rest (${this.report.state})`);
      if (!this.pending && !this.settling) this.wake();
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  /** Stops background work and persists what changed since the last snapshot. */
  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.wake();
    await this.loop;
    try {
      if (this.engine && this.unsaved > 0 && this.engine.status().state === "ready") await this.persist();
    } catch (error) {
      this.o.log?.("warn", "could not write the search snapshot", error instanceof Error ? error.message : error);
    }
    this.engine = null;
    this.update("closed");
  }

  private update(state: InstantSearchReport["state"]): void {
    if (this.report.state === "disabled" && state !== "closed") return;
    this.report.state = state;
    this.report.revision = this.engine?.revision ?? null;
    this.report.allocatedBytes = this.engine?.allocatedBytes() ?? 0;
  }

  private wake(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const w = this.wakeUp;
    this.wakeUp = null;
    w?.();
  }

  private sleep(ms: number | null): Promise<void> {
    return new Promise((resolve) => {
      this.wakeUp = resolve;
      if (ms !== null) this.timer = setTimeout(() => this.wake(), Math.max(0, ms));
    });
  }

  private engineOptions() {
    return { yield: () => this.o.platform.yield(), sliceMs: this.o.sliceMs ?? 4, phrases: this.o.phrases, identity: this.o.identity };
  }

  private disable(reason: string): void {
    this.engine?.disable();
    this.engine = null;
    this.report.disabled = reason;
    this.update("disabled");
    this.report.state = "disabled";
    this.o.log?.("warn", `instant search disabled, searches use FTS5: ${reason}`);
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      try {
        if (!this.engine) {
          const e = (await this.restore()) ?? (await this.build());
          if (this.stopped || !e) return;
          if (!this.withinCaps(e, this.memory.steadyBytes)) return;
          this.engine = e;
          this.update("ready");
          continue;
        }
        const e = this.engine;
        // writes are still arriving (an import): FTS5 answers until they settle
        if (this.pending && (await this.settle())) continue;
        if (await this.catchUp(e)) {
          if (!this.withinCaps(e, this.memory.steadyBytes)) return;
          this.update("ready");
          continue;
        }
        this.failures = 0;
        if (e.needsCompaction() && !this.noCompaction) {
          await this.compact(e);
          continue;
        }
        if (this.snapshotDue()) {
          try {
            await this.persist();
          } catch (error) {
            // a cache that can't be written (disk full, permissions) is retried later; the index stays
            this.retrySnapshotAt = this.now() + this.snapshotEvery().ms;
            this.o.log?.("warn", "could not write the search snapshot", error instanceof Error ? error.message : error);
          }
          continue;
        }
        // a commit that arrived while this pass awaited (after it read the head) must not wait for the next one
        if (this.pending) continue;
        // a deadline only where a snapshot can be written: otherwise an overdue one would poll forever
        const until = this.unsaved > 0 && this.canSnapshot() ? Math.max(this.unsavedSince + this.snapshotEvery().ms, this.retrySnapshotAt) - this.now() : null;
        this.resting = true;
        await this.sleep(until);
        this.resting = false;
      } catch (error) {
        if (this.stopped) return;
        this.engine?.disable();
        this.engine = null;
        this.report.rebuilds++;
        const message = error instanceof Error ? error.message : String(error);
        if (++this.failures > 3) return this.disable(`failed repeatedly: ${message}`);
        this.o.log?.(error instanceof RevisionError ? "info" : "warn", `instant search rebuilds: ${message}`);
      }
    }
  }

  /** Sleeps toward the moment writes have been quiet for settleMs (or lagged maxLagMs); false once it has come. */
  private async settle(): Promise<boolean> {
    const due = Math.min(this.dirtyAt + (this.o.settleMs ?? 25), this.firstDirtyAt + (this.o.maxLagMs ?? 5000));
    const wait = due - this.now();
    if (wait > 0) {
      this.settling = true;
      await this.sleep(wait);
      this.settling = false;
      return true;
    }
    this.pending = false;
    this.firstDirtyAt = 0;
    return false;
  }

  /** Applies committed batches up to the head; true if it applied anything. */
  private async catchUp(e: InstantSearchEngine): Promise<boolean> {
    const head = await this.o.feed.head();
    const at = e.revision!;
    if (sameRevision(at, head)) return false;
    this.update(this.engine === e ? "catching-up" : this.report.state);
    const batches = await this.o.feed.changes(at, head, 16);
    if (batches.length === 0 && head.epoch === at.epoch && head.seq > at.seq) throw new RevisionError("gap", "the feed served nothing");
    for (const b of batches) {
      if (this.stopped) return true;
      await e.apply(b);
      if (b.changes.length && !this.unsaved) this.unsavedSince = this.now();
      this.unsaved += b.changes.length;
    }
    await this.o.platform.yield();
    return true;
  }

  private withinCaps(e: InstantSearchEngine, cap: number): boolean {
    const bytes = e.allocatedBytes();
    if (bytes <= cap) return true;
    this.disable(`the index needs ${(bytes / MiB).toFixed(0)} MiB, over its ${(cap / MiB).toFixed(0)} MiB cap`);
    return false;
  }

  private async restore(): Promise<InstantSearchEngine | null> {
    const { snapshotPath: path, platform } = this.o;
    if (!path || !platform.files) return null;
    this.update("restoring");
    const started = this.now();
    let bytes: Uint8Array | null;
    try {
      bytes = await platform.files.read(path);
    } catch (error) {
      this.o.log?.("warn", "could not read the search snapshot", error instanceof Error ? error.message : error);
      return null;
    }
    if (!bytes) return null;
    const e = new InstantSearchEngine(this.engineOptions());
    if (bytes.length > this.memory.peakBytes || !(await e.restore(bytes, true))) {
      this.o.log?.("info", "the search snapshot is damaged or from another version: rebuilding");
      return null;
    }
    const head = await this.o.feed.head();
    const at = e.revision!;
    if (at.epoch !== head.epoch || at.seq > head.seq) {
      this.o.log?.("info", "the search snapshot belongs to another database state: rebuilding");
      return null;
    }
    this.report.restore = { ms: this.now() - started, bytes: bytes.length };
    bytes = null;
    try {
      // usable only once it reaches the head
      while (await this.catchUp(e)) if (this.stopped) return null;
    } catch (error) {
      if (!(error instanceof RevisionError)) throw error;
      this.o.log?.("info", `the search log no longer reaches the snapshot (${error.reason}): rebuilding`);
      return null;
    }
    return e;
  }

  private async build(): Promise<InstantSearchEngine | null> {
    this.update("building");
    const started = this.now();
    const lease = await this.o.feed.beginBuild();
    try {
      const e = new InstantSearchEngine(this.engineOptions());
      e.beginBuild(lease.from);
      let messages = 0;
      let threads = 0;
      for await (const page of lease.messages()) {
        if (this.stopped) return null;
        // reading the page was a slice of its own
        await this.o.platform.yield();
        await e.loadMessages(page);
        messages += page.length;
        if (!this.withinCaps(e, this.memory.peakBytes)) return null;
        await this.o.platform.yield();
      }
      for await (const page of lease.threads()) {
        if (this.stopped) return null;
        e.loadThreads(page);
        threads += page.length;
        await this.o.platform.yield();
      }
      await e.finishBuild();
      // rows written during the scan are repaired by replaying (from, head]
      const from = lease.from.seq;
      while (await this.catchUp(e)) if (this.stopped) return null;
      this.report.build = { ms: this.now() - started, messages, threads, replayed: e.revision!.seq - from };
      // the next start restores instead of building
      this.unsaved = Math.max(this.unsaved, this.snapshotEvery().changes);
      this.unsavedSince = this.now();
      return e;
    } finally {
      await lease.release();
    }
  }

  private async compact(e: InstantSearchEngine): Promise<void> {
    // the copy is at most as large as the original
    if (e.allocatedBytes() * 2 > this.memory.peakBytes) {
      this.noCompaction = true;
      this.o.log?.("info", "instant search: no room to compact under the peak cap");
      return;
    }
    // e keeps answering at its revision meanwhile; nothing applies to it until the swap
    const next = await e.compacted();
    if (this.stopped) return;
    this.engine = next;
    e.disable();
    this.report.compactions++;
    this.update("ready");
  }

  private snapshotEvery(): { changes: number; ms: number } {
    return this.o.snapshotEvery ?? { changes: 5000, ms: 5 * 60_000 };
  }

  private canSnapshot(): boolean {
    return !!this.o.snapshotPath && !!this.o.platform.files;
  }

  private snapshotDue(): boolean {
    if (!this.canSnapshot() || this.unsaved === 0 || this.now() < this.retrySnapshotAt) return false;
    const every = this.snapshotEvery();
    return this.unsaved >= every.changes || this.now() - this.unsavedSince >= every.ms;
  }

  private async persist(): Promise<void> {
    const e = this.engine;
    const files = this.o.platform.files;
    if (!e || !files || !this.o.snapshotPath) return;
    // the buffer is a copy of about what the index holds
    if (e.allocatedBytes() * 2 > this.memory.peakBytes) {
      this.unsaved = 0;
      this.o.log?.("info", "instant search: no room for a snapshot under the peak cap");
      return;
    }
    const started = this.now();
    const unsaved = this.unsaved;
    const bytes = await e.snapshot();
    await files.replace(this.o.snapshotPath, bytes);
    this.unsaved = Math.max(0, this.unsaved - unsaved);
    this.unsavedSince = this.now();
    this.report.snapshot = { ms: this.now() - started, bytes: bytes.length, at: this.now() };
  }
}
