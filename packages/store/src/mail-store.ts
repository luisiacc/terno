import type { AutocompleteSource } from "./autocomplete-source";
import type {
  AccountPatch,
  Account,
  AccountKind,
  AccountSyncState,
  Address,
  AutoCategorize,
  CategorizeScope,
  CategorizerModel,
  Category,
  CategoryColor,
  CategoryModelStats,
  Counts,
  ThreadFilter,
  Filter,
  FilterRule,
  OpState,
  Prediction,
  QuickActions,
  Reason,
  ThreadAction,
  ThreadDetail,
  ThreadSummary,
  TrainExample,
  UserActionKind,
  Vetoes,
} from "@terno/core";
import type { OwnerIdentity } from "@terno/core/rpc";
import type { MailStoreSearch, SearchCursor, SearchFeed, SearchMessageDoc, SearchThreadDoc, StoreSearchPage } from "./search";
import type {
  AddedBy,
  ClassifyResult,
  Cursor,
  DraftInput,
  DraftRow,
  ExampleKey,
  FlagUpdate,
  IncomingMessage,
  ListParams,
  ModelDelta,
  MovePhase,
  OpPark,
  OpRow,
  OwnerClaim,
  Page,
  MessageState,
  PendingSuggestion,
  ScopeParams,
  ThreadFeatureSet,
} from "./types";

export interface SnapshotMessage {
  id: number;
  threadId: number;
  accountId: number;
  providerMsgId: string | null;
  rfcMessageId: string | null;
  date: number;
  fromName: string;
  fromEmail: string;
  recipients: string;
  subject: string;
  bodyText: string | null;
  bodyState: "none" | "partial" | "full";
  listId: string | null;
  hasAttachments: boolean;
  isRead: boolean;
  isStarred: boolean;
  inInbox: boolean;
  isSent: boolean;
  isDraft: boolean;
  isTrash: boolean;
  isSpam: boolean;
  /** what plan 17's facts read: To and Cc as stored (JSON), the bulk headers, Gmail's labels (JSON), the references */
  toJson: string;
  ccJson: string;
  isBulk: boolean;
  gmailLabels: string | null;
  inReplyTo: string | null;
  references: string[];
}

export interface SnapshotThread {
  id: number;
  accountId: number;
  providerThreadId: string | null;
  subject: string;
  snippet: string;
  lastDate: number;
  lastFromName: string;
  lastFromEmail: string;
  messageCount: number;
  unreadCount: number;
  hasAttachments: boolean;
  isStarred: boolean;
  inInbox: boolean;
  hasSent: boolean;
  inTrash: boolean;
  inSpam: boolean;
  categoryIds: number[];
  /** plan 17: null until computed */
  person: boolean | null;
  waitingSince: number | null;
}

export interface StoreSnapshot {
  accounts: { id: number; email: string; display_name: string }[];
  categories: { id: number; name: string }[];
  messages: SnapshotMessage[];
  threads: SnapshotThread[];
  memberships: { threadId: number; categoryId: number; addedBy: AddedBy; batchId: number | null }[];
  examples: { threadId: number; categoryId: number; label: 1 | -1; source: string; weight: number; content: boolean; sender: string; batchId: number | null }[];
  ops: { id: string; accountId: number; kind: string; state: OpState; attempts: number; messageIds: number[] }[];
  /** what a search engine indexes */
  search: { messages: SearchMessageDoc[]; threads: SearchThreadDoc[] };
}

export interface StoreCapabilities {
  /** "sqlite-node" | "sqlite-wasm-opfs" | "indexeddb" | … */
  engine: string;
  /** id of the SearchEngine answering searches */
  search: string;
  /** filter preview/apply over all mail */
  bulkRuleScan: "indexed" | "scan";
  /** ImapLocationStore available */
  imapLocations: boolean;
  /** other connections may read the file (MCP, checkpoint worker) */
  externalReaders: boolean;
  durability: "fsync" | "browser";
}

