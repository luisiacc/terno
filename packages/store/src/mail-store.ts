import type { ProviderCooldownStore, OpAdmission } from "./provider-cooldown";
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
  Folder,
  CategoryColor,
  CategoryModelStats,
  Counts,
  ThreadFilter,
  Filter,
  FilterSave,
  FilterState,
  FilterRule,
  OpState,
  Prediction,
  QuickActions,
  Reason,
  Reminder,
  SimilarAction,
  SimilarOffers,
  SimilarPage,
  SimilarScope,
  StorageBucket,
  StorageThreadRow,
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
  FlagObservation,
  FlagObservationOptions,
  FlagReconciliation,
  FlagSnapshotRequest,
  FlagSnapshotPage,
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
  ProviderFolder,
  ScheduledRow,
  ScheduledSend,
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
  replyToJson: string;
  isBulk: boolean;
  /** plan 96: List-Unsubscribe as stored (JSON), null when none */
  unsubscribe: string | null;
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

export interface IngestOutcome extends FlagReconciliation {
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
  draftRevision?: number;
  draftGeneration?: string;
  attachments?: import("@terno/core").AttachmentRef[];
  /** explicit user replies feed learned filters; agents' don't */
  recordReply: boolean;
  /** plan 94: a scheduled send: only while the draft is still scheduled for exactly this moment (STALE "unscheduled" otherwise) */
  scheduledAt?: number;
  now: number;
}

