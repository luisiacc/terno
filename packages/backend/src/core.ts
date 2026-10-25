import type { AiTasks } from "@terno/ai";
import type { Account, AccountSyncState, ThreadAction } from "@terno/core";
import { breadcrumb, captureError, log, type FieldValueOf } from "@terno/core/diag";
import { RpcServer, type AppSettings, type CallContext, type HostInfo, type MethodName, type OpInfo, type Transport } from "@terno/core/rpc";
import type { ClassifierInput, IncomingMessage, MailStore, OpRow, Platform } from "@terno/store";
import { ProviderAuthError, ProviderError, type MailProvider, type ProviderRegistry, type SyncSink } from "@terno/mail/portable";
import { AiService, defaultAiFactory, type AiFactory } from "./ai-service";
import { AiAssist } from "./ai-assist";
import { Categorizer } from "./categorizer";
import { createHandlers } from "./handlers";
import { restorePending } from "./import";
import { blobFingerprint, migrateLegacySecrets, readKeychainState, SecretUnreadableError, type LegacySecretReader } from "./keychain";
import { createNetworkPolicy, type LookupAll, type NetworkPolicy } from "./net-policy";
import { readAutoCategorize, readLocalMode, readPolicy, readSettings } from "./settings";
import { BULK_SLICE, SliceSizer, type SliceBudget } from "./slicer";

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


/** Electron and the Node dev host: everything. */
export const FULL_HOST: HostInfo = { kind: "desktop", capabilities: { imap: true, agents: true, backgroundSync: true, network: "pinned" } };

export interface BackendCoreOptions {
  store: MailStore;
  /** ids, event-loop yields and files */
  platform: Platform;
  version: string;
  cipher: SecretCipher;
  providers: ProviderRegistry;
  aiFactory?: AiFactory;
  /** offer the offline demo model in Settings (dev, demo and test hosts) */
  demoAi?: boolean;
  /** demo build: no owner identity (defaults to true with the demo provider registry) */
  demo?: boolean;
  /** backend-dev E2E only: let the demo registry's no-op verification establish an owner */
  allowDemoOwnerClaims?: boolean;
  /** the host enforces the policy outside the backend too (Electron main fences the renderer) */
  onPolicy?: (policy: { localMode: boolean; errorReports: "ask" | "always" | "never"; language: AppSettings["language"] }) => void;
  openExternal?: (url: string) => Promise<void>;
  now?: () => number;
  log?: (level: "info" | "warn" | "error", message: string, extra?: unknown) => void;
  /** start sync loops and the ops worker on start() (tests disable) */
  autoSync?: boolean;
  syncIntervalMs?: number;
  /** target duration of one ingestion/filter slice before yielding to interactive RPCs */
  sliceBudgetMs?: number;
  /** DNS for the network policy; without it (browsers) only literal loopback hosts count as local and nothing is pinned */
  lookup?: LookupAll;
  /** the host's kind and capabilities, reported to the renderer (default: everything, as on desktop) */
  host?: HostInfo;
  /** desktop: opens secrets sealed under Única's keychain item, so start() seals them again under Terno's (see keychain.ts) */
  legacySecrets?: LegacySecretReader;
}

const COUNTS_EVERY_MS = 200;

const accountKindOf = (kind: string | undefined): FieldValueOf<"accountKind"> => (kind === "imap" || kind === "gmail" ? kind : "other");
const OP_KINDS = new Set<string>(["archive", "trash", "spam", "notSpam", "moveToInbox", "markRead", "markUnread", "star", "unstar", "send", "move"]);
const opKindOf = (kind: string): FieldValueOf<"opKind"> => (OP_KINDS.has(kind) ? (kind as FieldValueOf<"opKind">) : "other");
const AUTO_NOTICE_GATHER_MS = 1500;
const AUTO_NOTICE_EVERY_MS = 30_000;

const DESTRUCTIVE_OR_SIGNAL: Partial<Record<ThreadAction, "archive" | "trash" | "spam" | "star">> = {
  archive: "archive",
  trash: "trash",
  spam: "spam",
  star: "star",
};

