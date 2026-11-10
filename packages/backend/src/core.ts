import { AccountStatus, type StatusAuthority } from "./account-status";
import { captureLocator } from "@terno/store";
import { ProviderCooldown } from "./provider-cooldown";
import { savedGoogleRequests, type SavedGoogleRequests } from "./google-requests";
import { COOLDOWN_TICKETS, copyOpAdmission, rejectedRecipients, type CooldownStamp, type OpAdmission, type OpPark } from "@terno/store";
import { prepareCopyWire, readCopyWire } from "./sent-copy";
import type { PendingGmailRenewal } from "./identity";
import type { AiTasks } from "@terno/ai";
import { asciiEmail, canonicalAuthored, decodeText, encodeText, messageOf, aiCanRun, textRef, type Account, type AccountPrefs, type DevAiKeys, type FavoriteFolder, type FavoriteFoldersSnapshot, type AccountSyncState, type SyncProgress, type OpState, type ThreadAction } from "@terno/core";
import { breadcrumb, captureError, log, type FieldValueOf } from "@terno/core/diag";
import { RpcError, RpcServer, type AppSettings, type CallContext, type HostInfo, type MethodName, type OpInfo, type ResultOf, type Transport } from "@terno/core/rpc";
import { L } from "@terno/i18n";
import { AWAITING_AUTH, FlagObservationError, isFolderOp, operationFlagFields, type FlagObservation, type ClassifierInput, type IncomingMessage, type MailStore, type OpRow, type Platform, type ProviderStore } from "@terno/store";
import type { ImapAccountConfig } from "@terno/mail";
import { IncomingPipeline, ProviderIdentityError, ProviderCooldownError, ProviderAuthError, ProviderError, RequestNotDispatchedError, type IncomingProcessor, type MailProvider, type ProviderRegistry, type RequestDescriptor, type MailAdmission, type SendPayload, type SyncSink } from "@terno/mail/portable";
import { Autocomplete, DESKTOP_AUTOCOMPLETE_PEAK, DESKTOP_CONTACT_CAPS, DESKTOP_PHRASE_CAPS, WEB_AUTOCOMPLETE_PEAK, WEB_CONTACT_CAPS, WEB_PHRASE_CAPS } from "@terno/store/autocomplete";
import { AiService, defaultAiFactory, type AiFactory } from "./ai-service";
import { Connectivity, type ConnectivityOptions, type NetReason } from "./connectivity";
import { QuickChecks, type QuickCheckOptions } from "./quick-checks";
import { AiAssist } from "./ai-assist";
import { ActionsService } from "./actions";
import { ReplyService } from "./replies";
import { TodayService } from "./today";
import { AskService } from "./ask";
import { FollowupWorker } from "./followups";
import { SummaryWorker } from "./summaries";
import { WritingService } from "./writing";
import { Attention, type AttentionHost } from "./attention";
import { hydrateSendAttachments } from "./attachments";
import { Categorizer } from "./categorizer";
import { FactsBackfill } from "./facts";
import { Reminders } from "./reminders";
import { TabsBackfill } from "./tabs";
import { ScheduledSends, type ComposeSendParams } from "./scheduled";
import { Forwarding } from "./forwarding";
import { createHandlers } from "./handlers";
import { forgetOwnGoogleClient, googleClientFor, rememberedGoogleClient, type GoogleClients } from "./google-client";
import { restorePending } from "./import";
import { blobFingerprint, migrateLegacySecrets, readKeychainState, SecretUnreadableError, type LegacySecretReader } from "./keychain";
import { createNetworkPolicy, type LookupAll, type NetDecision, type NetworkPolicy } from "./net-policy";
import { CARRY_SLICE, carryRenamed } from "./folders";
import { followFolderFilters } from "./similar";
import { followFavoriteFolders, provideDevAi, readAutoCategorize, readComposeSuggestions, readGooglePhotos, readPolicy, readSettings, readSiteIcons, setGooglePhotoState } from "./settings";
import { IconService } from "./icons/service";
import type { IconTransport } from "./icons/transport";
import { browserUnsubscribeTransport, type UnsubscribeTransport } from "./unsubscribe";
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

/** plan 103: a sync's progress is written at most this often (the sidebar's card reads it) */
const PROGRESS_EVERY_MS = 2000;

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
  /** plan 146: a local build: the environment's keys, for Dev mode. Never set in a packaged app or the web build. */
  devAi?: DevAiKeys;
  /** demo build: no owner identity (defaults to true with the demo provider registry) */
  demo?: boolean;
  /** backend-dev E2E only: let the demo registry's no-op verification establish an owner */
  allowDemoOwnerClaims?: boolean;
  /** the host enforces the policy outside the backend too (Electron main fences the renderer) */
  onPolicy?: (policy: { localMode: boolean; errorReports: "ask" | "always" | "never"; language: AppSettings["language"] }) => void;
  openExternal?: (url: string) => Promise<void>;
  /** plan 99: Terno's own Google Desktop clients, baked into the build (google-client.ts) */
  googleClients?: GoogleClients | null;
  now?: () => number;
  log?: (level: "info" | "warn" | "error", message: string, extra?: unknown) => void;
  /** lift plan 62 clock holds on start (default); tests of its explicit Check clock contract disable it */
  checkClockOnStart?: boolean;
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
  /** plan 161: told every network policy decision; only a test host sets it (the desktop's demo mailbox, TERNO_TEST_NET_LOG) */
  onNet?: (decision: NetDecision) => void;
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
  /** tests: how often and how long accounts without push are checked after a focus (plan 176, quick-checks.ts) */
  quickChecks?: Pick<QuickCheckOptions, "everyMs" | "forMs">;
  /** plan 22: how website icons are fetched (Node: node-transport.ts); none: this host shows no website icons (the web) */
  iconTransport?: IconTransport | null;
  /** plan 96: how a one-click unsubscribe is POSTed (Node: unsubscribe-node.ts; the web: a no-cors fetch); null: never, its page opens instead */
  unsubscribeTransport?: UnsubscribeTransport | null;
  /** tests: the icon fetcher's deadlines */
  iconTimeouts?: { requestMs?: number; budgetMs?: number };
  /** plan 41: a host that shows the Dock badge and notifications itself (desktop main); without one, notices go to the page */
  attention?: AttentionHost;
}

class StatusHeld extends RequestNotDispatchedError {
  constructor() { super(L("errors.waitingForSignIn")); }
}

interface AccountLifetime {
  id: number;
  abort: AbortController;
  pending: Set<Promise<unknown>>;
  removing: boolean;
  captureRequests: number;
  provider?: MailProvider;
}

const COUNTS_EVERY_MS = 200;

const accountKindOf = (kind: string | undefined): FieldValueOf<"accountKind"> => (kind === "imap" || kind === "gmail" ? kind : "other");
const OP_KINDS = new Set<string>(["archive", "trash", "spam", "notSpam", "moveToInbox", "markRead", "markUnread", "star", "unstar", "send", "move", "moveToFolder", "leaveFolder", "toPrimary", "toPromotions", "toSocial", "toUpdates", "toForums", "toNoCategory"]);
const opKindOf = (kind: string): FieldValueOf<"opKind"> => (OP_KINDS.has(kind) ? (kind as FieldValueOf<"opKind">) : "other");

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
  moveToFolder: "backend.op.move",
  leaveFolder: "backend.op.move",
} as const;

/** What an op is, for the outbox and failure notices: English, plus the catalog message the renderer shows. */
export function opSummary(kind: string, subject: string, count: number): Pick<OpInfo, "summary" | "summaryI18n"> {
  const m = kind === "send" ? L("backend.op.send", { subject }) : Object.hasOwn(OP_SUMMARY, kind) ? L(OP_SUMMARY[kind as keyof typeof OP_SUMMARY], { count }) : L("backend.op.other", { kind, count });
  return { summary: m.message, summaryI18n: textRef(m)! };
}

const AUTO_NOTICE_GATHER_MS = 1500;
/** plan 25: a window's focus rechecks a refused saved password at most this often (a refused login, again and again, locks accounts out) */
const RECHECK_FOCUS_MS = 10 * 60_000;