/** Replaces ProviderContext.db: what providers read and write besides syncing through the backend. */
export interface ProviderStore {
  repairs?: Pick<import("./capture-repair").CaptureRepairs, "get" | "list">;
  pendingFlagSnapshots(request: FlagSnapshotRequest): Promise<FlagSnapshotPage>;
  messageByProviderId(providerMsgId: string): Promise<{ id: number; subject: string; fromEmail: string } | null>;
  /** Scan at most 50 account/provider keys, then exclude local rows. next is the last scanned key; absent only on an empty scan. */
  syncedMessagePage(after?: string): Promise<{ items: { id: number; providerMsgId: string }[]; next?: string }>;
  /** synced (non-local) messages of the account */
  syncedMessages(): Promise<{ id: number; providerMsgId: string; date: number }[]>;
  /** messages whose body hasn't been downloaded, newest first, with one IMAP location each */
  pendingAttachmentBodies(limit: number): Promise<{ id: number; providerMsgId: string }[]>;
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

export class ImapIdentityError extends Error {
  constructor() { super("IMAP identity unavailable"); }
}

export interface ImapLocationStore {
  /** Durable identity holds survive journal truncation; a new fence invalidates any older admission owner. */
  fence(messageIds: readonly number[]): Promise<void>;
  unresolved(messageIds: readonly number[]): Promise<number[]>;
  /** A completed sync may resume parked work whose targets are all already trusted; never releases holds. */
  resumeResolved(): Promise<void>;
  /** Validate every target and locator, then start without an async gap. Undispatched failure releases only its owned holds. */
  dispatch<T>(messageIds: readonly number[], expected: readonly ImapLocation[], start: (holdOwner?: string) => Promise<T>, fenceIds?: readonly number[]): Promise<T>;
  mappedMove(source: readonly ImapLocation[], mailbox: string, uidvalidity: number, mapping: readonly { messageId: number; uid: number }[], copy: boolean, expected: readonly ImapLocation[], holdOwner: string): Promise<void>;
  /** The server refused the one command a dispatch started (a tagged NO/BAD): nothing moved, so this admission's holds go. */
  refused(messageIds: readonly number[], holdOwner: string): Promise<void>;
  /**
   * Plan 114: a message another mail app moved (or a mailbox reset renumbered) found at its new place. The held
   * message takes `place` and its hold goes only when that is provably the same mail and nothing of ours can be
   * misdirected: a hold left by a lost location (no owner: no command of ours in flight), no place left anywhere,
   * the only message of the account with its Message-ID, the same size and date, and no action of ours queued,
   * running or unknown for it. False, with nothing written, otherwise: it stays held.
   */
  adopt(messageId: number, place: { mailbox: string; uidvalidity: number; uid: number; flags: string[] }, expect: { rfcMessageId: string; size: number; date: number }): Promise<boolean>;
  upsert(messageId: number, mailbox: string, uidvalidity: number, uid: number, flags: string[]): Promise<void>;
  /**
   * plan 107 (Codex code review round 20 #5): many places of one mailbox and generation, each as `upsert`, in one unit
   * (the caller bounds how many): one transaction a place grew SQLite's WAL past 300 MB for a 20,000-message folder
   */
  upsertMany(mailbox: string, uidvalidity: number, places: readonly { messageId: number; uid: number; flags: string[] }[]): Promise<void>;
  remove(messageId: number, mailbox: string): Promise<void>;
  /**
   * plan 68 (Codex R11): many locations of one mailbox gone (a sweep's expunges), a slice at a time with a yield
   * between; each thread's membership looked at once. `deleted` (plan 107, Codex code review round 6 #1): the places of
   * a mailbox the user deleted, whose path holds a new one now: no identity is held, as `resetMailbox`'s.
   */
  removeMany(messageIds: readonly number[], mailbox: string, o?: { deleted?: true }): Promise<void>;
  setFlags(messageId: number, mailbox: string, flags: string): Promise<void>;
  of(messageIds: readonly number[]): Promise<ImapLocation[]>;
  at(mailbox: string, uidvalidity: number, uid: number): Promise<number | null>;
  get(messageId: number, mailbox: string): Promise<{ uid: number; uidvalidity: number; flags: string } | null>;
  count(messageId: number): Promise<number>;
  inMailbox(mailbox: string, uidvalidity: number): Promise<{ message_id: number; uid: number; flags: string }[]>;
  /**
   * plan 68 (Codex R40): the same, UIDs above `afterUid` ascending, at most `limit`: a store whose reads hold the
   * loop (SQLite's) pages a big mailbox; one in memory may leave it out (its whole read is quick)
   */
  inMailboxPage?(mailbox: string, uidvalidity: number, afterUid: number, limit: number): Promise<{ message_id: number; uid: number; flags: string }[]>;
  /**
   * UIDVALIDITY changed: forgets every location in the mailbox, returns the messages that had one. `deleted` (plan
   * 107): the user deleted the mailbox on its server, so what was in it is gone, not moved: no identity is held.
   */
  resetMailbox(mailbox: string, o?: { deleted?: true }): Promise<number[]>;
  /**
   * plan 68 (Codex R15): the account's messages with no location, ids in (afterId, afterId + span], ascending; `more`
   * while messages above the window exist. A cut journal's messages are found again this way, a window at a time.
   */
  unlocated(afterId: number, span: number): Promise<{ ids: number[]; more: boolean }>;
  /** plan 68 (Codex R19, R20, R26): the account's ID-less messages (or, with `rfcMessageId`, those with that Message-ID) with this envelope (under any key), ids above `afterId` ascending, at most `limit` (an index of exactly that) */
  twins(e: { subject: string; fromEmail: string; date: number; size: number; rfcMessageId?: string | null }, afterId: number, limit: number): Promise<number[]>;
  /** plan 68: these messages' envelopes (a renamed folder's copies are recognised by them) */
  envelopes(messageIds: readonly number[]): Promise<{ id: number; subject: string; fromEmail: string; date: number; size: number; rfcMessageId: string | null }[]>;
  /** after a reset: an ID-less message among `candidates` with this exact envelope, not yet re-located in `mailbox`; `rfcMessageId`: one with that Message-ID instead (plan 68: a renamed folder's twin) */
  resetCandidate(c: { candidates: readonly number[]; subject: string; fromEmail: string; date: number; size: number; mailbox: string; rfcMessageId?: string | null }): Promise<{ id: number } | null>;
}

/** Plan 69: one storage.remove unit's ask. */
export interface StorageRemove {
  threadIds: readonly number[];
  buckets: readonly StorageBucket[];
  cutoff: number;
  maxMessages: number;
  /** conversations this removal already began: they go on whatever view their rest is in now (storageGoes) */
  continuing?: readonly number[];
}

/** Plan 69: what one storage.remove unit did. */
export interface StorageRemoval {
  touched: number[];
  /** conversations now gone entirely */
  threads: number;
  messages: number;
  /** messages of eligible threads still there (a thread larger than the unit): the caller runs another */
  remaining: number;
  /** the provider ids it removed, per account (a sync pass that fetched one before may not bring it back) */
  removed: { accountId: number; providerMsgIds: string[] }[];
  /** conversations it took messages from that are still there (the next unit continues them) */
  partial: number[];
}

/** Explicit verification can deliberately replace a missing credential; ordinary refresh CAS never upserts. */
export interface GoogleAdmission {
  expectedSubject: string | null;
  subject: string;
  /** Evaluated synchronously at actual store admission. */
  eligible?: () => boolean;
}

export type SecretIntent = { google?: GoogleAdmission } & (
  | { kind: "retain"; name: string; expectedBlob: Uint8Array }
  | { kind: "replace"; name: string; expectedBlob: Uint8Array | null; blob: Uint8Array });

export interface OwnerDecision {
  claim: OwnerClaim;
  stamp: { createdAt: number; email: string };
  secret: SecretIntent;
  reason: string;
  now: number;
}

/**
 * The storage boundary the backend uses. Every method is ONE atomic unit of
 * work; there is no generic cross-call transaction. Returned model deltas and
 * touched ids describe what already committed.
 */
export interface MailStore {
  captureRepairs: import("./capture-repair").CaptureRepairs;
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
    /** plan 96: the message Unsubscribe acts on (none of yours), its List-Unsubscribe, else its body; null: nothing to act on */
    unsubscribeSource(id: number): Promise<import("@terno/core").UnsubscribeSource | null>;
    /** `now`: the clock the waiting count reads its window from (plan 17) */
    counts(now: number): Promise<Counts>;
    /** resolves account:/category: and searches within one unit of work */
    /** an RPC cursor without revision/key (older renderers) continues this query */
    /** `signal`: the caller no longer wants the answer (a newer search); a slow path may stop and reject with SearchCancelledError */
    /** `threadFilter` (`threadAttachments`: its plan 15 name for attachments): the list's thread filters, applied by the engine before paging; waiting reads `now` */
    searchText(p: { query: string; accountId?: number; categoryId?: number; threadAttachments?: boolean; threadFilter?: ThreadFilter; cursor?: Cursor & Partial<Pick<SearchCursor, "revision" | "queryKey">>; limit: number; now: number; signal?: { readonly aborted: boolean } }): Promise<StoreSearchPage>;
    /** local optimistic change + learning signal + provider ops, atomically; `before`: each changed message as it was */
    act(c: { threadIds: readonly number[]; action: ThreadAction; signal: UserActionKind | null; now: number }): Promise<{ threadIds: number[]; opIds: string[]; before: MessageState[] } & FlagReconciliation>;
    /**
     * An undo: every message back to the given state (those still there),
     * with the provider ops that take it there, in order per message; never a
     * learning signal.
     */
    restore(c: { messages: readonly MessageState[]; now: number }): Promise<{ threadIds: number[]; opIds: string[] } & FlagReconciliation>;
  };

