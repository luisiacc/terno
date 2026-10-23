import { randomUUID } from "node:crypto";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import type { AiProvider } from "@unica/ai";
import { createAnthropicProvider, createFakeProvider } from "@unica/ai";
import type { Account, AccountSyncState, FilterAction, ThreadAction } from "@unica/core";
import { RpcServer, type CallContext, type MethodName, type OpInfo, type Transport } from "@unica/core/rpc";
import {
  addThreadsToCategory,
  applyMessageAction,
  claimFilterApplications,
  claimReadyOps,
  completeOp,
  deleteMessages,
  enqueueOp,
  failOp,
  findRuleMatches,
  getAccount,
  getAccountConfig,
  getCounts,
  getOp,
  getSecret,
  ingestMessages,
  listAccounts,
  listFilters,
  markOpUnknown,
  messagesWithPendingOps,
  openDatabase,
  recomputeThreads,
  adoptProviderThread,
  putSecret,
  recoverOps,
  setAccountProviderConfig,
  setAccountSyncState,
  setMessageBody,
  startCheckpointWorker,
  type CheckpointWorker,
  type ActionResult,
  type Db,
  type IncomingMessage,
  type OpRow,
} from "@unica/db";
import { ProviderError, type MailProvider, type ProviderRegistry, type SyncSink } from "@unica/mail";
import { createHandlers } from "./handlers";
import { readSettings } from "./settings";

export interface SecretCipher {
  encrypt(plain: string): Promise<Uint8Array>;
  decrypt(blob: Uint8Array): Promise<string>;
}

/** Dev/test only: no encryption. Production uses Electron safeStorage via the main process. */
export const plaintextCipher: SecretCipher = {
  async encrypt(plain) {
    return new TextEncoder().encode(`plain:${plain}`);
  },
  async decrypt(blob) {
    return new TextDecoder().decode(blob).replace(/^plain:/, "");
  },
};

export type AiFactory = (kind: "anthropic" | "fake", options: { apiKey: string | null; model: string }) => AiProvider | null;

export const defaultAiFactory: AiFactory = (kind, { apiKey, model }) => {
  if (kind === "fake") return createFakeProvider();
  return apiKey ? createAnthropicProvider({ apiKey, model }) : null;
};

export interface BackendOptions {
  dbPath: string;
  version: string;
  cipher: SecretCipher;
  providers: ProviderRegistry;
  aiFactory?: AiFactory;
  openExternal?: (url: string) => Promise<void>;
  now?: () => number;
  log?: (level: "info" | "warn" | "error", message: string, extra?: unknown) => void;
  /** start sync loops and the ops worker on start() (tests disable) */
  autoSync?: boolean;
  syncIntervalMs?: number;
  /** target duration of one ingestion/filter slice before yielding to interactive RPCs */
  sliceBudgetMs?: number;
}

const DESTRUCTIVE_OR_SIGNAL: Partial<Record<ThreadAction, "archive" | "trash" | "spam" | "star">> = {
  archive: "archive",
  trash: "trash",
  spam: "spam",
  star: "star",
};

/**
 * The single domain writer. Owns the database, the RPC surface, provider
 * operations and sync. Runs in Electron's utility process (or a Node host in
 * dev/tests) and serves any number of transports (renderer, MCP, dev WS).
 */
export class Backend {
  readonly db: Db;
  readonly server: RpcServer;
  readonly options: Required<Pick<BackendOptions, "now" | "sliceBudgetMs" | "syncIntervalMs">> & BackendOptions;
  private readonly providers = new Map<number, MailProvider>();
  private readonly syncing = new Map<number, Promise<void>>();
  /** a change arrived while syncing: run another pass when the current one ends */
  private readonly syncAgain = new Set<number>();
  private readonly unwatch = new Map<number, () => void>();
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private workerTimer: ReturnType<typeof setTimeout> | null = null;
  private workerRunning = false;
  private workerKicked = false;
  private stopped = false;
  private pendingThreadIds = new Set<number>();
  private pendingViews = false;
  private flushScheduled = false;
  readonly searchSeq = new Map<string, number>();
  private readonly checkpointer: CheckpointWorker | null;
  readonly abort = new AbortController();