/**
 * The single domain writer. Owns the store, the RPC surface, provider
 * operations and sync. Portable: Electron's utility process and the Node
 * hosts run it as `Backend` (node:sqlite defaults), the web runs it in a
 * dedicated worker on SQLite-WASM. Serves any number of transports
 * (renderer, MCP, dev WS, MessagePort).
 */
export class BackendCore {
  readonly store: MailStore;
  readonly server: RpcServer;
  readonly options: Required<Pick<BackendCoreOptions, "now" | "sliceBudgetMs" | "syncIntervalMs">> & BackendCoreOptions;
  private readonly providers = new Map<number, Promise<MailProvider | null>>();
  private readonly syncing = new Map<number, Promise<void>>();
  /** a change arrived while syncing: run another pass when the current one ends */
  private readonly syncAgain = new Set<number>();
  private readonly unwatch = new Map<number, () => void>();
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private workerTimer: ReturnType<typeof setTimeout> | null = null;
  private workerRunning = false;
  private workerKicked = false;
  private stopped = false;
  /** quitting or updating (quiesce): no op starts; claimed ones go back to the queue */
  private draining = false;
  /** sends talking to their server right now, and who waits for them to finish */
  private sendsInFlight = 0;
  /** claimed by the worker, not yet at their provider: quiesce gives them back at once */
  private readonly undispatched = new Set<string>();
  private sendsSettled: (() => void)[] = [];
  private pendingThreadIds = new Set<number>();
  private pendingViews = false;
  private flushScheduled = false;
  private lastCountsAt = -Infinity;
  private countsTimer: ReturnType<typeof setTimeout> | null = null;
  readonly searchSeq = new Map<string, number>();
  /** each client's search in flight: a newer one aborts it (slow paths stop early) */
  readonly searchAborts = new Map<string, AbortController>();
  readonly abort = new AbortController();
  readonly platform: Platform;
  /** the only way out of the backend: every outbound request asks it first */
  readonly net: NetworkPolicy;
  readonly aiService: AiService;
  readonly categorizer: Categorizer;
  readonly aiAssist: AiAssist;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  /** auto-filed threads waiting to be announced, per category */
  private readonly autoNotices = new Map<number, { threadIds: Set<number>; timer: ReturnType<typeof setTimeout> | null; lastAt: number }>();

