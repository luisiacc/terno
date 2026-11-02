import {
  attachmentMessageBudget,
  catalogWording,
  FORWARD_FILES_WAIT_MS,
  forwardBody,
  forwardChunks,
  forwardQuote,
  forwardSubject,
  fullDateFormat,
  type AttachmentRef,
  type ForwardInfo,
  type ForwardQuestion,
  type ForwardRuleRef,
  type ForwardSnapshot,
  type ForwardStatus,
  type MessageDetail,
} from "@terno/core";
import { captureError } from "@terno/core/diag";
import { RpcError } from "@terno/core/rpc";
import { DEFAULT_LOCALE, isLocaleId, LOCALES, type LocaleId } from "@terno/i18n";
import type { OpState } from "@terno/core";
import type { ForwardRow, MailStore, ModelDelta, SendCommand } from "@terno/store";

/**
 * Plan 116's forwards, on the backend: new mail a rule matches waits 10 s
 * (one timer for the soonest; none when nothing waits: idle stays idle),
 * then goes through compose's own durable send path, fenced by the store
 * (a forward is claimed once, each of its sends queued once). A rule past
 * its cap holds what comes next until the user answers. The windows get a
 * snapshot whenever what they show changed.
 */

/** setTimeout's longest delay; a later one re-arms when it runs out */
const MAX_DELAY = 2 ** 31 - 1;
/** a look that failed (the store refused) tries again in this long: never left without a timer */
const LOOK_RETRY_MS = 60_000;
/** forwards the windows are told about */
const LIST_LIMIT = 200;
/** forwards worked per store read */
const WORK_PAGE = 50;
/** eligible messages per sweep page at start */
const SWEEP_PAGE = 200;
/** where the renderer's language is kept for a "system" setting (the backend can't see the system's) */
export const UI_LOCALE_KEY = "ui:locale";

export interface ForwardingHost {
  readonly store: MailStore;
  now(): number;
  emit(snapshot: ForwardSnapshot): void;
  /** a forward's send was queued: the categorizer, the lists and the ops worker hear of it */
  queued(r: { threadId: number; deltas: ModelDelta[] }): void;
  /** agents may send (settings): their filing makes new mail go too */
  agentsMaySend(): Promise<boolean>;
  /** the UI language ("system", or a locale id) */
  language(): Promise<string>;
  yieldTurn(): Promise<void>;
  log(level: "info" | "warn" | "error", message: string, extra?: unknown): void;
}

const isStale = (error: unknown) => error instanceof RpcError && error.code === "STALE";
/** a send that may be queued later: the Sent-copy receipts are full (plan 65), or the store failed for its own reasons */
const transient = (error: unknown) => !(error instanceof RpcError) || error.i18n?.key === "errors.recipientReceipt.capacity" || !["NOT_FOUND", "BAD_REQUEST", "FORBIDDEN", "STALE"].includes(error.code);
const i18nKey = (error: unknown) => (error instanceof RpcError ? error.i18n?.key : undefined);

export class Forwarding {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private armedAt: number | null = null;
  private running: Promise<ForwardSnapshot> | null = null;
  private queued: Promise<ForwardSnapshot> | null = null;
  private sent = "";
  private stopped = false;
  /** any rule forwards: live ingest marks new mail only then */
  private active = false;
  /** op ids of the forwards last shown: an op of one settling is news */
  private ops = new Set<string>();

  constructor(private readonly host: ForwardingHost) {}

  /** whether ingest should mark live mail (no rule: no work at all) */
  get isActive(): boolean {
    return this.active && !this.stopped;
  }

  /** when the timer runs next (null: none armed); for tests */
  get nextAt(): number | null {
    return this.armedAt;
  }

  /** At start: whether anything forwards, what is old goes, and new mail a crash left unlooked-at is planned. */
  async start(): Promise<void> {
    await this.rules();
    if (this.stopped) return;
    await this.host.store.forwards.prune(this.host.now());
    if (this.active) {
      for (let after = 0; !this.stopped; ) {
        const page = await this.host.store.forwards.eligiblePage(this.host.now(), after, SWEEP_PAGE);
        if (!page.length) break;
        await this.host.store.forwards.plan({ messageIds: page, agentFiles: await this.host.agentsMaySend(), now: this.host.now() });
        after = page[page.length - 1]!;
        await this.host.yieldTurn();
      }
    }
    this.poke();
  }

