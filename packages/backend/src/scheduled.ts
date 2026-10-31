import { SCHEDULED_BYTES_MAX, SCHEDULED_MAX } from "@terno/core";
import { captureError } from "@terno/core/diag";
import { contract, RpcError, type ParsedParamsOf, type ScheduledFailure, type ScheduledInfo, type ScheduledSnapshot } from "@terno/core/rpc";
import type { MailStore, ScheduledSend } from "@terno/store";

/**
 * Plan 94's scheduled sends, on the backend: one timer for the soonest one
 * (none without any: idle stays idle), the send itself through compose.send's
 * own path when its time comes (fenced: only while it is still scheduled for
 * that moment, so a cancel or a new time meanwhile wins), and a snapshot to
 * the windows whenever what they show changed.
 *
 * A send that can't go because its draft changed or went, or its account
 * did, won't ever go: its row goes, its draft is a draft again, and a
 * failure is kept (a setting) until the user saw it. Anything else (a full
 * Sent-copy queue, a store hiccup) keeps it scheduled, says why, and tries
 * again later.
 */

export type ComposeSendParams = ParsedParamsOf<"compose.send">;

/** setTimeout's longest delay; a later one re-arms when it runs out */
const MAX_DELAY = 2 ** 31 - 1;
/** failures the user hasn't seen yet (a setting: they outlive a restart) */
export const FAILED_KEY = "scheduled:failed";
const FAILED_MAX = 20;
/** the next try after a failure, by how long it has been failing */
export function retryDelay(sinceSendAt: number): number {
  if (sinceSendAt < 60_000) return 60_000;
  if (sinceSendAt < 10 * 60_000) return 5 * 60_000;
  if (sinceSendAt < 60 * 60_000) return 15 * 60_000;
  return 60 * 60_000;
}

export interface ScheduledHost {
  readonly store: MailStore;
  now(): number;
  emit(snapshot: ScheduledSnapshot): void;
  /** compose.send's durable part (throws when nothing was queued) and its effects */
  send(params: ComposeSendParams & { scheduledAt: number }): Promise<void>;
  /** a draft is a draft again: the windows load it */
  draftsBack(): void;
  log(level: "info" | "warn" | "error", message: string, extra?: unknown): void;
}

const toInfo = (s: ScheduledSend): ScheduledInfo => ({
  draftId: s.draftId,
  sendAt: s.sendAt,
  accountId: s.accountId,
  threadId: s.threadId,
  mode: s.mode,
  to: s.to.flatMap((a) => (a && typeof a === "object" && typeof (a as { email?: unknown }).email === "string" ? [{ name: String((a as { name?: unknown }).name ?? ""), email: (a as { email: string }).email }] : [])),
  subject: s.subject,
  error: s.error,
  retryAt: s.retryAt,
});

/** refusals that a later try would meet again: what it answers is gone, it's too large, a file is missing */
const NEVER_GOES = new Set(["errors.replySourceGone", "attachments.tooLarge", "attachments.unavailable"]);

/** never sent again: the draft changed or went (or its account), or the message itself can't go as it is */
function permanent(error: unknown): boolean {
  return error instanceof RpcError && (error.code === "STALE" || error.code === "NOT_FOUND" || (error.code === "BAD_REQUEST" && NEVER_GOES.has(error.i18n?.key ?? "")));
}
/** a look that failed (the store refused, a disk full) tries again in this long: never left without a timer */
const LOOK_RETRY_MS = 60_000;

export class ScheduledSends {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<ScheduledSnapshot> | null = null;
  private queued: Promise<ScheduledSnapshot> | null = null;
  private sent = "";
  private armedAt: number | null = null;
  /** the drafts scheduled as of the last look (drafts.list leaves them out) */
  private ids = new Set<number>();
  private stopped = false;

  constructor(private readonly host: ScheduledHost) {}

  /** when the timer runs next (null: none armed); for tests */
  get nextAt(): number | null {
    return this.armedAt;
  }

  /** whether a draft was scheduled at the last look */
  has(draftId: number): boolean {
    return this.ids.has(draftId);
  }