/** The classifier's part of an ingestion command: pure scoring over the in-memory model, read-only. */
export interface ClassifierInput {
  model: CategorizerModel;
  mode: AutoCategorize;
}

export interface IngestOutcome {
  inserted: number[];
  /** threads to announce as changed */
  touched: number[];
  deltas: ModelDelta[];
  auto: ClassifyResult["auto"];
  backfill: number;
  uncertain: number[];
  /** provider ops the command queued (filter actions) */
  opIds: string[];
}

export interface CategorizeOutcome {
  added: number[];
  deltas: ModelDelta[];
}

export interface SendCommand {
  accountId: number;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  bodyText: string;
  /** plan 16: the text/html alternative (the renderer's own, built from a document) */
  bodyHtml?: string;
  inReplyToMessageId?: number;
  draftId?: number;
  /** explicit user replies feed learned filters; agents' don't */
  recordReply: boolean;
  now: number;
}

/** Replaces ProviderContext.db: what providers read and write besides syncing through the backend. */
export interface ProviderStore {
  messageByProviderId(providerMsgId: string): Promise<{ id: number; subject: string; fromEmail: string } | null>;
  /** synced (non-local) messages of the account */
  syncedMessages(): Promise<{ id: number; providerMsgId: string; date: number }[]>;
  /** messages whose body hasn't been downloaded, newest first, with one IMAP location each */
  pendingBodies(limit: number): Promise<{ id: number; mailbox: string; uid: number; uidvalidity: number }[]>;
  countPendingBodies(): Promise<number>;
  /** provider ids of the given messages (missing ids are absent) */
  providerIds(messageIds: readonly number[]): Promise<Map<number, string | null>>;
  setting<T>(key: string): Promise<T | null>;
  locations: ImapLocationStore;
}

export interface ImapLocation {
  message_id: number;
  mailbox: string;
  uid: number;
  uidvalidity: number;
  flags: string;
}

export interface ImapLocationStore {
  upsert(messageId: number, mailbox: string, uidvalidity: number, uid: number, flags: string[]): Promise<void>;
  remove(messageId: number, mailbox: string): Promise<void>;
  setFlags(messageId: number, mailbox: string, flags: string): Promise<void>;
  of(messageIds: readonly number[]): Promise<ImapLocation[]>;
  at(mailbox: string, uidvalidity: number, uid: number): Promise<number | null>;
  get(messageId: number, mailbox: string): Promise<{ uid: number; uidvalidity: number; flags: string } | null>;
  count(messageId: number): Promise<number>;
  inMailbox(mailbox: string, uidvalidity: number): Promise<{ message_id: number; uid: number; flags: string }[]>;
  /** UIDVALIDITY changed: forgets every location in the mailbox, returns the messages that had one */
  resetMailbox(mailbox: string): Promise<number[]>;
  /** after a reset: an ID-less message among `candidates` with this exact envelope, not yet re-located in `mailbox` */
  resetCandidate(c: { candidates: readonly number[]; subject: string; fromEmail: string; date: number; size: number; mailbox: string }): Promise<{ id: number } | null>;
}

/**
 * The storage boundary the backend uses. Every method is ONE atomic unit of
 * work; there is no generic cross-call transaction. Returned model deltas and
 * touched ids describe what already committed.
 */
export interface MailStore {
  readonly capabilities: StoreCapabilities;
  readonly isOpen: boolean;
  close(): Promise<void>;
  /**
   * Bulk writers await this between slices: the store may hold them back
   * (asynchronously) until its own upkeep caught up with what they wrote
   * (SQLite: the WAL checkpoint, so the log starts over instead of growing
   * by gigabytes). Absent or immediate when there is nothing to wait for.
   */
  settle?(): Promise<void>;

  /** every committed change to what search indexes, as revisioned batches (the transactional outbox) */
  readonly feed: SearchFeed;
  /** headers and sent text for autocomplete's in-memory models (plan 18), from the same log */
  readonly autocomplete: AutocompleteSource;