  /** A rule was saved, deleted, turned on or off: whether anything forwards now. */
  async rules(): Promise<void> {
    this.active = await this.host.store.forwards.active();
  }

  /**
   * New mail (inserted live, a body that arrived) or a filing: the forwards
   * it makes. `filed`: threads the user filed one at a time.
   */
  async plan(p: { messageIds?: readonly number[]; threadIds?: readonly number[]; filed?: readonly number[] }): Promise<void> {
    if (!this.isActive || (!p.messageIds?.length && !p.threadIds?.length)) return;
    const made = await this.host.store.forwards.plan({ ...p, agentFiles: await this.host.agentsMaySend(), now: this.host.now() });
    if (made.length) this.poke();
  }

  /** The original's files arrived: a forward waiting for them goes now. */
  async filesArrived(messageId: number): Promise<void> {
    if (!this.isActive) return;
    let woke = false;
    for (const row of await this.host.store.forwards.list(this.host.now(), LIST_LIMIT)) {
      if (row.messageId === messageId && row.state === "waiting" && row.filesUntil !== null) woke = (await this.host.store.forwards.waitForFiles(row.id, this.host.now(), this.host.now())) || woke;
    }
    if (woke) this.poke();
  }

  /** An op settled: if it is a forward's, the windows hear how it went. */
  opSettled(opId: string): void {
    if (this.ops.has(opId)) this.poke();
  }

  async cancel(ids: readonly number[]): Promise<number> {
    const n = (await this.host.store.forwards.cancel(ids, this.host.now())).length;
    this.poke();
    return n;
  }

  async retry(id: number): Promise<boolean> {
    const row = await this.host.store.forwards.get(id);
    if (!row) return false;
    const failed: string[] = [];
    for (const op of row.opIds) if (op && (await this.host.store.ops.get(op))?.state === "failed") failed.push(op);
    const ok = (await this.host.store.forwards.retry(id, this.host.now(), failed)) !== null;
    this.poke();
    return ok;
  }

  async answer(rule: ForwardRuleRef, keep: boolean): Promise<void> {
    if (keep) await this.host.store.forwards.approve(rule, this.host.now());
    else await this.host.store.forwards.stop(rule, this.host.now());
    await this.rules();
    this.poke();
  }

