import { PINS_MAX, type Pin } from "@terno/core";
import type { PinsSnapshot } from "@terno/core/rpc";
import type { MailStore } from "@terno/store";

/**
 * Plan 179's pins, on the backend: the snapshot to the windows whenever it
 * changed (pinned, unpinned, put away, merged or gone with its conversation).
 * No timer: while nothing is pinned, nothing runs; while something is, a
 * change to mail looks again, at most once a second.
 */

/** after mail changed, at most one look a second (an ingest burst) */
const TOUCH_EVERY_MS = 1000;

export interface PinsHost {
  readonly store: MailStore;
  now(): number;
  emit(snapshot: PinsSnapshot): void;
}

export class Pins {
  private touchTimer: ReturnType<typeof setTimeout> | null = null;
  /** the pinned threads, as of the last look */
  private ids = new Set<number>();
  /** what the windows were last sent */
  private sent = "";
  private running: Promise<PinsSnapshot> | null = null;
  private queued: Promise<PinsSnapshot> | null = null;
  private stopped = false;

  constructor(private readonly host: PinsHost) {}

  /** The pins now; the windows hear of it if it changed. */
  refresh(): Promise<PinsSnapshot> {
    // one look at a time; asked during one, the answer is the next look's (the one running may have read before the change)
    if (this.running) {
      this.queued ??= this.running.catch(() => undefined).then(() => {
        this.queued = null;
        return this.refresh();
      });
      return this.queued;
    }
    const run = this.look().finally(() => {
      if (this.running === run) this.running = null;
    });
    this.running = run;
    return run;
  }

  /**
   * Mail changed: while anything is pinned, a look (throttled). Not only for
   * pinned threads: a merge announces its survivor, an account's removal no
   * thread at all, and either may have taken a pin with it.
   */
  touched(): void {
    if (this.stopped || this.ids.size === 0 || this.touchTimer) return;
    this.touchTimer = setTimeout(() => {
      this.touchTimer = null;
      if (!this.stopped) void this.refresh().catch(() => undefined);
    }, TOUCH_EVERY_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.touchTimer) clearTimeout(this.touchTimer);
    this.touchTimer = null;
  }

  /** Pins these (one already pinned keeps its pin); null past the cap, nothing pinned. */
  async add(threadIds: readonly number[]): Promise<Pin[] | null> {
    // always later than the last pin made: a pin made again in the same millisecond is still a new one (an Undo's exact
    // delete of the old one can't take it)
    const pinnedAt = Math.max(this.host.now(), this.last + 1);
    this.last = pinnedAt;
    return this.putBack(threadIds.map((threadId) => ({ threadId, pinnedAt })));
  }

  /** Puts these rows in as they are (an Undo) where nothing is pinned now; null past the cap, nothing put. What it put. */
  async putBack(rows: readonly Pin[]): Promise<Pin[] | null> {
    const r = await this.host.store.pins.add(rows, PINS_MAX);
    if (!r.ok) return null;
    if (r.added.length) await this.refresh();
    return r.added;
  }

  async remove(threadIds: readonly number[]): Promise<Pin[]> {
    const removed = await this.host.store.pins.delete(threadIds);
    if (removed.length) await this.refresh();
    return removed;
  }

  /**
   * Undo: what was pinned goes (unless pinned again since), and what was
   * unpinned comes back where nothing is pinned now. Past the cap: refused,
   * nothing put back.
   */
  async restore(drop: readonly Pin[], put: readonly Pin[]): Promise<boolean> {
    if (drop.length) await this.host.store.pins.deleteExact(drop);
    const ok = put.length === 0 || (await this.host.store.pins.add(put, PINS_MAX)).ok;
    await this.refresh();
    return ok;
  }

  /** the newest pin's time (a new one is always later) */
  private last = 0;

  /** The pinned ones among these, as of the last look */
  among(threadIds: readonly number[]): number[] {
    return this.ids.size ? [...new Set(threadIds)].filter((id) => this.ids.has(id)) : [];
  }

  /** These conversations were put away (archived, trashed, marked as spam, filed out of the Inbox): their pins end. */
  async end(threadIds: readonly number[]): Promise<Pin[]> {
    if (this.ids.size === 0 || !threadIds.some((id) => this.ids.has(id))) return [];
    const ended = await this.host.store.pins.delete(threadIds);
    if (ended.length) await this.refresh();
    return ended;
  }

  private async look(): Promise<PinsSnapshot> {
    const pins = await this.host.store.pins.list();
    this.ids = new Set(pins.map((p) => p.threadId));
    for (const p of pins) if (p.pinnedAt > this.last) this.last = p.pinnedAt;
    const snapshot: PinsSnapshot = { pins };
    const text = JSON.stringify(snapshot);
    if (!this.stopped && text !== this.sent) {
      this.sent = text;
      this.host.emit(snapshot);
    }
    return snapshot;
  }
}
