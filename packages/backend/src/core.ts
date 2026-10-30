import { ProviderCooldown } from "./provider-cooldown";
import { savedGoogleRequests, type SavedGoogleRequests } from "./google-requests";
import { copyOpAdmission, rejectedRecipients, type CooldownStamp, type OpAdmission } from "@terno/store";
import { prepareCopyWire, readCopyWire } from "./sent-copy";
import type { PendingGmailRenewal } from "./identity";
import type { AiTasks } from "@terno/ai";
import { asciiEmail, decodeText, encodeText, messageOf, textRef, type Account, type AccountSyncState, type OpState, type ThreadAction } from "@terno/core";
import { breadcrumb, captureError, log, type FieldValueOf } from "@terno/core/diag";
import { RpcError, RpcServer, type AppSettings, type CallContext, type HostInfo, type MethodName, type OpInfo, type Transport } from "@terno/core/rpc";
import { L } from "@terno/i18n";
import { AWAITING_AUTH, FlagObservationError, operationFlagFields, type FlagObservation, type ClassifierInput, type IncomingMessage, type MailStore, type OpRow, type Platform, type ProviderStore } from "@terno/store";
import { IncomingPipeline, ProviderIdentityError, ProviderCooldownError, ProviderAuthError, ProviderError, RequestNotDispatchedError, type IncomingProcessor, type MailProvider, type ProviderRegistry, type SendPayload, type SyncSink } from "@terno/mail/portable";
import { Autocomplete, DESKTOP_AUTOCOMPLETE_PEAK, DESKTOP_CONTACT_CAPS, DESKTOP_PHRASE_CAPS, WEB_AUTOCOMPLETE_PEAK, WEB_CONTACT_CAPS, WEB_PHRASE_CAPS } from "@terno/store/autocomplete";
import { AiService, defaultAiFactory, type AiFactory } from "./ai-service";
import { Connectivity, type ConnectivityOptions, type NetReason } from "./connectivity";
import { AiAssist } from "./ai-assist";
import { Attention, type AttentionHost } from "./attention";
import { hydrateSendAttachments } from "./attachments";
import { Categorizer } from "./categorizer";
import { FactsBackfill } from "./facts";
import { createHandlers } from "./handlers";
import { restorePending } from "./import";
import { blobFingerprint, migrateLegacySecrets, readKeychainState, SecretUnreadableError, type LegacySecretReader } from "./keychain";
import { createNetworkPolicy, type LookupAll, type NetworkPolicy } from "./net-policy";
import { readAutoCategorize, readComposeSuggestions, readGooglePhotos, readLocalMode, readPolicy, readSettings, readSiteIcons, setGooglePhotoState } from "./settings";
import { IconService } from "./icons/service";
import type { IconTransport } from "./icons/transport";
import { BULK_SLICE, SliceSizer, type SliceBudget } from "./slicer";
import { Evictions } from "./storage";

class FlagConnectionError extends ProviderError {
  constructor() { super(L("errors.mail.flagConnection"), false); }
  override get expected(): boolean { return true; }
}

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
  /** Lazy host worker; only a lifetime-fenced run capability reaches providers. */
  incomingProcessor?: IncomingProcessor;
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
  /** tests: the most threads a similar sweep takes on (plan 63; else the scope cap) */
  similarCap?: number;
  /** tests: the messages a similar sweep reads per page while resolving (plan 63) */
  similarPage?: number;
  /** DNS for the network policy; without it (browsers) only literal loopback hosts count as local and nothing is pinned */
  lookup?: LookupAll;
  /** the host's kind and capabilities, reported to the renderer (default: everything, as on desktop) */
  host?: HostInfo;
  /** desktop: opens secrets sealed under Única's keychain item, so start() seals them again under Terno's (see keychain.ts) */
  legacySecrets?: LegacySecretReader;
  /** plan 20: what the host says about the network at startup (default online) */
  online?: boolean;
  /** plan 20: the host drops its own pooled HTTP sockets when the network changes (Node: fetch's dispatcher) */
  onNetworkReset?: () => void;
  /** tests: the retry schedule, the offline probe and the settle delay (see connectivity.ts) */
  connectivity?: Pick<ConnectivityOptions, "delays" | "offlineRetryMs" | "settleMs" | "random">;
  /** plan 22: how website icons are fetched (Node: node-transport.ts); none: this host shows no website icons (the web) */
  iconTransport?: IconTransport | null;
  /** tests: the icon fetcher's deadlines */
  iconTimeouts?: { requestMs?: number; budgetMs?: number };
  /** plan 41: a host that shows the Dock badge and notifications itself (desktop main); without one, notices go to the page */
  attention?: AttentionHost;
}

interface AccountLifetime {
  id: number;
  abort: AbortController;
  pending: Set<Promise<unknown>>;
  removing: boolean;
  provider?: MailProvider;
}

const COUNTS_EVERY_MS = 200;

const accountKindOf = (kind: string | undefined): FieldValueOf<"accountKind"> => (kind === "imap" || kind === "gmail" ? kind : "other");
const OP_KINDS = new Set<string>(["archive", "trash", "spam", "notSpam", "moveToInbox", "markRead", "markUnread", "star", "unstar", "send", "move"]);
const opKindOf = (kind: string): FieldValueOf<"opKind"> => (OP_KINDS.has(kind) ? (kind as FieldValueOf<"opKind">) : "other");
/** plan 25: the account's sign-in was refused as a whole (not only its sending) */
const needsWholeSignIn = (s: AccountSyncState): boolean => Boolean(s.authRequired) && s.authScope !== "send";
/** plan 25: an op this refusal holds back (a refused send holds only sends) */
const heldBySignIn = (s: AccountSyncState, kind: string): boolean => Boolean(s.authRequired) && (s.authScope !== "send" || kind === "send");

const OP_SUMMARY = {
  archive: "backend.op.archive",
  trash: "backend.op.trash",
  spam: "backend.op.spam",
  notSpam: "backend.op.notSpam",
  moveToInbox: "backend.op.moveToInbox",
  markRead: "backend.op.markRead",
  markUnread: "backend.op.markUnread",
  star: "backend.op.star",
  unstar: "backend.op.unstar",
  move: "backend.op.move",
} as const;

/** What an op is, for the outbox and failure notices: English, plus the catalog message the renderer shows. */
export function opSummary(kind: string, subject: string, count: number): Pick<OpInfo, "summary" | "summaryI18n"> {
  const m = kind === "send" ? L("backend.op.send", { subject }) : Object.hasOwn(OP_SUMMARY, kind) ? L(OP_SUMMARY[kind as keyof typeof OP_SUMMARY], { count }) : L("backend.op.other", { kind, count });
  return { summary: m.message, summaryI18n: textRef(m)! };
}

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
/** plan 68: rows a folder rebuild handles per slice */
const REBUILD_SLICE = 250;

export class BackendCore {
  readonly store: MailStore;
  readonly server: RpcServer;
  readonly options: Required<Pick<BackendCoreOptions, "now" | "sliceBudgetMs" | "syncIntervalMs">> & BackendCoreOptions;
  private readonly incoming: IncomingPipeline;
  private cooldown?: ProviderCooldown;
  private readonly google = new Map<number, SavedGoogleRequests>();
  private readonly cooldownAccounts = new Map<number, CooldownStamp & { kind: string }>();
  private admissionSnapshot?: Promise<OpAdmission>;
  private cooldownVersion = 0;
  private cooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly providers = new Map<number, Promise<MailProvider | null>>();
  private readonly lifetimes = new Map<number, AccountLifetime>();
  private readonly syncing = new Map<number, Promise<void>>();
  /** a change arrived while syncing: run another pass when the current one ends */
  private readonly syncAgain = new Set<number>();
  private readonly flagSyncAgain = new Set<number>();
  /** plan 25: bumped per account each time a sign-in stores new credentials (a refusal from before doesn't count) */
  private readonly credentials = new Map<number, number>();
  /** plan 25: the Google sign-in in flight per account (a new one aborts it: one flow, one secret written) */
  readonly signIns = new Map<number, AbortController>();
  readonly gmailRenewals = new Map<number, PendingGmailRenewal>();
  private readonly credentialFlows = new Map<number, Promise<unknown>>();
  private readonly unwatch = new Map<number, () => void>();
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private workerTimer: ReturnType<typeof setTimeout> | null = null;
  private workerRunning = false;
  private workerKicked = false;
  private stopped = false;
  /** plan 69: what a storage removal took off this device, kept from sync passes that overlapped it */
  readonly evictions = new Evictions();
  /** the backend is shutting down: long jobs stop between units */
  get isStopped(): boolean {
    return this.stopped;
  }
  /** quitting or updating (quiesce): no op starts; claimed ones go back to the queue */
  private draining = false;
  /** sends talking to their server or recording its outcome, and who waits for them to finish */
  private readonly sendsInFlight = new Set<string>();
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
  /** plan 18: recipient and body suggestions, in memory, built on first use */
  readonly autocomplete: Autocomplete;
  /** plan 17: the thread facts' backfill, woken at start and by changes */
  readonly facts: FactsBackfill;
  /** plan 20: retries, offline and network changes */
  readonly connectivity: Connectivity;
  /** plan 22: sender icons (website icons and Google photos), idle until the first lookup */
  readonly icons: IconService;
  /** plan 41: the Dock badge and notifications for important new mail */
  readonly attention: Attention;
  private warming: Promise<void> | null = null;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  /** auto-filed threads waiting to be announced, per category */
  private readonly autoNotices = new Map<number, { threadIds: Set<number>; timer: ReturnType<typeof setTimeout> | null; lastAt: number }>();