  threads: MailStoreSearch & {
    list(p: ListParams): Promise<Page>;
    summaries(ids: readonly number[]): Promise<ThreadSummary[]>;
    /** a view's thread ids above `after`, ascending, up to `limit`, straight from the indexes (keyset pages, no display rows) */
    scopeIds(p: ScopeParams & { after?: number; limit: number }): Promise<number[]>;
    /** how many threads a view holds, counted up to `limit` */
    scopeCount(p: ScopeParams & { limit: number }): Promise<number>;
    get(id: number): Promise<(ThreadDetail & { categorization: { auto: { categoryId: number; reasons: Reason[] }[]; suggestions: PendingSuggestion[] } }) | null>;
    /** `now`: the clock the waiting count reads its window from (plan 17) */
    counts(now: number): Promise<Counts>;
    /** resolves account:/category: and searches within one unit of work */
    /** an RPC cursor without revision/key (older renderers) continues this query */
    /** `signal`: the caller no longer wants the answer (a newer search); a slow path may stop and reject with SearchCancelledError */
    /** `threadFilter` (`threadAttachments`: its plan 15 name for attachments): the list's thread filters, applied by the engine before paging; waiting reads `now` */
    searchText(p: { query: string; accountId?: number; categoryId?: number; threadAttachments?: boolean; threadFilter?: ThreadFilter; cursor?: Cursor & Partial<Pick<SearchCursor, "revision" | "queryKey">>; limit: number; now: number; signal?: { readonly aborted: boolean } }): Promise<StoreSearchPage>;
    /** local optimistic change + learning signal + provider ops, atomically; `before`: each changed message as it was */
    act(c: { threadIds: readonly number[]; action: ThreadAction; signal: UserActionKind | null; now: number }): Promise<{ threadIds: number[]; opIds: string[]; before: MessageState[] }>;
    /**
     * An undo: every message back to the given state (those still there),
     * with the provider ops that take it there, in order per message; never a
     * learning signal.
     */
    restore(c: { messages: readonly MessageState[]; now: number }): Promise<{ threadIds: number[]; opIds: string[] }>;
  };

  sync: {
    /** threading, aggregates, filters (claims, actions, ops) and classification of one slice */
    ingest(batch: readonly IncomingMessage[], o: { applyFilters: boolean; now: number; classifier: ClassifierInput | null }): Promise<IngestOutcome>;
    setBody(messageId: number, text: string | null, html: string | null, o: { now: number; classifier: ClassifierInput | null }): Promise<{ touched: number[]; deltas: ModelDelta[]; auto: ClassifyResult["auto"]; opIds: string[] }>;
    /** provider state for existing messages; skips messages with unsettled ops, read inside the same unit */
    updateFlags(accountId: number, updates: readonly FlagUpdate[]): Promise<{ touched: number[] }>;
    remove(messageIds: readonly number[]): Promise<{ touched: number[] }>;
    pendingMessageIds(accountId: number): Promise<Set<number>>;
  };

  ops: {
    claimReady(now: number, limit: number): Promise<OpRow[]>;
    get(id: string): Promise<OpRow | null>;
    /** success, including adopting the provider's ids for a sent message */
    complete(id: string, result: { providerMsgId?: string; providerThreadId?: string; warning?: string } | void, now: number): Promise<{ touched: number[]; deltas: ModelDelta[] }>;
    /** with `park` (plan 20): the server couldn't be reached, so it waits for resumeNetwork (an outage gives the attempt back) */
    fail(id: string, error: string, retryable: boolean, now: number, park?: OpPark): Promise<OpState>;
    markUnknown(id: string, error: string, now: number): Promise<void>;
    /** the provider needs the user to sign in again: back to the queue without spending the attempt, until resumeAuth */
    awaitAuth(id: string, error: string, now: number): Promise<void>;
    /** claimed but never started (the app is quitting): back to the queue as it was, ready now, the attempt given back */
    release(id: string, now: number): Promise<void>;
    /** the account's authorization works again: its waiting ops are ready now (their ids) */
    resumeAuth(accountId: number, now: number): Promise<string[]>;
    /** the network is back (one account's, or every account's with null): ops parked for it are ready now (their ids) */
    resumeNetwork(accountId: number | null, now: number): Promise<string[]>;
    recover(now: number): Promise<{ requeued: number; unknown: number }>;
    /** when the next op can actually be claimed (one blocked behind an older op on its messages isn't due) */
    nextAttemptAt(): Promise<number | null>;
    recent(limit: number): Promise<OpRow[]>;
    resolveUnknown(id: string, resolution: "markSent" | "retry" | "discard", now: number): Promise<{ touched: number[] }>;
  };