  sync: {
    beginObservation(accountId: number, options: FlagObservationOptions): Promise<FlagObservation | null>;
    /** threading, aggregates, filters (claims, actions, ops) and classification of one slice */
    ingest(batch: readonly IncomingMessage[], o: { applyFilters: boolean; now: number; classifier: ClassifierInput | null; observation?: FlagObservation; check?: () => void }): Promise<IngestOutcome>;
    setBody(messageId: number, text: string | null, html: string | null, o: { now: number; classifier: ClassifierInput | null; attachments?: import("./types").IncomingAttachment[]; captureUnavailable?: "size"; repair?: import("@terno/core").CaptureTicket; check?: () => void; expected?: { accountId: number; threadId: number; providerMsgId: string } }): Promise<{ touched: number[]; deltas: ModelDelta[]; auto: ClassifyResult["auto"]; opIds: string[] } & FlagReconciliation>;
    /** provider state for existing messages; preserves fields affected by queued/running ops inside the same unit */
    updateFlags(accountId: number, updates: readonly FlagUpdate[], observation?: FlagObservation, check?: () => void): Promise<{ touched: number[] } & FlagReconciliation>;
    remove(messageIds: readonly number[], check?: () => void): Promise<{ touched: number[] }>;
    pendingMessageIds(accountId: number): Promise<Set<number>>;
    /** plan 41: newly inserted messages as they are now (missing ids left out), for the notification rule; bounded by the caller */
    arrivals(messageIds: readonly number[]): Promise<import("@terno/core").ArrivalRow[]>;
  };