  constructor(options: BackendCoreOptions) {
    // explicit `undefined` must not clobber defaults
    const defined = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) as BackendCoreOptions;
    this.options = { now: Date.now, sliceBudgetMs: 8, syncIntervalMs: 120_000, ...defined };
    this.platform = options.platform;
    this.store = options.store;
    this.net = createNetworkPolicy({ localMode: () => readLocalMode(this.store), lookup: options.lookup });
    this.aiService = new AiService(this, options.aiFactory ?? defaultAiFactory);
    this.categorizer = new Categorizer(this);
    this.aiAssist = new AiAssist(this);
    this.ready = this.init();
    this.server = new RpcServer(createHandlers(this), {
      onError: (error, method, payload) => {
        // the original failure, captured once here (an RpcError wrapping it carries it as its cause)
        const original = error instanceof Error && error.cause !== undefined ? error.cause : error;
        captureError(original, { code: "rpc.handler_threw", fields: { method, rpcCode: payload.code }, expected: false });
        this.log("error", `rpc ${method} failed`, original instanceof Error ? original.stack : original);
      },
      authorize: async (method, ctx) => {
        await this.ready;
        return this.authorize(method, ctx);
      },
    });
  }

  /** Startup reads: the persisted model and crash recovery of ops, before any RPC or worker runs. */
  readonly ready: Promise<void>;

  /** the MCP socket (desktop, the Node dev host), set by startAgentSocket */
  agents: { connected(): number; tokenSince(): number; rotate(): { disconnected: number; tokenSince: number } } | null = null;

  get host(): HostInfo {
    return this.options.host ?? FULL_HOST;
  }

  private async init(): Promise<void> {
    await this.categorizer.load();
    const recovered = await this.store.ops.recover(this.now());
    if (recovered.requeued || recovered.unknown) {
      log.info("ops.recovered", { count: recovered.requeued + recovered.unknown });
      this.log("info", "recovered ops after restart", recovered);
    }
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

  /** Starts background work (model rebuild, unfinished moves, sync loops, the ops worker); resolves once they are scheduled. */
  async start(): Promise<void> {
    await this.ready;
    if (this.stopped) return;
    // before anything syncs: secrets sealed by Única are sealed again (or stay pending, and Settings asks for them)
    if (this.options.legacySecrets) {
      await migrateLegacySecrets(this.store, this.options.cipher, this.options.legacySecrets, (level, message) => this.log(level, message)).catch((error: unknown) => {
        captureError(error, { code: "keychain.migration_failed" });
        this.log("warn", "keychain migration failed; it is retried on the next start", error instanceof Error ? error.message : error);
      });
      if (this.stopped) return;
    }
    if (!this.categorizer.ready) void this.categorizer.rebuild();
    // a resume that fails waits for the next start (its journal is intact); it must never crash the backend
    for (const m of await this.store.categories.unfinishedMoves()) {
      this.finishMove(m.batchId).catch((error: unknown) => {
        captureError(error, { code: "move.resume_failed" });
        this.log("warn", `move ${m.batchId} couldn't be resumed`, error instanceof Error ? error.message : error);
      });
    }
    if (this.options.autoSync === false) return;
    this.idleTimer = setInterval(() => void this.categorizer.idle(), 10 * 60_000);
    this.idleTimer.unref?.();
    for (const account of await this.store.accounts.list()) this.startAccount(account);
    this.syncTimer = setInterval(() => {
      void this.store.accounts.list().then((accounts) => {
        for (const account of accounts) void this.syncAccount(account.id);
      });
    }, this.options.syncIntervalMs);
    this.kickWorker();
  }

  /**
   * Before a quit or an update: no op starts from now on (claimed ones go
   * back to the queue untouched), and a send already talking to its server
   * gets until `deadlineMs`. "sending" means one still is: the caller either
   * resumes and asks again once sends settle, or stops anyway (the send is
   * then recovered as unknown, never resent).
   */
  async quiesce(deadlineMs: number): Promise<"idle" | "sending"> {
    this.draining = true;
    if (this.workerTimer) clearTimeout(this.workerTimer);
    this.workerTimer = null;
    // the rest of a claimed batch (behind a slow op of the same account) goes back now, before any answer:
    // a send waiting there must never be left "running" for recovery to call unknown
    for (const id of this.undispatched) {
      this.undispatched.delete(id);
      await this.store.ops.release(id, this.now());
    }
    if (this.sendsInFlight === 0) return "idle";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      this.sendsIdle().then(() => true),
      new Promise<boolean>((r) => (timer = setTimeout(() => r(false), Math.max(0, deadlineMs)))),
    ]);
    clearTimeout(timer);
    return settled ? "idle" : "sending";
  }

  /** The quit or update was put off: ops run again. */
  resume(): void {
    if (!this.draining) return;
    this.draining = false;
    this.kickWorker();
  }

  /** Resolves once no send is in flight. */
  sendsIdle(): Promise<void> {
    return this.sendsInFlight === 0 ? Promise.resolve() : new Promise((r) => this.sendsSettled.push(r));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    if (this.syncTimer) clearInterval(this.syncTimer);
    if (this.idleTimer) clearInterval(this.idleTimer);
    if (this.countsTimer) clearTimeout(this.countsTimer);
    for (const n of this.autoNotices.values()) if (n.timer) clearTimeout(n.timer);
    this.categorizer.stop();
    this.aiAssist.stop();
    if (this.workerTimer) clearTimeout(this.workerTimer);
    for (const off of this.unwatch.values()) off();
    await Promise.allSettled(this.syncing.values());
    // let an in-flight ops batch finish writing before the database closes
    for (let i = 0; this.workerRunning && i < 200; i++) await new Promise((r) => setTimeout(r, 10));
    await Promise.allSettled([...this.providers.values()].map(async (p) => (await p)?.close()));
    await this.ready.catch(() => {});
    try {
      await this.categorizer.persist();
    } catch (error) {
      captureError(error, { code: "categorize.persist_failed" });
      this.log("warn", "could not persist the categorization model", error instanceof Error ? error.message : error);
    }
    await this.store.close();
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
    // agents can ask what the engine thinks and file in bulk (as agents: half weight)
    "categorize.predict",
    "categorize.suggestions",
    "categorize.count",
    "categorize.preview",
    "categorize.apply",
    "counts.get",
    "filters.list",
    "filters.save",
    "filters.preview",
    "drafts.save",
    "drafts.list",
    "compose.send",
  ]);

  private async authorize(method: MethodName, ctx: CallContext): Promise<boolean> {
    if (ctx.origin !== "mcp") return true;
    if (!BackendCore.MCP_ALLOWED.has(method)) return false;
    if (method === "compose.send") return (await readSettings(this.store)).allowAgentSend;
    return true;
  }

  // ───────────────────────────── secrets ─────────────────────────────

  /** null: none saved. Throws SecretUnreadableError when one is saved but can't be opened (sealed by Única and not migrated, or refused by the keychain). */
  async getSecret(name: string): Promise<string | null> {
    const blob = await this.store.secrets.get(name);
    if (!blob) return null;
    if ((await readKeychainState(this.store))?.pending[name] === blobFingerprint(blob)) throw new SecretUnreadableError(name, true);
    try {
      return await this.options.cipher.decrypt(blob);
    } catch (error) {
      log.warn("secret.unreadable", { op: "decrypt" });
      this.log("warn", `secret ${name} couldn't be opened`, error instanceof Error ? error.message : error);
      throw new SecretUnreadableError(name, false);
    }
  }

  async setSecret(name: string, value: string): Promise<void> {
    await this.store.secrets.put(name, await this.options.cipher.encrypt(value));
  }

  // ───────────────────────────── events ─────────────────────────────

  /** Coalesces change notifications within one turn of the event loop. */
  notifyChanged(threadIds: Iterable<number>, views = true): void {
    for (const id of threadIds) this.pendingThreadIds.add(id);
    this.pendingViews ||= views;
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    void this.platform.yield().then(() => {
      this.flushScheduled = false;
      if (this.stopped) return;
      const threadIds = [...this.pendingThreadIds];
      const views = this.pendingViews;
      this.pendingThreadIds.clear();
      this.pendingViews = false;
      this.server.emit("changed", { threadIds, views });
      this.emitCounts();
    });
  }

  /**
   * Sidebar counts cost a couple of milliseconds: once per ingestion slice
   * that is a quarter of an 8 ms slice. Leading edge immediately, then at
   * most every COUNTS_EVERY_MS (trailing), so the last state always arrives.
   */
  private emitCounts(): void {
    const wait = this.lastCountsAt + COUNTS_EVERY_MS - performance.now();
    if (wait <= 0 && !this.countsTimer) {
      this.lastCountsAt = performance.now();
      void this.sendCounts();
      return;
    }
    if (this.countsTimer) return;
    this.countsTimer = setTimeout(() => {
      this.countsTimer = null;
      if (this.stopped) return;
      this.lastCountsAt = performance.now();
      void this.sendCounts();
    }, Math.max(0, wait));
  }

  private async sendCounts(): Promise<void> {
    const counts = await this.store.threads.counts();
    if (!this.stopped) this.server.emit("counts", counts);
  }

  async emitAccounts(): Promise<void> {
    this.server.emit("accounts", await this.store.accounts.list());
  }

  /** Tells the host the current policy (at startup and whenever local mode changes). */
  async publishPolicy(): Promise<void> {
    this.options.onPolicy?.(await readPolicy(this.store));
  }

  async emitOwner(): Promise<void> {
    // the person's identity is for the user's own windows, never for agents
    this.server.emit("owner", await this.store.owner.get(), { origins: ["renderer", "dev"] });
  }

  // ───────────────────────────── owner identity ─────────────────────────────

  get demo(): boolean {
    return this.options.demo ?? (this.options.providers.kind === "demo" && !this.options.allowDemoOwnerClaims);
  }

  /** Only a real verification establishes an owner: never demo builds or the demo registry's no-op checks. */
  canClaimOwner(): boolean {
    if (this.demo) return false;
    return this.options.providers.kind !== "demo" || this.options.allowDemoOwnerClaims === true;
  }

  // ───────────────────────────── actions → ops ─────────────────────────────

  /** A store command queued provider ops: run them. */
  opsQueued(opIds: readonly string[]): void {
    if (opIds.length) this.kickWorker();
  }

  static learningSignal(action: ThreadAction) {
    return DESTRUCTIVE_OR_SIGNAL[action];
  }

  // ───────────────────────────── ingestion (time-sliced) ─────────────────────────────

  /**
   * Ingests in slices sized to ~sliceBudgetMs and yields between slices so
   * interactive RPCs (list, search, open) interleave with big imports.
   */
  async ingestSliced(messages: IncomingMessage[], applyFilters = true): Promise<{ inserted: number[] }> {
    const inserted: number[] = [];
    await this.runSliced(messages, 50, async (chunk) => {
      // one store command per slice: messages, filter claims and actions with their ops, and
      // the categorizer's decisions commit together
      const r = await this.store.sync.ingest(chunk, { applyFilters, now: this.now(), classifier: await this.classifier() });
      inserted.push(...r.inserted);
      // RAM follows the database, never the other way round
      this.categorizer.apply(r.deltas);
      this.categorizer.noteBackfill(r.backfill);
      // the optional AI looks at what the engine was unsure about, after commit, outside the slice
      void this.aiAssist.enqueue(r.uncertain);
      this.announceAuto(r.auto);
      this.opsQueued(r.opIds);
      this.notifyChanged(r.touched);
    });
    return { inserted };
  }

  /** The categorizer's pure part of an ingestion command (null until a model is ready). */
  async classifier(): Promise<ClassifierInput | null> {
    const model = this.categorizer.model;
    return model ? { model, mode: await readAutoCategorize(this.store) } : null;
  }

  /** One "Terno añadió N conversaciones a X" per category at most every 30 s. */
  private announceAuto(auto: Map<number, number[]>): void {
    for (const [categoryId, threadIds] of auto) {
      let n = this.autoNotices.get(categoryId);
      if (!n) this.autoNotices.set(categoryId, (n = { threadIds: new Set(), timer: null, lastAt: 0 }));
      for (const t of threadIds) n.threadIds.add(t);
      if (n.timer) continue;
      const notice = n;
      const wait = Math.max(AUTO_NOTICE_GATHER_MS, notice.lastAt + AUTO_NOTICE_EVERY_MS - Date.now());
      notice.timer = setTimeout(() => {
        notice.timer = null;
        if (this.stopped || notice.threadIds.size === 0) return;
        notice.lastAt = Date.now();
        this.server.emit("categorized", { categoryId, threadIds: [...notice.threadIds], by: "auto" });
        notice.threadIds.clear();
      }, wait);
      notice.timer.unref?.();
    }
  }

  private readonly moves = new Map<number, Promise<void>>();

  /**
   * Runs (or joins) whatever a move still has to do, in slices: its
   * memberships ("moving"), its training, an undo's memberships
   * ("unmoving") and its example restore. Resumable: progress is per thread
   * in the journal, so after a crash start() picks it up. `tally` collects
   * what an undo's slices took out and put back.
   */
  finishMove(batchId: number, tally?: { removed: Set<number>; restored: Set<number> }): Promise<void> {
    const running = this.moves.get(batchId);
    if (running) return running.then(() => (tally ? this.finishMove(batchId, tally) : undefined));
    const job = (async () => {
      await this.platform.yield();
      for (;;) {
        const phase = await this.store.categories.movePhase(batchId);
        if (phase !== "moving" && phase !== "training" && phase !== "unmoving" && phase !== "restoring") return;
        const pending = await this.store.categories.movePending(batchId);
        if (pending.length === 0) return;
        // a thread can mean 20 rows (one per category) or 20 examples: slices are sized by the time they take
        await this.runBudgeted(pending, async (chunk) => {
            const now = this.now();
            if (phase === "moving") {
              const r = await this.store.categories.applyMoveSlice(batchId, chunk, now);
              this.categorizer.apply(r.deltas);
              this.notifyChanged(r.touched);
            } else if (phase === "unmoving") {
              const r = await this.store.categories.undoMoveSlice(batchId, chunk, now);
              this.categorizer.apply(r.deltas);
              for (const t of r.removed) tally?.removed.add(t);
              for (const t of r.restored) tally?.restored.add(t);
              this.notifyChanged([...r.removed, ...r.restored]);
            } else {
              this.categorizer.apply(phase === "training" ? await this.store.categories.trainMoveSlice(batchId, chunk, now) : await this.store.categories.restoreMoveSlice(batchId, chunk));
            }
        });
        if (this.stopped) return;
      }
    })().finally(() => this.moves.delete(batchId));
    this.moves.set(batchId, job);
    return job;
  }

  /**
   * Processes items in slices whose size adapts so each slice takes about
   * sliceBudgetMs, yielding to the event loop in between. Any background job
   * (import, bulk filter) must go through here so it never blocks interactive
   * RPCs for longer than one slice.
   */
  async runSliced<T>(items: readonly T[], initialSize: number, work: (chunk: T[]) => void | Promise<void>, budgetMs = this.options.sliceBudgetMs): Promise<void> {
    let size = initialSize;
    for (let i = 0; i < items.length && !this.stopped; ) {
      const started = performance.now();
      const chunk = items.slice(i, i + size);
      await work(chunk);
      i += chunk.length;
      const took = performance.now() - started;
      // shrink immediately when over budget, grow cautiously (≤1.25× per slice, but at least +1: from 1 it must still grow)
      const ideal = (size * budgetMs) / Math.max(took, 0.25);
      size = Math.max(1, Math.min(1000, Math.floor(Math.min(ideal, Math.max(size + 1, size * 1.25)))));
      await this.platform.yield();
      await this.store.settle?.();
    }
  }

  /**
   * Bulk work the user started (scope actions, moves and their undo, large
   * filings) in time-budgeted slices: each sized from how long the previous
   * ones took (see slicer.ts), a yield between them and whatever the store
   * needs to catch up (settle).
   */
  async runBudgeted<T>(items: readonly T[], work: (chunk: T[]) => void | Promise<void>, budget: Partial<SliceBudget> = {}): Promise<void> {
    const sizer = new SliceSizer({ ...BULK_SLICE, ...budget });
    for (let i = 0; i < items.length && !this.stopped; ) {
      const chunk = items.slice(i, i + sizer.size);
      const started = performance.now();
      await work(chunk);
      sizer.record(chunk.length, performance.now() - started);
      i += chunk.length;
      await this.yieldTurn();
      await this.store.settle?.();
    }
  }

  /**
   * Gives the event loop a whole turn: work the slice scheduled for the next
   * one (the changed event, sidebar counts) runs there, and the next slice
   * only in the turn after, never back to back with it.
   */
  async yieldTurn(): Promise<void> {
    await this.platform.yield();
    await this.platform.yield();
  }

  // ───────────────────────────── providers & sync ─────────────────────────────

  provider(accountId: number): Promise<MailProvider | null> {
    const existing = this.providers.get(accountId);
    if (existing) return existing;
    const created = (async () => {
      const account = await this.store.accounts.get(accountId);
      const cfg = await this.store.accounts.config<Record<string, unknown>>(accountId);
      if (!account || !cfg) return null;
      return this.options.providers.create({
        store: this.store.providerStore(accountId),
        account,
        config: cfg.config,
        // an unreadable password or token is a sign-in to redo: ops wait for it, Settings shows the account's error with its fix
        getSecret: (name) =>
          this.getSecret(`account:${accountId}:${name}`).catch((error: unknown) => {
            throw error instanceof SecretUnreadableError ? new ProviderAuthError(error.message) : error;
          }),
        setSecret: (name, value) => this.setSecret(`account:${accountId}:${name}`, value),
        getAppSecret: (name) => this.getSecret(name),
        loadCursor: async <T,>() => ((await this.store.accounts.config<{ cursor?: T }>(accountId))?.config.cursor ?? null) as T | null,
        // one store command: a read here and a write later would undo a preference saved in between
        saveCursor: (cursor) => this.store.accounts.setCursor(accountId, cursor),
        fetch: this.net.fetchFor("mail"),
      });
    })();
    this.providers.set(accountId, created);
    // a missing account is not cached: it may be created later under a fresh id only, but don't pin null
    void created.then((p) => {
      if (!p && this.providers.get(accountId) === created) this.providers.delete(accountId);
    });
    return created;
  }

  startAccount(account: Account): void {
    void this.provider(account.id).then((provider) => {
      if (!provider || this.stopped) return;
      if (provider.watch && !this.unwatch.has(account.id)) {
        this.unwatch.set(account.id, provider.watch(() => void this.syncAccount(account.id)));
      }
      void this.syncAccount(account.id);
    });
  }

  async dropAccount(accountId: number): Promise<void> {
    this.unwatch.get(accountId)?.();
    this.unwatch.delete(accountId);
    await this.syncing.get(accountId)?.catch(() => {});
    const provider = this.providers.get(accountId);
    this.providers.delete(accountId);
    await (await provider?.catch(() => null))?.close().catch(() => {});
  }

  syncAccount(accountId: number): Promise<void> {
    const running = this.syncing.get(accountId);
    if (running) {
      // Don't drop the notification (IDLE/push during a long sync): schedule one more pass.
      this.syncAgain.add(accountId);
      return running.then(() => this.syncing.get(accountId));
    }
    const setState = async (patch: Partial<AccountSyncState>) => {
      await this.store.accounts.setSyncState(accountId, patch);
      await this.emitAccounts();
    };
    const run = (async () => {
      const provider = await this.provider(accountId);
      if (!provider) return;
      const sink: SyncSink = {
        signal: this.abort.signal,
        ingest: async (messages) => {
          await this.ingestSliced(messages);
        },
        // the account's own window, else the general one
        windowStart: this.now() - ((await this.store.accounts.get(accountId))?.syncWindowDays ?? (await readSettings(this.store)).syncWindowDays) * 86_400_000,
        updateFlags: async (updates) => {
          const touched = new Set<number>();
          await this.runSliced(updates, 200, async (chunk) => {
            for (const t of (await this.store.sync.updateFlags(accountId, chunk)).touched) touched.add(t);
          });
          this.notifyChanged(touched);
        },
        setBody: async (messageId, text, html) => {
          const r = await this.store.sync.setBody(messageId, text, html, { now: this.now(), classifier: await this.classifier() });
          this.categorizer.apply(r.deltas);
          this.announceAuto(r.auto);
          this.opsQueued(r.opIds);
          this.notifyChanged(r.touched, false);
        },
        removeMessages: async (ids) => {
          this.notifyChanged((await this.store.sync.remove(ids)).touched);
        },
        pendingMessageIds: () => this.store.sync.pendingMessageIds(accountId),
        setSyncState: (patch) => setState(patch),
      };
      await setState({ status: "syncing" });
      const accountKind = accountKindOf((await this.store.accounts.get(accountId))?.kind);
      const started = performance.now();
      try {
        await provider.sync(sink);
        breadcrumb("sync", "sync.done", { accountKind, durationMs: performance.now() - started });
        await setState({ status: "idle", lastError: null, lastSyncAt: this.now() });
        // the account works: whatever waited for its sign-in goes now
        await this.resumeAuth(accountId);
        // its mail is here: drafts an import kept for it (answering messages that just synced) go in
        await restorePending(this, accountId).catch((error: unknown) => {
          captureError(error, { code: "import.restore_failed" });
          this.log("warn", "restoring imported items failed", error instanceof Error ? error.message : error);
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // offline or a sign-in to redo is the provider's verdict (expected); anything else is ours
        captureError(error, { code: "sync.failed", fields: { accountKind, retryable: error instanceof ProviderError && error.retryable } });
        this.log("warn", `sync failed for account ${accountId}`, message);
        if (this.store.isOpen) await setState({ status: error instanceof ProviderError && error.retryable ? "offline" : "error", lastError: message });
      }
    })().finally(() => {
      this.syncing.delete(accountId);
      if (this.syncAgain.delete(accountId) && !this.stopped) void this.syncAccount(accountId);
    });
    this.syncing.set(accountId, run);
    return run;
  }

  // ───────────────────────────── ops worker ─────────────────────────────

  /** The account's authorization works again (sync succeeded, reconnected): its ops waiting for it run now. */
  async resumeAuth(accountId: number): Promise<void> {
    if ((await this.store.ops.resumeAuth(accountId, this.now())).length) this.kickWorker();
  }

  kickWorker(): void {
    if (this.options.autoSync === false || this.stopped) return;
    this.workerKicked = true;
    if (this.workerRunning || this.draining) return;
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
          if (this.draining) break;
          const batch = await this.store.ops.claimReady(this.now(), 25);
          if (batch.length === 0) break;
          for (const op of batch) this.undispatched.add(op.id);
          const byAccount = new Map<number, OpRow[]>();
          for (const op of batch) byAccount.set(op.account_id, [...(byAccount.get(op.account_id) ?? []), op]);
          await Promise.all(
            [...byAccount.values()].map(async (ops) => {
              for (const op of ops) {
                try {
                  await this.executeOp(op);
                } catch (error) {
                  // never strand the rest of the batch in "running"
                  captureError(error, { code: "ops.crashed", fields: { opKind: opKindOf(op.kind) } });
                  this.log("error", `op ${op.id} crashed`, error instanceof Error ? error.stack : error);
                  if (this.store.isOpen && (await this.store.ops.get(op.id))?.state === "running") await this.store.ops.fail(op.id, String(error), true, this.now());
                }
              }
            }),
          );
          processed += batch.length;
        }
      } while (this.workerKicked && !this.stopped && !this.draining);
    } finally {
      this.workerRunning = false;
    }
    await this.scheduleRetry();
    return processed;
  }

  private async scheduleRetry(): Promise<void> {
    if (this.stopped || this.draining || this.options.autoSync === false) return;
    const next = await this.store.ops.nextAttemptAt();
    if (next === null || this.stopped) return;
    if (this.workerTimer) clearTimeout(this.workerTimer);
    this.workerTimer = setTimeout(() => void this.runWorker(), Math.max(0, next - this.now()));
  }

  private async executeOp(claimed: OpRow): Promise<void> {
    // Re-read right before dispatch: while earlier ops of the batch ran, this one may have
    // been superseded (deleted), pruned (deleted messages) or narrowed.
    const op = await this.store.ops.get(claimed.id);
    if (!op || op.state !== "running") return void this.undispatched.delete(claimed.id);
    // quitting: an op that hasn't reached its server waits for the next start, as it was
    if (this.draining) return void (this.undispatched.delete(op.id), await this.store.ops.release(op.id, this.now()));
    const provider = await this.provider(op.account_id);
    if (this.draining) return void (this.undispatched.delete(op.id), await this.store.ops.release(op.id, this.now()));
    // from here it is on its way (synchronously after the last check: quiesce can't release it now)
    this.undispatched.delete(op.id);
    const sending = op.kind === "send";
    if (sending) this.sendsInFlight++;
    const target = JSON.parse(op.target_json) as { messageIds?: number[] };
    const started = performance.now();
    try {
      if (!provider) throw new ProviderError("Account no longer exists", false);
      const result = await provider.execute({ id: op.id, kind: op.kind, target, payload: JSON.parse(op.payload_json) });
      if (op.kind === "send") log.info("send.done", { durationMs: performance.now() - started });
      if (this.stopped && !this.store.isOpen) return;
      const done = await this.store.ops.complete(op.id, result, this.now());
      this.categorizer.apply(done.deltas);
      if (done.touched.length) this.notifyChanged(done.touched);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const pe = error instanceof ProviderError ? error : null;
      // a deleted account is gone on purpose: its ops just fail
      const expected = pe ? pe.expected || !provider : undefined;
      if (op.kind === "send") captureError(error, { code: "send.failed", fields: { retryable: pe?.retryable, ambiguous: pe?.ambiguous }, expected });
      else captureError(error, { code: "ops.failed", fields: { opKind: opKindOf(op.kind), retryable: pe?.retryable, ambiguous: pe?.ambiguous }, expected });
      if (error instanceof ProviderAuthError) await this.store.ops.awaitAuth(op.id, message, this.now());
      else if (error instanceof ProviderError && error.ambiguous) await this.store.ops.markUnknown(op.id, message, this.now());
      else await this.store.ops.fail(op.id, message, error instanceof ProviderError ? error.retryable : true, this.now());
    } finally {
      if (sending && --this.sendsInFlight === 0) for (const settle of this.sendsSettled.splice(0)) settle();
    }
    if (this.stopped && !this.store.isOpen) return;
    const after = await this.store.ops.get(op.id);
    if (after) this.server.emit("op", this.opInfo(after)); // a superseded op is simply gone
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

  /** The configured AI, ready to run tasks; throws AiError (not configured, paused by local mode, blocked). */
  ai(): Promise<AiTasks> {
    return this.aiService.current();
  }

}