  compose: {
    /** optimistic local copy + durable send op (+ draft removal, reply signal), atomically */
    queueSend(c: SendCommand): Promise<{ opId: string; threadId: number; deltas: ModelDelta[] }>;
  };

  filters: {
    list(): Promise<Filter[]>;
    get(id: number): Promise<Filter | null>;
    save(f: { id?: number; name: string; enabled: boolean; source: Filter["source"]; rule: FilterRule; learnedKey?: string }, now: number): Promise<Filter>;
    delete(id: number): Promise<void>;
    preview(rule: FilterRule, now: number, limit: number): Promise<{ count: number; sample: ThreadSummary[] }>;
    /** message id bounds, for windowed matching */
    messageIdRange(): Promise<{ lo: number; hi: number } | null>;
    /** messages matching the rule in one id window */
    matchWindow(rule: FilterRule, now: number, window: { from: number; to: number }): Promise<number[]>;
    /** claims + actions + ops for one chunk; refuses (CANCELLED) if the filter changed since `ruleJson` */
    applyChunk(id: number, ruleJson: string, messageIds: readonly number[], now: number): Promise<{ applied: number; touched: number[]; opIds: string[] }>;
  };

  categories: {
    list(): Promise<Category[]>;
    exists(id: number): Promise<boolean>;
    create(name: string, color: CategoryColor): Promise<Category>;
    update(id: number, patch: { name?: string; color?: CategoryColor; position?: number; autoApply?: boolean }): Promise<Category | null>;
    /** positions in this order, in one unit (ids it leaves out keep their order after those); the new list */
    reorder(ids: readonly number[]): Promise<Category[]>;
    delete(id: number): Promise<void>;
    createBatch(categoryId: number, source: string, scope: unknown, now: number): Promise<number>;
    /** adds (and trains on explicit origins); counts the adds into the batch, in one unit */
    add(a: { categoryId: number; threadIds: readonly number[]; addedBy: AddedBy; now: number; batchId?: number | null }): Promise<CategorizeOutcome>;
    remove(r: { categoryId: number; threadIds: readonly number[]; reason: "user" | "undo"; now: number }): Promise<{ removed: number[]; deltas: ModelDelta[] }>;
    batchThreads(batchId: number): Promise<number[]>;
    undoBatchPart(batchId: number, threadIds: readonly number[], now: number): Promise<{ removed: number[]; deltas: ModelDelta[] }>;
    finishUndo(batchId: number, now: number): Promise<void>;
    /** an exclusive move, recorded: afterwards every thread will be in `to` and no other category; applyMoveSlice moves them */
    beginMove(m: { to: number; threadIds: readonly number[]; addedBy: AddedBy; now: number; source: string }): Promise<{ batchId: number }>;
    /** what an applied move did: the threads it added to `to`, and those it took out of another category */
    moveOutcome(batchId: number): Promise<{ added: number[]; moved: number[] }>;
    movePhase(batchId: number): Promise<MovePhase | null>;
    /** the threads the current phase (moving, training, unmoving, restoring) hasn't reached yet */
    movePending(batchId: number): Promise<number[]>;
    unfinishedMoves(): Promise<{ batchId: number; phase: "moving" | "training" | "unmoving" | "restoring" }[]>;
    /** one slice of a move, one unit: these threads leave every other category (journaled per row) and join `to` */
    applyMoveSlice(batchId: number, threadIds: readonly number[], now: number): Promise<{ deltas: ModelDelta[]; touched: number[] }>;
    trainMoveSlice(batchId: number, threadIds: readonly number[], now: number): Promise<ModelDelta[]>;
    /** starts an undo (false: nothing left to undo); undoMoveSlice then restores memberships and decisions */
    undoMoveBegin(batchId: number, now: number): Promise<boolean>;
    undoMoveSlice(batchId: number, threadIds: readonly number[], now: number): Promise<{ removed: number[]; restored: number[]; deltas: ModelDelta[] }>;
    restoreMoveSlice(batchId: number, threadIds: readonly number[]): Promise<ModelDelta[]>;
  };