  ops: {
    claimReady(now: number, limit: number, admission?: OpAdmission): Promise<OpRow[]>;
    get(id: string): Promise<OpRow | null>;
    /** Point-read only send control/target metadata, without materializing the immutable wire payload. */
    sendSubmission(id: string): Promise<{ state: OpState; accepted: boolean } | null>;
    /** success, including adopting the provider's ids for a sent message */
    complete(id: string, result: { providerMsgId?: string; providerThreadId?: string; warning?: string; sendAccepted?: import("./recipient-receipts").AcceptedRecipientEvidence } | void, now: number): Promise<{ touched: number[]; deltas: ModelDelta[] } & FlagReconciliation>;
    /** with `park` (plan 20): the server couldn't be reached, so it waits for resumeNetwork (an outage gives the attempt back) */
    fail(id: string, error: string, retryable: boolean, now: number, park?: OpPark): Promise<OpState>;
    markUnknown(id: string, error: string, now: number, sendAccepted?: import("./recipient-receipts").AcceptedRecipientEvidence): Promise<void>;
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
    nextAttemptAt(admission?: OpAdmission): Promise<number | null>;
    defer(id: string, now: number, o: { refundClaim: boolean }): Promise<void>;
    recent(limit: number): Promise<OpRow[]>;
    resolveUnknown(id: string, resolution: "markSent" | "retry" | "discard", now: number): Promise<{ touched: number[] } & FlagReconciliation>;
  };

  recipientReceipts: {
    get(id: string): Promise<import("./recipient-receipts").RecipientReceiptHeader | null>;
    claimRecovery(id: string, expected: import("./recipient-receipts").RecipientReceiptHeader, now: number, active?: () => void): Promise<string>;
    list(accountId: number): Promise<import("./recipient-receipts").RecipientReceiptHeader[]>;
    readPart(id: string, kind: "envelope" | "outcomes", index: number): Promise<string | null>;
    retireSlice(id: string, force?: boolean): Promise<boolean>;
    finishRetire(id: string): Promise<void>;
  };

  sendCopies: {
    pinned(id: string): Promise<boolean>;
    get(id: string): Promise<import("./send-copies").SendCopyRow | null>;
    list(accountId: number): Promise<import("@terno/core").SentCopyInfo[]>;
    resetWireSlice(id: string): Promise<boolean>;
    startWire(id: string, size: number): Promise<void>;
    appendWire(id: string, index: number, data: string): Promise<void>;
    sealWire(id: string): Promise<void>;
    readWire(id: string, index: number): Promise<string | null>;
    accepted(id: string, warning: string | null): Promise<void>;
    record(id: string, copy: import("@terno/core").SentCopyState, identity?: { mailbox: string; uidValidity?: string; uid?: number }): Promise<void>;
    forgetSlice(id: string, force?: boolean): Promise<boolean>;
    pruneSavedSlice(id: string): Promise<boolean>;
  };

