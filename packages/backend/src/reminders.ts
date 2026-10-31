import { REMINDERS_MAX, type Reminder } from "@terno/core";
import { captureError } from "@terno/core/diag";
import type { RemindersSnapshot } from "@terno/core/rpc";
import type { MailStore } from "@terno/store";

/**
 * Plan 87's reminders, on the backend: one timer for the soonest one that
 * isn't due yet (none without reminders: idle stays idle), a snapshot to the
 * windows whenever what they show changed (set, cleared, due, answered,
 * merged away), and the sweep that ends a "noReply" reminder once someone
 * answered. Nothing about them is shown as a notification (the Inbox's top is
 * the reminder).
 */

/** setTimeout's longest delay; a later reminder re-arms when it runs out */
const MAX_DELAY = 2 ** 31 - 1;
/** after a change touched a reminded thread, at most one look a second (an ingest burst) */
const TOUCH_EVERY_MS = 1000;

export interface RemindersHost {
  readonly store: MailStore;
  now(): number;
  emit(snapshot: RemindersSnapshot): void;
  /** slices with a turn between them (the slicer's budget) */
  runBudgeted<T>(items: readonly T[], work: (chunk: T[]) => void | Promise<void>): Promise<void>;
  log(level: "info" | "warn" | "error", message: string, extra?: unknown): void;
}

export class Reminders {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private touchTimer: ReturnType<typeof setTimeout> | null = null;
  /** the threads with a reminder, as of the last look (a change to one of them looks again) */
  private ids = new Set<number>();
  /** what the windows were last sent */
  private sent = "";
  private running: Promise<RemindersSnapshot> | null = null;
  private queued: Promise<RemindersSnapshot> | null = null;
  private armedAt: number | null = null;
  private stopped = false;

  constructor(private readonly host: RemindersHost) {}

  /** The reminders now (answered ones ended first); the windows hear of it if it changed, and the timer follows. */
  refresh(): Promise<RemindersSnapshot> {
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

  /** when the timer runs next (null: none armed); for tests */
  get nextAt(): number | null {
    return this.armedAt;
  }

  /**
   * Threads changed: a look, if one of them has a reminder (an answer, a
   * delete; throttled). A merge announces only its survivor: the reminder it
   * carried over is the store's at once (the Inbox's top, the timer's next
   * look), and the windows' copy catches up at the next look.
   */
  touched(threadIds: Iterable<number>): void {
    if (this.stopped || this.ids.size === 0 || this.touchTimer) return;
    let hit = false;
    for (const id of threadIds) if (this.ids.has(id)) hit = true;
    if (!hit) return;
    this.touchTimer = setTimeout(() => {
      this.touchTimer = null;
      if (!this.stopped) void this.refresh();
    }, TOUCH_EVERY_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.touchTimer) clearTimeout(this.touchTimer);
    this.timer = this.touchTimer = null;
    this.armedAt = null;
  }

  /** Sets one reminder on these threads (all or none). */
  async set(threadIds: readonly number[], dueAt: number, kind: Reminder["kind"]): Promise<{ rows: Reminder[]; replaced: Reminder[] } | null> {
    const setAt = this.host.now();
    const rows = threadIds.map((threadId) => ({ threadId, dueAt, kind, setAt }));
    const r = await this.host.store.reminders.put(rows, REMINDERS_MAX);
    if (!r.ok) return null;
    void this.refresh();
    const put = new Set(r.put);
    return { rows: rows.filter((x) => put.has(x.threadId)), replaced: r.replaced };
  }

  async clear(threadIds: readonly number[], dueOnly: boolean): Promise<Reminder[]> {
    const cleared = await this.host.store.reminders.delete(threadIds, dueOnly ? { dueBy: this.host.now() } : undefined);
    if (cleared.length) void this.refresh();
    return cleared;
  }

  /** Undo: what was set goes (unless replaced since), what it replaced comes back. Over the cap: refused. */
  async restore(drop: readonly Reminder[], put: readonly Reminder[]): Promise<boolean> {
    if (drop.length) await this.host.store.reminders.deleteExact(drop);
    const ok = put.length === 0 || (await this.host.store.reminders.put(put, REMINDERS_MAX)).ok;
    void this.refresh();
    return ok;
  }

  /** Due reminders of these threads end (they were archived, trashed or marked as spam). */
  async endDue(threadIds: readonly number[]): Promise<Reminder[]> {
    if (this.ids.size === 0 || !threadIds.some((id) => this.ids.has(id))) return [];
    const ended = await this.host.store.reminders.delete(threadIds, { dueBy: this.host.now() });
    if (ended.length) void this.refresh();
    return ended;
  }

  private async look(): Promise<RemindersSnapshot> {
    const store = this.host.store;
    let list = await store.reminders.list();
    // answered "noReply" ones end, in slices (a long conversation reads its messages); unless replaced meanwhile
    const noReply = list.filter((r) => r.kind === "noReply");
    if (noReply.length) {
      const answered = new Set<number>();
      await this.host.runBudgeted(noReply, async (chunk) => {
        for (const id of await store.reminders.answered(chunk)) answered.add(id);
      });
      if (answered.size) {
        const ended = new Set((await store.reminders.deleteExact(noReply.filter((r) => answered.has(r.threadId)))).map((r) => r.threadId));
        list = list.filter((r) => !ended.has(r.threadId));
      }
    }
    const now = this.host.now();
    const snapshot: RemindersSnapshot = { reminders: list.map((r) => ({ ...r, due: r.dueAt <= now })) };
    this.ids = new Set(list.map((r) => r.threadId));
    if (this.stopped) return snapshot;
    this.arm(list, now);
    const text = JSON.stringify(snapshot);
    if (text !== this.sent) {
      this.sent = text;
      this.host.emit(snapshot);
    }
    return snapshot;
  }

  /** One timer, for the soonest reminder that isn't due yet. */
  private arm(list: readonly Reminder[], now: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.armedAt = null;
    let next = Infinity;
    for (const r of list) if (r.dueAt > now && r.dueAt < next) next = r.dueAt;
    if (next === Infinity) return;
    this.armedAt = next;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.armedAt = null;
      if (this.stopped) return;
      this.refresh().catch((error: unknown) => {
        captureError(error, { code: "reminders.failed" });
        this.host.log("warn", "reminders couldn't be read", error instanceof Error ? error.message : error);
      });
    }, Math.min(MAX_DELAY, next - now));
    // never keeps a quitting process alive
    (this.timer as { unref?: () => void }).unref?.();
  }
}