  categorize: {
    quickActions(categoryId: number, threadIds: readonly number[], model: CategorizerModel | null): Promise<QuickActions>;
    countScope(categoryId: number, scope: CategorizeScope, now: number): Promise<{ count: number; capped: boolean }>;
    /** the scope's threads, fixed once (filing changes the scope's own "not yet filed" predicate) */
    resolveScope(categoryId: number, scope: CategorizeScope, now: number, limit?: number): Promise<number[]>;
    predict(threadId: number, model: CategorizerModel, mode: AutoCategorize, now: number): Promise<Prediction[]>;
    pendingSuggestions(o: { categoryId?: number; threadId?: number; limit: number }): Promise<PendingSuggestion[]>;
    reject(threadId: number, categoryId: number, now: number): Promise<ModelDelta[]>;
    stats(): Promise<CategoryModelStats[]>;
    // model upkeep
    loadSnapshot(): Promise<{ snapshot: { featuresV: number; builtAt: number; fingerprint: string; blob: Uint8Array } | null; fingerprint: string }>;
    saveSnapshot(s: { featuresV: number; builtAt: number; blob: Uint8Array }): Promise<void>;
    backfillExamples(limit: number): Promise<number>;
    examples(): Promise<TrainExample[]>;
    examplesPage(after: ExampleKey | null, limit: number): Promise<{ example: TrainExample; key: ExampleKey }[]>;
    backgroundCandidates(now: number): Promise<number[]>;
    threadFeatures(threadIds: readonly number[]): Promise<Map<number, ThreadFeatureSet>>;
    backfillCandidates(now: number): Promise<number[]>;
    suggestBackfill(r: { threadIds: readonly number[]; now: number; mode: AutoCategorize; model: CategorizerModel }): Promise<{ touched: number[] }>;
    matureDecisions(now: number): Promise<number>;
    /** the AI assist may look at it: a new-mail-like thread nobody decided on */
    aiCandidate(threadId: number): Promise<boolean>;
    vetoes(threadId: number, sender: string, categoryIds: readonly number[], now: number): Promise<Map<number, Vetoes>>;
    /** records the AI's suggestion if the thread is still undecided and nothing vetoes it now */
    recordAiSuggestion(s: { threadId: number; categoryId: number; p: number; explain: Reason[]; sender: string; encoded: Uint32Array; model: CategorizerModel; now: number }): Promise<boolean>;
  };