  constructor(options: BackendOptions) {
    // explicit `undefined` must not clobber defaults
    const defined = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) as BackendOptions;
    this.options = { now: Date.now, sliceBudgetMs: 8, syncIntervalMs: 120_000, ...defined };
    this.db = openDatabase(options.dbPath);
    this.checkpointer = startCheckpointWorker(this.db);
    const recovered = recoverOps(this.db, this.now());
    if (recovered.requeued || recovered.unknown) this.log("info", "recovered ops after restart", recovered);
    this.server = new RpcServer(createHandlers(this), {
      onError: (error, method) => this.log("error", `rpc ${method} failed`, error instanceof Error ? error.stack : error),
      authorize: (method, ctx) => this.authorize(method, ctx),
    });
  }

  now(): number {
    return this.options.now();
  }

  log(level: "info" | "warn" | "error", message: string, extra?: unknown): void {
    this.options.log?.(level, message, extra);
  }

  connect(transport: Transport, ctx: CallContext): () => void {
    return this.server.connect(transport, ctx);
  }

  start(): void {
    if (this.options.autoSync === false) return;
    for (const account of listAccounts(this.db)) this.startAccount(account);
    this.syncTimer = setInterval(() => {
      for (const account of listAccounts(this.db)) void this.syncAccount(account.id);
    }, this.options.syncIntervalMs);
    this.kickWorker();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    if (this.syncTimer) clearInterval(this.syncTimer);
    if (this.workerTimer) clearTimeout(this.workerTimer);
    for (const off of this.unwatch.values()) off();
    await Promise.allSettled([...this.syncing.values()]);
    // let an in-flight ops batch finish writing before the database closes
    for (let i = 0; this.workerRunning && i < 200; i++) await new Promise((r) => setTimeout(r, 10));
    await Promise.allSettled([...this.providers.values()].map((p) => p.close()));
    await this.checkpointer?.stop();
    this.db.close();
  }

  // ───────────────────────────── permissions ─────────────────────────────

  private static readonly MCP_ALLOWED: ReadonlySet<MethodName> = new Set<MethodName>([
    "app.bootstrap",
    "threads.list",
    "threads.search",
    "threads.get",
    "threads.act",
    "categories.addThreads",
    "categories.removeThreads",
    "categories.create",
    "counts.get",
    "filters.list",
    "filters.save",
    "filters.preview",
    "drafts.save",
    "drafts.list",
    "compose.send",
  ]);

  private authorize(method: MethodName, ctx: CallContext): boolean {
    if (ctx.origin !== "mcp") return true;
    if (!Backend.MCP_ALLOWED.has(method)) return false;
    if (method === "compose.send") return readSettings(this.db).allowAgentSend;
    return true;
  }

  // ───────────────────────────── secrets ─────────────────────────────

  async getSecret(name: string): Promise<string | null> {
    const blob = getSecret(this.db, name);
    return blob ? this.options.cipher.decrypt(blob) : null;
  }

  async setSecret(name: string, value: string): Promise<void> {
    putSecret(this.db, name, await this.options.cipher.encrypt(value));
  }

  // ───────────────────────────── events ─────────────────────────────

  /** Coalesces change notifications within one turn of the event loop. */
  notifyChanged(threadIds: Iterable<number>, views = true): void {
    for (const id of threadIds) this.pendingThreadIds.add(id);
    this.pendingViews ||= views;
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      if (this.stopped) return;
      const threadIds = [...this.pendingThreadIds];
      const views = this.pendingViews;
      this.pendingThreadIds.clear();
      this.pendingViews = false;
      this.server.emit("changed", { threadIds, views });
      this.server.emit("counts", getCounts(this.db));
    });
  }

  emitAccounts(): void {
    this.server.emit("accounts", listAccounts(this.db));
  }

  // ───────────────────────────── actions → ops ─────────────────────────────

  /** Enqueues provider ops for a locally-applied action and logs explicit user signals. */
  queueActionOps(result: ActionResult, action: ThreadAction): string[] {
    const ids: string[] = [];
    for (const target of result.targets) {
      const id = enqueueOp(this.db, { accountId: target.accountId, kind: action, target: { messageIds: target.messageIds } }, this.now());
      if (id) ids.push(id);
    }
    if (ids.length) this.kickWorker();
    return ids;
  }

  static learningSignal(action: ThreadAction) {
    return DESTRUCTIVE_OR_SIGNAL[action];
  }

  // ───────────────────────────── filters ─────────────────────────────

  /** Applies enabled filters to new (or newly body-complete) messages. Automated: not a learning signal. */
  applyFiltersTo(messageIds: number[], onlyBodyFilters = false): Set<number> {
    const touched = new Set<number>();
    if (messageIds.length === 0) return touched;
    for (const filter of listFilters(this.db)) {
      if (!filter.enabled) continue;
      if (onlyBodyFilters && !filter.rule.conditions.some((c) => c.field === "body")) continue;
      const matches = findRuleMatches(this.db, filter.rule, this.now(), messageIds);
      if (matches.messageIds.length === 0) continue;
      try {
        // claims + actions + ops atomically (savepoint when nested in an ingest slice)
        const changed = this.db.tx(() => this.runFilterActions(filter.rule.actions, claimFilterApplications(this.db, filter.id, matches.messageIds, this.now())));
        for (const id of changed) touched.add(id);
      } catch (error) {
        // e.g. the filter points at a deleted category: skip it, keep ingesting
        this.log("warn", `filter ${filter.id} (${filter.name}) failed`, error instanceof Error ? error.message : error);
      }
    }
    return touched;
  }

  runFilterActions(actions: FilterAction[], messageIds: number[]): Set<number> {
    const touched = new Set<number>();
    if (messageIds.length === 0) return touched;
    for (const action of actions) {
      if (action.type === "addCategory") {
        const threads = this.db
          .all<{ thread_id: number }>(
            "SELECT DISTINCT thread_id FROM messages WHERE id IN (SELECT value FROM json_each(?))",
            JSON.stringify(messageIds),
          )
          .map((r) => r.thread_id);
        addThreadsToCategory(this.db, action.categoryId, threads, "filter", this.now());
        for (const t of threads) touched.add(t);
      } else {
        const result = applyMessageAction(this.db, messageIds, action.type);
        this.queueActionOps(result, action.type);
        for (const t of result.threadIds) touched.add(t);
      }
    }
    return touched;
  }

  // ───────────────────────────── ingestion (time-sliced) ─────────────────────────────

  /**
   * Ingests in slices sized to ~sliceBudgetMs and yields between slices so
   * interactive RPCs (list, search, open) interleave with big imports.
   */
  async ingestSliced(messages: IncomingMessage[], applyFilters = true): Promise<{ inserted: number[] }> {
    const inserted: number[] = [];
    await this.runSliced(messages, 50, (chunk) => {
      // One transaction per slice: messages, filter claims, filter actions and their ops
      // commit together, so a crash can't record a filter as applied without its effects.
      const touched = this.db.tx(() => {
        const result = ingestMessages(this.db, chunk, this.now());
        inserted.push(...result.inserted);
        const t = new Set(result.touchedThreads);
        if (applyFilters) {
          for (const x of this.applyFiltersTo(result.inserted)) t.add(x);
          // bodies that arrived through an upsert may now satisfy body filters
          for (const x of this.applyFiltersTo(result.bodyCompleted, true)) t.add(x);
        }
        return t;
      });
      this.notifyChanged(touched);
    });
    return { inserted };
  }

  /**
   * Processes items in slices whose size adapts so each slice takes about
   * sliceBudgetMs, yielding to the event loop in between. Any background job
   * (import, bulk filter) must go through here so it never blocks interactive
   * RPCs for longer than one slice.
   */
  async runSliced<T>(items: readonly T[], initialSize: number, work: (chunk: T[]) => void): Promise<void> {
    let size = initialSize;
    for (let i = 0; i < items.length && !this.stopped; ) {
      const started = performance.now();
      const chunk = items.slice(i, i + size);
      work(chunk);
      i += chunk.length;
      const took = performance.now() - started;
      // shrink immediately when over budget, grow cautiously (≤1.25× per slice) to avoid overshoot
      const ideal = (size * this.options.sliceBudgetMs) / Math.max(took, 0.25);
      size = Math.max(1, Math.min(1000, Math.round(Math.min(ideal, size * 1.25))));
      await yieldToLoop();
    }
  }

  // ───────────────────────────── providers & sync ─────────────────────────────

  provider(accountId: number): MailProvider | null {
    const existing = this.providers.get(accountId);
    if (existing) return existing;
    const account = getAccount(this.db, accountId);
    if (!account) return null;
    const cfg = getAccountConfig<Record<string, unknown>>(this.db, accountId)!;
    const provider = this.options.providers.create({
      db: this.db,
      account,
      config: cfg.config,
      getSecret: (name) => this.getSecret(`account:${accountId}:${name}`),
      setSecret: (name, value) => this.setSecret(`account:${accountId}:${name}`, value),
      getAppSecret: (name) => this.getSecret(name),
      loadCursor: <T,>() => (getAccountConfig<{ cursor?: T }>(this.db, accountId)?.config.cursor ?? null) as T | null,
      saveCursor: (cursor) => {
        const current = getAccountConfig<Record<string, unknown>>(this.db, accountId);
        if (current) setAccountProviderConfig(this.db, accountId, { ...current.config, cursor });
      },
    });
    this.providers.set(accountId, provider);
    return provider;
  }

  startAccount(account: Account): void {
    const provider = this.provider(account.id);
    if (!provider) return;
    if (provider.watch && !this.unwatch.has(account.id)) {
      this.unwatch.set(account.id, provider.watch(() => void this.syncAccount(account.id)));
    }
    void this.syncAccount(account.id);
  }

  async dropAccount(accountId: number): Promise<void> {
    this.unwatch.get(accountId)?.();
    this.unwatch.delete(accountId);
    await this.syncing.get(accountId)?.catch(() => {});
    await this.providers.get(accountId)?.close().catch(() => {});
    this.providers.delete(accountId);
  }

  syncAccount(accountId: number): Promise<void> {
    const running = this.syncing.get(accountId);
    if (running) {
      // Don't drop the notification (IDLE/push during a long sync): schedule one more pass.
      this.syncAgain.add(accountId);
      return running.then(() => this.syncing.get(accountId));
    }
    const provider = this.provider(accountId);
    if (!provider) return Promise.resolve();
    const setState = (patch: Partial<AccountSyncState>) => {
      setAccountSyncState(this.db, accountId, patch);
      this.emitAccounts();
    };
    const sink: SyncSink = {
      signal: this.abort.signal,
      ingest: async (messages) => {
        await this.ingestSliced(messages);
      },
      windowStart: this.now() - readSettings(this.db).syncWindowDays * 86_400_000,
      updateFlags: async (updates) => {
        const touched = new Set<number>();
        const columns: Record<string, string> = { isRead: "is_read", isStarred: "is_starred", inInbox: "in_inbox", isTrash: "is_trash", isSpam: "is_spam", isSent: "is_sent", isDraft: "is_draft" };
        await this.runSliced(updates, 200, (chunk) => {
          this.db.tx(() => {
            // read inside this slice's transaction: a user action between slices is honoured
            const pending = messagesWithPendingOps(this.db, accountId);
            const threads = new Set<number>();
            for (const u of chunk) {
              // optimistic local state wins until its op settles
              if (pending.has(u.messageId)) continue;
              const sets = Object.entries(u.flags).filter(([k]) => columns[k]);
              if (!sets.length) continue;
              const r = this.db.get<{ thread_id: number }>(
                `UPDATE messages SET ${sets.map(([k]) => `${columns[k]} = ?`).join(", ")} WHERE id = ? AND account_id = ? RETURNING thread_id`,
                ...sets.map(([, v]) => (v ? 1 : 0)),
                u.messageId,
                accountId,
              );
              if (r) threads.add(r.thread_id);
            }
            recomputeThreads(this.db, threads);
            for (const t of threads) touched.add(t);
          });
        });
        this.notifyChanged(touched);
      },
      setBody: async (messageId, text, html) => {
        setMessageBody(this.db, messageId, text, html, "full");
        const owner = this.db.get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE id = ?", messageId);
        if (owner) recomputeThreads(this.db, [owner.thread_id]);
        const touched = this.applyFiltersTo([messageId], true);
        const thread = this.db.get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE id = ?", messageId);
        if (thread) touched.add(thread.thread_id);
        this.notifyChanged(touched, false);
      },
      removeMessages: async (ids) => {
        this.notifyChanged(deleteMessages(this.db, ids));
      },
      pendingMessageIds: () => messagesWithPendingOps(this.db, accountId),
      setSyncState: setState,
    };
    const run = (async () => {
      setState({ status: "syncing" });
      try {
        await provider.sync(sink);
        setState({ status: "idle", lastError: null, lastSyncAt: this.now() });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log("warn", `sync failed for account ${accountId}`, message);
        setState({ status: error instanceof ProviderError && error.retryable ? "offline" : "error", lastError: message });
      } finally {
        this.syncing.delete(accountId);
        if (this.syncAgain.delete(accountId) && !this.stopped) void this.syncAccount(accountId);
      }
    })();
    this.syncing.set(accountId, run);
    return run;
  }

  // ───────────────────────────── ops worker ─────────────────────────────

  kickWorker(): void {
    if (this.options.autoSync === false || this.stopped) return;
    this.workerKicked = true;
    if (this.workerRunning) return;
    if (this.workerTimer) clearTimeout(this.workerTimer);
    this.workerTimer = setTimeout(() => void this.runWorker(), 0);
  }

  /** Processes ready ops until none remain; ops of one account run in sequence order. */
  async runWorker(): Promise<number> {
    if (this.workerRunning) return 0;
    this.workerRunning = true;
    let processed = 0;
    try {
      do {
        this.workerKicked = false;
        for (;;) {
          const batch = claimReadyOps(this.db, this.now(), 25);
          if (batch.length === 0) break;
          const byAccount = new Map<number, OpRow[]>();
          for (const op of batch) byAccount.set(op.account_id, [...(byAccount.get(op.account_id) ?? []), op]);
          await Promise.all(
            [...byAccount.values()].map(async (ops) => {
              for (const op of ops) await this.executeOp(op);
            }),
          );
          processed += batch.length;
        }
      } while (this.workerKicked && !this.stopped);
    } finally {
      this.workerRunning = false;
    }
    this.scheduleRetry();
    return processed;
  }

  private scheduleRetry(): void {
    if (this.stopped || this.options.autoSync === false) return;
    const next = this.db.get<{ t: number | null }>("SELECT min(next_attempt_at) AS t FROM ops WHERE state = 'queued'")?.t;
    if (next === null || next === undefined) return;
    if (this.workerTimer) clearTimeout(this.workerTimer);
    this.workerTimer = setTimeout(() => void this.runWorker(), Math.max(0, next - this.now()));
  }

  private async executeOp(op: OpRow): Promise<void> {
    const provider = this.provider(op.account_id);
    const target = JSON.parse(op.target_json) as { messageIds?: number[] };
    try {
      if (!provider) throw new ProviderError("Account no longer exists", false);
      const result = await provider.execute({ id: op.id, kind: op.kind, target, payload: JSON.parse(op.payload_json) });
      if (this.stopped && !this.db.raw.isOpen) return;
      this.db.tx(() => {
        completeOp(this.db, op.id, this.now());
        if (result?.warning) this.db.run("UPDATE ops SET last_error = ? WHERE id = ?", result.warning, op.id);
        const localId = target.messageIds?.[0];
        if (op.kind === "send" && result && localId) {
          if (result.providerMsgId) {
            this.db.run("UPDATE messages SET provider_msg_id = ? WHERE id = ? AND provider_msg_id LIKE 'local:%'", result.providerMsgId, localId);
          }
          if (result.providerThreadId) {
            // a conversation we started gets its Gmail thread id, so replies land in it
            const row = this.db.get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE id = ?", localId);
            if (row) this.notifyChanged([adoptProviderThread(this.db, row.thread_id, op.account_id, result.providerThreadId)]);
          }
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof ProviderError && error.ambiguous) markOpUnknown(this.db, op.id, message, this.now());
      else failOp(this.db, op.id, message, error instanceof ProviderError ? error.retryable : true, this.now());
    }
    const info = this.opInfo(getOp(this.db, op.id)!);
    this.server.emit("op", info);
  }

  opInfo(op: OpRow): OpInfo {
    const payload = JSON.parse(op.payload_json) as { subject?: string };
    const n = (JSON.parse(op.target_json) as { messageIds?: number[] }).messageIds?.length ?? 0;
    return {
      id: op.id,
      accountId: op.account_id,
      kind: op.kind,
      state: op.state,
      attempts: op.attempts,
      lastError: op.last_error,
      createdAt: op.created_at,
      summary: op.kind === "send" ? `Send “${payload.subject ?? ""}”` : `${op.kind} · ${n} message${n === 1 ? "" : "s"}`,
    };
  }

  // ───────────────────────────── AI ─────────────────────────────

  async ai(): Promise<AiProvider | null> {
    const settings = readSettings(this.db);
    if (settings.aiProvider === "none") return null;
    const factory = this.options.aiFactory ?? defaultAiFactory;
    return factory(settings.aiProvider, { apiKey: await this.getSecret("anthropicApiKey"), model: settings.aiModel });
  }

  newMessageId(email: string): string {
    const domain = email.split("@")[1] || "unica.local";
    return `${randomUUID()}@${domain}`;
  }
}