/** plan 176: synced and healthy: no first sync or backfill under way, no failure, nothing waiting on the user or the network */
function quickHealthy(s: AccountSyncState): boolean {
  return s.status === "idle" && s.lastSyncAt !== null && !s.lastError && !s.connection && !s.authRequired && !s.progress;
}
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
  private readonly statuses = new Map<number, AccountStatus>();
  private readonly statusLoads = new Map<number, Promise<AccountStatus>>();
  /** plan 25: when each IMAP account's refused saved password was last rechecked, and those being rechecked now */
  private readonly rechecked = new Map<number, number>();
  private readonly rechecking = new Set<number>();
  private statusNotification: Promise<void> | null = null;
  private statusDirty = false;
  private readonly syncing = new Map<number, Promise<void>>();
  /** plan 107 (Codex R2): an account's folder change in flight (it opens when done; one queued behind it replaces it) */
  private readonly folderChanges = new Map<number, Promise<void>>();
  /** plan 107 (Codex code review round 10 #4): an account's folder list and the favorites that follow it, written one at a time */
  private readonly folderLists = new Map<number, Promise<unknown>>();
  private favoriteWrites: Promise<unknown> = Promise.resolve();
  /** the last favorites write's number (writeFavorites) */
  private favoritesRevision = 0;
  /** plan 107: what talks to an account's provider now (sync passes, ops, body reads, copy repairs): a folder change waits for it */
  private readonly providerWork = new Map<number, Set<Promise<unknown>>>();
  private readonly capacitySync = new Set<number>();
  private readonly bodyJobs = new Map<number, { threadId: number; promise: Promise<ResultOf<"reader.hydrate">> }>();
  private bodyWaiters = 0;
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
  private readonly workerIdle: (() => void)[] = [];
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
  /** the excerpts being read for each client: its next ask replaces them (plan 158) */
  readonly excerptAborts = new Map<string, AbortController>();
  readonly abort = new AbortController();
  readonly platform: Platform;
  /** the only way out of the backend: every outbound request asks it first */
  readonly net: NetworkPolicy;
  readonly aiService: AiService;
  readonly categorizer: Categorizer;
  readonly aiAssist: AiAssist;
  /** plan 132: summaries of new mail, and by hand; asleep on an empty queue */
  readonly summaries: SummaryWorker;
  readonly ask: AskService;
  readonly actions: ActionsService;
  readonly replies: ReplyService;
  readonly today: TodayService;
  readonly followups: FollowupWorker;
  /** plan 133: drafting: what goes into a draft, and the learner, asleep until the feature is used */
  readonly writing: WritingService;
  /** plan 18: recipient and body suggestions, in memory, built on first use */
  readonly autocomplete: Autocomplete;
  /** plan 17: the thread facts' backfill, woken at start and by changes */
  readonly facts: FactsBackfill;
  /** plan 86 */
  readonly tabs: TabsBackfill;
  /** plan 20: retries, offline and network changes */
  readonly connectivity: Connectivity;
  /** plan 176: the minute after a window gains focus, accounts without push are checked every 5 s */
  readonly quickChecks: QuickChecks;
  /** plan 22: sender icons (website icons and Google photos), idle until the first lookup */
  readonly icons: IconService;
  /** plan 41: the Dock badge and notifications for important new mail */
  readonly attention: Attention;
  /** plan 87: reminders: one timer for the next one, a snapshot to the windows when they change */
  readonly reminders: Reminders;
  /** plan 94: scheduled sends: one timer for the next one, sent through compose.send's own path */
  readonly scheduled: ScheduledSends;
  /** plan 116: forwards of new mail: one timer for the next one, sent through compose's own durable path */
  readonly forwards: Forwarding;
  /** plan 96 */
  readonly unsubscribeTransport: UnsubscribeTransport | null;
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
    if (options.devAi) provideDevAi(this.store, options.devAi);
    this.net = createNetworkPolicy({ siteIcons: () => readSiteIcons(this.store), lookup: options.lookup, googleChanged: () => this.cooldownChanged(), observe: options.onNet });
    // the web host POSTs through the policy (no-cors); other hosts pass theirs (Node's in backend.ts)
    this.unsubscribeTransport = options.unsubscribeTransport !== undefined ? options.unsubscribeTransport : options.host?.kind === "web" ? browserUnsubscribeTransport(this.net.fetchFor("unsubscribe")) : null;
    this.aiService = new AiService(this, options.aiFactory ?? defaultAiFactory);
    this.categorizer = new Categorizer(this);
    this.aiAssist = new AiAssist(this);
    this.summaries = new SummaryWorker({
      store: this.store,
      now: () => this.now(),
      settings: () => readSettings(this.store),
      // readSettings says `devAi` only on a local build
      runs: (s) => s.summaries.enabled && (!options.devAi || s.devAi) && aiCanRun("summary", s.ai),
      forTask: (o) => this.aiService.forTask("summary", o),
      begin: (requestId, clientId) => this.aiService.begin(requestId, clientId),
      ready: (threadId) => this.server.emit("aiSummary", { threadId }, { origins: ["renderer", "dev"] }),
      log: (level, message, extra) => this.log(level, message, extra),
    });
    this.writing = new WritingService(this);
    this.ask = new AskService(this);
    this.actions = new ActionsService(this);
    this.replies = new ReplyService(this);
    this.today = new TodayService(this);
    this.followups = new FollowupWorker({
      store: this.store,
      now: () => this.now(),
      settings: () => readSettings(this.store),
      forTask: () => this.aiService.forTask("followup", { foreground: false }),
      begin: (requestId, clientId) => this.aiService.begin(requestId, clientId),
      accountWanted: async (accountId) => (await this.store.accounts.config<AccountPrefs>(accountId))?.config.followups !== false,
      signature: async (accountId) => (await this.store.accounts.get(accountId))?.signature ?? "",
      templated: (accountId) => this.writing.learner.templatedIn(accountId),
      emit: (snapshot) => this.server.emit("followups", snapshot, { origins: ["renderer", "dev"] }),
      statusChanged: (status) => this.server.emit("followupsStatus", status, { origins: ["renderer", "dev"] }),
      notify: (notice) => this.attention.remind(notice),
      summaries: (ids) => this.store.threads.summaries(ids),
      runBudgeted: (items, work) => this.runBudgeted(items, work),
      log: (level, message, extra) => this.log(level, message, extra),
    });
    this.facts = new FactsBackfill(this);
    this.reminders = new Reminders({
      store: this.store,
      now: () => this.now(),
      emit: (snapshot) => this.server.emit("reminders", snapshot),
      notify: (notice) => this.attention.remind(notice),
      runBudgeted: (items, work) => this.runBudgeted(items, work),
      log: (level, message, extra) => this.log(level, message, extra),
    });
    this.tabs = new TabsBackfill(this);
    this.scheduled = new ScheduledSends({
      store: this.store,
      now: () => this.now(),
      emit: (snapshot) => this.server.emit("scheduled", snapshot),
      send: async (p) => void (await this.queueComposeSend(p, { renderer: true, scheduledAt: p.scheduledAt })),
      draftsBack: () => this.server.emit("drafts", { reason: "scheduled" }),
      log: (level, message, extra) => this.log(level, message, extra),
    });
    this.forwards = new Forwarding({
      store: this.store,
      now: () => this.now(),
      emit: (snapshot) => this.server.emit("forwards", snapshot),
      queued: ({ threadId, deltas }) => {
        this.categorizer.apply(deltas);
        this.notifyChanged([threadId]);
        this.kickWorker();
      },
      agentsMaySend: async () => (await readSettings(this.store)).allowAgentSend,
      language: async () => (await readPolicy(this.store)).language,
      yieldTurn: () => this.yieldTurn(),
      log: (level, message, extra) => this.log(level, message, extra),
    });
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
        signInRequired: (id) => this.statuses.get(id)?.signInRequired ?? false,
        sync: (accountId) => void this.syncAccount(accountId),
        reconnect: (reason) => void this.reconnect(reason),
        offline: () => void this.wentOffline(),
      },
      { online: options.online, now: () => this.now(), retries: options.autoSync !== false, ...options.connectivity },
    );
    this.quickChecks = new QuickChecks({ check: () => void this.quickCheck() }, { now: () => this.now(), ...options.quickChecks });
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
      onDisconnect: (ctx) => {
        this.aiService.disconnected(ctx.clientId);
        this.writing.disconnected(ctx.clientId);
        this.actions.disconnected(ctx.clientId);
        this.replies.disconnected(ctx.clientId);
        this.quickChecks.disconnected(ctx.clientId);
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
    await this.store.ready;
    this.cooldown = await ProviderCooldown.open(this.store.providerCooldown, { wallNow: () => this.now(), elapsedNow: () => performance.now(), random: () => Math.random() }, { changed: () => this.cooldownChanged() });
    // A hold (plan 62: a clock check, or evidence it couldn't resolve) is only lifted by Check clock, and no
    // control for it ships: each start lifts them, re-waiting each hold's full retained pause from now
    // (nothing is released early). In batches below the gate's write slots, drained between.
    const holds = this.options.checkClockOnStart === false ? [] : this.cooldown.holds();
    for (let i = 0; i < holds.length; i += COOLDOWN_TICKETS / 2) {
      for (const hold of holds.slice(i, i + COOLDOWN_TICKETS / 2)) this.cooldown.liftHold(hold.owner, hold.service, hold.revision);
      if ((await this.cooldown.drain(5000)) !== "drained") break;
    }
    if (holds.length) {
      const wait = this.cooldown.nextWakeDelay();
      this.log("info", `${holds.length} held Google pause(s) were lifted; ${wait === null ? "nothing waits" : `requests resume in ${Math.ceil(wait / 1000)} s`}`);
    }
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
    for (const id of this.capacitySync) {
      if (this.syncing.has(id) || !this.connectivity.canSync(id) || !this.googleReady(id)) continue;
      this.capacitySync.delete(id);
      void this.syncAccount(id);
    }
  }

  /** Before mailbox proof, Google admission belongs to the installation, never a claimed address. */
  async initialGoogleRequests(codeExchange = false, accountId?: number) {
    await this.ready;
    const policy = this.cooldown!.requestsFor("installation", () => !this.stopped && !this.abort.signal.aborted);
    const stamp = accountId === undefined ? null : await this.store.accounts.stamp(accountId);
    // A known target may refuse admission; unverified proof responses still charge installation only.
    const bound = stamp && await this.cooldown!.bindingFor(stamp) ? await this.cooldown!.requestsForAccount(stamp, () => !this.stopped && !this.abort.signal.aborted) : undefined;
    const close = () => { policy.close(); bound?.close(); };
    const failure = (error: unknown) => {
      return error instanceof ProviderCooldownError && error.cooldown.kind === "capacity" ? new ProviderError(L("errors.google.capacity"), true) : error;
    };
    const check = () => {
      try {
        for (const scope of [policy, ...(bound ? [bound] : [])]) {
          scope.check({ request: { endpoint: "gmail-api", purpose: "identity-proof" } });
          scope.check({ request: { endpoint: "google-userinfo", purpose: "identity-proof" } });
          if (codeExchange) scope.check({ request: { endpoint: "oauth-token", purpose: "authorization-code" } });
        }
        if (this.net.googlePending() >= 64) throw new ProviderError(L("errors.google.capacity"), true);
      } catch (error) { throw failure(error); }
    };
    try { check(); } catch (error) { close(); throw error; }
    return {
      request: (descriptor: RequestDescriptor, input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        check();
        return this.net.fetchGoogle(policy, descriptor)(input, init).catch((error: unknown) => {
          throw failure(error);
        });
      },
      close,
    };
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
      const blocked = [...snapshot.blockedAccountIds, ...[...this.google].filter(([id, google]) => google.paused && !this.statuses.get(id)?.signInRequired).map(([id]) => id)];
      const all = snapshot.blockAllGoogle || this.cooldown!.state("installation", "gmail-api").kind !== "ready";
      return copyOpAdmission({ ...snapshot, blockGoogleSends: !this.net.googleAvailable("send"), blockGoogleBackground: !this.net.googleAvailable("background"), blockedAccountIds: blocked, blockAllGoogle: all || version !== this.cooldownVersion,
        // plan 107: an account changing its folders is passed by until it's done (the worker is kicked then)
        pausedAccountIds: [...this.folderChanges.keys()] });
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
    // plan 123: only Terno's own Google clients; a secret saved for one of the user's goes (before the keychain move,
    // which would otherwise open and seal it again)
    await forgetOwnGoogleClient(this).catch((error: unknown) => void captureError(error, { code: "google.own_client_cleanup_failed" }));
    // before anything syncs: secrets sealed by Única are sealed again (or stay pending, and Settings asks for them)
    if (this.options.legacySecrets) {
      await migrateLegacySecrets(this.store, this.options.cipher, this.options.legacySecrets, (level, message) => this.log(level, message)).catch((error: unknown) => {
        captureError(error, { code: "keychain.migration_failed" });
        this.log("warn", "keychain migration failed; it is retried on the next start", error instanceof Error ? error.message : error);
      });
      if (this.stopped) return;
    }
    if (this.stopped) return;
    // plan 134: marked mail waits for the engine's turn
    if (!this.categorizer.ready) void this.categorizer.rebuild().then(() => this.aiAssist.wake());
    // plan 41: the badge as it is now (a restarted backend puts it back), before any sync changes it
    await this.attention.start().catch((error: unknown) => void captureError(error, { code: "notify.failed" }));
    if (this.stopped) return;
    // plan 17: old mail's facts, and threads requeued before a quit, in slices
    this.facts.wake();
    // the digest's timer, and anything a quit left pending
    void this.today.start().catch((error: unknown) => captureError(error, { code: "ai.failed" }));
    // plan 87: reminders come due whether or not mail syncs (what came due while it was closed shows at once)
    this.refreshReminders();
    // plan 86: the Gmail tabs of mail stored before them, once (and again whenever what's yours changes)
    this.tabs.start();
    // plan 94: what came due while Terno was closed goes now
    this.scheduled.poke();
    // plan 116: forwards a quit left waiting (or half sent), and new mail a crash left unlooked-at
    void this.forwards.start().catch((error: unknown) => {
      captureError(error, { code: "forward.failed" });
      this.log("warn", "forwards couldn't start", error instanceof Error ? error.message : error);
    });
    // plan 132: summaries a quit left queued; awaited (one settings read): no sync may start before ingest knows it's on
    await this.followups.start().catch((error: unknown) => {
      captureError(error, { code: "ai.failed" });
    });
    await this.summaries.start().catch((error: unknown) => {
      captureError(error, { code: "ai.failed" });
      this.log("warn", "summaries couldn't start", error instanceof Error ? error.message : error);
    });
    // plan 134: the one-time reset, then what a quit left marked; awaited like summaries, for ingest's question
    await this.aiAssist.start().catch((error: unknown) => {
      captureError(error, { code: "ai.failed" });
      this.log("warn", "categorization assist couldn't start", error instanceof Error ? error.message : error);
    });
    // plan 133: one setting read; nothing runs unless the feature has been used
    void this.writing.learner.start().catch((error: unknown) => {
      captureError(error, { code: "ai.failed" });
      this.log("warn", "voice learner couldn't start", error instanceof Error ? error.name : "error");
    });
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
    for (const account of await this.store.accounts.list()) {
      // plan 25: a refusal kept across the quit gets one recheck, and no watcher knocking with the same password
      if (this.connectivity.online && account.kind === "imap" && (await this.accountStatus(account.id)).recheck) {
        this.lifetime(account.id);
        this.connectivity.track(account.id);
        void this.recheckSignIn(account.id, "start");
      } else this.startAccount(account);
    }
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
      // accounts out); signing in again lifts it, and recheckSignIn tries the saved password at moments the user would
      if (!this.connectivity.pending(account.id) && !(await this.accountStatus(account.id)).signInRequired) void this.syncAccount(account.id);
    }
  }

  /**
   * Plan 176: a window gained or lost focus (a renderer's own on the web; on desktop, main's word for every window,
   * which a mail frame's focus doesn't hide). With autoSync off nothing syncs by itself, so nothing starts here.
   */
  windowFocus(clientId: string, focused: boolean): void {
    if (this.options.autoSync !== false) this.quickChecks.focus(clientId, focused);
  }

  /**
   * Plan 176: one quick check, the minute after a window gained focus. Only accounts whose provider takes quick passes
   * (`quickChecks`: Gmail; Outlook's when it comes) and that are synced and healthy: one in a first sync, a backfill
   * or a pass, one that failed (it waits for its retry or the poll; a failure that isn't retried isn't repeated every
   * 5 s) or that needs a sign-in is left alone. Push accounts (IMAP) already hear of new mail.
   */
  private async quickCheck(): Promise<void> {
    const admitted = (accountId: number) => !this.syncing.has(accountId) && this.quickAdmitted(accountId);
    for (const account of await this.store.accounts.list()) {
      if (!admitted(account.id) || !quickHealthy((await this.accountStatus(account.id)).project())) continue;
      const provider = await this.provider(account.id).catch(() => null);
      // admitted again: a blur, offline or another pass may have come while those were read
      if (provider?.quickChecks && admitted(account.id)) void this.syncAccount(account.id, undefined, { quick: true });
    }
  }

  /**
   * Plan 176: a quick pass may go now: a window has focus within the minute and the account may sync. The poll not
   * running yet (before start) or at all (autoSync off) has nothing to hurry. Asked again as the pass starts (it can
   * wait behind a folder change) and just before the provider, so a blur or offline meanwhile drops it quietly.
   */
  private quickAdmitted(accountId: number): boolean {
    return !this.stopped && this.syncTimer !== null && this.quickChecks.running && this.connectivity.canSync(accountId);
  }

  // ───────────────────────────── network (plan 20) ─────────────────────────────

  /** The host's word on the network: desktop's main (a route or address change, a wake), the web page (online/offline). */
  networkChanged(online: boolean, reason: NetReason): void {
    if (this.stopped) return;
    // plan 87: a timer runs late across sleep: a wake looks at once (sync or not)
    if (reason === "wake") {
      this.refreshReminders();
      this.today.wake();
      this.scheduled.poke();
      this.forwards.poke();
    }
    // plan 132: what waited for the provider to be reachable
    if (online) {
      this.summaries.wake({ network: true });
      this.followups.wake({ network: true });
      this.aiAssist.wake({ network: true });
    }
    if (this.options.autoSync === false) return;
    breadcrumb("sync", "net.changed", { netReason: reason, online });
    this.connectivity.network(online, reason);
  }

  /** "Retry now" (the user: every account or one) or a window regaining focus (offline accounts, rate-limited). */
  async retryNow(accountId: number | null, reason: "user" | "focus"): Promise<void> {
    if (this.stopped) return;
    for (const account of await this.store.accounts.list()) if (accountId === null || account.id === accountId) await this.accountStatus(account.id);
    if (reason === "user") {
      for (const [id, google] of this.google) if (accountId === null || accountId === id) google.recoverPolicy();
      this.cooldownChanged();
    }
    const ids = this.connectivity.retryNow(accountId, reason);
    if (reason === "user") {
      let resumed = false;
      for (const id of ids) resumed = (await this.store.ops.resumeNetwork(id, this.now())).length > 0 || resumed;
      if (resumed) this.kickWorker();
    }
    for (const id of ids) void this.syncAccount(id);
    for (const account of await this.store.accounts.list()) {
      if (accountId !== null && account.id !== accountId) continue;
      void this.recheckSignIn(account.id, reason);
    }
  }

  /**
   * Plan 25: a server that refused an IMAP account's saved password may take it again (a glitch, a lockout
   * lifted). At a moment the user would try again (a launch, a network change, Retry, the window's focus at
   * most every ten minutes) the saved password gets one login: IMAP for a refusal IMAP made, IMAP and SMTP as a
   * sign-in proves them when the refusal's protocol is unknown (one kept across a quit). Accepted, the refusal
   * lifts as a sign-in would; refused, nothing changes. Gmail's refusal is a revoked grant: only a sign-in
   * answers it. Lifted, the account watches and syncs again.
   */
  private async recheckSignIn(accountId: number, reason: "start" | "network" | "user" | "focus"): Promise<boolean> {
    const life = this.lifetimes.get(accountId);
    if (!life || !this.current(life) || this.rechecking.has(accountId)) return false;
    const last = this.rechecked.get(accountId);
    if (reason === "focus" && last !== undefined && this.now() - last < RECHECK_FOCUS_MS) return false;
    this.rechecking.add(accountId);
    try {
      const account = await this.store.accounts.get(accountId);
      const status = await this.accountStatus(accountId);
      const scope = status.recheck;
      if (account?.kind !== "imap" || !scope || !this.current(life)) return false;
      this.rechecked.set(accountId, this.now());
      // a refusal published while the login runs is newer than its answer
      const recover = status.recoveryProof(this.statusAuthority(life), scope);
      if (scope === "incoming") {
        const provider = await this.provider(accountId);
        if (!provider || !this.current(life)) return false;
        await provider.verify();
      } else {
        const config = (await this.store.accounts.config<ImapAccountConfig>(accountId))?.config;
        const password = await this.getSecret(`account:${accountId}:password`);
        if (!config || !password || !this.current(life)) return false;
        await this.options.providers.verifyImap(config, password);
      }
      await recover();
      if (status.signInRequired) return false;
      await this.resumeAuth(accountId);
      this.watchAccount(accountId);
      void this.syncAccount(accountId);
      return true;
    } catch {
      // a refused (or failed) recheck never discharges the sign-in hold
      return false;
    } finally {
      this.rechecking.delete(accountId);
    }
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
    // each account on its own: one server slow to answer its login holds up nobody else's mail
    await Promise.all((await this.store.accounts.list()).map(async (account) => {
      await this.recheckSignIn(account.id, "network");
      // a watcher would only knock with a password its server refuses
      if (!this.unwatch.has(account.id) && !(await this.accountStatus(account.id)).signInRequired) this.watchAccount(account.id);
      await this.store.ops.resumeNetwork(account.id, this.now());
      // the worker paused while offline: whatever is due goes now
      this.kickWorker();
    }));
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
    const networkEpoch = this.connectivity.epoch;
    for (const account of await this.store.accounts.list()) {
      // a sign-in to redo stays what it is
      const life = lifetimes.get(account.id);
      if (!life || account.syncState.status === "error" || !this.store.isOpen || !this.current(life)) continue;
      await (await this.accountStatus(account.id)).network({ live: () => this.current(life) && !this.connectivity.online && this.connectivity.epoch === networkEpoch }, {
        status: "offline",
        lastError: offline.message,
        lastErrorI18n: textRef(offline) ?? null,
        connection: { state: "offline", retryAt: this.connectivity.retryAt(account.id) },
      });
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
    const until = this.now() + Math.max(0, deadlineMs);
    // plan 158: a send held for its Undo goes now: whoever quit a moment after Send means it to go, not at the next launch
    if (await this.scheduled.releaseHolds().catch(() => 0)) await this.workerSettled(deadlineMs);
    deadlineMs = until - this.now();
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

  /** Runs the worker now, and resolves once it has gone through what's ready, or at the deadline. */
  private async workerSettled(deadlineMs: number): Promise<void> {
    const running = this.workerRunning ? new Promise<void>((r) => this.workerIdle.push(r)) : this.runWorker();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([running, new Promise((r) => (timer = setTimeout(r, Math.max(0, deadlineMs))))]);
    clearTimeout(timer);
  }

  /** Resolves once no send is in flight. */
  sendsIdle(): Promise<void> {
    return this.sendsInFlight.size === 0 ? Promise.resolve() : new Promise((r) => this.sendsSettled.push(r));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.backfillTimers.values()) clearTimeout(timer);
    this.backfillTimers.clear();
    this.gmailRenewals.clear();
    for (const flow of this.signIns.values()) flow.abort();
    this.signIns.clear();
    this.abort.abort();
    const openingRetirement = this.store.cancelOpening?.();
    void this.ready.catch(() => {});
    this.aiAssist.stop();
    this.summaries.stop();
    this.followups.stop();
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
    this.quickChecks.stop();
    const accountsClosed = Promise.allSettled([...this.lifetimes.values()].map((life) => this.dropAccount(life.id, { remove: life.removing })));
    if (this.syncTimer) clearInterval(this.syncTimer);
    if (this.idleTimer) clearInterval(this.idleTimer);
    if (this.countsTimer) clearTimeout(this.countsTimer);
    this.attention.stop();
    this.reminders.stop();
    await this.today.stop();
    // plan 94: no new scheduled send starts; the one in flight finishes before the store closes (awaited below)
    const scheduledStopped = this.scheduled.stop();
    const forwardsStopped = this.forwards.stop();
    for (const n of this.autoNotices.values()) if (n.timer) clearTimeout(n.timer);
    this.categorizer.stop();
    // the slice in flight finishes; the next start resumes where the store's progress says
    await this.writing.learner.stop();
    await this.facts.stop();
    await this.tabs.stop();
    if (this.workerTimer) clearTimeout(this.workerTimer);
    if (this.cooldownTimer) clearTimeout(this.cooldownTimer);
    for (const off of this.unwatch.values()) off();
    await accountsClosed;
    await scheduledStopped;
    await forwardsStopped;
    await Promise.allSettled([...this.bodyJobs.values()].map((job) => job.promise));
    // let an in-flight ops batch finish writing before the database closes
    for (let i = 0; this.workerRunning && i < 200; i++) await new Promise((r) => setTimeout(r, 10));
    await openingRetirement;
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
    "threads.bodyPart",
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

  /** plan 87: the reminders now (a start, a wake, a window's focus); a failure waits for the next one */
  refreshReminders(): void {
    this.reminders.refresh().catch((error: unknown) => {
      captureError(error, { code: "reminders.failed" });
      this.log("warn", "reminders couldn't be read", error instanceof Error ? error.message : error);
    });
  }

  /**
   * compose.send's own path (plan 94's scheduled sends take it too): queued
   * (the draft deleted with it), then announced. Once queued, nothing after
   * it can fail the send: the announcing is logged instead.
   */
  async queueComposeSend(p: ComposeSendParams, o: { renderer: boolean; scheduledAt?: number }): Promise<{ opId: string; threadId: number; messageId: number }> {
    const { opId, threadId, messageId, deltas } = await this.store.compose.queueSend({
      accountId: p.accountId,
      to: p.to,
      cc: p.cc,
      bcc: p.bcc,
      subject: p.subject,
      bodyText: p.bodyText,
      // HTML only from the renderer, which builds it from a document (agents send text)
      bodyHtml: o.renderer && p.bodyHtml ? p.bodyHtml : undefined,
      inReplyToMessageId: p.inReplyToMessageId,
      draftId: p.draftId,
      draftRevision: p.draftRevision,
      draftGeneration: p.draftGeneration,
      attachments: p.attachments,
      recordReply: o.renderer,
      ...(o.scheduledAt !== undefined && { scheduledAt: o.scheduledAt }),
      // plan 133 §8: only the renderer knows what was typed; a scheduled send kept what it said in its params
      ...(p.draftId !== undefined && { writing: { authored: o.renderer && p.authoredText !== undefined ? canonicalAuthored(p.authoredText) : null } }),
      now: this.now(),
    });
    try {
      this.categorizer.apply(deltas);
      this.notifyChanged([threadId]);
      this.kickWorker();
    } catch (error) {
      captureError(error, { code: "send.failed", expected: false });
      this.log("warn", "a queued send couldn't be announced", error instanceof Error ? error.message : error);
    }
    return { opId, threadId, messageId };
  }

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
      this.reminders.touched();
      this.followups.touched();
      this.scheduled.touched();
      this.emitCounts();
      this.autocomplete.notify();
      this.facts.wake();
      this.tabs.start();
      this.writing.learner.wake();
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
    const counts = await this.today.withCount(await this.store.threads.counts(this.now()));
    if (this.stopped) return;
    this.server.emit("counts", counts);
    // plan 41: the Dock shows the sidebar's Inbox number (no query of its own)
    this.attention.counts(counts);
  }

  async retryCapture(accountId: number, key: string, revision: number): Promise<import("@terno/core").CaptureRepair | null> {
    const life = this.lifetime(accountId), credentials = this.credentialsOf(accountId);
    const check = () => { this.assertCurrent(life); if (credentials !== this.credentialsOf(accountId)) throw new RequestNotDispatchedError(L("errors.accountGone")); };
    if (life.captureRequests >= 50) throw new RpcError("UNAVAILABLE", L("capture.busy"));
    life.captureRequests++;
    try {
      await this.accountWrite(life, () => this.store.captureRepairs.retry(accountId, key, revision, check));
      const locator = captureLocator(key);
      await this.syncAccount(accountId, { locator, revision: revision + 1, check });
      check();
      return this.store.captureRepairs.get(accountId, locator);
    } finally { life.captureRequests--; }
  }

  async retryAttachments(accountId: number, messageId: number): Promise<void> {
    const life = this.lifetime(accountId), credentials = this.credentialsOf(accountId);
    const check = () => { this.assertCurrent(life); if (credentials !== this.credentialsOf(accountId)) throw new RequestNotDispatchedError(L("errors.accountGone")); };
    if (life.captureRequests >= 50) throw new RpcError("UNAVAILABLE", L("capture.busy"));
    life.captureRequests++;
    try {
      await this.accountWrite(life, () => this.store.attachments.retry(accountId, messageId, check));
      const repair = await this.store.captureRepairs.forMessage(accountId, messageId);
      check();
      await this.syncAccount(accountId, repair ? { locator: repair.locator, revision: repair.revision, check } : undefined);
    } finally { life.captureRequests--; }
  }

  /**
   * Plan 101: an account's effective window grew from `oldDays` to `newDays`: the span between is recorded as a
   * request (merged with a pending one: their union), and a pass starts now (not awaited) to begin downloading it.
   */
  async widenWindow(accountId: number, oldDays: number, newDays: number): Promise<void> {
    if (!(newDays > oldDays)) return;
    const now = this.now();
    // merged in the store's own transaction (Codex review: two widenings at once never lose one another's span)
    if (!(await this.store.accounts.update(accountId, { backfill: { merge: { since: now - newDays * 86_400_000, until: now - oldDays * 86_400_000 } } }))) return;
    void this.syncAccount(accountId).catch(() => {});
  }

  /** Plan 101: storage removal wins: what the user removes isn't fetched back by a pending backfill. */
  async cancelBackfills(): Promise<void> {
    for (const account of await this.store.accounts.list()) {
      if (account.backfillSince != null) await this.store.accounts.update(account.id, { backfill: null });
    }
  }

  private async accountStatus(accountId: number): Promise<AccountStatus> {
    const existing = this.statuses.get(accountId);
    if (existing) return existing;
    let loading = this.statusLoads.get(accountId);
    if (!loading) {
      const life = this.lifetime(accountId);
      loading = (async () => {
        const account = await this.store.accounts.get(accountId);
        // Provider replacement retains this account owner; removal keeps its original fence.
        if (!account || life.removing || this.lifetimes.get(accountId)?.removing || this.stopped) throw new RpcError("NOT_FOUND", L("errors.accountGone"));
        const status = new AccountStatus({
          initial: account.syncState,
          generation: () => this.credentialsOf(accountId),
          write: (state) => {
            const owner = this.lifetimes.get(accountId) ?? life;
            const pending = this.store.accounts.setSyncState(accountId, state);
            owner.pending.add(pending);
            void pending.then(() => owner.pending.delete(pending), () => owner.pending.delete(pending));
            return pending;
          },
          changed: () => this.statusChanged(),
          failed: () => this.log("warn", "Account status could not be saved"),
          admissionChanged: () => {
            this.connectivity.waitForSignIn(accountId, this.statuses.get(accountId)?.signInRequired ?? false);
            this.cooldownChanged();
          },
        });
        this.statuses.set(accountId, status);
        return status;
      })();
      this.statusLoads.set(accountId, loading);
      void loading.then(() => this.statusLoads.delete(accountId), () => this.statusLoads.delete(accountId));
    }
    return loading;
  }

  private statusAuthority(life: AccountLifetime): StatusAuthority {
    return { generation: this.credentialsOf(life.id), live: () => this.current(life) };
  }

  private statusChanged(): void {
    this.statusDirty = true;
    this.statusNotification ??= Promise.resolve().then(async () => {
      try {
        while (this.statusDirty && !this.stopped) { this.statusDirty = false; await this.emitAccounts(); }
      } finally {
        this.statusNotification = null;
        if (this.statusDirty && !this.stopped) this.statusChanged();
      }
    }).catch(() => this.log("warn", "Account status could not be published"));
  }

  async accountViews(accounts: Account[]): Promise<Account[]> {
    await Promise.all(accounts.map(async (account) => { await this.accountStatus(account.id); }));
    return accounts.map((account) => ({ ...account, syncState: this.statuses.get(account.id)!.project() }));
  }

  async emitAccounts(): Promise<void> {
    const accounts = await this.accountViews(await this.store.accounts.list());
    this.server.emit("accounts", accounts);
    if (this.autocomplete.warmed) this.autocomplete.setOwn(accounts.map((a) => a.email));
    // plan 17 (Codex review 1, #7): an account added or removed changed your addresses; its rescan runs now, with or
    // without mail to sync (an empty account brings no change that would wake it). Idle, a wake is one probe.
    this.facts.wake();
    this.tabs.start();
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
  async ingestSliced(messages: IncomingMessage[], applyFilters = true, life?: AccountLifetime, onInserted?: (ids: number[]) => void, observation?: FlagObservation, checkCurrent?: () => void, pass?: { accountId: number; pass: number }, live = false): Promise<{ inserted: number[] }> {
    const inserted: number[] = [];
    await this.runSliced(messages, 50, async (chunk) => {
      // one store command per slice: messages, filter claims and actions with their ops, and
      // the categorizer's decisions commit together
      if (life) this.assertCurrent(life);
      const classifier = await this.classifier();
      checkCurrent?.();
      // plan 116: live mail may be forwarded (marked with its insertion), only while a rule forwards
      const forwardEligible = live && this.forwards.isActive;
      // plan 131 revision 5: and it's new mail the AI features may want, with the message or never (off: this one boolean)
      const wants = live ? { summary: this.summaries.isActive, category: await this.aiAssist.wanted() } : null;
      const newMail = wants && (wants.summary || wants.category) ? wants : undefined;
      // plan 142: mail you sent from elsewhere, only while live; the account's own switch is the worker's to read
      const liveSent = live ? { wanted: this.followups.isActive, since: this.followups.since } : undefined;
      const ingest = async (batch: IncomingMessage[]) => (batch.length ? this.store.sync.ingest(batch, { applyFilters, now: this.now(), classifier, observation, check: checkCurrent, forwardEligible, newMail, liveSent }) : null);
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
      this.announceAuto(r.auto);
      this.opsQueued(r.opIds);
      this.reconcileFlags(r.flagReconcileAccounts);
      this.notifyChanged(r.touched);
      // plan 116: what it inserted, and the bodies it completed (their filters and category may make them go)
      if (this.forwards.isActive) {
        this.planForwards({ messageIds: forwardEligible ? r.inserted : [], threadIds: r.touched });
        void this.forwards.filesArrived({ threadIds: r.touched }).catch(() => {});
      }
      // plan 132: what it queued, and any body it completed for what waits
      this.summaries.wake();
      if (live) this.followups.wake();
      // plan 134: after commit, outside the slice
      this.aiAssist.wake();
    });
    return { inserted };
  }

  /** The categorizer's pure part of an ingestion command (null until a model is ready). */
  async classifier(): Promise<ClassifierInput | null> {
    const model = this.categorizer.model;
    return model ? { model, mode: await readAutoCategorize(this.store) } : null;
  }

  /** Plan 134: the AI filed it; announced like the engine's. */
  announceFiled(categoryId: number, threadId: number): void {
    this.announceAuto(new Map([[categoryId, [threadId]]]));
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
      life = { id: accountId, abort: new AbortController(), pending: new Set(), removing: false, captureRequests: 0 };
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
      repairs: {
        get: (_account, locator) => read(() => store.repairs!.get(life.id, locator)),
        list: (_account, after, state) => read(() => store.repairs!.list(life.id, after, state)),
      },
      messageByProviderId: (id) => read(() => store.messageByProviderId(id)),
      syncedMessagePage: (after) => read(() => store.syncedMessagePage(after)),
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
        resumeResolved: () => write(() => locations.resumeResolved()),
        dispatch: (ids, expected, start, fenceIds) => write(() => locations.dispatch(ids, expected, start, fenceIds)),
        mappedMove: (...args) => write(() => locations.mappedMove(...args)),
        refused: (...args) => write(() => locations.refused(...args)),
        adopt: (...args) => write(() => locations.adopt(...args)),
        upsert: (...args) => write(() => locations.upsert(...args)),
        upsertMany: (...args) => write(() => locations.upsertMany(...args)),
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
      const status = await this.accountStatus(accountId);
      const authority = this.statusAuthority(life);
      const google = account.kind === "gmail" && !cfg.config.demo ? await savedGoogleRequests({
        status,
        gate: this.cooldown!, net: this.net, store: this.store.providerCooldown, stamp,
        live: () => this.current(life), credentials: () => this.credentialsOf(accountId),
        write: (work) => this.accountWrite(life, work), changed: () => this.cooldownChanged(),
      }) : undefined;
      if (!this.current(life)) { google?.close(); return null; }
      if (google) this.google.set(accountId, google);
      const provider = this.options.providers.create({
        yield: () => this.platform.yield(),
        google,
        tokenResult: (generation, error) => {
          if (error instanceof ProviderAuthError) void status.refuse({ ...authority, generation }, error);
        },
        flagObservation: true,
        store: this.providerStore(life), account, config: cfg.config,
        incoming: {
          acquire: (id, signal, reset, admission) => this.incoming.acquire(id, signal, reset, admission),
          promote: (id, signal, reset, admission) => this.promote(life, id, signal, reset, admission),
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
        // plan 99: the client this account's refresh token belongs to (read now: a reconnect may have recorded it)
        googleClient: () => this.accountRead(life, async () => googleClientFor(this, await rememberedGoogleClient(this, accountId))),
        event: (code, fields) => {
          if (this.current(life)) breadcrumb("sync", code, { accountKind: accountKindOf(account.kind), ...(fields?.durationMs !== undefined && { durationMs: fields.durationMs }) });
        },
        loadCursor: async <T,>() => this.accountRead(life, async () => ((await this.store.accounts.config<{ cursor?: T }>(accountId))?.config.cursor ?? null) as T | null),
        saveCursor: (cursor, check) => this.accountWrite(life, () => this.store.accounts.setCursor(accountId, cursor, check)),
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

  private async promote(life: AccountLifetime, accountId: number, signal: AbortSignal, reset?: AbortSignal, admission?: MailAdmission): Promise<() => void> {
    this.assertCurrent(life);
    const stop = AbortSignal.any(reset ? [signal, reset, life.abort.signal, this.abort.signal] : [signal, life.abort.signal, this.abort.signal]);
    const release = await this.incoming.promote(accountId, stop, undefined, admission);
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
    this.capacitySync.delete(accountId);
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
    await this.statuses.get(accountId)?.flush();
    const outcomes = await Promise.allSettled(life.pending);
    const failed = outcomes.find((r) => r.status === "rejected" && r.reason !== life.abort.signal.reason);
    if (failed?.status === "rejected") throw failed.reason;
  }

  /** Called only after successful durable row deletion; failed deletion keeps its fence. */
  /** plan 101: the timers of the next backfill chunks (one an account; stop and removal clear them) */
  private readonly backfillTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private continueBackfill(accountId: number): void {
    if (this.stopped || this.backfillTimers.has(accountId)) return;
    const timer = setTimeout(() => {
      this.backfillTimers.delete(accountId);
      if (!this.stopped && this.connectivity.online) void this.syncAccount(accountId).catch(() => {});
    }, 1000);
    (timer as { unref?: () => void }).unref?.();
    this.backfillTimers.set(accountId, timer);
  }

  accountRemoved(accountId: number): void {
    const backfill = this.backfillTimers.get(accountId);
    if (backfill) clearTimeout(backfill);
    this.backfillTimers.delete(accountId);
    const life = this.lifetimes.get(accountId);
    if (!life?.abort.signal.aborted) return;
    this.lifetimes.delete(accountId);
    this.credentials.delete(accountId);
    this.statuses.delete(accountId);
    this.capacitySync.delete(accountId);
    this.cooldownAccounts.delete(accountId);
    this.cooldownChanged();
    this.options.providers.gmailTokens?.forget?.(accountId);
  }

  hydrateBody(threadId: number, messageId: number): Promise<ResultOf<"reader.hydrate">> {
    const existing = this.bodyJobs.get(messageId);
    if (existing && existing.threadId !== threadId) return Promise.resolve<ResultOf<"reader.hydrate">>({ changed: false });
    if (this.bodyWaiters >= 8 || (!existing && this.bodyJobs.size >= 2)) return Promise.reject(new RpcError("UNAVAILABLE", L("attachments.busy")));
    const job = existing ?? { threadId, promise: Promise.resolve<ResultOf<"reader.hydrate">>({ changed: false }) };
    if (!existing) {
      job.promise = Promise.resolve().then(() => this.readSelectedBody(threadId, messageId)).finally(() => { if (this.bodyJobs.get(messageId) === job) this.bodyJobs.delete(messageId); });
      this.bodyJobs.set(messageId, job);
    }
    this.bodyWaiters++;
    return job.promise.finally(() => { this.bodyWaiters--; });
  }

  private async readSelectedBody(threadId: number, messageId: number): Promise<ResultOf<"reader.hydrate">> {
    await this.ready;
    // the message's state is all this needs: parts, so no body in the thread is read to learn it
    const detail = await this.store.threads.get(threadId, { bodyFormat: "parts" });
    const message = detail?.messages.find((m) => m.id === messageId);
    if (!message || message.bodyState === "full" || message.bodyUnavailable) return { changed: false };
    const life = this.lifetime(message.accountId);
    const credentials = this.credentialsOf(message.accountId);
    const eviction = this.evictions.generation;
    const check = () => {
      this.assertCurrent(life);
      if (life.abort.signal.aborted || credentials !== this.credentialsOf(message.accountId) || eviction !== this.evictions.generation) throw new RequestNotDispatchedError(L("errors.accountGone"));
    };
    check();
    const account = await this.accountRead(life, () => this.store.accounts.get(message.accountId));
    if (!account || (await this.accountStatus(message.accountId)).signInRequired) return { changed: false };
    const ids = await this.providerStore(life).providerIds([messageId]);
    const providerMsgId = ids.get(messageId);
    if (!providerMsgId || providerMsgId.startsWith("local:")) return { changed: false };
    const provider = await this.provider(message.accountId);
    check();
    if (!provider?.readBody) return { changed: false };
    const body = await this.afterFolderChange(message.accountId, () => provider.readBody!({ id: messageId, providerMsgId }, AbortSignal.any([life.abort.signal, this.abort.signal]))).catch(async (error: unknown) => {
      if (error instanceof ProviderAuthError) {
        check();
        await this.needsSignIn(message.accountId, "read", error, credentials, life);
      }
      throw error;
    });
    if (!body) { check(); return { changed: false, unavailable: true }; }
    try {
      check();
      const classifier = await this.classifier();
      const result = await this.evictions.write(() => this.accountWrite(life, () => this.store.sync.setBody(messageId, body.parsed.text, body.parsed.html, {
        now: this.now(), classifier, bodyParts: body.parsed.bodyParts, preparedBodyTokens: body.parsed.preparedBodyTokens, attachments: body.parsed.captureUnavailable ? undefined : body.parsed.attachments, captureUnavailable: body.parsed.captureUnavailable,
        expected: { accountId: message.accountId, threadId, providerMsgId }, check,
      })));
      this.categorizer.apply(result.deltas);
      this.announceAuto(result.auto);
      this.opsQueued(result.opIds);
      this.reconcileFlags(result.flagReconcileAccounts);
      this.notifyChanged(result.touched, false);
      this.bodyArrived(messageId);
      return { changed: result.touched.length > 0 };
    } finally { body.release(); }
  }

  /**
   * One sync pass. `quick` (plan 176): a quick check, only new mail and changes (SyncSink.quick), quietly: it says
   * nothing of itself in the account's status (no "syncing", no new "synced at"), so a check with nothing new writes
   * and publishes nothing. One already running isn't followed by another: the running pass reads the same mail.
   */
  syncAccount(accountId: number, captureRetry?: { locator: import("@terno/core").CaptureLocator; revision: number; check(): void }, o: { quick?: boolean } = {}): Promise<void> {
    if (this.stopped || this.google.get(accountId)?.paused) return Promise.resolve();
    const life = this.lifetime(accountId);
    if (!this.current(life)) return Promise.resolve();
    const running = this.syncing.get(accountId);
    if (running && o.quick) return Promise.resolve();
    if (running && !captureRetry) {
      // Don't drop the notification (IDLE/push during a long sync): schedule one more pass.
      this.syncAgain.add(accountId);
      return running.then(() => this.syncing.get(accountId));
    }
    let status: AccountStatus | undefined;
    let statusRun: ReturnType<AccountStatus["begin"]> | undefined;
    const setState = (patch: Partial<AccountSyncState>) => statusRun?.update(patch) ?? Promise.resolve();
    const work = async () => {
      captureRetry?.check();
      // before the provider: a provider made from older credentials never passes for the new ones (Codex code review #1)
      const credentials = this.credentialsOf(accountId);
      status = await this.accountStatus(accountId);
      if (status.signInRequired || !this.current(life)) return;
      // plan 176: a quick pass that waited (a folder change) goes only if it still may, on an account still healthy
      if (o.quick && (!this.quickAdmitted(accountId) || !quickHealthy(status.project()))) return;
      const authority = this.statusAuthority(life);
      statusRun = status.begin(authority);
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
        captureRetry?.check();
        this.assertCurrent(life);
        if (credentials !== this.credentialsOf(accountId)) throw new RequestNotDispatchedError(L("errors.gmail.requestOffline"));
      };
      const windowDays = before?.syncWindowDays ?? (await readSettings(this.store)).syncWindowDays;
      // plan 101: older mail a widened window asks for, a chunk after this pass's own work
      const backfill = before?.backfillSince != null ? (await this.store.accounts.config<AccountPrefs>(accountId))?.config.backfill : undefined;
      // plan 101/102: more of this account's sync remains (older mail, or a first sync's next chunk)
      let more = false;
      // plan 103: progress, written at most every PROGRESS_EVERY_MS (a batch can report many times a second)
      let progress: SyncProgress | null = null, progressAt = Number.NEGATIVE_INFINITY;
      let backfillFinished = false;
      const sink: SyncSink = {
        ...(captureRetry && { captureRetry: { locator: captureRetry.locator, revision: captureRetry.revision } }),
        ...(o.quick && { quick: true as const }),
        signal: life.abort.signal,
        blockCapture: async (locator, reason, revision) => {
          checkCurrent();
          const write = () => this.accountWrite(life, () => this.store.captureRepairs.block(accountId, locator, reason, revision, checkCurrent));
          if (locator.kind === "gmail") await this.evictions.capture(accountId, pass, locator.providerId, write);
          else await write();
        },
        retireCapture: async (locator) => {
          checkCurrent();
          await this.accountWrite(life, () => this.store.captureRepairs.retire(accountId, locator, checkCurrent));
        },
        ingest: async (messages, o) => {
          await this.ingestSliced(messages, true, life, o?.live ? (ids) => arrivals.add(ids) : undefined, provider.flagSnapshotSource === "locations" ? undefined : observation ?? undefined, checkCurrent, { accountId, pass }, o?.live === true);
        },
        // the account's own window, else the general one
        windowDays,
        windowStart: this.now() - windowDays * 86_400_000,
        again: () => { more = true; },
        progress: (p) => {
          // a change of phase (downloading → finishing) is written at once, never held back (Codex review)
          const phase = Boolean(p.finishing) !== Boolean(progress?.finishing);
          progress = { ...p };
          const now = performance.now();
          if (!phase && now - progressAt < PROGRESS_EVERY_MS) return;
          progressAt = now;
          // only to the sync card (an accounts event would re-render the reader and the composer
          // every 2 s for the whole sync); saved with the pass's own state writes, at a chunk's end
          if (this.current(life)) this.server.emit("syncProgress", { accountId, progress });
        },
        ...(backfill && {
          backfill: { since: backfill.since, until: backfill.until },
          backfillMore: () => { more = true; },
          backfillDone: async (done) => {
            backfillFinished = true;
            checkCurrent();
            // only that request, compared and cleared in one store transaction: a wider one recorded meanwhile stays
            await this.accountWrite(life, () => this.store.accounts.update(accountId, { backfill: { clearIf: done } }));
            await this.emitAccounts();
          },
        }),
        updateFlags: async (updates, o) => {
          const touched = new Set<number>();
          await this.runSliced(updates, 200, async (chunk) => {
            checkCurrent();
            const result = await this.accountWrite(life, () => this.store.sync.updateFlags(accountId, chunk, o?.authoritative === false ? undefined : observation ?? undefined, checkCurrent));
            for (const t of result.touched) touched.add(t);
            this.reconcileFlags(result.flagReconcileAccounts);
          });
          this.notifyChanged(touched);
        },
        setBody: async (messageId, text, html, attachments, capture) => {
          const checkBody = () => { checkCurrent(); capture?.signal?.throwIfAborted(); };
          checkBody();
          const classifier = await this.classifier();
          checkBody();
          const r = await this.accountWrite(life, () => this.store.sync.setBody(messageId, text, html, { now: this.now(), classifier, attachments, bodyParts: capture?.bodyParts, preparedBodyTokens: capture?.preparedBodyTokens, captureUnavailable: capture?.captureUnavailable, repair: capture?.repair, check: checkBody }));
          this.categorizer.apply(r.deltas);
          this.announceAuto(r.auto);
          this.opsQueued(r.opIds);
          this.reconcileFlags(r.flagReconcileAccounts);
          this.notifyChanged(r.touched, false);
          this.bodyArrived(messageId);
        },
        removeMessages: async (ids) => {
          checkCurrent();
          this.notifyChanged((await this.accountWrite(life, () => this.store.sync.remove(ids, checkCurrent))).touched);
        },
        pendingMessageIds: () => this.accountRead(life, () => this.store.sync.pendingMessageIds(accountId)),
        setSyncState: (patch) => setState(patch),
        // plan 68: the account's own folders; an unchanged list writes and says nothing
        setFolders: async (folders, renamed = [], deleted = [], unproven = []) => {
          checkCurrent();
          // plan 107: a rename this list shows done that the backend hasn't followed (its answer was lost, Codex code
          // review round 5 #1) is announced as a change's is, and favorites follow it. The provider hands only those
          // (its records' acknowledgement), never decided by what the store lists: a stale listing of the new path
          // suppressed it (Codex code review round 15 #2)
          const moves = renamed.filter((m) => m.from !== m.to);
          // carried before the list is stored, as a change's are (Codex code review round 8 #1); only from a key the
          // store still shows (one followed before a crash kept its acknowledgement from being written has none, and
          // its new key's rows are the carry's already)
          const shown = moves.length ? new Set((await this.accountRead(life, () => this.store.folders.list())).filter((f) => f.accountId === accountId).map((f) => f.key)) : null;
          const carried = shown ? moves.filter((m) => shown.has(m.from)) : [];
          const partial = await carryRenamed(this, accountId, carried, folders, (work) => this.accountWrite(life, work), moves);
          // a retired rename's new key whose carried rows no read proved starts empty and is derived again from its
          // places (Codex code review round 25 #1: a server that renumbered it left a thread listed with none there)
          const again = unproven.filter((key) => folders.some((f) => f.key === key));
          for (const key of again) while ((await this.accountWrite(life, () => this.store.folders.clear(accountId, key, CARRY_SLICE))).more) await this.yieldTurn();
          // the list and the favorites that follow it, never between a favorite's check and its write (round 10 #4)
          await this.withFolderList(accountId, async () => {
            const r = await this.accountWrite(life, () => this.store.folders.replace(accountId, folders, carried.map((m) => m.to), [...partial, ...again]));
            if (r.changed || moves.length || partial.length || again.length) {
              this.server.emit("folders", await this.store.folders.list());
              this.notifyChanged(r.touched);
              void this.rebuildFolders();
            }
            // a DELETE whose answer was lost, shown done by this list, takes its favorites as a change's does (Codex code
            // review round 12 #3: they stayed, and a folder made again under the name came back a favorite); and so
            // does a folder gone in another app, this list being the account's whole one (Codex code review round 24 #3)
            await this.accountWrite(life, () => this.writeFavorites(() => followFavoriteFolders(this.store, accountId, { renamed: moves, deleted, listed: new Set(folders.map((f) => f.key)) })));
            await this.accountWrite(life, () => followFolderFilters(this.store, accountId, { renamed: moves, deleted }, this.now(), (m, d) => this.log("warn", m, d)));
          });
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
          // plan 176: the last moment to drop a quick pass whose focus or network went while it set up (nothing written)
          if (o.quick && !this.quickAdmitted(accountId)) return void (await statusRun.end({}));
          if (!o.quick) await setState({ status: "syncing", ...(wasDown && { connection: { state: "reconnecting", retryAt: null } }) });
          checkCurrent();
          observation = await this.accountWrite(life, () => this.store.sync.beginObservation(accountId, { authoritativeFlags: provider.flagSnapshots === true, signal: life.abort.signal }));
          checkCurrent();
          await provider.sync(sink);
          checkCurrent();
          // plan 68: the account's own folders (Gmail's labels), only when they may have changed; a failure waits for the next pass
          try {
            // plan 176: a quick check leaves the folders (labels met and unknown) to the ordinary pass
            if (!o.quick) await provider.folders?.(sink);
          } catch (error) {
            // the provider's own failure (offline, a malformed answer) waits; a sign-in to redo or a store failure doesn't
            if (!(error instanceof ProviderError) || error instanceof ProviderAuthError || error instanceof ProviderCooldownError || (accountKind === "gmail" && (error.httpResponse?.status === 429 || (error.httpResponse?.status === 403 && (error.retryable || this.google.get(accountId)?.paused))))) throw error;
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
          // plan 102 (Codex review): a first sync paused between chunks stays one here too (no "synced at" yet)
          await setState({ status: "offline", ...(!(more && before?.syncState.lastSyncAt === null) && { lastSyncAt: this.now() }), connection: { state: "offline", retryAt: this.connectivity.probeLater(accountId) } });
          return;
        }
        const finished = await this.accountRead(life, () => this.store.accounts.get(accountId));
        if (!finished) return;
        if (credentials !== this.credentialsOf(accountId)) return;
        // plan 102: a first sync that paused between chunks is still one (the pill stays; no "synced at" yet)
        const firstChunk = more && before?.syncState.lastSyncAt === null;
        // plan 103: a chunk leaves its latest progress; a sync that's done leaves none
        const kept = more || (backfill && !backfillFinished) ? (progress ?? before?.syncState.progress ?? null) : null;
        // plan 176: a quick check only ever runs on a synced, healthy account, which it leaves as it found it
        if (o.quick) await statusRun.end({ status: "idle", lastError: null, lastErrorI18n: null, connection: null });
        else await statusRun.end({ ...(firstChunk ? { status: "syncing" as const } : { status: "idle" as const, lastSyncAt: this.now() }), lastError: null, lastErrorI18n: null, connection: null, progress: kept });
        // the card hears the end too (a sync done: nothing left to show)
        // (only an account that showed some: a regular poll sends nothing)
        if (progress !== null || before?.syncState.progress) this.server.emit("syncProgress", { accountId, progress: kept });
        if (!this.current(life)) return;

        // a probe the host thought pointless worked: it was wrong about offline (reachability can be, with some VPNs)
        if (startedOffline && !this.connectivity.online) this.networkChanged(true, "other");
        // the account works: whatever waited for its sign-in, or for the network, goes now
        if (!status.holds("send")) await this.accountWrite(life, () => this.resumeAuth(accountId));
        if ((await this.accountWrite(life, () => this.store.ops.resumeNetwork(accountId, this.now()))).length) this.kickWorker();
        // its mail is here: drafts an import kept for it (answering messages that just synced) go in
        await this.accountWrite(life, () => restorePending(this, accountId)).catch((error: unknown) => {
          captureError(error, { code: "import.restore_failed" });
          this.log("warn", "restoring imported items failed", error instanceof Error ? error.message : error);
        });
        // plan 101/102: more to do (older mail, a first sync's next chunk): another pass in a second, which reads
        // new mail first (it stays a chunk away at most)
        if (more && this.current(life)) this.continueBackfill(accountId);
      } catch (caught) {
        if (!this.current(life) || (before?.kind === "gmail" && credentials !== this.credentialsOf(accountId))) return;
        const error = caught instanceof FlagObservationError ? new FlagConnectionError() : caught;
        const message = error instanceof Error ? error.message : String(error);
        const lastErrorI18n = textRef((error as { i18n?: unknown } | null)?.i18n) ?? null;
        const retryable = error instanceof ProviderError && error.retryable;
        // plan 102 (Codex review): what a pass brought in before failing is in; what the next one finds is new (a
        // first chunk that failed mustn't leave the retry's new mail unannounced)
        if (retryable) this.attention.prime(accountId);
        if (error instanceof ProviderCooldownError && error.cooldown.kind === "capacity") this.capacitySync.add(accountId);
        // offline or a sign-in to redo is the provider's verdict (expected); anything else is ours
        captureError(error, { code: "sync.failed", fields: { accountKind, retryable } });
        const wake = error instanceof ProviderCooldownError ? this.cooldown?.nextWakeDelay() : null;
        this.log("warn", `sync failed for account ${accountId}`, `${message}${syncFailureDetail(error)}${wake != null ? ` (tries again in ${Math.ceil(wake / 1000)} s)` : error instanceof ProviderCooldownError ? " (no retry scheduled)" : ""}`);
        if (!this.store.isOpen) return;
        if (error instanceof ProviderCooldownError || (accountKind === "gmail" && error instanceof ProviderError && (error.httpResponse?.status === 429 || (error.httpResponse?.status === 403 && (error.retryable || this.google.get(accountId)?.paused))))) {
          this.connectivity.succeeded(accountId);
          await status.constrain(authority, { message, i18n: lastErrorI18n }, () => !this.googleReady(accountId));
          await statusRun.end({ status: "error", lastError: message, lastErrorI18n, connection: null });
          return;
        }
        if (error instanceof FlagConnectionError) {
          await statusRun.end({ status: "error", lastError: message, lastErrorI18n });
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
          if (auth) await status.refuse(authority, error as ProviderAuthError, null, before?.kind === "imap" ? "incoming" : "account");
          if (!this.connectivity.online && !auth) this.connectivity.probeLater(accountId);
          // anything else proves nothing about the sign-in: a request for one stays
          await statusRun.end({ status: "error", lastError: message, lastErrorI18n, connection: null, ...(auth && { authRequired: true, authScope: null }) });
          return;
        }
        const retry = this.connectivity.failed(accountId, epoch);
        // a pass our own reconnect cut short doesn't count: the pass that follows the change decides
        if (!retry) return;
        breadcrumb("sync", "sync.retry", { accountKind, attempt: retry.failures, delayMs: retry.at - this.now() });
        // a blip is retried quietly (2 s later); the second failure in a row, or the host offline, is honest about it
        const down = wasDown || retry.failures >= 2 || !this.connectivity.online;
        await statusRun.end({ status: down ? "offline" : "syncing", lastError: message, lastErrorI18n, connection: down ? { state: "offline", retryAt: retry.at } : null });
      }
    };
    // plan 107: a pass never overlaps a folder change of its account
    const gated = () => this.afterFolderChange(accountId, work);
    const run = (running ? running.then(gated) : gated()).catch((error: unknown) => {
      if (error !== life.abort.signal.reason) throw error;
    }).finally(() => {
      if (this.syncing.get(accountId) !== run) return;
      this.syncing.delete(accountId);
      const explicit = this.syncAgain.delete(accountId);
      const flags = this.flagSyncAgain.delete(accountId);
      const capacity = this.options.autoSync !== false && this.capacitySync.has(accountId) && this.connectivity.canSync(accountId);
      if (this.current(life) && !this.statuses.get(accountId)?.signInRequired && this.googleReady(accountId) && (explicit || ((flags || capacity) && this.connectivity.canSync(accountId)))) {
        this.capacitySync.delete(accountId);
        void this.syncAccount(accountId);
      }
    });
    this.syncing.set(accountId, run);
    return run;
  }

  // ───────────────────────────── folder changes (plan 107) ─────────────────────────────

  /** `work` is talking to the account's provider until it settles: a folder change waits for it. */
  private providerWorking<T>(accountId: number, work: Promise<T>): Promise<T> {
    let running = this.providerWork.get(accountId);
    if (!running) this.providerWork.set(accountId, (running = new Set()));
    running.add(work);
    const done = () => {
      running.delete(work);
      if (!running.size && this.providerWork.get(accountId) === running) this.providerWork.delete(accountId);
    };
    void work.then(done, done);
    return work;
  }

  /**
   * Runs `run` once no folder change holds the account, counted as provider work from its first step: the check and
   * the start are one synchronous step, so a change that begins after it waits for it, and one before it is waited for.
   */
  private async afterFolderChange<T>(accountId: number, run: () => Promise<T>): Promise<T> {
    for (let gate = this.folderChanges.get(accountId); gate; gate = this.folderChanges.get(accountId)) await gate;
    return this.providerWorking(accountId, run());
  }

  private admissionChanged(): void {
    this.cooldownVersion++;
    this.admissionSnapshot = undefined;
  }

  /**
   * Plan 107 (Codex code review round 10 #4): `run` alone among the account's folder-list writes: a change's or a sync
   * pass's stored list and the favorites that follow it, and a favorite's check of the list and its write. A favorite
   * read against the list before a rename or delete wrote its key back after the change had moved it.
   */
  async withFolderList<T>(accountId: number, run: () => Promise<T>): Promise<T> {
    const previous = this.folderLists.get(accountId);
    const mine = (async () => { await previous?.catch(() => {}); return run(); })();
    const settled = mine.catch(() => {});
    this.folderLists.set(accountId, settled);
    try {
      return await mine;
    } finally {
      if (this.folderLists.get(accountId) === settled) this.folderLists.delete(accountId);
    }
  }

  /**
   * Plan 107 (Codex code review round 11 #2): the favorites written one at a time, each write announced
   * (`favoriteFolders`) before the next: every window keeps the backend's list, a partial delete's or another
   * window's change included, and never an older one after a newer. `write` answers null when it changed nothing.
   * Each write is numbered, the number in its announcement and its answer (Codex code review round 12 #2): a window
   * applies only a list newer than the last it applied, so a call's answer arriving after a newer announcement is
   * dropped.
   */
  async writeFavorites(write: () => Promise<FavoriteFolder[] | null>): Promise<FavoriteFoldersSnapshot | null> {
    const mine = (async () => {
      await this.favoriteWrites;
      const next = await write();
      if (!next) return null;
      // never lower, after a restart too (a window outlives its backend): the clock's, or one past the last
      this.favoritesRevision = Math.max(this.favoritesRevision + 1, Date.now());
      const snapshot = { favorites: next, revision: this.favoritesRevision };
      this.server.emit("favoriteFolders", snapshot);
      return snapshot;
    })();
    this.favoriteWrites = mine.catch(() => {});
    return mine;
  }

  /**
   * Plan 107 (Codex R2): a change to an account's own folders, alone with its provider. It waits for the account's
   * running sync pass and op (and an earlier change); while it runs, a sync waits, the ops worker passes the account
   * by, and body reads and copy repairs wait. When it's done the worker is kicked.
   */
  changeFolders<T>(accountId: number, change: (provider: MailProvider, account: { write<W>(work: () => Promise<W>): Promise<W>; check(): void }) => Promise<T>): Promise<T> {
    return this.runForAccount(accountId, change);
  }

  /**
   * Plan 141: older mail asked for by a person: what the server finds and what it fetches, stored as a first sync's is
   * (no arrivals, no notices). In the account's own slot, so it holds sync and ops as a folder change does.
   */
  fetchHitsForAccount(accountId: number, hits: readonly import("@terno/mail").ProviderHit[], signal: AbortSignal, onInserted: (ids: number[]) => void): Promise<void> {
    return this.runForAccount(accountId, async (provider) => {
      const life = this.lifetime(accountId);
      const check = () => {
        this.assertCurrent(life);
        signal.throwIfAborted();
      };
      const pass = this.evictions.pass();
      const sink: SyncSink = {
        signal: AbortSignal.any([life.abort.signal, signal]),
        // nothing here is "too old": it was asked for
        windowStart: 0,
        ingest: async (messages) => {
          check();
          const { inserted } = await this.ingestSliced(messages, true, life, undefined, undefined, check, { accountId, pass }, false);
          onInserted(inserted);
        },
        setBody: async (messageId, text, html, attachments, capture) => {
          const checkBody = () => { check(); capture?.signal?.throwIfAborted(); };
          checkBody();
          const classifier = await this.classifier();
          checkBody();
          const r = await this.accountWrite(life, () => this.store.sync.setBody(messageId, text, html, { now: this.now(), classifier, attachments, bodyParts: capture?.bodyParts, preparedBodyTokens: capture?.preparedBodyTokens, captureUnavailable: capture?.captureUnavailable, repair: capture?.repair, check: checkBody }));
          this.categorizer.apply(r.deltas);
          this.announceAuto(r.auto);
          this.opsQueued(r.opIds);
          this.reconcileFlags(r.flagReconcileAccounts);
          this.notifyChanged(r.touched, false);
          this.bodyArrived(messageId);
        },
        updateFlags: async (updates, o) => {
          const touched = new Set<number>();
          await this.runSliced(updates, 200, async (chunk) => {
            check();
            const result = await this.accountWrite(life, () => this.store.sync.updateFlags(accountId, chunk, o?.authoritative === false ? undefined : undefined, check));
            for (const t of result.touched) touched.add(t);
            this.reconcileFlags(result.flagReconcileAccounts);
          });
          this.notifyChanged(touched);
        },
        // only the regular pass, which sees the whole folder, may say a message has gone
        removeMessages: async () => {},
        pendingMessageIds: () => this.accountRead(life, () => this.store.sync.pendingMessageIds(accountId)),
        setSyncState: async () => {},
      };
      await provider.fetchHits?.(hits, sink);
      this.evictions.passDone(accountId, pass);
    });
  }

  async runForAccount<T>(accountId: number, change: (provider: MailProvider, account: { write<W>(work: () => Promise<W>): Promise<W>; check(): void }) => Promise<T>): Promise<T> {
    await this.ready;
    const previous = this.folderChanges.get(accountId);
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    this.folderChanges.set(accountId, gate);
    this.admissionChanged();
    try {
      await previous;
      await Promise.allSettled(this.providerWork.get(accountId) ?? []);
      const life = this.lifetime(accountId);
      this.assertCurrent(life);
      const provider = await this.provider(accountId);
      this.assertCurrent(life);
      if (!provider) throw new RpcError("NOT_FOUND", L("errors.accountGone"));
      // a request the account's removal or reconnect interrupted fails as the lifetime's end, never as the server's
      // error: teardown waits for this and rethrows any other (Codex code review round 21 #2)
      return await this.accountWrite(life, () => change(provider, { write: (work) => this.accountWrite(life, work), check: () => this.assertCurrent(life) }).catch((error: unknown) => {
        this.assertCurrent(life);
        throw error;
      }));
    } finally {
      if (this.folderChanges.get(accountId) === gate) {
        this.folderChanges.delete(accountId);
        this.admissionChanged();
      }
      open();
      this.kickWorker();
    }
  }

  // ───────────────────────────── ops worker ─────────────────────────────

  /** The account's authorization works again (sync succeeded, reconnected): its ops waiting for it run now. */
  async resumeAuth(accountId: number): Promise<void> {
    if ((await this.accountStatus(accountId)).signInRequired) return;
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
    await this.accountStatus(accountId);
    // Pending rotation recovery belongs to the next explicit demand, never a refresh of the spent old grant.
    if (!(await this.accountStatus(account.id)).signInRequired && !this.gmailRenewals.has(accountId)) this.startAccount(account);
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
            if (await confirm() && active()) { this.credentials.set(accountId, this.credentialsOf(accountId) + 1); this.cooldownChanged(); }
          } catch { /* An unreadable result proves neither commit nor rollback. */ }
        }
        throw new RpcError("BAD_REQUEST", L("errors.secret.replaceFailed"));
      }
      if (committed && active()) {
        this.credentials.set(accountId, this.credentialsOf(accountId) + 1);
        this.cooldownChanged();
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
    const status = await this.accountStatus(accountId);
    this.credentials.set(accountId, this.credentialsOf(accountId) + 1);
    this.capacitySync.delete(accountId);
    this.cooldownChanged();
    await this.accountWrite(life, async () => {
      if (flow) this.assertSignIn(accountId, flow);
      installCredentials?.();
      await status.verified(this.statusAuthority(life));
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
                      // plan 107: a folder change waits for it (one claimed meanwhile goes back to the queue: hold())
                      await this.providerWorking(op.account_id, this.executeOp(op, recovery, reconciliations));
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
      for (const idle of this.workerIdle.splice(0)) idle();
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
    const hold = () => this.draining || this.stopped || !this.connectivity.online || this.folderChanges.has(op.account_id);
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
    if (account && (await this.accountStatus(op.account_id)).holds(op.kind)) {
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
    let accepted = false, transportStarted = false, remoteDispatched = false, submissionDispatched = false;
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
      if (this.statuses.get(op.account_id)?.holds(op.kind)) throw new StatusHeld();
      const execution = await provider.execute({ id: op.id, kind: op.kind, target, payload,
        requestRun: { markDispatched: () => { remoteDispatched = true; }, markSubmissionDispatched: () => { submissionDispatched = true; } },
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
          if (this.statuses.get(op.account_id)?.holds(op.kind)) throw new StatusHeld();
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
      const done = await this.store.ops.complete(op.id, { ...result, ...(sendAccepted && { sendAccepted }), ...(warning !== undefined && { warning: encodeText(warning) }) }, this.now(), { followup: this.followups.isActive, since: this.followups.since });
      if (sending) this.followups.wake();
      if (sending && receipt) {
        try {
          const stored = await this.store.sendCopies.get(op.id);
          if (stored && !stored.copyRequested && !(await this.store.recipientReceipts.get(op.id))?.hasRejected) { while (!this.stopped && await this.store.sendCopies.forgetSlice(op.id)) await this.platform.yield(); }
          else if (stored?.copy === "saved") while (!this.stopped && await this.store.sendCopies.pruneSavedSlice(op.id)) await this.platform.yield();
        } catch { /* Saved wire remains charged for deliberate cleanup; submission is complete. */ }
      }
      for (const id of done.flagReconcileAccounts ?? []) reconciliations.add(id);
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
        else if (error instanceof ProviderCooldownError && (!remoteDispatched || (sending && !submissionDispatched)) && this.current(life)) {
          await this.store.ops.release(op.id, this.now());
          this.cooldownChanged();
        }
        else if (error instanceof StatusHeld) {
          await this.store.ops.awaitAuth(op.id, message, this.now());
          if (!this.statuses.get(op.account_id)?.holds(op.kind)) await this.resumeAuth(op.account_id);
        }
        else if (error instanceof RequestNotDispatchedError && !this.current(life)) await this.parkClosedOp(op);
        else if (error instanceof ProviderAuthError && credentials !== this.credentialsOf(op.account_id)) {
          await this.store.ops.release(op.id, this.now());
          this.kickWorker();
        } else if (error instanceof ProviderAuthError) {
          await this.store.ops.awaitAuth(op.id, message, this.now());
          if (this.current(life) && !(await this.parkedAcrossSignIn(op.account_id, credentials))) await this.needsSignIn(op.account_id, op.kind, error, credentials, life);
        } else if (error instanceof ProviderError && error.ambiguous) {
          await this.store.ops.markUnknown(op.id, message, this.now());
          if (isFolderOp(op.kind)) this.notifyChanged([]);
        }
        // the server couldn't be reached: wait for the network (plan 20); an outage gives the attempt back
        else if (error instanceof ProviderIdentityError) state = await this.store.ops.fail(op.id, message, true, this.now(), { identity: true, keepAttempt: true });
        else if (error instanceof ProviderError && error.network) state = await this.store.ops.fail(op.id, message, true, this.now(), { network: true, keepAttempt: this.connectivity.inOutage(op.account_id) });
        else {
          const retryAt = pe?.retryable && pe.httpResponse?.status === 403 ? this.google.get(op.account_id)?.retryAt() : undefined;
          state = await this.store.ops.fail(op.id, message, pe ? pe.retryable : true, this.now(), retryPark(pe, retryAt, this.connectivity.inOutage(op.account_id)));
        }
        // A permanently failed send answered nobody: recomputed lists and counts follow. So do a folder move's (plan 127).
        if (state === "failed" && (sending || isFolderOp(op.kind))) this.notifyChanged([]);
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
    const status = await this.accountStatus(accountId);
    await status.refuse({ generation: credentials, live: () => this.current(life) }, error, scope, account.kind === "imap" && scope === null ? "incoming" : "account");
  }

  /**
   * Plan 25 (Codex code review #1): an op parked for a sign-in while one landed (its resume ran before this
   * park): it goes again now instead of waiting for a sign-in already done. True when that happened.
   */
  private async parkedAcrossSignIn(accountId: number, credentials: number): Promise<boolean> {
    if (credentials === this.credentialsOf(accountId) || (await this.accountStatus(accountId)).signInRequired) return false;
    await this.resumeAuth(accountId);
    return true;
  }

  private announceOp(op: OpRow, reconciliations: Set<number>): void {
    if (operationFlagFields(op.kind).length && ["succeeded", "failed", "unknown"].includes(op.state)) reconciliations.add(op.account_id);
    this.server.emit("op", this.opInfo(op));
    // plan 116: a forward's send settled
    if (op.kind === "send") this.forwards.opSettled(op.id);
  }

  /** Plan 116: a body arrived (a sync's, or one the reader asked for): its filters and category may make it go; a forward waiting for its files goes now. */
  private bodyArrived(messageId: number): void {
    // plan 132: a summary may have waited for it (both ways a body arrives come here); plan 134: so may the AI's look
    this.summaries.wake();
    this.followups.wake();
    this.aiAssist.wake();
    if (!this.forwards.isActive) return;
    this.planForwards({ messageIds: [messageId] });
    void this.forwards.filesArrived({ messageIds: [messageId] }).catch(() => {});
  }

  /** Plan 116: new mail or a filing may make forwards; a failure is logged (the start's sweep looks again). */
  planForwards(p: { messageIds?: readonly number[]; threadIds?: readonly number[]; filed?: readonly number[] }): void {
    void this.forwards.plan(p).catch((error: unknown) => {
      captureError(error, { code: "forward.failed" });
      this.log("warn", "forwards couldn't be planned", error instanceof Error ? error.message : error);
    });
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
          await this.afterFolderChange(row.accountId, () => provider.repairSentCopy!({ raw, messageId, mailbox: row.mailbox }, {
            prepare: async () => raw,
            accepted: async () => { throw new Error("Copy repair cannot submit SMTP"); },
            record: (copy, identity) => { this.assertCurrent(life); return this.store.sendCopies.record(id, copy, identity); },
          }));
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

  /** What categorizes, ready to run tasks; throws AiError (not configured, blocked). */
  ai(): Promise<AiTasks> {
    return this.aiService.forTask("categorize");
  }

}

/**
 * What the console adds to a failed sync (never mail content): the HTTP status, Google's reason token and
 * the request's shape with ids replaced; a pause says why and for which service.
 */
export function syncFailureDetail(error: unknown): string {
  if (error instanceof ProviderCooldownError) return ` [paused: ${error.cooldown.service}, ${error.cooldown.kind}]`;
  if (!(error instanceof ProviderError)) return "";
  const e = error as ProviderError & { status?: unknown; googleReason?: unknown; resource?: unknown };
  const status = typeof e.status === "number" ? e.status : e.httpResponse?.status;
  const parts = [status !== undefined && `HTTP ${status}`, typeof e.googleReason === "string" && e.googleReason,
    typeof e.resource === "string" && requestShape(e.resource)].filter(Boolean);
  return parts.length ? ` [${parts.join(", ")}]` : "";
}

// the route words Google's mail, people and identity requests use; any other segment is an id
const ROUTE_WORDS = new Set(["messages", "threads", "attachments", "drafts", "labels", "history", "profile", "send", "import", "insert", "modify", "trash", "untrash", "batchModify", "batchDelete", "watch", "stop", "people", "me", "connections", "otherContacts", "userinfo", "v1", "v2", "v3", "oauth2", "gmail", "users", "token", "settings", "sendAs", "filters"]);

/** A request's path with its origin, query and every id-like segment removed (only route words stay). */
export function requestShape(resource: string): string {
  const path = resource.replace(/^https?:\/\/[^/]+/, "").replace(/[?#].*$/, "");
  return path.split("/").map((part) => (part === "" || ROUTE_WORDS.has(part) ? part : ":id")).join("/");
}

/**
 * How a retryable op failure waits: a Google pause until its time; a server that said "later" (SMTP 4xx,
 * IMAP throttling) a day of retries; and during an outage (offline, the account's sync failing, a network
 * that just changed) whatever went wrong, a VPN or proxy breaking TLS, a 5xx, waits for the network with its
 * attempt given back, as a network error does. A day without a connection never uses up a send.
 */
export function retryPark(pe: ProviderError | null | undefined, retryAt: number | undefined, outage: boolean): OpPark | undefined {
  if (retryAt !== undefined) return { retryAt };
  if (pe?.deferred) return { deferred: true };
  if (pe?.retryable && outage) return { network: true, keepAttempt: true };
  return undefined;
}