  accounts: {
    list(): Promise<Account[]>;
    get(id: number): Promise<Account | null>;
    config<T>(id: number): Promise<{ config: T; secretRef: string | null } | null>;
    stamp(id: number): Promise<{ id: number; email: string; createdAt: number } | null>;
    /** the account, its first secret and (optionally) the owner claim commit together */
    create(a: {
      kind: AccountKind;
      email: string;
      displayName: string;
      color: string;
      providerConfig?: unknown;
      /** stored as account:<id>:<key> */
      secret?: { key: string; blob: Uint8Array };
      ownerClaim?: Omit<OwnerClaim, "accountId" | "email">;
      now: number;
    }): Promise<{ account: Account; claimed: boolean }>;
    /** name and color in their columns; sender name, signature and sync window in the provider config, in one unit */
    update(id: number, patch: AccountPatch): Promise<Account | null>;
    /** the account, its mail and its secrets; the owner row survives with account_id cleared */
    remove(id: number): Promise<void>;
    setSyncState(id: number, patch: Partial<AccountSyncState>): Promise<void>;
    setProviderConfig(id: number, config: unknown): Promise<void>;
    /** the provider's sync cursor, merged into the latest stored config in one unit (preferences beside it are kept) */
    setCursor(id: number, cursor: unknown): Promise<void>;
  };

  owner: {
    get(): Promise<OwnerIdentity | null>;
    /** moves ownership to a re-verified account with its fresh secret, if it is still the same mailbox */
    change(c: { claim: OwnerClaim; stamp: { createdAt: number; email: string }; secret: { name: string; blob: Uint8Array }; reason: string; now: number }): Promise<void>;
  };

  drafts: {
    /** null: `id` no longer exists (sent or deleted); a stale baseRevision inserts a new draft instead of overwriting */
    save(d: DraftInput, now: number): Promise<DraftRow | null>;
    list(): Promise<DraftRow[]>;
    delete(id: number): Promise<void>;
    /** a message's Message-ID (what a draft answers or forwards, portably, in an export) */
    messageRef(messageId: number): Promise<string | null>;
    /** the newest message of an account with that Message-ID (any case, with or without <>), for an import */
    findMessage(accountId: number, rfcMessageId: string): Promise<{ id: number; threadId: number } | null>;
  };

  settings: {
    get<T>(key: string, fallback: T): Promise<T>;
    set(key: string, value: unknown): Promise<void>;
    /** read-modify-write in one unit; `fn` is pure and may throw to abort */
    update<T, R>(key: string, fallback: T, fn: (current: T) => { value: T; result: R }): Promise<R>;
  };

  secrets: {
    /** every stored secret's name, sorted */
    names(): Promise<string[]>;
    get(name: string): Promise<Uint8Array | null>;
    has(name: string): Promise<boolean>;
    put(name: string, blob: Uint8Array): Promise<void>;
    delete(name: string): Promise<void>;
  };

  learning: {
    actionsSince(since: number): Promise<{ action: UserActionKind; fromEmail: string; fromDomain: string; listId: string | null; at: number }[]>;
    /** dismissed proposals and keys that already have a learned filter */
    excludedKeys(): Promise<Set<string>>;
    dismiss(key: string, now: number): Promise<void>;
  };

  /**
   * Plan 17's thread facts: the backfill of mail stored before them, and of
   * threads requeued since. Each call is ONE unit of work and does at most
   * `limit` message ids (while it collects your addresses) or threads.
   */
  facts: {
    backfill(o: { limit: number }): Promise<{ phase: "senders" | "threads" | "rescan" | "done"; processed: number; more: boolean; next?: "senders" | "threads" }>;
    /** nothing is pending (cheap: what a wake checks first) */
    idle(): Promise<boolean>;
  };

  providerStore(accountId: number): ProviderStore;

  /** test-only, required: plain rows for oracles and property tests */
  debug: {
    snapshot(): Promise<StoreSnapshot>;
    /** internal consistency (FTS5: integrity-check against the content) */
    verify(): Promise<void>;
    /** plan 17: back to the state right after the facts migration (no facts, no correspondents, the backfill from its start) */
    resetFacts(): Promise<void>;
  };

  /** development hosts and tests */
  dev: {
    /** loads a mock dataset into an empty store (deterministic) */
    seed(data: unknown, options: { now?: number; learningSignals?: boolean; categorizeRate?: number }): Promise<{ accountIds: number[]; categoryIds: number[]; messageCount: number; threadCount: number }>;
  };
}