  attachments: {
    current(accountId: number, message: { id: number } | { providerMsgId: string }): Promise<import("./types").IncomingAttachment[]>;
    retry(accountId: number, messageId: number, check?: () => void): Promise<void>;
    create(p: { accountId: number; filename: string; mime: string; size: number; contentId?: string | null; now: number }): Promise<import("@terno/core").AttachmentRef>;
    append(accountId: number, assetId: string, index: number, dataBase64: string): Promise<void>;
    seal(accountId: number, assetId: string): Promise<void>;
    info(accountId: number, assetId: string): Promise<import("@terno/core").AttachmentRef>;
    read(accountId: number, assetId: string, index: number): Promise<string | null>;
    /** Only orphan assets; pinned draft/message/op assets cannot be removed. */
    discard(accountId: number, assetId: string): Promise<void>;
  };

  compose: {
    /** optimistic local copy (`messageId`) + durable send op (+ draft removal, reply signal), atomically */
    queueSend(c: SendCommand): Promise<{ opId: string; threadId: number; messageId: number; deltas: ModelDelta[] }>;
  };

  filters: {
    list(): Promise<Filter[]>;
    get(id: number): Promise<Filter | null>;
    save(f: FilterSave, now: number): Promise<Filter>;
    /** plan 90: with `expect`, only while the filter is still exactly that (else CANCELLED) */
    delete(id: number, expect?: FilterState): Promise<void>;
    preview(rule: FilterRule, now: number, limit: number): Promise<{ count: number; sample: ThreadSummary[] }>;
    /** message id bounds, for windowed matching */
    messageIdRange(): Promise<{ lo: number; hi: number } | null>;
    /** messages matching the rule in one id window */
    matchWindow(rule: FilterRule, now: number, window: { from: number; to: number }): Promise<number[]>;
    /** plan 90: which of these messages (a few hundred at most) the rule matches */
    matchMessages(rule: FilterRule, now: number, messageIds: readonly number[]): Promise<number[]>;
    /** claims + actions + ops for one chunk; refuses (CANCELLED) if the filter changed since `ruleJson` */
    applyChunk(id: number, ruleJson: string, messageIds: readonly number[], now: number): Promise<{ applied: number; touched: number[]; opIds: string[] } & FlagReconciliation>;
  };

  /**
   * Plan 87: a thread's reminder (one per thread). A thread that goes takes its
   * reminder with it; a merge keeps the survivor's, or the vanished one's when
   * the survivor had none (the earlier when both had one).
   */
  reminders: {
    /** every reminder (at most REMINDERS_MAX), by thread id */
    list(): Promise<Reminder[]>;
    /**
     * Sets these, replacing what those threads had, all or nothing: refused
     * (`ok: false`) when the reminders not among them plus these would pass
     * `cap`. Threads that are gone are skipped. `replaced`: what they had.
     * `ifAbsent`: only threads that have none now (an Undo never overwrites a reminder set since).
     */
    put(rows: readonly Reminder[], cap: number, o?: { ifAbsent?: boolean }): Promise<{ ok: true; put: number[]; replaced: Reminder[] } | { ok: false }>;
    /** removes these threads' reminders (`dueBy`: only those due by then); what it removed */
    delete(threadIds: readonly number[], o?: { dueBy?: number }): Promise<Reminder[]>;
    /** removes these reminders only if they are still exactly these (a replacement meanwhile stays) */
    deleteExact(rows: readonly Reminder[]): Promise<Reminder[]>;
    /**
     * The threads among these "noReply" reminders that were answered: a
     * message after `setAt` that is not a draft, spam or trash, and not from
     * one of your addresses.
     */
    answered(rows: readonly Reminder[]): Promise<number[]>;
  };

  /**
   * Plan 94: drafts scheduled to send (one row per draft; deleting the draft
   * removes it). The draft stays as it was until the send deletes it.
   */
  scheduled: {
    /** every scheduled send (at most SCHEDULED_MAX), soonest first */
    list(): Promise<ScheduledSend[]>;
    get(draftId: number): Promise<ScheduledRow | null>;
    /** "stale": the draft is gone or isn't that generation and revision; "full": `cap.count` others are scheduled, or the params would pass `cap.bytes` together */
    put(row: Omit<ScheduledRow, "error" | "retryAt"> & { generation: string; revision: number }, cap: { count: number; bytes: number }): Promise<"ok" | "full" | "stale">;
    /** a new moment; a failure noted before is forgotten */
    reschedule(draftId: number, sendAt: number): Promise<boolean>;
    /** it couldn't go yet: why, and when to try again (only if still scheduled for `sendAt`) */
    fail(draftId: number, sendAt: number, error: string, retryAt: number): Promise<boolean>;
    delete(draftId: number): Promise<boolean>;
  };