  /** The scheduled sends now (the due ones sent first); the windows hear of it if it changed, and the timer follows. */
  refresh(): Promise<ScheduledSnapshot> {
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

  /** a refresh that logs instead of failing (a start, a wake, a focus, a change); a failed one looks again in a minute */
  poke(): void {
    if (this.stopped) return;
    this.refresh().catch((error: unknown) => {
      captureError(error, { code: "scheduled.failed" });
      this.host.log("warn", "scheduled sends couldn't be read", error instanceof Error ? error.message : error);
      if (!this.stopped && (this.armedAt === null || this.armedAt > this.host.now() + LOOK_RETRY_MS)) this.armIn(LOOK_RETRY_MS);
    });
  }

  /** Mail or drafts changed: a look, but only while something is scheduled (a deleted draft or account takes its row). */
  touched(): void {
    if (this.ids.size) this.poke();
  }

  /** No new send starts; the one in flight finishes before the store closes. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.armedAt = null;
    await this.queued?.catch(() => {});
    await this.running?.catch(() => {});
  }

  async schedule(params: ComposeSendParams & { draftId: number; draftGeneration: string; draftRevision: number }, sendAt: number): Promise<"ok" | "full" | "stale"> {
    const r = await this.host.store.scheduled.put(
      { draftId: params.draftId, generation: params.draftGeneration, revision: params.draftRevision, sendAt, setAt: this.host.now(), paramsJson: JSON.stringify(params) },
      { count: SCHEDULED_MAX, bytes: SCHEDULED_BYTES_MAX },
    );
    if (r === "ok") {
      this.ids.add(params.draftId);
      this.poke();
    }
    return r;
  }

  async reschedule(draftId: number, sendAt: number): Promise<boolean> {
    const ok = await this.host.store.scheduled.reschedule(draftId, sendAt);
    if (ok) this.poke();
    return ok;
  }

  async cancel(draftId: number): Promise<boolean> {
    const ok = await this.host.store.scheduled.delete(draftId);
    if (ok) {
      this.ids.delete(draftId);
      this.poke();
    }
    return ok;
  }

  async ackFailed(ids: readonly string[]): Promise<void> {
    const gone = new Set(ids);
    await this.host.store.settings.update<ScheduledFailure[], void>(FAILED_KEY, [], (list) => ({ value: list.filter((f) => !gone.has(f.id)), result: undefined }));
    this.poke();
  }

  private async look(): Promise<ScheduledSnapshot> {
    const store = this.host.store;
    let list = await store.scheduled.list();
    const due = list.filter((s) => (s.retryAt ?? s.sendAt) <= this.host.now());
    const tried = new Set(due.map((s) => s.draftId));
    // one that couldn't even note its failure (the store refused) waits a minute, in memory; the others go on
    const held = new Map<number, number>();
    for (const s of due) {
      if (this.stopped) break;
      try {
        await this.sendOne(s);
      } catch (error) {
        captureError(error, { code: "scheduled.failed" });
        held.set(s.draftId, this.host.now() + LOOK_RETRY_MS);
      }
    }
    if (due.length) list = await store.scheduled.list();
    const failed = await store.settings.get<ScheduledFailure[]>(FAILED_KEY, []);
    const snapshot: ScheduledSnapshot = { items: list.map(toInfo), failed };
    this.ids = new Set(list.map((s) => s.draftId));
    if (this.stopped) return snapshot;
    this.arm(list, tried, held);
    const text = JSON.stringify(snapshot);
    if (text !== this.sent) {
      this.sent = text;
      this.host.emit(snapshot);
    }
    return snapshot;
  }

  private async sendOne(s: ScheduledSend): Promise<void> {
    const store = this.host.store;
    const row = await store.scheduled.get(s.draftId);
    // cancelled or moved since the list was read
    if (!row || row.sendAt !== s.sendAt) return;
    let params: ComposeSendParams;
    try {
      params = contract["compose.send"].params.parse(JSON.parse(row.paramsJson));
    } catch (error) {
      return this.giveBack(s, error);
    }
    try {
      await this.host.send({ ...params, scheduledAt: row.sendAt });
      this.host.log("info", "scheduled send queued");
    } catch (error) {
      // a cancel or a new time won the race: nothing to say
      if (error instanceof RpcError && error.code === "STALE" && (error.details as { reason?: string } | undefined)?.reason === "unscheduled") return;
      if (permanent(error)) return this.giveBack(s, error);
      const now = this.host.now();
      const message = error instanceof Error ? error.message : String(error);
      captureError(error, { code: "scheduled.send_failed", expected: error instanceof RpcError });
      await store.scheduled.fail(s.draftId, row.sendAt, message, now + retryDelay(now - row.sendAt));
    }
  }

  /** It won't go: the row goes, the draft (if any) is a draft again, and the user is told until they saw it. */
  private async giveBack(s: ScheduledSend, error: unknown): Promise<void> {
    const store = this.host.store;
    await store.scheduled.delete(s.draftId);
    const now = this.host.now();
    const failure: ScheduledFailure = { id: `${s.draftId}-${now.toString(36)}`, draftId: s.draftId, subject: s.subject, message: error instanceof Error ? error.message : String(error), at: now };
    await store.settings.update<ScheduledFailure[], void>(FAILED_KEY, [], (list) => ({ value: [...list, failure].slice(-FAILED_MAX), result: undefined }));
    captureError(error, { code: "scheduled.given_back", expected: true });
    this.host.draftsBack();
  }

  /** One timer, for the soonest one (a failed one at its retry; one just tried and still due, a minute on, never a spin). */
  private arm(list: readonly ScheduledSend[], tried: ReadonlySet<number>, held: ReadonlyMap<number, number>): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.armedAt = null;
    const now = this.host.now();
    let next = Infinity;
    for (const s of list) {
      const at = held.get(s.draftId) ?? s.retryAt ?? s.sendAt;
      const when = at <= now && tried.has(s.draftId) ? now + 60_000 : at;
      if (when < next) next = when;
    }
    if (next === Infinity) return;
    this.armIn(next - now);
  }

  private armIn(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    const delay = Math.min(MAX_DELAY, Math.max(0, ms));
    this.armedAt = this.host.now() + delay;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.armedAt = null;
      this.poke();
    }, delay);
    // never keeps a quitting process alive
    (this.timer as { unref?: () => void }).unref?.();
  }
}