  constructor(options: BackendCoreOptions) {
    // explicit `undefined` must not clobber defaults
    const defined = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) as BackendCoreOptions;
    this.options = { now: Date.now, sliceBudgetMs: 8, syncIntervalMs: 120_000, ...defined };
    this.incoming = new IncomingPipeline(options.incomingProcessor);
    this.platform = options.platform;
    this.store = options.store;
    this.net = createNetworkPolicy({ localMode: () => readLocalMode(this.store), siteIcons: () => readSiteIcons(this.store), lookup: options.lookup, googleChanged: () => this.cooldownChanged() });
    this.aiService = new AiService(this, options.aiFactory ?? defaultAiFactory);
    this.categorizer = new Categorizer(this);
    this.aiAssist = new AiAssist(this);
    this.facts = new FactsBackfill(this);
    const web = options.host?.kind === "web";
    this.autocomplete = new Autocomplete({
      source: this.store.autocomplete,
      platform: this.platform,
      contactCaps: web ? WEB_CONTACT_CAPS : DESKTOP_CONTACT_CAPS,
      phraseCaps: web ? WEB_PHRASE_CAPS : DESKTOP_PHRASE_CAPS,
      peakBytes: web ? WEB_AUTOCOMPLETE_PEAK : DESKTOP_AUTOCOMPLETE_PEAK,
      sliceMs: web ? 6 : 4,
      onEvent: (event, f) => {
        const fields = { model: f.model, ...(f.count !== undefined && { count: f.count }), ...(f.durationMs !== undefined && { durationMs: f.durationMs }), ...(f.bytes !== undefined && { bytes: f.bytes }), ...(f.errorClass && { errorClass: f.errorClass }) };
        if (event === "rebuild" || event === "disabled") log.warn(`autocomplete.${event}`, fields as never);
        else log.info(`autocomplete.${event}`, fields as never);
      },
    });
    this.connectivity = new Connectivity(
      {
        sync: (accountId) => void this.syncAccount(accountId),
        reconnect: (reason) => void this.reconnect(reason),
        offline: () => void this.wentOffline(),
      },
      { online: options.online, now: () => this.now(), retries: options.autoSync !== false, ...options.connectivity },
    );
    this.icons = new IconService({
      transport: options.iconTransport ?? null,
      files: this.platform.files,
      base: this.store.autocomplete.snapshotBase,
      web,
      now: () => this.now(),
      assertSite: async (url) => void (await this.net.assert("icons", url)),
      photoFetch: this.net.fetchFor("mail"),
      siteIconsOn: () => readSiteIcons(this.store),
      googlePhotos: () => readGooglePhotos(this.store),
      setGooglePhotoState: (accountId, state) => {
        const flow = this.signIns.get(accountId);
        // maintenance (scopes or the API changed), not consent: an account waiting for its sign-in keeps waiting (plan 74)
        return flow ? this.credentialWrite(accountId, flow, () => setGooglePhotoState(this.store, accountId, state, false)) : setGooglePhotoState(this.store, accountId, state, false);
      },
      accountEmail: async (accountId) => (await this.store.accounts.get(accountId))?.email ?? null,
      provider: (accountId) => this.provider(accountId),
      // the people's pictures are for the user's own windows, never for agents
      emit: (payload) => this.server.emit("icons", payload, { origins: ["renderer", "dev"] }),
      timeouts: options.iconTimeouts,
    });
    if (options.online === false) this.icons.network(false);
    this.attention = new Attention({
      store: this.store,
      host: options.attention ?? null,
      // mail for the user's own windows, never for agents
      emit: (notice) => this.server.emit("notify", notice, { origins: ["renderer", "dev"] }),
      publishCounts: () => this.emitCounts(),
      now: () => this.now(),
      yieldTurn: () => this.platform.yield(),
    });
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
    const host = this.options.host ?? FULL_HOST;
    // plan 22: website icons where there is a way to fetch them
    return { ...host, capabilities: { ...host.capabilities, siteIcons: !!this.options.iconTransport } };
  }

  private async init(): Promise<void> {
    this.cooldown = await ProviderCooldown.open(this.store.providerCooldown, { wallNow: () => this.now(), elapsedNow: () => performance.now(), random: () => Math.random() }, { changed: () => this.cooldownChanged() });
    for (const id of this.cooldown.boundAccountIds()) {
      const stamp = await this.store.accounts.stamp(id);
      if (stamp) this.cooldownAccounts.set(id, { ...stamp, kind: (await this.store.accounts.get(id))?.kind ?? "" });
    }
    await this.categorizer.load();
    const recovered = await this.store.ops.recover(this.now());
    if (recovered.requeued || recovered.unknown) {
      log.info("ops.recovered", { count: recovered.requeued + recovered.unknown });
      this.log("info", "recovered ops after restart", recovered);
    }
  }

  private cooldownChanged(): void {
    this.cooldownVersion++;
    this.admissionSnapshot = undefined;
    if (this.stopped || this.options.autoSync === false || !this.cooldown) return;
    if (this.cooldownTimer) clearTimeout(this.cooldownTimer);
    this.cooldownTimer = null;
    const delay = this.cooldown.nextWakeDelay();
    if (delay !== null) this.cooldownTimer = setTimeout(() => {
      this.cooldownTimer = null;
      this.cooldownChanged();
      for (const id of this.google.keys()) if (this.googleReady(id)) void this.syncAccount(id);
    }, delay);
    this.kickWorker();
  }

  private googleReady(id: number): boolean {
    try { this.google.get(id)?.check({ endpoint: "gmail-api", purpose: "mail" }); return true; }
    catch { return false; }
  }

  private operationAdmission(): Promise<OpAdmission> {
    if (this.admissionSnapshot) return this.admissionSnapshot;
    const version = this.cooldownVersion;
    return this.admissionSnapshot = (async () => {
      const snapshot = await this.cooldown!.admission((id) => this.cooldownAccounts.get(id));
      const blocked = [...snapshot.blockedAccountIds, ...[...this.google].filter(([, google]) => google.paused).map(([id]) => id)];
      const all = snapshot.blockAllGoogle || this.net.googlePending() >= 64 || this.cooldown!.state("installation", "gmail-api").kind !== "ready";
      return copyOpAdmission({ ...snapshot, blockedAccountIds: blocked, blockAllGoogle: all || version !== this.cooldownVersion });
    })();
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
    // plan 41: the badge as it is now (a restarted backend puts it back), before any sync changes it
    await this.attention.start().catch((error: unknown) => void captureError(error, { code: "notify.failed" }));
    if (this.stopped) return;
    // plan 17: old mail's facts, and threads requeued before a quit, in slices
    this.facts.wake();
    // plan 68: a folder rebuild a quit interrupted goes on where it was
    void this.rebuildFolders();
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
    // a new start is a fresh look at the network: ops parked for it in the last session try again
    if (this.connectivity.online) await this.store.ops.resumeNetwork(null, this.now());
    for (const account of await this.store.accounts.list()) this.startAccount(account);
    this.syncTimer = setInterval(() => void this.tick(), this.options.syncIntervalMs);
    this.kickWorker();
  }

  /**
   * The poll (folders push doesn't watch) and push's heartbeat. Nothing while offline (the
   * connectivity probes cover it); an account in backoff waits for its retry.
   */
  private async tick(): Promise<void> {
    if (!this.connectivity.online || this.stopped) return;
    for (const account of await this.store.accounts.list()) {
      // started here, not after the sync: a long or failing pass mustn't postpone it (one probe per watcher)
      const life = this.lifetimes.get(account.id);
      void this.providers.get(account.id)?.then((p) => { if (life && this.current(life)) p?.heartbeat?.(); }, () => {});
      // plan 25: one that needs a sign-in isn't asked every two minutes (a refused login, again and again, locks
      // accounts out); a start, a network change and signing in again still try it
      if (!this.connectivity.pending(account.id) && !needsWholeSignIn(account.syncState)) void this.syncAccount(account.id);
    }
  }

  // ───────────────────────────── network (plan 20) ─────────────────────────────

  /** The host's word on the network: desktop's main (a route or address change, a wake), the web page (online/offline). */
  networkChanged(online: boolean, reason: NetReason): void {
    if (this.stopped || this.options.autoSync === false) return;
    breadcrumb("sync", "net.changed", { netReason: reason, online });
    this.connectivity.network(online, reason);
  }

  /** "Retry now" (the user: every account or one) or a window regaining focus (offline accounts, rate-limited). */
  async retryNow(accountId: number | null, reason: "user" | "focus"): Promise<void> {
    if (this.stopped) return;
    const ids = this.connectivity.retryNow(accountId, reason);
    if (reason === "user") {
      let resumed = false;
      for (const id of ids) resumed = (await this.store.ops.resumeNetwork(id, this.now())).length > 0 || resumed;
      if (resumed) this.kickWorker();
    }
    for (const id of ids) void this.syncAccount(id);
  }

  /**
   * Online, or the network changed: every socket is presumed dead. Providers drop theirs (push
   * reconnects at once), the host drops its pooled HTTP sockets, push that was paused offline comes
   * back and ops parked for the network go. Connectivity then syncs every account.
   */
  private async reconnect(reason: NetReason): Promise<void> {
    if (this.stopped) return;
    log.info("net.changed", { netReason: reason, online: true });
    this.options.onNetworkReset?.();
    this.icons.network(true);
    for (const [id, p] of this.providers) {
      const life = this.lifetimes.get(id)!;
      void p.then((provider) => { if (this.current(life)) provider?.reset?.(); }, () => {});
    }
    for (const account of await this.store.accounts.list()) if (!this.unwatch.has(account.id)) this.watchAccount(account.id);
    await this.store.ops.resumeNetwork(null, this.now());
    // the worker paused while offline: whatever is due goes now
    this.kickWorker();
  }

  /** The host went offline: push stops (its sockets are dead anyway), the worker waits, accounts say so. */
  private async wentOffline(): Promise<void> {
    if (this.stopped) return;
    log.info("net.changed", { netReason: "offline", online: false });
    this.icons.network(false);
    for (const off of this.unwatch.values()) off();
    this.unwatch.clear();
    if (this.workerTimer) clearTimeout(this.workerTimer);
    this.workerTimer = null;
    const offline = L("errors.network.offline");
    const lifetimes = new Map(this.lifetimes);
    for (const account of await this.store.accounts.list()) {
      // a sign-in to redo stays what it is
      const life = lifetimes.get(account.id);
      if (!life || account.syncState.status === "error" || !this.store.isOpen || !this.current(life)) continue;
      await this.accountWrite(life, () => this.store.accounts.setSyncState(account.id, {
        status: "offline",
        lastError: offline.message,
        lastErrorI18n: textRef(offline) ?? null,
        connection: { state: "offline", retryAt: this.connectivity.retryAt(account.id) },
      }));
    }
    if (this.store.isOpen) await this.emitAccounts();
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
    if (this.sendsInFlight.size === 0) return "idle";
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
    return this.sendsInFlight.size === 0 ? Promise.resolve() : new Promise((r) => this.sendsSettled.push(r));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.gmailRenewals.clear();
    for (const flow of this.signIns.values()) flow.abort();
    this.signIns.clear();
    this.abort.abort();
    this.aiAssist.stop();
    this.incoming.close();
    const retirement = (async () => {
      let failed: { error: unknown } | undefined;
      try { await this.options.incomingProcessor?.close(); }
      catch (error) { failed = { error }; }
      try { await this.options.incomingProcessor?.whenIdle(); }
      catch (error) { failed ??= { error }; }
      return failed;
    })();
    this.connectivity.stop();
    const accountsClosed = Promise.allSettled([...this.lifetimes.values()].map((life) => this.dropAccount(life.id, { remove: life.removing })));
    if (this.syncTimer) clearInterval(this.syncTimer);
    if (this.idleTimer) clearInterval(this.idleTimer);
    if (this.countsTimer) clearTimeout(this.countsTimer);
    this.attention.stop();
    for (const n of this.autoNotices.values()) if (n.timer) clearTimeout(n.timer);
    this.categorizer.stop();
    // the slice in flight finishes; the next start resumes where the store's progress says
    await this.facts.stop();
    if (this.workerTimer) clearTimeout(this.workerTimer);
    if (this.cooldownTimer) clearTimeout(this.cooldownTimer);
    for (const off of this.unwatch.values()) off();
    await accountsClosed;
    // let an in-flight ops batch finish writing before the database closes
    for (let i = 0; this.workerRunning && i < 200; i++) await new Promise((r) => setTimeout(r, 10));
    await this.ready.catch(() => {});
    // its snapshots are written before the store closes under them
    await this.autocomplete.close().catch(() => {});
    // fetches in flight aborted, the icon index and the photo lists written
    await this.icons.close().catch(() => {});
    try {
      await this.categorizer.persist();
    } catch (error) {
      captureError(error, { code: "categorize.persist_failed" });
      this.log("warn", "could not persist the categorization model", error instanceof Error ? error.message : error);
    }
    const failedRetirement = await retirement;
    await this.cooldown?.close();
    await this.store.close();
    if (failedRetirement) throw failedRetirement.error;
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
    } catch {
      log.warn("secret.unreadable", { op: "decrypt" });
      this.log("warn", "saved secret couldn't be opened", { op: "decrypt" });
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
      this.autocomplete.notify();
      this.facts.wake();
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
    const counts = await this.store.threads.counts(this.now());
    if (this.stopped) return;
    this.server.emit("counts", counts);
    // plan 41: the Dock shows the sidebar's Inbox number (no query of its own)
    this.attention.counts(counts);
  }

  async emitAccounts(): Promise<void> {
    const accounts = await this.store.accounts.list();
    this.server.emit("accounts", accounts);
    if (this.autocomplete.warmed) this.autocomplete.setOwn(accounts.map((a) => a.email));
    // plan 17 (Codex review 1, #7): an account added or removed changed your addresses; its rescan runs now, with or
    // without mail to sync (an empty account brings no change that would wake it). Idle, a wake is one probe.
    this.facts.wake();
  }

  /**
   * Plan 18: the first draft or recipient field of the session: the models
   * restore (or build, in slices) with the user's addresses and the
   * body-suggestions setting. Once; returns when recipients can answer.
   */
  warmAutocomplete(): Promise<void> {
    this.warming ??= (async () => {
      this.autocomplete.setOwn((await this.store.accounts.list()).map((a) => a.email));
      await this.autocomplete.setPhrases(await readComposeSuggestions(this.store));
    })();
    return this.warming.then(() => this.autocomplete.warm());
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

  reconcileFlags(accountIds: readonly number[] | undefined): void {
    if (!accountIds?.length || this.stopped || this.options.autoSync === false) return;
    for (const id of new Set(accountIds)) {
      if (!this.connectivity.canSync(id)) continue;
      if (this.syncing.has(id)) this.flagSyncAgain.add(id);
      else void this.syncAccount(id);
    }
  }

  static learningSignal(action: ThreadAction) {
    return DESTRUCTIVE_OR_SIGNAL[action];
  }

  // ───────────────────────────── ingestion (time-sliced) ─────────────────────────────

  /**
   * Ingests in slices sized to ~sliceBudgetMs and yields between slices so
   * interactive RPCs (list, search, open) interleave with big imports.
   */
  async ingestSliced(messages: IncomingMessage[], applyFilters = true, life?: AccountLifetime, onInserted?: (ids: number[]) => void, observation?: FlagObservation, checkCurrent?: () => void, pass?: { accountId: number; pass: number }): Promise<{ inserted: number[] }> {
    const inserted: number[] = [];
    await this.runSliced(messages, 50, async (chunk) => {
      // one store command per slice: messages, filter claims and actions with their ops, and
      // the categorizer's decisions commit together
      if (life) this.assertCurrent(life);
      const classifier = await this.classifier();
      checkCurrent?.();
      const ingest = async (batch: IncomingMessage[]) => (batch.length ? this.store.sync.ingest(batch, { applyFilters, now: this.now(), classifier, observation }) : null);
      // plan 69: a sync pass's slice never overlaps a storage removal unit, and leaves out what one removed
      const write = () => (pass ? this.evictions.ingest(pass.accountId, pass.pass, chunk, ingest) : ingest(chunk));
      const r = await (life ? this.accountWrite(life, write) : write());
      if (!r) return;
      inserted.push(...r.inserted);
      // plan 41: each committed slice, so a pass that fails later still hands over what it stored
      onInserted?.(r.inserted);
      // RAM follows the database, never the other way round
      this.categorizer.apply(r.deltas);
      this.categorizer.noteBackfill(r.backfill);
      // the optional AI looks at what the engine was unsure about, after commit, outside the slice
      void this.aiAssist.enqueue(r.uncertain);
      this.announceAuto(r.auto);
      this.opsQueued(r.opIds);
      this.reconcileFlags(r.flagReconcileAccounts);
      this.notifyChanged(r.touched);
    });
    return { inserted };
  }

  /** The categorizer's pure part of an ingestion command (null until a model is ready). */
  async classifier(): Promise<ClassifierInput | null> {
    const model = this.categorizer.model;
    return model ? { model, mode: await readAutoCategorize(this.store) } : null;
  }

  /** One "Terno added N conversations to X" per category at most every 30 s. */
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
  /** plan 68 (Codex R5): pending folder rebuilds, a slice per turn (REBUILD_SLICE rows: within a frame in IndexedDB, where a slice is a commit); one runner at a time, a failure waits for the next start or list change */
  private folderRebuild: Promise<void> | null = null;
  rebuildFolders(): Promise<void> {
    this.folderRebuild ??= (async () => {
      try {
        for (;;) {
          if (this.stopped || !this.store.isOpen) return;
          const r = await this.store.folders.rebuild(REBUILD_SLICE);
          if (r.touched.length) this.notifyChanged(r.touched);
          if (!r.more) return;
          // a bulk writer: the WAL checkpoint catches up between slices (Codex R13: a long backfill grew it)
          await this.store.settle?.();
          await this.yieldTurn();
        }
      } catch (error) {
        this.log("warn", "a folder rebuild stopped; it goes on at the next start", error instanceof Error ? error.message : error);
      } finally {
        this.folderRebuild = null;
      }
    })();
    return this.folderRebuild;
  }

  async yieldTurn(): Promise<void> {
    await this.platform.yield();
    await this.platform.yield();
  }

  // ───────────────────────────── providers & sync ─────────────────────────────

  private lifetime(accountId: number): AccountLifetime {
    let life = this.lifetimes.get(accountId);
    if (!life) {
      life = { id: accountId, abort: new AbortController(), pending: new Set(), removing: false };
      this.lifetimes.set(accountId, life);
    }
    return life;
  }

  private current(life: AccountLifetime): boolean {
    return !this.stopped && !life.abort.signal.aborted && this.lifetimes.get(life.id) === life;
  }

  private assertCurrent(life: AccountLifetime): void {
    if (!this.current(life)) throw life.abort.signal.reason ?? this.abort.signal.reason ?? new DOMException("Account closed", "AbortError");
  }

  private async accountRead<T>(life: AccountLifetime, read: () => Promise<T>): Promise<T> {
    this.assertCurrent(life);
    const result = await read();
    this.assertCurrent(life);
    return result;
  }

  /** Deletion waits for admitted store commands, including their asynchronous staging/persistence. */
  private accountWrite<T>(life: AccountLifetime, write: () => Promise<T>): Promise<T> {
    const pending = (async () => {
      this.assertCurrent(life);
      return write();
    })();
    life.pending.add(pending);
    void pending.then(() => life.pending.delete(pending), () => life.pending.delete(pending));
    return pending;
  }

  private async replaceProviderSecret(life: AccountLifetime, stamp: { id: number; email: string; createdAt: number }, key: string, expected: string, next: string): Promise<boolean> {
    const name = `account:${life.id}:${key}`;
    let unreadable: ProviderAuthError | undefined;
    try {
      const blob = await this.accountRead(life, async () => {
        const stored = await this.store.secrets.get(name);
        return stored ? Uint8Array.from(stored) : null;
      });
      if (!blob) return false;
      const pending = await this.accountRead(life, () => readKeychainState(this.store));
      if (pending?.pending[name] === blobFingerprint(blob)) {
        unreadable = new ProviderAuthError(messageOf(new SecretUnreadableError(name, true)));
        throw unreadable;
      }
      let plain: string;
      try {
        plain = await this.options.cipher.decrypt(blob);
      } catch {
        unreadable = new ProviderAuthError(messageOf(new SecretUnreadableError(name, false)));
        throw unreadable;
      }
      this.assertCurrent(life);
      if (plain !== expected) return false;
      const candidate = next === expected ? blob : await this.options.cipher.encrypt(next);
      const replaced = await this.accountWrite(life, () => this.store.secrets.replace(name, blob, candidate, stamp));
      this.assertCurrent(life);
      return replaced;
    } catch {
      this.assertCurrent(life);
      if (unreadable) throw unreadable;
      throw new ProviderError(L("errors.secret.replaceFailed"), true);
    }
  }

  private providerStore(life: AccountLifetime): ProviderStore {
    const store = this.store.providerStore(life.id);
    const read = <T,>(fn: () => Promise<T>) => this.accountRead(life, fn);
    const write = <T,>(fn: () => Promise<T>) => this.accountWrite(life, fn);
    const locations = store.locations;
    return {
      messageByProviderId: (id) => read(() => store.messageByProviderId(id)),
      syncedMessages: () => read(() => store.syncedMessages()),
      pendingAttachmentBodies: (limit) => read(() => store.pendingAttachmentBodies(limit)),
      pendingFlagSnapshots: (request) => read(() => store.pendingFlagSnapshots(request)),
      pendingBodies: (limit) => read(() => store.pendingBodies(limit)),
      countPendingBodies: () => read(() => store.countPendingBodies()),
      providerIds: (ids) => read(() => store.providerIds(ids)),
      setting: <T,>(key: string) => read(() => store.setting<T>(key)),
      locations: {
        fence: (...args) => write(() => locations.fence(...args)),
        unresolved: (...args) => read(() => locations.unresolved(...args)),
        dispatch: (ids, expected, start) => read(() => locations.dispatch(ids, expected, start)),
        mappedMove: (...args) => write(() => locations.mappedMove(...args)),
        upsert: (...args) => write(() => locations.upsert(...args)),
        remove: (...args) => write(() => locations.remove(...args)),
        removeMany: (...args) => write(() => locations.removeMany(...args)),
        setFlags: (...args) => write(() => locations.setFlags(...args)),
        resetMailbox: (...args) => write(() => locations.resetMailbox(...args)),
        of: (...args) => read(() => locations.of(...args)),
        at: (...args) => read(() => locations.at(...args)),
        get: (...args) => read(() => locations.get(...args)),
        count: (...args) => read(() => locations.count(...args)),
        inMailbox: (...args) => read(() => locations.inMailbox(...args)),
        ...(locations.inMailboxPage && { inMailboxPage: (...args: Parameters<NonNullable<typeof locations.inMailboxPage>>) => read(() => locations.inMailboxPage!(...args)) }),
        resetCandidate: (...args) => read(() => locations.resetCandidate(...args)),
        envelopes: (...args) => read(() => locations.envelopes(...args)),
        unlocated: (...args) => read(() => locations.unlocated(...args)),
        twins: (...args) => read(() => locations.twins(...args)),
      },
    };
  }

  provider(accountId: number): Promise<MailProvider | null> {
    if (this.stopped) return Promise.resolve(null);
    const life = this.lifetime(accountId);
    if (!this.current(life)) return Promise.resolve(null);
    const existing = this.providers.get(accountId);
    if (existing) return existing;
    const created = (async () => {
      await this.ready;
      const account = await this.store.accounts.get(accountId);
      if (!this.current(life) || !account) return null;
      const cfg = await this.store.accounts.config<Record<string, unknown>>(accountId);
      if (!this.current(life) || !cfg) return null;
      const stamp = await this.store.accounts.stamp(accountId);
      if (!this.current(life) || !stamp) return null;
      this.cooldownAccounts.set(accountId, { ...stamp, kind: account.kind });
      this.cooldownChanged();
      const google = account.kind === "gmail" && !cfg.config.demo ? await savedGoogleRequests({
        gate: this.cooldown!, net: this.net, store: this.store.providerCooldown, stamp,
        live: () => this.current(life), credentials: () => this.credentialsOf(accountId),
        write: (work) => this.accountWrite(life, work), changed: () => this.cooldownChanged(),
      }) : undefined;
      if (!this.current(life)) { google?.close(); return null; }
      if (google) this.google.set(accountId, google);
      const provider = this.options.providers.create({
        google,
        flagObservation: true,
        store: this.providerStore(life), account, config: cfg.config,
        incoming: {
          acquire: (id, signal, reset) => this.incoming.acquire(id, signal, reset),
          promote: (id, signal, reset) => this.promote(life, id, signal, reset),
          retainCompleted: (bytes) => { this.assertCurrent(life); return this.incoming.retainCompleted(bytes); },
        },
        incomingProcessor: this.processing(life),
        getSecret: (name) => this.accountRead(life, () =>
          this.getSecret(`account:${accountId}:${name}`).catch((error: unknown) => {
            throw error instanceof SecretUnreadableError ? new ProviderAuthError(messageOf(error)) : error;
          })),
        setSecret: async (name, value) => {
          this.assertCurrent(life);
          const blob = await this.options.cipher.encrypt(value);
          await this.accountWrite(life, () => this.store.secrets.put(`account:${accountId}:${name}`, blob));
        },
        replaceSecret: (name, expected, next) => this.replaceProviderSecret(life, stamp, name, expected, next),
        getAppSecret: (name) => this.accountRead(life, () => this.getSecret(name)),
        event: (code, fields) => {
          if (this.current(life)) breadcrumb("sync", code, { accountKind: accountKindOf(account.kind), ...(fields?.durationMs !== undefined && { durationMs: fields.durationMs }) });
        },
        loadCursor: async <T,>() => this.accountRead(life, async () => ((await this.store.accounts.config<{ cursor?: T }>(accountId))?.config.cursor ?? null) as T | null),
        saveCursor: (cursor) => this.accountWrite(life, () => this.store.accounts.setCursor(accountId, cursor)),
        // Providers cancel their reads on reset/close. Sends retain their own acceptance/ambiguity signal.
        fetch: (input, init) => {
          if (!this.current(life) || google) throw new RequestNotDispatchedError(L("errors.accountGone"));
          return this.net.fetchFor("mail")(input, init);
        },
      });
      life.provider = provider;
      return provider;
    })().catch((error: unknown) => { if (!this.current(life)) return null; throw error; });
    this.providers.set(accountId, created);
    const forget = () => {
      if (this.providers.get(accountId) !== created) return;
      this.providers.delete(accountId);
      if (this.current(life) && !this.connectivity.tracked(accountId)) this.lifetimes.delete(accountId);
    };
    void created.then((p) => {
      if (!p && this.current(life)) this.connectivity.untrack(accountId);
      if (!p) forget();
    }, forget);
    return created;
  }

  private processing(life: AccountLifetime): Pick<IncomingProcessor, "run"> | undefined {
    const processor = this.options.incomingProcessor;
    if (!processor) return;
    return { run: async (input, signal) => {
      this.assertCurrent(life);
      const result = await processor.run(input, AbortSignal.any([signal, life.abort.signal, this.abort.signal]));
      this.assertCurrent(life);
      return result;
    } };
  }

  private async promote(life: AccountLifetime, accountId: number, signal: AbortSignal, reset?: AbortSignal): Promise<() => void> {
    this.assertCurrent(life);
    const stop = AbortSignal.any(reset ? [signal, reset, life.abort.signal, this.abort.signal] : [signal, life.abort.signal, this.abort.signal]);
    const release = await this.incoming.promote(accountId, stop);
    try {
      stop.throwIfAborted();
      this.assertCurrent(life);
    } catch (error) { release(); throw error; }
    return release;
  }

  startAccount(account: Account): void {
    if (this.stopped) return;
    const life = this.lifetime(account.id);
    if (!this.current(life)) return;
    this.connectivity.track(account.id);
    if (needsWholeSignIn(account.syncState)) this.connectivity.waitForSignIn(account.id, true);
    void this.provider(account.id).then((provider) => {
      if (!provider || !this.current(life)) return;
      this.watchAccount(account.id, provider);
    }, () => {});
    void this.syncAccount(account.id);
  }

  private watchAccount(accountId: number, known?: MailProvider): void {
    if (this.stopped) return;
    const life = this.lifetime(accountId);
    if (!this.current(life) || !this.connectivity.online || this.unwatch.has(accountId) || !this.connectivity.tracked(accountId)) return;
    void (known ? Promise.resolve(known) : this.provider(accountId)).then((provider) => {
      if (!provider?.watch || !this.current(life) || !this.connectivity.online || this.unwatch.has(accountId) || !this.connectivity.tracked(accountId)) return;
      this.unwatch.set(accountId, provider.watch(() => { if (this.current(life)) void this.syncAccount(accountId); }));
    });
  }

  async dropAccount(accountId: number, options: { remove?: boolean } = {}): Promise<void> {
    const life = this.lifetime(accountId);
    if (life.removing && !options.remove) throw new RpcError("NOT_FOUND", L("errors.accountGone"));
    life.removing ||= options.remove === true;
    life.abort.abort(new DOMException("Account closed", "AbortError"));
    if (options.remove) {
      this.gmailRenewals.delete(accountId);
      this.signIns.get(accountId)?.abort(new RpcError("NOT_FOUND", L("errors.accountGone")));
      this.signIns.delete(accountId);
    }
    this.connectivity.untrack(accountId);
    this.attention.forget(accountId);
    this.unwatch.get(accountId)?.();
    this.unwatch.delete(accountId);
    this.syncAgain.delete(accountId);
    this.flagSyncAgain.delete(accountId);
    this.syncing.delete(accountId);
    this.providers.delete(accountId);
    this.google.get(accountId)?.close();
    this.google.delete(accountId);
    this.cooldownChanged();
    // Never wait for a stuck read, factory or close before cancelling its lifetime.
    if (life.provider) {
      life.provider.reset?.();
      void life.provider.close().catch(() => {});
      life.provider = undefined;
    }
    const outcomes = await Promise.allSettled(life.pending);
    const failed = outcomes.find((r) => r.status === "rejected" && r.reason !== life.abort.signal.reason);
    if (failed?.status === "rejected") throw failed.reason;
  }

  /** Called only after successful durable row deletion; failed deletion keeps its fence. */
  accountRemoved(accountId: number): void {
    const life = this.lifetimes.get(accountId);
    if (!life?.abort.signal.aborted) return;
    this.lifetimes.delete(accountId);
    this.credentials.delete(accountId);
    this.cooldownAccounts.delete(accountId);
    this.cooldownChanged();
    this.options.providers.gmailTokens?.forget?.(accountId);
  }

  syncAccount(accountId: number): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const life = this.lifetime(accountId);
    if (!this.current(life)) return Promise.resolve();
    const running = this.syncing.get(accountId);
    if (running) {
      // Don't drop the notification (IDLE/push during a long sync): schedule one more pass.
      this.syncAgain.add(accountId);
      return running.then(() => this.syncing.get(accountId));
    }
    const setState = async (patch: Partial<AccountSyncState>) => {
      await this.accountWrite(life, async () => {
        await this.store.accounts.setSyncState(accountId, patch);
        await this.emitAccounts();
      });
    };
    const run = (async () => {
      // before the provider: a provider made from older credentials never passes for the new ones (Codex code review #1)
      const credentials = this.credentialsOf(accountId);
      const provider = await this.provider(accountId);
      if (!provider || !this.current(life)) return;
      // an account that syncs is one whose failures are counted (dropAccount untracks it)
      this.connectivity.track(accountId);
      // plan 41: live mail this pass inserts is news once the account synced in this life (no first sync, no catch-up
      // at launch); it's looked at when the pass is over (its flags, filters and bodies settled)
      const arrivals = this.attention.beginPass(accountId);
      // plan 69: a pass that overlaps a storage removal doesn't put back what it removed
      const pass = this.evictions.pass();
      let observation: FlagObservation | null = null;
      const before = await this.store.accounts.get(accountId);
      if (!this.current(life)) return;
      const checkCurrent = () => {
        this.assertCurrent(life);
        if (before?.kind === "gmail" && credentials !== this.credentialsOf(accountId)) throw new RequestNotDispatchedError(L("errors.gmail.requestOffline"));
      };
      const windowDays = before?.syncWindowDays ?? (await readSettings(this.store)).syncWindowDays;
      const sink: SyncSink = {
        signal: life.abort.signal,
        ingest: async (messages, o) => {
          await this.ingestSliced(messages, true, life, o?.live ? (ids) => arrivals.add(ids) : undefined, provider.flagSnapshotSource === "locations" ? undefined : observation ?? undefined, checkCurrent, { accountId, pass });
        },
        // the account's own window, else the general one
        windowDays,
        windowStart: this.now() - windowDays * 86_400_000,
        updateFlags: async (updates, o) => {
          const touched = new Set<number>();
          await this.runSliced(updates, 200, async (chunk) => {
            checkCurrent();
            const result = await this.accountWrite(life, () => this.store.sync.updateFlags(accountId, chunk, o?.authoritative === false ? undefined : observation ?? undefined));
            for (const t of result.touched) touched.add(t);
            this.reconcileFlags(result.flagReconcileAccounts);
          });
          this.notifyChanged(touched);
        },
        setBody: async (messageId, text, html, attachments, capture) => {
          this.assertCurrent(life);
          const classifier = await this.classifier();
          checkCurrent();
          const r = await this.accountWrite(life, () => this.store.sync.setBody(messageId, text, html, { now: this.now(), classifier, attachments, captureUnavailable: capture?.captureUnavailable }));
          this.categorizer.apply(r.deltas);
          this.announceAuto(r.auto);
          this.opsQueued(r.opIds);
          this.reconcileFlags(r.flagReconcileAccounts);
          this.notifyChanged(r.touched, false);
        },
        removeMessages: async (ids) => {
          checkCurrent();
          this.notifyChanged((await this.accountWrite(life, () => this.store.sync.remove(ids))).touched);
        },
        pendingMessageIds: () => this.accountRead(life, () => this.store.sync.pendingMessageIds(accountId)),
        setSyncState: (patch) => setState(patch),
        // plan 68: the account's own folders; an unchanged list writes and says nothing
        setFolders: async (folders) => {
          checkCurrent();
          const r = await this.accountWrite(life, () => this.store.folders.replace(accountId, folders));
          if (!r.changed) return;
          this.server.emit("folders", await this.store.folders.list());
          this.notifyChanged(r.touched);
          void this.rebuildFolders();
        },
      };
      if (!this.current(life)) return;
      const accountKind = accountKindOf(before?.kind);
      // once the account is offline it says so until a pass works: a retry reads "reconnecting", never healthy
      const wasDown = Boolean(before?.syncState.connection);
      const epoch = this.connectivity.epoch;
      const startedOffline = !this.connectivity.online;
      const started = performance.now();
      try {
        // plan 41: the pass is over (done or failed): what it stored as live mail is looked at now
        try {
          checkCurrent();
          await setState({ status: "syncing", ...(wasDown && { connection: { state: "reconnecting", retryAt: null } }) });
          checkCurrent();
          observation = await this.accountWrite(life, () => this.store.sync.beginObservation(accountId, { authoritativeFlags: provider.flagSnapshots === true, signal: life.abort.signal }));
          checkCurrent();
          await provider.sync(sink);
          checkCurrent();
          // plan 68: the account's own folders (Gmail's labels), only when they may have changed; a failure waits for the next pass
          try {
            await provider.folders?.(sink);
          } catch (error) {
            // the provider's own failure (offline, a malformed answer) waits; a sign-in to redo or a store failure doesn't
            if (!(error instanceof ProviderError) || error instanceof ProviderAuthError || error instanceof ProviderCooldownError) throw error;
          }
        } finally { arrivals.end(); }
        if (!this.current(life) || (before?.kind === "gmail" && credentials !== this.credentialsOf(accountId))) return;
        breadcrumb("sync", "sync.done", { accountKind, durationMs: performance.now() - started });
        this.evictions.passDone(accountId, pass);
        this.attention.prime(accountId);
        this.connectivity.succeeded(accountId);
        if (!this.connectivity.online && !startedOffline) {
          // the host went offline while this pass ran: what it fetched is in, the account says offline,
          // and it keeps its probe (succeeded() just cleared it; nothing else would try it again)
          await setState({ status: "offline", lastSyncAt: this.now(), connection: { state: "offline", retryAt: this.connectivity.probeLater(accountId) } });
          return;
        }
        // plan 25: a refused send (SMTP) isn't proven by a sync (IMAP): it keeps asking, and its sends keep waiting
        const sendOnly = (await this.accountRead(life, () => this.store.accounts.get(accountId)))?.syncState.authScope === "send";
        if (before?.kind === "gmail" && credentials !== this.credentialsOf(accountId)) return;
        await setState({ status: "idle", lastError: null, lastErrorI18n: null, lastSyncAt: this.now(), connection: null, ...(!sendOnly && { authRequired: false, authScope: null }) });
        if (!this.current(life)) return;
        this.connectivity.waitForSignIn(accountId, false);
        // a probe the host thought pointless worked: it was wrong about offline (reachability can be, with some VPNs)
        if (startedOffline && !this.connectivity.online) this.networkChanged(true, "other");
        // the account works: whatever waited for its sign-in, or for the network, goes now
        if (!sendOnly) await this.accountWrite(life, () => this.resumeAuth(accountId));
        if ((await this.accountWrite(life, () => this.store.ops.resumeNetwork(accountId, this.now()))).length) this.kickWorker();
        // its mail is here: drafts an import kept for it (answering messages that just synced) go in
        await this.accountWrite(life, () => restorePending(this, accountId)).catch((error: unknown) => {
          captureError(error, { code: "import.restore_failed" });
          this.log("warn", "restoring imported items failed", error instanceof Error ? error.message : error);
        });
      } catch (caught) {
        if (!this.current(life) || (before?.kind === "gmail" && credentials !== this.credentialsOf(accountId))) return;
        const error = caught instanceof FlagObservationError ? new FlagConnectionError() : caught;
        const message = error instanceof Error ? error.message : String(error);
        const lastErrorI18n = textRef((error as { i18n?: unknown } | null)?.i18n) ?? null;
        const retryable = error instanceof ProviderError && error.retryable;
        // offline or a sign-in to redo is the provider's verdict (expected); anything else is ours
        captureError(error, { code: "sync.failed", fields: { accountKind, retryable } });
        this.log("warn", `sync failed for account ${accountId}`, message);
        if (!this.store.isOpen) return;
        if (error instanceof ProviderCooldownError || (accountKind === "gmail" && error instanceof ProviderError && error.httpResponse?.status === 429)) {
          this.connectivity.succeeded(accountId);
          await setState({ status: "error", lastError: message, lastErrorI18n, connection: null });
          return;
        }
        if (error instanceof FlagConnectionError) {
          await setState({ status: "error", lastError: message, lastErrorI18n });
          return;
        }
        if (!retryable) {
          const auth = error instanceof ProviderAuthError;
          // plan 25: refused with the credentials a sign-in has since replaced: it says nothing, the next pass decides
          if (auth && credentials !== this.credentialsOf(accountId)) return void this.syncAgain.add(accountId);
          // a configuration problem: no retry schedule (the poll and the user try again); offline the poll doesn't
          // run, so it keeps its 5-minute probe (some refusals pass: Gmail's 403 rate limits). A refused sign-in
          // (plan 25) waits for the user: no probe, no poll (a start and a network change still try it).
          this.connectivity.succeeded(accountId);
          this.connectivity.waitForSignIn(accountId, auth);
          if (!this.connectivity.online && !auth) this.connectivity.probeLater(accountId);
          // anything else proves nothing about the sign-in: a request for one stays
          await setState({ status: "error", lastError: message, lastErrorI18n, connection: null, ...(auth && { authRequired: true, authScope: null }) });
          return;
        }
        const retry = this.connectivity.failed(accountId, epoch);
        // a pass our own reconnect cut short doesn't count: the pass that follows the change decides
        if (!retry) return;
        breadcrumb("sync", "sync.retry", { accountKind, attempt: retry.failures, delayMs: retry.at - this.now() });
        // a blip is retried quietly (2 s later); the second failure in a row, or the host offline, is honest about it
        const down = wasDown || retry.failures >= 2 || !this.connectivity.online;
        await setState({ status: down ? "offline" : "syncing", lastError: message, lastErrorI18n, connection: down ? { state: "offline", retryAt: retry.at } : null });
      }
    })().catch((error: unknown) => {
      if (error !== life.abort.signal.reason) throw error;
    }).finally(() => {
      if (this.syncing.get(accountId) !== run) return;
      this.syncing.delete(accountId);
      const explicit = this.syncAgain.delete(accountId);
      const flags = this.flagSyncAgain.delete(accountId);
      if (this.current(life) && this.googleReady(accountId) && (explicit || (flags && this.connectivity.canSync(accountId)))) void this.syncAccount(accountId);
    });
    this.syncing.set(accountId, run);
    return run;
  }

  // ───────────────────────────── ops worker ─────────────────────────────

  /** The account's authorization works again (sync succeeded, reconnected): its ops waiting for it run now. */
  async resumeAuth(accountId: number): Promise<void> {
    if ((await this.store.ops.resumeAuth(accountId, this.now())).length) this.kickWorker();
  }

  credentialsOf(accountId: number): number {
    return this.credentials.get(accountId) ?? 0;
  }

  assertSignIn(accountId: number, flow: AbortController): void {
    if (flow.signal.aborted && flow.signal.reason instanceof RpcError && flow.signal.reason.code === "NOT_FOUND") throw flow.signal.reason;
    if (this.stopped || this.abort.signal.aborted || flow.signal.aborted || this.signIns.get(accountId) !== flow) throw new RpcError("BAD_REQUEST", L("errors.google.cancelled"));
    if (this.lifetimes.get(accountId)?.removing) throw new RpcError("NOT_FOUND", L("errors.accountGone"));
  }

  /** Serialize finalization, including recovery, so an admitted old write precedes the newer snapshot. */
  async credentialFlow<T>(accountId: number, flow: AbortController, run: () => Promise<T>): Promise<T> {
    const previous = this.credentialFlows.get(accountId);
    const pending = (async () => {
      await previous?.catch(() => {});
      this.assertSignIn(accountId, flow);
      const life = this.lifetime(accountId);
      try { return await run(); }
      catch (error) {
        await this.recoverDroppedSignIn(accountId, flow, life);
        throw error;
      }
    })();
    this.credentialFlows.set(accountId, pending);
    try { return await pending; }
    finally { if (this.credentialFlows.get(accountId) === pending) this.credentialFlows.delete(accountId); }
  }

  /** A failed newer intent can also inherit the previous intent's deliberate drop. */
  async recoverSignIn(accountId: number, flow: AbortController): Promise<void> {
    await this.credentialFlows.get(accountId)?.catch(() => {});
    await this.recoverDroppedSignIn(accountId, flow, this.lifetimes.get(accountId));
  }

  private async recoverDroppedSignIn(accountId: number, flow: AbortController, expected: AccountLifetime | undefined): Promise<void> {
    const active = () => !!expected && expected.abort.signal.aborted && !expected.removing && this.lifetimes.get(accountId) === expected && this.signIns.get(accountId) === flow && !flow.signal.aborted && !this.abort.signal.aborted && !this.stopped;
    if (!active()) return;
    const account = await this.store.accounts.get(accountId);
    if (!account || !active()) return;
    this.lifetimes.delete(accountId);
    this.lifetime(accountId);
    this.connectivity.track(accountId);
    this.connectivity.waitForSignIn(accountId, needsWholeSignIn(account.syncState));
    // Pending rotation recovery belongs to the next explicit demand, never a refresh of the spent old grant.
    if (!needsWholeSignIn(account.syncState) && !this.gmailRenewals.has(accountId)) this.startAccount(account);
  }

  /** Durable writes retire refusals independently of permission to publish RPC success. */
  credentialCommit(accountId: number, flow: AbortController, write: (active: () => boolean) => Promise<boolean>, confirm?: () => Promise<boolean>): Promise<boolean> {
    const life = this.lifetime(accountId);
    const active = () => !this.stopped && !this.abort.signal.aborted && !life.removing && this.lifetimes.get(accountId) === life;
    return this.credentialWrite(accountId, flow, async () => {
      let committed: boolean;
      try { committed = await write(active); }
      catch {
        if (active() && confirm) {
          try {
            if (await confirm() && active()) this.credentials.set(accountId, this.credentialsOf(accountId) + 1);
          } catch { /* An unreadable result proves neither commit nor rollback. */ }
        }
        throw new RpcError("BAD_REQUEST", L("errors.secret.replaceFailed"));
      }
      if (committed && active()) {
        this.credentials.set(accountId, this.credentialsOf(accountId) + 1);
      }
      return committed;
    });
  }

  /** Explicit writes may follow a deliberate drop; deletion still drains every admitted command. */
  credentialWrite<T>(accountId: number, flow: AbortController, write: () => Promise<T>): Promise<T> {
    this.assertSignIn(accountId, flow);
    const life = this.lifetime(accountId);
    const pending = write();
    life.pending.add(pending);
    void pending.then(() => life.pending.delete(pending), () => life.pending.delete(pending));
    return pending;
  }

  /**
   * Plan 25: the account was just signed in again with new credentials (stored by the caller), proven by a live
   * login or Google's answer: it stops asking now, not after the sync. A refusal of the old credentials still in
   * flight no longer counts, and what waited for the sign-in goes. The caller syncs (or restarts the account).
   */
  async signedIn(accountId: number, installCredentials?: () => void, flow?: AbortController): Promise<void> {
    if (flow) this.assertSignIn(accountId, flow);
    if (this.stopped || this.lifetimes.get(accountId)?.removing) throw new RpcError("NOT_FOUND", L("errors.accountGone"));
    const allocated = !this.lifetimes.has(accountId);
    const previous = this.lifetime(accountId);
    try {
      const account = await this.store.accounts.get(accountId);
      if (flow) this.assertSignIn(accountId, flow);
      if (this.stopped || previous.removing || this.lifetimes.get(accountId) !== previous || !account) throw new RpcError("NOT_FOUND", L("errors.accountGone"));
    } catch (error) {
      // A rejected late sign-in owns only its unused allocation, never a deletion fence or newer generation.
      if (allocated && this.lifetimes.get(accountId) === previous && !previous.removing && !previous.abort.signal.aborted && !this.providers.has(accountId) && !this.connectivity.tracked(accountId) && previous.pending.size === 0) this.lifetimes.delete(accountId);
      throw error;
    }
    // Explicit reconnect dropped its old provider first; token renewal can keep an active provider.
    if (previous.abort.signal.aborted) this.lifetimes.delete(accountId);
    const life = this.lifetime(accountId);
    if (flow) this.assertSignIn(accountId, flow);
    this.credentials.set(accountId, this.credentialsOf(accountId) + 1);
    this.connectivity.waitForSignIn(accountId, false);
    await this.accountWrite(life, async () => {
      if (flow) this.assertSignIn(accountId, flow);
      installCredentials?.();
      await this.store.accounts.setSyncState(accountId, { status: "idle", lastError: null, lastErrorI18n: null, authRequired: false, authScope: null });
      if (flow) this.assertSignIn(accountId, flow);
      await this.emitAccounts();
      if (flow) this.assertSignIn(accountId, flow);
      await this.resumeAuth(accountId);
    });
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
    await this.ready;
    if (this.workerRunning) return 0;
    this.workerRunning = true;
    let processed = 0;
    try {
      do {
        this.workerKicked = false;
        for (;;) {
          // quitting: nothing more is claimed (the rest stays queued, durably); offline: they'd only fail (plan 20)
          if (this.draining || this.stopped || !this.connectivity.online) break;
          const batch = await this.store.ops.claimReady(this.now(), 25, await this.operationAdmission());
          if (batch.length === 0) break;
          for (const op of batch) this.undispatched.add(op.id);
          const byAccount = new Map<number, OpRow[]>();
          for (const op of batch) byAccount.set(op.account_id, [...(byAccount.get(op.account_id) ?? []), op]);
          const reconciliations = new Set<number>();
          const reconcile = (accountId: number) => {
            if (reconciliations.delete(accountId)) this.reconcileFlags([accountId]);
          };
          try {
            await Promise.all(
              [...byAccount.values()].map(async (ops) => {
                try {
                  for (const op of ops) {
                    const recovery: { record?: () => Promise<void> } = {};
                    try {
                      await this.executeOp(op, recovery, reconciliations);
                    } catch (error) {
                      // never strand the rest of the batch in "running"
                      captureError(error, { code: "ops.crashed", fields: { opKind: opKindOf(op.kind) } });
                      this.log("error", `op ${op.id} crashed`, error instanceof Error ? error.stack : error);
                      try {
                        if (this.store.isOpen) {
                          if (recovery.record) await recovery.record();
                          else if ((await this.store.ops.get(op.id))?.state === "running") {
                            if (this.sendsInFlight.has(op.id)) await this.store.ops.markUnknown(op.id, String(error), this.now());
                            else await this.store.ops.fail(op.id, String(error), true, this.now());
                          }
                          const after = await this.store.ops.get(op.id);
                          if (after) this.announceOp(after, reconciliations);
                        }
                      } catch (recoveryError) {
                        // A running send stays noneligible until storage recovers or startup marks it unknown.
                        captureError(recoveryError, { code: "ops.crashed", fields: { opKind: opKindOf(op.kind) } });
                        this.log("error", `op ${op.id} recovery failed`, recoveryError instanceof Error ? recoveryError.stack : recoveryError);
                      }
                    } finally {
                      this.undispatched.delete(op.id);
                      if (this.sendsInFlight.delete(op.id) && this.sendsInFlight.size === 0) for (const settle of this.sendsSettled.splice(0)) settle();
                    }
                  }
                } finally { reconcile(ops[0]!.account_id); }
              }),
            );
          } finally { for (const id of reconciliations) reconcile(id); }
          processed += batch.length;
        }
      } while (this.workerKicked && !this.stopped && !this.draining && this.connectivity.online);
    } finally {
      this.workerRunning = false;
    }
    await this.scheduleRetry();
    return processed;
  }

  private async scheduleRetry(): Promise<void> {
    // offline: the online event kicks the worker
    if (this.stopped || this.draining || this.options.autoSync === false || !this.connectivity.online) return;
    const next = await this.store.ops.nextAttemptAt(await this.operationAdmission());
    if (next === null || this.stopped) return;
    if (this.workerTimer) clearTimeout(this.workerTimer);
    this.workerTimer = setTimeout(() => void this.runWorker(), Math.max(0, next - this.now()));
  }

  private async parkClosedOp(op: OpRow): Promise<void> {
    this.undispatched.delete(op.id);
    await this.store.ops.awaitAuth(op.id, encodeText(L("errors.waitingForSignIn")), this.now());
    // Reconnect may have resumed before this late park. The new lifetime releases it again.
    const replacement = this.lifetimes.get(op.account_id);
    if (replacement && this.current(replacement)) await this.resumeAuth(op.account_id);
  }

  private async executeOp(claimed: OpRow, recovery: { record?: () => Promise<void> }, reconciliations: Set<number>): Promise<void> {
    // Re-read right before dispatch: while earlier ops of the batch ran, this one may have
    // been superseded (deleted), pruned (deleted messages) or narrowed.
    const stored = await this.store.ops.get(claimed.id);
    if (!stored || stored.state !== "running") return void this.undispatched.delete(claimed.id);
    let op = stored;
    // quitting (or offline, plan 20): an op that hasn't reached its server waits, as it was (the attempt given back)
    const hold = () => this.draining || this.stopped || !this.connectivity.online;
    if (hold()) return void (this.undispatched.delete(op.id), await this.store.ops.release(op.id, this.now()));
    // before the provider and the account: a sign-in after this point makes whatever they say stale (Codex code review #1)
    const credentials = this.credentialsOf(op.account_id);
    const life = this.lifetime(op.account_id);
    const opening = this.provider(op.account_id);
    const provider = await opening;
    const account = await this.store.accounts.get(op.account_id);
    if (hold()) return void (this.undispatched.delete(op.id), await this.store.ops.release(op.id, this.now()));
    if (!this.current(life)) return this.parkClosedOp(op);
    if (op.kind === "send") this.undispatched.delete(op.id);
    // plan 25: the account waits for a sign-in: so does the op, without knocking with the refused credentials
    if (account && heldBySignIn(account.syncState, op.kind)) {
      await this.store.ops.awaitAuth(op.id, encodeText(L("errors.waitingForSignIn")), this.now());
      await this.parkedAcrossSignIn(op.account_id, credentials);
      const after = await this.store.ops.get(op.id);
      if (after) this.announceOp(after, reconciliations);
      return;
    }
    // A send owns its drain slot while its immutable attachments are prepared.
    const sending = op.kind === "send";
    if (sending) this.sendsInFlight.add(op.id);
    let target = JSON.parse(op.target_json) as { messageIds?: number[]; recoveryParentId?: string };
    const started = performance.now();
    let accepted = false, transportStarted = false, remoteDispatched = false;
    let sendAccepted: import("@terno/store").AcceptedRecipientEvidence | undefined;
    try {
      if (!provider) throw new ProviderError(L("errors.accountGone"), false);
      if (operationFlagFields(op.kind).length) {
        await this.accountWrite(life, () => this.store.sync.beginObservation(life.id, { authoritativeFlags: provider.flagSnapshots === true, signal: life.abort.signal }));
        if (!this.current(life)) return this.parkClosedOp(op);
        const current = await this.store.ops.get(op.id);
        if (!current || current.state !== "running") return void this.undispatched.delete(op.id);
        op = current;
        target = JSON.parse(op.target_json) as { messageIds?: number[]; recoveryParentId?: string };
        if (hold() || this.providers.get(op.account_id) !== opening || credentials !== this.credentialsOf(op.account_id)) {
          this.undispatched.delete(op.id);
          await this.store.ops.release(op.id, this.now());
          return;
        }
      }
      let payload: unknown;
      let recovery: import("@terno/mail").ProviderOp["recovery"];
      try {
        payload = JSON.parse(op.payload_json);
        if (sending && target.recoveryParentId) {
          const parentId = target.recoveryParentId;
          const header = await this.store.recipientReceipts.get(parentId);
          const parent = await this.store.ops.get(parentId);
          if (!header || header.retired || header.childOpId !== op.id || header.accountId !== op.account_id || !parent || parent.account_id !== op.account_id || !(await this.store.ops.sendSubmission(parentId))?.accepted) throw new ProviderError(L("errors.recipientReceipt.unavailable"), false);
          const to = await rejectedRecipients(header, (kind, index) => this.store.recipientReceipts.readPart(parentId, kind, index), () => this.platform.yield());
          if (!to.length) throw new ProviderError(L("errors.recipientReceipt.unavailable"), false);
          const ownerId = header.wireOwnerId ?? parentId;
          const owner = ownerId === parentId ? parent : await this.store.ops.get(ownerId);
          if (!owner || owner.account_id !== op.account_id) throw new ProviderError(L("errors.recipientReceipt.unavailable"), false);
          const raw = await readCopyWire(this.store, ownerId, () => this.platform.yield(), () => this.assertCurrent(life));
          payload = JSON.parse(owner.payload_json);
          const original = payload as SendPayload;
          if (!original || typeof original !== "object" || typeof original.from?.email !== "string" || !original.from.email || typeof original.messageId !== "string") throw new ProviderError(L("errors.recipientReceipt.unavailable"), false);
          recovery = { raw, envelope: { from: asciiEmail(original.from.email), to } };
        } else if (sending) {
          if (!payload || typeof payload !== "object" || Array.isArray(payload) || !("text" in payload) || typeof payload.text !== "string" || ("html" in payload && payload.html !== undefined && typeof payload.html !== "string") || ("attachments" in payload && payload.attachments !== undefined && !Array.isArray(payload.attachments))) throw new ProviderError(L("attachments.unavailable"), false);
          payload = await hydrateSendAttachments(this.store, op.account_id, payload as SendPayload, () => this.platform.yield());
        }
      } catch (error) {
        if (sending && !(error instanceof ProviderError)) throw new ProviderError(L("attachments.unavailable"), false);
        throw error;
      }
      if (!this.current(life)) return this.parkClosedOp(op);
      if (sending && (hold() || this.providers.get(op.account_id) !== opening || credentials !== this.credentialsOf(op.account_id))) {
        await this.store.ops.release(op.id, this.now());
        return;
      }
      // SMTP repeats the durable submission fence after its yielding preparation.
      this.undispatched.delete(op.id);
      transportStarted = true;
      const receipt = sending ? await this.store.sendCopies.get(op.id) : null;
      const currentSend = sending ? await this.store.ops.sendSubmission(op.id) : null;
      if (receipt?.submission === "accepted" || currentSend?.accepted) throw new ProviderError(L("errors.send.alreadyAccepted"), false, true);
      if (sending && (!currentSend || currentSend.state !== "running")) return;
      if (!this.current(life) || hold() || credentials !== this.credentialsOf(op.account_id) || this.providers.get(op.account_id) !== opening) { await this.store.ops.release(op.id, this.now()); return; }
      const execution = await provider.execute({ id: op.id, kind: op.kind, target, payload,
        requestRun: { markDispatched: () => { remoteDispatched = true; } },
        submissionAccepted: () => { accepted = true; sendAccepted ??= { warning: null }; },
        recipientOutcomes: (outcomes) => { if (sendAccepted) sendAccepted = { ...sendAccepted, outcomes }; },
        submissionWarning: (warning) => { if (sendAccepted) sendAccepted = { ...sendAccepted, warning: warning ? encodeText(warning) : null }; },
        ...(recovery && { recovery }),
        ...(sending && { beforeSubmission: async () => {
          // Receipt-first, then fresh op: retirement transfers proof atomically before deleting a receipt.
          const copy = await this.store.sendCopies.get(op.id);
          const current = await this.store.ops.sendSubmission(op.id);
          if (target.recoveryParentId) {
            const parent = await this.store.recipientReceipts.get(target.recoveryParentId);
            const source = parent ? await this.store.sendCopies.get(parent.wireOwnerId ?? target.recoveryParentId) : null;
            const proof = await this.store.ops.sendSubmission(target.recoveryParentId);
            if (!parent || parent.retired || parent.childOpId !== op.id || parent.accountId !== op.account_id || !source?.ready || source.retiring || !source.size || !proof?.accepted) throw new ProviderError(L("errors.recipientReceipt.unavailable"), false);
          }
          if (copy?.submission === "accepted" || current?.accepted) throw new ProviderError(L("errors.send.alreadyAccepted"), false, true);
          if (!current || current.state !== "running") throw new ProviderError(L("errors.sentCopy.unavailable"), false);
          this.assertCurrent(life);
          if (hold() || credentials !== this.credentialsOf(op.account_id) || this.providers.get(op.account_id) !== opening) throw new ProviderError(L("errors.sentCopy.unavailable"), true);
        } }),
        ...(receipt && { sentCopyRequested: receipt.copyRequested, sentCopy: {
          prepare: (raw) => this.accountWrite(life, () => prepareCopyWire(this.store, op.id, raw, () => this.platform.yield(), () => { this.assertCurrent(life); if (hold() || credentials !== this.credentialsOf(op.account_id) || this.providers.get(op.account_id) !== opening) throw new ProviderError(L("errors.sentCopy.unavailable"), true); })),
          accepted: (warning) => { sendAccepted = { ...sendAccepted, warning: warning ? encodeText(warning) : null }; return this.accountWrite(life, () => this.store.sendCopies.accepted(op.id, sendAccepted!.warning)); },
          record: (copy, identity) => this.accountWrite(life, () => this.store.sendCopies.record(op.id, copy, identity)),
        } }),
      });
      accepted = true;
      if (sending) sendAccepted ??= { warning: null };
      const { warning, ...result } = execution || {};
      if (op.kind === "send") log.info("send.done", { durationMs: performance.now() - started });
      if (this.stopped && !this.store.isOpen) return;
      // a warning in Terno's words stays a catalog message (see opInfo)
      const done = await this.store.ops.complete(op.id, { ...result, ...(sendAccepted && { sendAccepted }), ...(warning !== undefined && { warning: encodeText(warning) }) }, this.now());
      if (sending && receipt) {
        try {
          const stored = await this.store.sendCopies.get(op.id);
          if (stored && !stored.copyRequested && !(await this.store.recipientReceipts.get(op.id))?.hasRejected) { while (!this.stopped && await this.store.sendCopies.forgetSlice(op.id)) await this.platform.yield(); }
          else if (stored?.copy === "saved") while (!this.stopped && await this.store.sendCopies.pruneSavedSlice(op.id)) await this.platform.yield();
        } catch { /* Saved wire remains charged for deliberate cleanup; submission is complete. */ }
      }
      this.categorizer.apply(done.deltas);
      if (done.touched.length) this.notifyChanged(done.touched);
    } catch (caught) {
      if (!sending && !transportStarted && !this.current(life)) return this.parkClosedOp(op);
      const error = caught instanceof FlagObservationError ? new FlagConnectionError() : caught;
      // a message in Terno's words is kept as a catalog message (see opInfo)
      const message = encodeText(messageOf(error));
      const pe = error instanceof ProviderError ? error : null;
      // a deleted account is gone on purpose: its ops just fail
      const expected = pe ? pe.expected || !provider : undefined;
      if (op.kind === "send") captureError(error, { code: "send.failed", fields: { retryable: pe?.retryable, ambiguous: pe?.ambiguous }, expected });
      else captureError(error, { code: "ops.failed", fields: { opKind: opKindOf(op.kind), retryable: pe?.retryable, ambiguous: pe?.ambiguous }, expected });
      // If persistence fails, the worker retries recording this outcome, never the provider call.
      recovery.record = async () => {
        let state: OpState | null = null;
        // plan 25: refused with credentials a sign-in replaced meanwhile: it goes again with the new ones
        if (sending && accepted) await this.store.ops.markUnknown(op.id, message, this.now(), sendAccepted);
        else if (error instanceof ProviderCooldownError && !remoteDispatched && this.current(life)) {
          await this.store.ops.release(op.id, this.now());
          this.cooldownChanged();
        }
        else if (error instanceof RequestNotDispatchedError && !this.current(life)) await this.parkClosedOp(op);
        else if (error instanceof ProviderAuthError && credentials !== this.credentialsOf(op.account_id)) {
          await this.store.ops.release(op.id, this.now());
          this.kickWorker();
        } else if (error instanceof ProviderAuthError) {
          await this.store.ops.awaitAuth(op.id, message, this.now());
          if (this.current(life) && !(await this.parkedAcrossSignIn(op.account_id, credentials))) await this.needsSignIn(op.account_id, op.kind, error, credentials, life);
        } else if (error instanceof ProviderError && error.ambiguous) await this.store.ops.markUnknown(op.id, message, this.now());
        // the server couldn't be reached: wait for the network (plan 20); an outage gives the attempt back
        else if (error instanceof ProviderIdentityError) state = await this.store.ops.fail(op.id, message, true, this.now(), { identity: true, keepAttempt: true });
        else if (error instanceof ProviderError && error.network) state = await this.store.ops.fail(op.id, message, true, this.now(), { network: true, keepAttempt: this.connectivity.inOutage(op.account_id) });
        else state = await this.store.ops.fail(op.id, message, error instanceof ProviderError ? error.retryable : true, this.now());
        // A permanently failed send answered nobody: recomputed lists and counts follow.
        if (state === "failed" && sending) this.notifyChanged([]);
      };
      await recovery.record();
    }
    if (this.stopped && !this.store.isOpen) return;
    const after = await this.store.ops.get(op.id);
    if (after) this.announceOp(after, reconciliations); // a superseded op is simply gone
  }

  /**
   * Plan 25: an action was refused for a sign-in (an SMTP login, an expired grant): the account says so now, even
   * if no sync has run into it yet. Once: an account that already says so isn't written or announced again.
   */
  private async needsSignIn(accountId: number, opKind: string, error: ProviderAuthError, credentials: number, life: AccountLifetime): Promise<void> {
    const account = await this.store.accounts.get(accountId);
    // a sign-in landed meanwhile: this refusal was of the credentials it replaced
    if (!account || !this.store.isOpen || !this.current(life) || credentials !== this.credentialsOf(accountId)) return;
    // an IMAP account's send goes through SMTP: refused there, it's only its sending (Codex review #2)
    const scope = account.kind === "imap" && opKind === "send" ? "send" : null;
    // already asking (as a whole, or for this): nothing new to say
    if (account.syncState.authRequired && (account.syncState.authScope !== "send" || scope === "send")) return;
    const lastErrorI18n = textRef((error as { i18n?: unknown }).i18n) ?? null;
    if (scope === null) this.connectivity.waitForSignIn(accountId, true);
    // a refused send leaves the account's sync as it was (it works)
    await this.accountWrite(life, () => this.store.accounts.setSyncState(accountId, { ...(scope === null && { status: "error" as const, connection: null }), lastError: error.message, lastErrorI18n, authRequired: true, authScope: scope }));
    await this.emitAccounts();
  }

  /**
   * Plan 25 (Codex code review #1): an op parked for a sign-in while one landed (its resume ran before this
   * park): it goes again now instead of waiting for a sign-in already done. True when that happened.
   */
  private async parkedAcrossSignIn(accountId: number, credentials: number): Promise<boolean> {
    if (credentials === this.credentialsOf(accountId)) return false;
    await this.resumeAuth(accountId);
    return true;
  }

  private announceOp(op: OpRow, reconciliations: Set<number>): void {
    if (operationFlagFields(op.kind).length && ["succeeded", "failed", "unknown"].includes(op.state)) reconciliations.add(op.account_id);
    this.server.emit("op", this.opInfo(op));
  }

  private readonly copyActions = new Set<string>();

  async repairSentCopy(id: string): Promise<import("@terno/core").SentCopyState> {
    if (this.copyActions.size >= 2 || this.copyActions.has(id) || this.sendsInFlight.has(id) || this.stopped || this.draining) throw new RpcError("BAD_REQUEST", L("errors.sentCopy.unavailable"));
    this.copyActions.add(id);
    try {
      const row = await this.store.sendCopies.get(id);
      if (!row || !row.copyRequested || row.retiring || row.submission !== "accepted" || row.copy === "saved") throw new RpcError("BAD_REQUEST", L("errors.sentCopy.unavailable"));
      const life = this.lifetime(row.accountId);
      return await this.accountWrite(life, async () => {
        this.sendsInFlight.add(id);
        try {
          const provider = await this.provider(row.accountId);
          this.assertCurrent(life);
          if (!provider?.repairSentCopy || this.stopped || this.draining) throw new RpcError("BAD_REQUEST", L("errors.sentCopy.unavailable"));
          const op = await this.store.ops.get(id);
          if (!op) throw new RpcError("BAD_REQUEST", L("errors.sentCopy.unavailable"));
          const { messageId } = JSON.parse(op.payload_json) as SendPayload;
          const raw = await readCopyWire(this.store, id, () => this.platform.yield(), () => this.assertCurrent(life));
          this.assertCurrent(life);
          await provider.repairSentCopy({ raw, messageId, mailbox: row.mailbox }, {
            prepare: async () => raw,
            accepted: async () => { throw new Error("Copy repair cannot submit SMTP"); },
            record: (copy, identity) => { this.assertCurrent(life); return this.store.sendCopies.record(id, copy, identity); },
          });
          this.assertCurrent(life);
          const after = await this.store.sendCopies.get(id);
          if (after?.copy === "saved") {
            if (op.state === "unknown") await this.store.ops.resolveUnknown(id, "markSent", this.now());
            try { while (!this.stopped && await this.store.sendCopies.pruneSavedSlice(id)) await this.platform.yield(); } catch { /* The saved copy is already durable. */ }
          }
          if (!after) throw new RpcError("BAD_REQUEST", L("errors.sentCopy.unavailable"));
          return after.copy;
        } finally {
          if (this.sendsInFlight.delete(id) && this.sendsInFlight.size === 0) for (const settle of this.sendsSettled.splice(0)) settle();
        }
      });
    } finally { this.copyActions.delete(id); }
  }

  async recoverRejectedRecipients(id: string): Promise<string> {
    if (this.stopped || this.draining) throw new RpcError("BAD_REQUEST", L("errors.recipientReceipt.unavailable"));
    const op = await this.store.ops.get(id);
    if (!op || op.kind !== "send") throw new RpcError("BAD_REQUEST", L("errors.recipientReceipt.unavailable"));
    const target = JSON.parse(op.target_json) as { recipientRecoveryChild?: unknown };
    if (typeof target.recipientRecoveryChild === "string") return target.recipientRecoveryChild;
    const header = await this.store.recipientReceipts.get(id);
    if (!header || header.accountId !== op.account_id) throw new RpcError("BAD_REQUEST", L("errors.recipientReceipt.unavailable"));
    const life = this.lifetime(op.account_id);
    return this.accountWrite(life, async () => {
      this.assertCurrent(life);
      const rejected = await rejectedRecipients(header, (kind, index) => this.store.recipientReceipts.readPart(id, kind, index), () => this.platform.yield());
      if (!rejected.length) throw new RpcError("BAD_REQUEST", L("errors.recipientReceipt.unavailable"));
      this.assertCurrent(life);
      const child = await this.store.recipientReceipts.claimRecovery(id, header, this.now(), () => this.assertCurrent(life));
      this.assertCurrent(life);
      this.kickWorker();
      return child;
    });
  }

  async forgetRecipientReceipt(id: string): Promise<void> {
    if (this.copyActions.size >= 2 || this.copyActions.has(id) || this.sendsInFlight.has(id) || this.stopped || this.draining) throw new RpcError("BAD_REQUEST", L("errors.recipientReceipt.unavailable"));
    this.copyActions.add(id);
    try {
      const row = await this.store.recipientReceipts.get(id);
      const op = await this.store.ops.get(id);
      if (!row || !op || !["succeeded", "failed", "unknown"].includes(op.state)) throw new RpcError("BAD_REQUEST", L("errors.recipientReceipt.unavailable"));
      const life = this.lifetime(row.accountId);
      await this.accountWrite(life, async () => {
        this.assertCurrent(life);
        let more: boolean;
        try { more = await this.store.recipientReceipts.retireSlice(id); }
        catch (error) { this.server.emit("recipientReceiptRetired", { opId: id }, { origins: ["renderer", "dev"] }); throw error; }
        this.server.emit("recipientReceiptRetired", { opId: id }, { origins: ["renderer", "dev"] });
        while (more) {
          await this.platform.yield();
          this.assertCurrent(life);
          more = await this.store.recipientReceipts.retireSlice(id);
        }
        const sourceId = row.wireOwnerId ?? id;
        const source = await this.store.sendCopies.get(sourceId);
        const retained = await this.store.sendCopies.pinned(sourceId);
        if (source && !retained && !source.copyRequested) while (await this.store.sendCopies.forgetSlice(sourceId)) { this.assertCurrent(life); await this.platform.yield(); }
        else if (source && !retained && source.copy === "saved") while (await this.store.sendCopies.pruneSavedSlice(sourceId)) { this.assertCurrent(life); await this.platform.yield(); }
        this.assertCurrent(life);
        await this.store.recipientReceipts.finishRetire(id);
      });
    } finally { this.copyActions.delete(id); }
  }

  async forgetSentCopy(id: string): Promise<void> {
    if (this.copyActions.size >= 2 || this.copyActions.has(id) || this.sendsInFlight.has(id) || this.stopped || this.draining) throw new RpcError("BAD_REQUEST", L("errors.sentCopy.unavailable"));
    this.copyActions.add(id);
    try {
      const row = await this.store.sendCopies.get(id);
      const op = await this.store.ops.get(id);
      if (!row || !row.copyRequested || !op || !(["succeeded", "failed"].includes(op.state) || (op.state === "unknown" && row.submission === "accepted" && row.copy === "saved"))) throw new RpcError("BAD_REQUEST", L("errors.sentCopy.unavailable"));
      const life = this.lifetime(row.accountId);
      await this.accountWrite(life, async () => {
        while (true) {
          this.assertCurrent(life);
          if (!await this.store.sendCopies.forgetSlice(id)) break;
          await this.platform.yield();
        }
      });
    } finally { this.copyActions.delete(id); }
  }

  opInfo(op: OpRow): OpInfo {
    const payload: unknown = JSON.parse(op.payload_json);
    const subject = payload && typeof payload === "object" && "subject" in payload && typeof payload.subject === "string" ? payload.subject : "";
    const n = (JSON.parse(op.target_json) as { messageIds?: number[] }).messageIds?.length ?? 0;
    const stored = op.last_error === null ? null : decodeText(op.last_error);
    const lastError = { lastError: stored?.message ?? null, ...(stored?.i18n ? { lastErrorI18n: stored.i18n } : {}) };
    return {
      id: op.id,
      ...(op.sent_copy && { sentCopy: op.sent_copy }),
      ...(op.kind === "send" && { partialRecipients: op.send_partial ?? false, recipientOutcomeUnknown: op.send_recipient_unknown ?? false }),
      accountId: op.account_id,
      kind: op.kind,
      state: op.state,
      attempts: op.attempts,
      ...lastError,
      createdAt: op.created_at,
      // plan 25: queued until the account signs in again (a send says so)
      ...(op.state === "queued" && op.next_attempt_at === AWAITING_AUTH && { awaitingAuth: true as const }),
      ...opSummary(op.kind, subject, n),
    };
  }

  // ───────────────────────────── AI ─────────────────────────────

  /** The configured AI, ready to run tasks; throws AiError (not configured, paused by local mode, blocked). */
  ai(): Promise<AiTasks> {
    return this.aiService.current();
  }

}