  /** plan 68: the accounts' own folders, as their providers list them (membership is the store's own: see refreshFolders) */
  folders: {
    list(): Promise<Folder[]>;
    /**
     * an account's list now (a sync pass); `changed`: false when it's the same; a newly listed IMAP folder whose mailbox
     * already has locations gets a rebuild job, as does one whose `except` changed (plan 107, Codex code review round 8
     * #1). `carried`: keys a rename's threads were just carried to (`carry`, before this): they keep those rows.
     * A folder's `aliases` (a pending rename's old path and generation) derive its membership too, in every derivation
     * and rebuild, until a listing without them (Codex code review round 16 #1); a change of them rebuilds nothing.
     * `rebuild`: keys a rename carried from a folder whose own rebuild was pending (`carry`'s `pending`): what it
     * carried may be partial, so each gets a rebuild job from its places and aliases, listed before or not (Codex
     * code review round 23 #1); one with neither keeps what was carried.
     */
    replace(accountId: number, folders: readonly ProviderFolder[], carried?: readonly string[], rebuild?: readonly string[]): Promise<{ changed: boolean; touched: number[] }>;
    /** one slice (up to `limit` rows) of a pending rebuild, durable and resumable (Codex R5); `more`: a job remains */
    rebuild(limit: number): Promise<{ more: boolean; touched: number[] }>;
    /**
     * plan 107: how many of the account's messages are in these folders (a delete's confirmation): IMAP, a location
     * in one; Gmail, one of them in its labels, outside trash and spam as membership is. Read through the folders' own
     * rows, never the whole mailbox. A slice at a time (Codex code review round 4 #3: overlapping sublabels over one
     * long conversation were seconds in one call): `limit` bounds what's looked at, each thread and message once
     * however many of the folders hold it; `messages` is this slice's; `next`: where the count goes on, null when done.
     * `restarted`: a thread merge since the last slice moved messages into a thread already passed, so the count began
     * again with this slice (what earlier slices counted is dropped: Codex code review round 19 #2).
     */
    count(accountId: number, keys: readonly import("./types").FolderPlace[], after: import("./types").FolderCountCursor | null, limit: number): Promise<{ messages: number; next: import("./types").FolderCountCursor | null; restarted?: true }>;
    /**
     * Plan 107: a renamed IMAP folder keeps its threads under its new key until the next pass proves where its mail
     * went (membership is derived: that pass, or any refresh of a thread, rewrites it from locations). Up to `limit`
     * threads above `after`, by id; `next`: where the next slice starts, null when done. `pending`: `from` has a
     * rebuild under way, so its rows may be partial (Codex code review round 23 #1: see `replace`'s `rebuild`).
     */
    carry(accountId: number, from: string, to: string, after: number, limit: number): Promise<{ next: number | null; pending?: true }>;
    /**
     * Plan 107: up to `limit` of the rows a folder no longer listed left under its key, gone, before a rename carries
     * another folder's threads there (Codex code review round 14 #2: Work → Job, then Other → Work before a pass,
     * showed the old Work's threads beside Other's). `more`: rows remain.
     */
    clear(accountId: number, key: string, limit: number): Promise<{ more: boolean }>;
  };