  /** The forwards now (the due ones go first); the windows hear of it if it changed, and the timer follows. */
  refresh(): Promise<ForwardSnapshot> {
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

  /** a refresh that logs instead of failing; a failed one looks again in a minute */
  poke(): void {
    if (this.stopped) return;
    this.refresh().catch((error: unknown) => {
      captureError(error, { code: "forward.failed" });
      this.host.log("warn", "forwards couldn't be read", error instanceof Error ? error.message : error);
      if (!this.stopped && (this.armedAt === null || this.armedAt > this.host.now() + LOOK_RETRY_MS)) this.armIn(LOOK_RETRY_MS);
    });
  }

  /** No new forward starts; the one in flight finishes before the store closes. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.armedAt = null;
    await this.queued?.catch(() => {});
    await this.running?.catch(() => {});
  }

  private async look(): Promise<ForwardSnapshot> {
    const store = this.host.store;
    const now = this.host.now();
    // what to do comes from its own query, never the windows' list (a burst bigger than it waits all the same)
    let worked = 0;
    let stuck = false;
    const tried = new Set<number>();
    while (!this.stopped) {
      const work = (await store.forwards.work(now, WORK_PAGE)).filter((r) => !tried.has(r.id));
      if (!work.length) break;
      for (const row of work) {
        if (this.stopped) break;
        tried.add(row.id);
        worked++;
        try {
          // looks run one at a time: a forward still "sending" here is one a quit, a crash or a full queue interrupted
          if (row.state === "sending") await this.send(row, await this.message(row));
          else await this.admit(row);
        } catch (error) {
          captureError(error, { code: "forward.send_failed", expected: error instanceof RpcError });
          this.host.log("warn", "a forward couldn't be sent", error instanceof Error ? error.message : error);
          // a send that can't be queued now (a full Sent-copy queue, a store hiccup) is tried again later; one that never can fails
          if (transient(error)) stuck = true;
          else await store.forwards.fail(row.id, "forward.reason.failed", this.host.now()).catch(() => {});
        }
      }
      await this.host.yieldTurn();
    }
    // held past their wait are cancelled; history past its time goes
    if (worked || ((await store.forwards.nextDue()) ?? Infinity) <= now) await store.forwards.prune(this.host.now());
    const rows = await store.forwards.list(this.host.now(), LIST_LIMIT);
    const snapshot = await this.snapshot(rows);
    if (this.stopped) return snapshot;
    await this.arm(stuck);
    const text = JSON.stringify(snapshot);
    if (text !== this.sent) {
      this.sent = text;
      this.host.emit(snapshot);
    }
    return snapshot;
  }

  /** A due forward: its files waited for (at most FORWARD_FILES_WAIT_MS), then claimed in one transaction and sent. */
  private async admit(row: ForwardRow): Promise<void> {
    const store = this.host.store;
    const now = this.host.now();
    const message = await this.message(row);
    if (message?.attachmentState === "pending" && message.hasAttachments) {
      if (row.filesUntil === null) {
        await store.forwards.waitForFiles(row.id, now + FORWARD_FILES_WAIT_MS, now);
        return;
      }
      if (row.filesUntil > now) return;
    }
    const files = filesOf(message);
    const own = (await store.accounts.list()).map((a) => a.email);
    const claim = await store.forwards.claim(row.id, now, { filesMissing: files.missing, own });
    if (claim.kind === "go") await this.send(claim.row, message);
  }

  /**
   * A claimed forward's sends not queued yet (all of them, or what a quit
   * interrupted): each one queued once, the store refusing a second.
   */
  private async send(row: ForwardRow, message: MessageDetail | undefined): Promise<void> {
    const store = this.host.store;
    if (!message) return store.forwards.fail(row.id, "forward.reason.gone", this.host.now());
    const files = filesOf(message);
    const account = await store.accounts.get(row.accountId);
    const wording = await this.wording();
    const quote = forwardQuote({ from: message.from, to: message.to, subject: message.subject, date: message.date, text: message.bodyText ?? message.snippet }, wording);
    const base: Omit<SendCommand, "to" | "forward" | "attachments" | "now"> = {
      accountId: row.accountId,
      cc: [],
      bcc: [],
      subject: forwardSubject(message.subject, wording),
      bodyText: forwardBody(quote, account?.signature ?? ""),
      recordReply: false,
    };
    for (const [chunk, to] of forwardChunks(row.to).entries()) {
      if (this.stopped) return;
      if (row.opIds[chunk] !== null) continue;
      const queue = (attachments: AttachmentRef[]) => store.compose.queueSend({ ...base, to, attachments, forward: { id: row.id, chunk }, now: this.host.now() });
      let r: Awaited<ReturnType<MailStore["compose"]["queueSend"]>>;
      try {
        r = await queue(files.refs);
      } catch (error) {
        // cancelled or already queued meanwhile: nothing to say
        if (isStale(error)) return;
        const key = i18nKey(error);
        // files that can't go (too large, gone): it goes without them, as the composer's forward would (plan 60)
        if (files.refs.length && (key === "attachments.tooLarge" || key === "attachments.unavailable")) r = await queue([]);
        else {
          // the rest waits for room (look() tries again); what can never go fails, its queued sends going on
          if (!transient(error)) await store.forwards.fail(row.id, error instanceof RpcError && error.code === "NOT_FOUND" ? "forward.reason.accountGone" : "forward.reason.failed", this.host.now());
          throw error;
        }
      }
      this.host.queued({ threadId: r.threadId, deltas: r.deltas });
    }
    this.host.log("info", "forward queued");
  }

  private async message(row: ForwardRow): Promise<MessageDetail | undefined> {
    return (await this.host.store.threads.get(row.threadId))?.messages.find((m) => m.id === row.messageId);
  }

  /** The language the forward is written in: the setting, else the windows' (a "system" setting), else English. */
  private async wording() {
    const setting = await this.host.language();
    let locale: LocaleId = DEFAULT_LOCALE;
    if (isLocaleId(setting)) locale = setting;
    else {
      const ui = await this.host.store.settings.get<string | null>(UI_LOCALE_KEY, null);
      if (isLocaleId(ui)) locale = ui;
    }
    const format = fullDateFormat(locale);
    return catalogWording(locale, await LOCALES[locale].load(), (ms) => format.format(new Date(ms)));
  }

  private async snapshot(rows: readonly ForwardRow[]): Promise<ForwardSnapshot> {
    const store = this.host.store;
    const names = new Map<string, string>();
    for (const c of await store.categories.list()) names.set(`category:${c.id}`, c.name);
    if (rows.some((r) => r.ruleKind === "filter")) for (const f of await store.filters.list()) names.set(`filter:${f.id}`, f.name);
    const ops = new Set<string>();
    const items: ForwardInfo[] = [];
    for (const r of rows) {
      for (const op of r.opIds) if (op) ops.add(op);
      items.push({
        id: r.id,
        messageId: r.messageId,
        threadId: r.threadId,
        accountId: r.accountId,
        rule: { kind: r.ruleKind, id: r.ruleId },
        ruleName: names.get(`${r.ruleKind}:${r.ruleId}`) ?? "",
        to: r.to,
        status: await this.status(r),
        dueAt: r.dueAt,
        at: r.at,
        filesMissing: r.filesMissing,
        reason: r.reason,
      });
    }
    this.ops = ops;
    const questions: ForwardQuestion[] = (await store.forwards.holds(this.host.now())).map((h) => ({ rule: h.rule, ruleName: names.get(`${h.rule.kind}:${h.rule.id}`) ?? "", count: h.count, held: h.held }));
    return { items, questions };
  }

  /** Where a forward is: its own state until its sends are queued, then theirs (never "failed" while one may have gone). */
  private async status(r: ForwardRow): Promise<ForwardStatus> {
    if (r.state !== "queued") return r.state === "sending" ? "sending" : r.state;
    const ops = [];
    for (const id of r.opIds) if (id) ops.push(await this.host.store.ops.get(id));
    const states: (OpState | undefined)[] = ops.map((op) => op?.state);
    if (states.some((s) => s === "unknown") || ops.some((op) => op?.send_recipient_unknown)) return "unknown";
    // a part that can never go: whatever the rest does, it's partly sent
    if (r.opIds.some((id) => id === null)) return "partial";
    if (states.some((s) => s === "queued" || s === "running")) return "sending";
    // some addresses got it and some didn't: a refused send, a server that took only some
    if (ops.some((op) => op?.send_partial) || (states.some((s) => s === "failed") && states.some((s) => s === "succeeded"))) return "partial";
    if (states.some((s) => s === "failed")) return "failed";
    // its ops pruned (old history) or all succeeded
    return "sent";
  }

  /** One timer, for the soonest due forward or held one's expiry; a minute on while a send waits for room. */
  private async arm(stuck: boolean): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.armedAt = null;
    const now = this.host.now();
    let next = (await this.host.store.forwards.nextDue()) ?? Infinity;
    if (stuck) next = Math.min(next, now + LOOK_RETRY_MS);
    if (next === Infinity) return;
    // still due right after a look (a store that refused): a minute on, never a spin
    this.armIn(next <= now ? LOOK_RETRY_MS : next - now);
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

/** The original's files a forward carries (those stored on this device), and whether some can't go. */
function filesOf(message: MessageDetail | undefined): { refs: AttachmentRef[]; missing: boolean } {
  if (!message) return { refs: [], missing: false };
  const refs = message.attachments.filter((a) => a.assetId).map((a) => ({ assetId: a.assetId!, filename: a.filename, mime: a.mime, size: a.size, contentId: a.contentId ?? null }));
  // too large to go together (the quote's text counted, its header's few lines aside): it goes without them
  if (refs.length && !attachmentMessageBudget(message.bodyText ?? message.snippet, undefined, refs)) return { refs: [], missing: true };
  return { refs, missing: message.hasAttachments && (message.attachmentState !== "complete" || refs.length < message.attachments.length) };
}