  /**
   * Plan 107: what an .mbox export of a folder reads, from this computer's copy. A folder holds the messages that
   * carry its key (a Gmail label, an IMAP location), never in trash or spam; a standard row the account's messages
   * in that place (inbox, sent, archive: neither trash nor spam; spam; trash), drafts never.
   */
  folderExport: {
    /**
     * One stretch of the place, from `after` (null: the start): its threads by id, and the messages there that are in
     * it (unordered). `limit` bounds the work, threads visited and messages looked at together, so one long
     * conversation is read a stretch at a time too (Codex code review round 2 #6). `next`: where the walk goes on;
     * null: none left. `rewound`: a thread merge since the last stretch moved messages behind the walk, which went
     * back to read them, so ids already given may come again (the caller keeps each once; Codex code review round 17 #1).
     */
    ids(target: import("./types").FolderExportTarget, after: import("./types").FolderExportCursor | null, limit: number): Promise<{ messages: { id: number; date: number }[]; next: import("./types").FolderExportCursor | null; rewound?: true }>;
    /** these messages (a batch), in this order, without their bodies; gone ones are left out */
    messages(ids: readonly number[]): Promise<import("./types").ExportMessage[]>;
    /**
     * A stretch of a message's stored body part, about `size` of the store's own units from `at` (0: the start), never
     * half a character; `next`: where the rest starts, null at its end; null: the message or the part is gone. A big
     * body is never read whole into one call (Codex code review round 6 #4): SQLite reads that byte range of the
     * stored value; IndexedDB keeps a body as one record, read whole once, then sliced.
     * `lease`: the export session reading it. IndexedDB holds the session's body being written under it, outside its
     * body cache (which lets one past its budget go after every call: Codex code review round 27 #3), until `release`,
     * another message's body under it, a write to the message, or more sessions than it keeps.
     */
    body(id: number, part: "text" | "html", at: number, size: number, lease?: string): Promise<{ text: string; next: number | null } | null>;
    /** the session ended (finished, cancelled, expired): what it held goes */
    release(lease: string): void;
  };

  categories: {
    list(): Promise<Category[]>;
    exists(id: number): Promise<boolean>;
    /** shown in the Inbox unless `showInInbox: false` (seeds and imports keep their data's; the RPC hides new ones) */
    create(name: string, color: CategoryColor, options?: { showInInbox?: boolean }): Promise<Category>;
    update(id: number, patch: { name?: string; color?: CategoryColor; position?: number; autoApply?: boolean; showInInbox?: boolean }): Promise<Category | null>;
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
    /**
     * an exclusive move, recorded: afterwards every thread will be in `to` and no other category; applyMoveSlice moves them.
     * `leave` (plan 77): they only leave `to` instead, journaled alike (undone exactly by categorize.undo)
     */
    beginMove(m: { to: number; threadIds: readonly number[]; addedBy: AddedBy; now: number; source: string; leave?: boolean }): Promise<{ batchId: number }>;
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

  /**
   * Plan 69: what the mailbox takes on this device, and removing this device's copy of old conversations (the
   * provider keeps its own: nothing here is sent to it).
   */
  storage: {
    /** the conversations above `after`, ascending, at most `limit`, as the report and removal read them */
    threads(after: number, limit: number): Promise<StorageThreadRow[]>;
    /**
     * One unit: re-reads these threads and keeps only those `removable()` passes now (their account synced and
     * signed in), then deletes at most `maxMessages` of their messages, oldest first (a thread's age holds until it
     * is gone). Expires the orphan grace of the attachments it unpinned (only those), for collect().
     */
    remove(r: StorageRemove): Promise<StorageRemoval>;
    /** one bounded cleanup unit of an expired orphan attachment (any account); false: none left */
    collect(now: number): Promise<boolean>;
    /** what the database takes, measured (null: the store can't tell); `free`: pages it reuses for new mail */
    footprint(): Promise<{ bytes: number; free: number } | null>;
    /**
     * Gives up to `pages` free pages back to the disk; `more` while some remain. A store that can't do it now
     * says whether it will the next time it opens (`onRestart`, then also in footprint's report).
     */
    compact(pages: number): Promise<{ more: boolean; onRestart: boolean }>;
    /** a compaction waits for the next open */
    compactPending(): Promise<boolean>;
  };

  /** Plan 63: received mail similar to some threads (same sender, sender + subject, domain or list), for archive, trash and spam. */
  similar: {
    /** what the threads' root inbound messages share (≤ 200 read), with eligible counts; targets still in place count too */
    offers(threadIds: readonly number[], action: SimilarAction): Promise<SimilarOffers>;
    /** plan 80: the same shared scopes, not counted (the sender's display name with them) */
    scopes(threadIds: readonly number[]): Promise<{ senderName: string | null; scopes: SimilarScope[] }>;
    /**
     * One page of what a sweep acts on, examining at most `limit` of the scope's messages from
     * `cursor` (this store's own token from the last page's `next`; null: from the start, and the
     * targets still in place join). Ids are threads in place, not starred or replied unless targeted.
     */
    resolvePage(scope: SimilarScope, action: SimilarAction, targets: readonly number[], cursor: number | null, limit: number): Promise<SimilarPage>;
    /** plan 90: each thread's root inbound message (what sender and subject rules decide on) */
    roots(threadIds: readonly number[]): Promise<number[]>;
    /** plan 91: every thread is known not to be from a person (its facts computed: person = 0, never still unknown) */
    automated(threadIds: readonly number[]): Promise<boolean>;
    /** which of these threads the user values now (starred, or with a message they sent): a sweep re-reads it per slice */
    kept(threadIds: readonly number[]): Promise<number[]>;
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
    /** Explicit browser consent: conditional pin admission without a durable token. */
    admitGoogle(stamp: { id: number; email: string; createdAt: number }, admission: GoogleAdmission): Promise<boolean>;
    /** the provider's sync cursor, merged into the latest stored config in one unit (preferences beside it are kept) */
    setCursor(id: number, cursor: unknown, check?: () => void): Promise<void>;
  };

  owner: {
    get(): Promise<OwnerIdentity | null>;
    /**
     * Moves ownership and its exact credential atomically. eligible is a synchronous, pure predicate
     * evaluated inside the command before any mutation; false leaves owner/history/secret unchanged.
     * A thrown predicate aborts the command. It must not start async work or mutate store state.
     */
    change(c: OwnerDecision & { eligible?: () => boolean }): Promise<boolean>;
    /** Read-only atomic confirmation of the resulting owner, proof, credential bytes and account stamp. */
    confirm(c: OwnerDecision): Promise<boolean>;
  };

  drafts: {
    /** null: `id` no longer exists (sent or deleted); a stale baseRevision inserts a new draft instead of overwriting */
    save(d: DraftInput, now: number): Promise<DraftRow | null>;
    list(): Promise<DraftRow[]>;
    sourceContext(messageId: number): Promise<{ threadId: number; accountId: number } | null>;
    /** The RPC boundary always supplies its immutable generation; internal maintenance may delete by numeric id. */
    delete(id: number, generation?: string): Promise<void>;
    /** a message's Message-ID (what a draft answers or forwards, portably, in an export) */
    messageRef(messageId: number): Promise<string | null>;
    /** the newest message of an account with that Message-ID (any case, with or without <>), for an import */
    findMessage(accountId: number, rfcMessageId: string): Promise<{ id: number; threadId: number } | null>;
  };

  /** Private fixed-key cooldown ledger; never included in ProviderStore or preferences. */
  providerCooldown: ProviderCooldownStore;

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
    /** Exact byte CAS, never an upsert. Optional mailbox stamp is checked atomically; equal bytes assert ownership without rewriting. */
    replace(name: string, expectedBlob: Uint8Array, nextBlob: Uint8Array, accountStamp?: { id: number; email: string; createdAt: number }): Promise<boolean>;
    /** Explicit verified flow only: stamp and exact expected secret are one transaction. */
    commit(intent: SecretIntent, stamp: { id: number; email: string; createdAt: number }): Promise<boolean>;
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

  /**
   * Plan 86: the Gmail tabs of mail stored before them (each message's
   * category, then each Inbox thread's tab), in slices of at most `limit`
   * message ids or threads. Resumes where it stopped; done once.
   */
  tabs: {
    backfill(o: { limit: number }): Promise<{ processed: number; more: boolean }>;
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
