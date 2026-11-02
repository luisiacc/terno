import { finishBodyClose } from "@terno/store";
import { projectBodyTokens, messageBodiesReleased } from "@terno/store";
import { releaseIndexBodies, releaseBodyChanges, type IndexChange } from "@terno/store";
import { releaseMessageBodies } from "@terno/store";
import { BodyProtocol, BodyEpochChanged, BODY_FACT_TABLES, publishBody, type BodyTicket } from "@terno/store";
import { unsubscribeBodyParts } from "@terno/store";
import { bodyPreview, validateBodyInput, bodyPrefix, SENT_TEXT_MAX } from "@terno/store";
import { bodyOwnership } from "./body-ownership";
import { iterateBodyTokens, type TextOp } from "@terno/core";
import { bodyPartRange, decodeBodyPart, assembleBody, prepareBodySnippet, bodyPartWrites, BODY_PART_UNITS, bodyTestKey, matchBodyParts, type BodyPartSource, type BodyTest, type BodyTestResults, prepareBodyTokens, browserBodyPreparationFactory } from "@terno/store";
import { idbCaptureRepairs, idbCaptureStorage, idbCapturePage } from "./capture-repair";
import { exportBody, exportIds, exportMessages, sliceBody } from "./folder-export";
import { completeCapture, retryCapture } from "@terno/store";
class CredentialAdmissionExpired extends Error {}
import { recipientReceiptParts, reserveRecipientReceipt, publishRecipientReceipt, retireRecipientSlice, finishRecipientRetirement, requireRecoverySource, rejectedRecipientSelection } from "@terno/store";
import { idbRecipientReceipts } from "./recipient-receipts";
import { detachedReply } from "@terno/store";
import { idbSendCopies } from "./send-copies";
import { reserveSendCopy, startCopyWire, appendCopyWire, sealCopyWire, acceptCopySubmission, recordCopy, forgetCopySlice, pruneSavedCopySlice, resetCopyWireSlice, copyWarningText, clearRecipientWarning, sendWarningFlags, submissionAccepted } from "@terno/store";
import { addMessageLabels, carryFolder, clearFolder, confirmRebuilt, countFolderMessages, listFolders, rebuildFolders, replaceFolders } from "./folders";
import { COOLDOWN_TICKETS, bindCooldown, decodeCooldown, encodeCooldown, mailboxDigest, mailboxKeyValid, PROVIDER_COOLDOWN_KEY, copyOpAdmission } from "@terno/store";
import { keptThreads, resolveSimilarPage, similarOffers, similarScopesOf } from "./similar";
import { removeStorage, storageThreads } from "./storage";
import { assetAccounting } from "./asset-accounting";
import { attachmentMessageBudgetAsync } from "@terno/core";
import { mergeBefore, sameImapLocations, reaffirmSavedFlagIntent, acceptFlagObservation, flagEpochs, flagReconciliation, flagObservationValid, flagTick, initializeFlagStep, rearmFlagEffects, settleFlagEffects, startFlagObservation } from "@terno/store";
import { bindIdbPromotedFlags, idbFlags, idbFlagSnapshots, prepareIdbFlagPage } from "./flag-intents";
import { appendAsset, assetError, assetRef, assetRow, createAsset, ASSET_CLEANUP_STEPS, cleanupAssets, validateAssetCreation, linkAssets, sealAsset, stageAttachments, validateAssets } from "@terno/store";
import { idbAssets, replaceAttachments } from "./attachments";
import { categoryOf, COUNT_CAP, filterState, LIST_FILTERS, sameFilterState, parseSearch, resolvable, resolveSearch, senderVetoed, type Address, type FilterAction, type FilterRule, type ListFilter, type ThreadAction, type ThreadFilter, type ThreadSummary } from "@terno/core";
import { RpcError } from "@terno/core/rpc";
import { L } from "@terno/i18n";
import type { MockDataset } from "@terno/mock-data";
import {
  type ClassifierInput,
  type ClassifyResult,
  type Cursor,
  type IncomingMessage,
  type LocalFlagField,
  type IndexBatch,
  type MailStore,
  type ModelDelta,
  type Platform,
  type ProviderStore,
  type Revision,
  type SearchBuild,
  type SearchCursor,
  type SearchFeed,
  type SearchMessageDoc,
  type SearchRequest,
  type SearchThreadDoc,
  type StoreCapabilities,
  type StoreSearchPage,
  type StoreSnapshot,
} from "@terno/store";
import { InstantSearch, WEB_SEARCH_MEMORY, type InstantSearchOptions } from "@terno/store/instant";
import {
  addToCategory,
  aiCandidate,
  autoReasons,
  backfillCandidates,
  backfillExamples,
  backfillRows,
  backgroundCandidates,
  batchThreads,
  beginMove,
  categoryStats,
  classifyNewThreads,
  countOf,
  createBatch,
  examplesFingerprint,
  finishBatch,
  finishUndo,
  loadExamples,
  loadExamplesPage,
  loadSnapshot,
  matureDecisions,
  movePending,
  moveOutcome,
  movePhase,
  pendingSuggestions,
  predictThread,
  quickActions,
  rejectSuggestion,
  removeFromCategory,
  restoreMoveSlice,
  rootRefs,
  saveSnapshot,
  scopeOpen,
  scopeThreads,
  suggestBackfill,
  threadFeatures,
  trainMoveSlice,
  undoBatchPart,
  undoMoveBegin,
  undoMoveSlice,
  applyMoveSlice,
  unfinishedMoves,
  vetoesFor,
} from "./categorize";
import {
  adoptProviderThread,
  applyMessageAction,
  applyThreadAction,
  restoreMessages,
  untabThreads,
  awaitAuthOp,
  releaseOp,
  deferOp,
  changeOwner,
  claimFilterApplications,
  claimOwner,
  claimReadyOps,
  completeOp,
  createAccount,
  createCategory,
  deleteMessages,
  enqueueOp,
  failOp,
  findRuleMatches,
  getAccount,
  getAccountConfig,
  getCounts,
  getFilter,
  getOp,
  getOwner,
  getSetting,
  getThread,
  unsubscribeCandidate,
  requireIdbGmailRefresh,
  ingestMessages,
  findIngestMessage,
  listAccounts,
  listCategories,
  listDrafts,
  listFilters,
  listRecentOps,
  listThreads,
  scopeThreadIds,
  loadUserActions,
  markOpUnknown,
  messageDoc,
  messagesWithPendingOps,
  pendingFlagFields,
  recomputeThreads,
  recordUserActions,
  recoverOps,
  resumeAuthOps,
  resumeNetworkOps,
  nextOpAttemptAt,
  ruleNeedsBody,
  ruleReadsBody,
  saveDraft,
  saveFilter,
  setMessageBody,
  setSetting,
  summariesInOrder,
  T,
  ThreadOrder,
  ScopeIndex,
  FILTER_TEST,
  threadDoc,
  toSummary,
  updateAccount,
  updateCategory,
  reorderCategories,
  type ActionResult,
  type Ctx,
  type R,
} from "./mail";
import type { Key, MemDb } from "./mem";
import { idbCachedPage, IdbProviderStore } from "./provider-store";
import { createMemDb, EARLY_TABLES, idbExists, LATE_TABLES, LOGICAL_SCHEMA, loadAll, PartialCommit, SEARCH_SCHEMA, openIdb, persist, readAll, readLazy, writeMeta } from "./schema";
import { UncertainWriteError } from "./uncertainty";
import { cancelWaiting, filesReady, waitingCount, forwardRuleGone, forwardWork, approveRule, cancelForwards, claimForward, eligiblePage, failForward, forwardHolds, forwardSendOpen, forwardsActive, getForward, linkForwardSend, listForwards, markEligible, nextForwardDue, planForwards, pruneForwards, retryForward, setCategoryForward, stopRule, waitForFiles } from "./forwards";
import { deleteScheduled, failScheduled, getScheduled, listScheduled, putScheduled, rescheduleScheduled, stillScheduled } from "./scheduled";
import { answeredReminders, deleteExactReminders, deleteReminders, listReminders, putReminders } from "./reminders";
import { startTabsBackfill, tabsIdle, tabsSlice } from "./tabs";
import { answeredThreads, arrivalRows, backfillSlice, FactsQueue, factsReady, ownMailChanged, referencesOfOwn, resetFacts, startRescan } from "./facts";
import { sameRevision, SearchCancelledError, type AutocompleteSource, type ContactBatch, type ContactMessage, type SentText } from "@terno/store";
import { contactOf, isLearnable, sentOf } from "./autocomplete";
import { appendOutbox, checkCursor, columnsOf, materializeChanges, pageOf, planScan, scanPage, searchChangeIds, searchHead } from "./search";

class IdbStoreClosed extends Error { constructor() { super("the store is closed"); } }

const PENDING_BODIES_CAP = 1000;
/** bodies kept in memory after a unit of work (read ahead or written), by count and bytes; the rest stay in IndexedDB */
const BODY_CACHE = 2000;
const BODY_CACHE_BYTES = 8 * 1024 * 1024;
/** export sessions whose body being written is held at once (plan 107, Codex code review round 27 #3); one more lets the oldest go */
export const EXPORT_LEASES_MAX = 4;
/** ids per exclusive slice when the feed reads bodies */
const SLICE = 500;
/** a scan's slice: this long at most, in chunks of this many messages, before yielding */
const SCAN_SLICE_MS = 8;
const SCAN_CHUNK = 256;

const FLAG_COLUMNS: Record<string, string> = { isRead: "is_read", isStarred: "is_starred", inInbox: "in_inbox", isTrash: "is_trash", isSpam: "is_spam", isSent: "is_sent", isDraft: "is_draft" };
const NO_CLASSIFICATION: ClassifyResult = { deltas: [], auto: new Map(), touched: new Set(), suggested: 0, uncertain: [], backfill: 0 };

export interface IdbMailStoreOptions {
  /** the mailbox: one IndexedDB database per name (terno-<name>) */
  name: string;
  signal?: AbortSignal;
  legacyUpgrade?: (name: string, signal?: AbortSignal) => Promise<void>;
  /** the browser's indexedDB (fake-indexeddb in Node tests) */
  factory: IDBFactory;
  platform: Pick<Platform, "uuid" | "yield" | "files" | "bodyPreparation">;
  /** answer searches from the instant index when it is current (default); the exact scan otherwise */
  instantSearch?: boolean | Omit<InstantSearchOptions, "feed" | "platform" | "snapshotPath" | "identity" | "phrases" | "log">;
  log?: (level: "info" | "warn" | "error", message: string, extra?: unknown) => void;
}

/**
 * MailStore on IndexedDB, natively: one object store per table, written in
 * one readwrite transaction per command. Every table but message bodies is
 * mirrored in memory on open, so a command runs synchronously (nothing
 * interleaves inside it, as with SQLite) and is acknowledged only after
 * IndexedDB committed it; bodies are read when a command, a search scan or
 * the index needs them. Commands are serialized (one writer), reads wait
 * for the command in flight. Search: the instant index at the store's
 * revision, otherwise an exact scan; never an incomplete page.
 */
export class IdbMailStore implements MailStore {
  private cooldownActions = 0;
  private cooldownAction<V>(fn: () => Promise<V>): Promise<V> {
    if (this.cooldownActions >= COOLDOWN_TICKETS) return Promise.reject(new Error("Private cooldown action capacity"));
    this.cooldownActions++;
    return Promise.resolve().then(fn).catch(() => { throw new Error("Private cooldown action failed"); }).finally(() => { this.cooldownActions--; });
  }

  readonly capabilities: StoreCapabilities;
  readonly instant: InstantSearch | null;
  private readonly c: Ctx;
  private queue: Promise<unknown> = Promise.resolve();
  /** the late tables (messages and their satellites) are in memory */
  private loaded: Promise<void> = Promise.resolve();
  /** plan 68: a mailbox from before schema 24, its Gmail memberships still to add (the labelled messages, how far) */
  private backfill: { scan: Iterator<R> | null; done: boolean; pending: number[] | null } | null = null;
  private inflight: Promise<unknown> | null = null;
  private open = true;
  private bodyClosing = false;
  private bodyClose: Promise<void> | undefined;
  private bodyCleanupFailure: { error: unknown } | undefined;
  private readonly bodyCommands = new Set<Promise<unknown>>();
  private readonly bodyStages = new Map<string, () => void>();
  private readonly bodyProtocol = new BodyProtocol(() => String(this.db.table("body_protocol").get(1)?.epoch ?? "0"), (id) => {
    if (this.isOpen && bodyOwnership(this.db).isOrphan(id)) this.queueBodyGarbage(true);
  });
  private readonly preparedTickets = new WeakMap<BodyTestResults, BodyTicket>();
  private bodyCleanup: Promise<void> = Promise.resolve();
  private bodyGarbage: Promise<void> | undefined;
  private bodyGarbageAgain = false;
  private queueBodyGarbage(retired = false): void {
    if (this.bodyClosing) return;
    if (this.bodyGarbage) { this.bodyGarbageAgain ||= retired; return; }
    const task = Promise.resolve().then(() => this.cleanupBodies()).catch((error: unknown) => { this.bodyCleanupFailure ??= { error }; this.log("warn", "Body cleanup will resume after reopening the mailbox"); }).finally(() => { if (this.bodyGarbage === task) this.bodyGarbage = undefined; if (this.bodyGarbageAgain) { this.bodyGarbageAgain = false; this.queueBodyGarbage(); } });
    this.bodyGarbage = task;
  }

  private bodyCommand<V>(work: () => Promise<V>): Promise<V> {
    if (this.bodyClosing) return Promise.reject(new Error("The store is closing"));
    const command = work(); this.bodyCommands.add(command);
    void command.finally(() => this.bodyCommands.delete(command)).catch(() => {});
    return command;
  }
  private unusable = false;
  private seeding = false;
  /**
   * plan 107: each export session's body being written, held outside the body cache (one past its budget went after
   * every call, so a 20 MB body was read again for each 256 KB stretch: Codex code review round 27 #3). One a session,
   * at most `EXPORT_LEASES_MAX`; a write to the message lets it go.
   */
  private readonly exportLeases = new Map<string, { id: number; body: { body_text: string | null; body_html: string | null } }>();
  private readonly providerStores = new Map<number, ProviderStore>();
  private readonly log: NonNullable<IdbMailStoreOptions["log"]>;
  /** how long opening took: reading IndexedDB, building the in-memory tables */
  readonly openTimings: Record<string, number> = {};

  private constructor(
    private readonly idb: IDBDatabase,
    private readonly db: MemDb,
    private readonly o: IdbMailStoreOptions,
  ) {
    this.log = o.log ?? (() => {});
    bodyOwnership(db).onRetired = () => this.queueBodyGarbage(true);
    const order = new ThreadOrder(db);
    const filterOrders = Object.fromEntries(LIST_FILTERS.map((f) => [f, new ThreadOrder(db, FILTER_TEST[f])])) as Record<ListFilter, ThreadOrder>;
    const facts = new FactsQueue(db);
    const scopes = new ScopeIndex(db);
    const bodies = db.table<R>("message_bodies");
    this.c = {
      db,
      order,
      filterOrders,
      facts,
      scopes,
      uuid: () => o.platform.uuid(),
      bodyProjection: (capture) => projectBodyTokens(this.bodyProtocol.retain(capture), () => this.bodyPartSource(capture, 2)),
      body: (id) => {
        const r = bodies.get(id);
        if (r) return { body_text: r.body_text ?? null, body_html: r.body_html ?? null, body_preview: r.body_preview ?? null, capture_id: r.capture_id ?? null };
        if (bodies.absent.has(id)) return null;
        throw new Error(`the body of message ${id} was not read ahead`);
      },
    };
    if (o.instantSearch !== false) {
      this.instant = new InstantSearch({
        memory: WEB_SEARCH_MEMORY,
        ...(o.instantSearch === true || o.instantSearch === undefined ? {} : o.instantSearch),
        feed: this.feed,
        platform: o.platform,
        snapshotPath: o.platform.files ? `/${o.name}.idb.search` : null,
        identity: `idb-schema-${SEARCH_SCHEMA}`,
        log: this.log,
      });
      this.instant.start();
    } else this.instant = null;
    this.autocomplete = this.autocompleteSource();
    this.capabilities = { engine: "indexeddb", search: this.instant ? "instant+scan" : "scan", bulkRuleScan: "scan", imapLocations: true, externalReaders: false, durability: "browser" };
  }

  /** Opens (creating) the mailbox and mirrors it in memory. */
  static async open(o: IdbMailStoreOptions): Promise<IdbMailStore> {
    o.signal?.throwIfAborted();
    await o.legacyUpgrade?.(o.name, o.signal);
    o.signal?.throwIfAborted();
    const idb = await openIdb(o.factory, o.name);
    try {
      const pending = await new Promise<{ pending?: boolean } | undefined>((resolve, reject) => { const query = idb.transaction("meta", "readonly").objectStore("meta").get("bodyPartsUpgrade"); query.onsuccess = () => resolve(query.result); query.onerror = () => reject(query.error); });
      if (pending?.pending) throw new Error("This mailbox needs asynchronous body upgrade admission");
      o.signal?.throwIfAborted();
      const db = createMemDb();
      const timings: Record<string, number> = {};
      const meta = await loadAll(idb, db, timings, EARLY_TABLES, () => o.platform.yield());
      if (!db.table("search_state").get(1)) {
        // a new database: its epoch, the search log's head
        db.tx(() => db.table("search_state").insert({ id: 1, epoch: o.platform.uuid(), seq: 0, bytes: 0 }));
        const commit = db.takeCommit()!;
        await persist(idb, commit, "strict", o.platform);
        db.confirm();
      }
      // plan 68 (SQL v24): a mailbox from before gets its Gmail memberships once, after its messages load; the mark
      // goes in with the upgrade and comes off only when they're saved, so a close or a failure meanwhile resumes (Codex R1)
      const foldersPending = (typeof meta.logicalSchema === "number" && meta.logicalSchema < 24) || meta.foldersPending === true;
      // plan 86 (SQL v37): a mailbox from before gets its Gmail tabs once; the mark is saved before the schema moves on
      if (typeof meta.logicalSchema === "number" && meta.logicalSchema < 37) {
        db.tx(() => startTabsBackfill(db));
        const commit = db.takeCommit();
        if (commit) {
          await persist(idb, commit, "strict", o.platform);
          db.confirm();
        }
      }
      if (meta.logicalSchema === undefined) await writeMeta(idb, { logicalSchema: LOGICAL_SCHEMA, createdAt: Date.now() });
      else if (meta.logicalSchema !== LOGICAL_SCHEMA || foldersPending) await writeMeta(idb, { logicalSchema: LOGICAL_SCHEMA, ...(foldersPending && { foldersPending: true }) });
      o.signal?.throwIfAborted();
      const store = new IdbMailStore(idb, db, o);
      Object.assign(store.openTimings, timings);
      // the first screen needs none of it: messages load while it paints (writes to these tables wait for them)
      store.c.late = { loaded: false };
      store.loaded = loadAll(idb, db, {}, LATE_TABLES, () => o.platform.yield()).then(
        () => {
          store.c.late!.loaded = true;
        },
        (error: unknown) => {
          store.log("error", "could not load the mailbox", error instanceof Error ? error.message : error);
          throw error;
        },
      );
      // the upgrade's backfill goes through folders.rebuild (the backend's runner: a slice a turn, what it touched
      // published), a batch of messages at a time once no folder job is left (Codex R17)
      if (foldersPending) store.backfill = { scan: null, done: false, pending: null };
      store.bodyCleanup = store.loaded.then(() => store.cleanupBodies());
      void store.bodyCleanup.catch(() => {});
      if (o.signal?.aborted) { await store.close(); o.signal.throwIfAborted(); }
      return store;
    } catch (error) {
      idb.close();
      throw error instanceof PartialCommit ? error.original : error;
    }
  }

  static exists(factory: IDBFactory, name: string): Promise<boolean> {
    return idbExists(factory, name);
  }

  get isOpen(): boolean {
    return this.open && !this.unusable;
  }

  get name(): string {
    return this.o.name;
  }

  /** resolves once every table is in memory (messages load after open) */
  async whenLoaded(): Promise<void> {
    await this.loaded;
    await this.settled();
  }

  close(): Promise<void> {
    if (this.bodyClose) return this.bodyClose;
    if (!this.open) return Promise.resolve();
    this.exportLeases.clear();
    this.bodyClosing = true;
    return this.bodyClose = finishBodyClose([
      () => Promise.allSettled(this.bodyCommands),
      () => this.instant?.close(),
      () => this.bodyCleanup,
      () => this.bodyGarbage,
      () => this.loaded,
      () => this.queue,
      () => { if (!this.unusable) return this.cleanupBodies(); },
      () => this.queue,
      () => { if (this.bodyCleanupFailure) throw this.bodyCleanupFailure.error; },
      () => { if (!this.unusable) this.idb.close(); this.open = false; },
    ]);
  }

  // ───────────────────────────── units of work ─────────────────────────────

  /** One at a time: commands, scans and feed slices never interleave with a command. `early` units touch only early tables. */
  private exclusive<V>(fn: () => Promise<V>, early = false): Promise<V> {
    // a unit that needs the late tables waits for them before queueing, so it never holds up early units
    const enqueue = () => {
      const run = this.queue.then(async () => {
        this.assertUsable();
        try {
          return await fn();
        } finally {
          // whatever the unit read ahead, the cache goes back within its budget
          this.evictBodies();
        }
      });
      this.queue = run.catch(() => {});
      return run;
    };
    return early ? enqueue() : this.loaded.then(enqueue);
  }

  /**
   * A store command: optional reads ahead (bodies), then the synchronous
   * unit, its search outbox batch, and one IndexedDB transaction. Resolves
   * after IndexedDB committed; if it fails, memory is put back.
   */
  private command<V>(fn: () => V, o: { prefetch?: () => Promise<void>; durability?: "strict" | "relaxed"; early?: boolean; check?: () => void; bodyTicket?: BodyTicket } = {}): Promise<V> {
    return this.exclusive(async () => {
      await o.prefetch?.();
      const epoch = this.bodyProtocol.ticket().epoch;
      const result = this.db.tx(() => { if (o.bodyTicket) this.bodyProtocol.validate(o.bodyTicket); o.check?.(); return fn(); });
      if ([...this.db.touched(BODY_FACT_TABLES).values()].some((keys) => keys.length)) this.db.tx(() => {
        const table = this.db.table("body_protocol"), row = table.get(1)!;
        table.update(row, { epoch: this.o.platform.uuid() });
      });
      const touched = this.db.touched(["messages", "message_bodies", "threads", "thread_categories"]);
      const messageIds = new Set<number>([...touched.get("messages")!, ...touched.get("message_bodies")!].map(Number));
      // a body held for an export is read again once its message is written (round 27 #3)
      if (this.exportLeases.size) for (const [k, l] of this.exportLeases) if (messageIds.has(l.id)) this.exportLeases.delete(k);
      const threadIds = new Set<number>([...touched.get("threads")!.map(Number), ...touched.get("thread_categories")!.map((k) => (JSON.parse(k as string) as number[])[0]!)]);
      if (messageIds.size || threadIds.size) this.db.tx(() => appendOutbox(this.c, [...messageIds].sort((a, b) => a - b), [...threadIds].sort((a, b) => a - b), Date.now()));
      const commit = this.db.takeCommit();
      if (commit) {
        let release!: () => void;
        this.inflight = new Promise<void>((resolve) => { release = resolve; });
        try {
          await persist(this.idb, commit, o.durability ?? "strict", this.o.platform, o.check, epoch);
          this.db.confirm();
        } catch (error) {
          if (error instanceof PartialCommit || error instanceof UncertainWriteError) {
            this.unusable = true;
            this.idb.close();
            throw error instanceof PartialCommit ? error.original : error;
          }
          this.db.revert();
          if (error instanceof BodyEpochChanged && error.durable) {
            this.unusable = true; this.idb.close();
            throw new RpcError("STALE", L("errors.mail.processingBusy"), { reason: "revision" });
          }
          if (error instanceof CredentialAdmissionExpired) return false as V;
          throw error;
        } finally {
          this.inflight = null;
          release();
        }
        if (messageIds.size || threadIds.size) this.instant?.notify();
      }
      this.evictBodies();
      return result;
    }, o.early);
  }

  /** Reads see only committed state: they wait for the command whose transaction is in flight. */
  private async settled(): Promise<void> {
    while (this.inflight) await this.inflight.catch(() => {});
    this.assertUsable();
  }

  private assertUsable(): void {
    if (!this.open || this.unusable) throw new IdbStoreClosed();
  }

  /** `early`: reads only early tables (answers while messages load) */
  private async read<V>(fn: () => V, early = false): Promise<V> {
    if (!early) await this.loaded;
    for (;;) {
      await this.settled();
      if (this.inflight) continue;
      this.assertUsable();
      return fn();
    }
  }

  private early<V>(fn: () => V): Promise<V> {
    return this.read(fn, true);
  }

  private evictBodies(): void {
    if (this.seeding || this.db.inTransaction) return;
    const parts = this.db.table("body_parts");
    parts.evict([...parts.rows.keys()]); parts.absent.clear();
    const chunks = this.db.table("attachment_bytes");
    chunks.evict([...chunks.rows.keys()]);
    // No pending undo remains here; cold-delete keys need not outlive their committed unit.
    chunks.absent.clear();
    const detail = this.db.table("recipient_receipt_parts");
    detail.evict([...detail.rows.keys()]);
    detail.absent.clear();
    const wire = this.db.table("send_copy_bytes");
    wire.evict([...wire.rows.keys()]);
    wire.absent.clear();
    const bodies = this.db.table<R>("message_bodies");
    let { count, bytes } = this.bodyCache();
    if (count <= BODY_CACHE && bytes <= BODY_CACHE_BYTES) return;
    // oldest first (insertion order)
    const keys: Key[] = [];
    for (const [k, r] of bodies.rows) {
      if (count <= BODY_CACHE && bytes <= BODY_CACHE_BYTES) break;
      keys.push(k);
      count--;
      bytes -= bodyBytes(r);
    }
    bodies.evict(keys);
  }

  /** what the body cache holds (bytes as UTF-16) and may hold */
  bodyCache(): { count: number; bytes: number; budgetBytes: number } {
    let bytes = 0;
    const bodies = this.db.table<R>("message_bodies");
    for (const r of bodies.rows.values()) bytes += bodyBytes(r);
    return { count: bodies.size, bytes, budgetBytes: BODY_CACHE_BYTES };
  }

  private searchMessageDoc(id: number): SearchMessageDoc {
    const body = this.c.body(id);
    return { ...messageDoc(T(this.c, "messages").get(id)!, body?.body_text ?? null), ...(body?.capture_id ? this.c.bodyProjection!(body.capture_id) : {}) };
  }

  private bodyPartSource(capture: string, field: number): BodyPartSource {
    const row = T(this.c, "body_captures").get(capture);
    if (!row?.ready) throw new Error("Body source changed before it was read");
    const release = this.bodyProtocol.retain(capture);
    const expected = field === 0 ? row.text_parts : field === 1 ? row.html_parts : row.token_parts;
    return { close: release, read: async (after) => {
      if (expected == null || after + 1 >= expected) return null;
      const table = this.db.table("body_parts"), key = JSON.stringify([capture, field, after + 1]);
      await readLazy(this.idb, table, [key]);
      const part = table.get(capture, field, after + 1);
      table.evict([key]); table.absent.delete(key);
      if (!part) throw new Error("Incomplete body parts");
      await this.o.platform.yield();
      return { ordinal: after + 1, value: part.value as Uint8Array };
    } };
  }

  private async stageBody<M extends Pick<IncomingMessage, "accountId" | "bodyText" | "bodyHtml" | "snippet" | "preparedBodyTokens" | "bodyParts">>(message: M, check?: () => void): Promise<M & Pick<IncomingMessage, "bodyCapture">> {
    validateBodyInput(message);
    if (!message.bodyParts && Math.max(message.bodyText?.length ?? 0, message.bodyHtml?.length ?? 0) <= BODY_PART_UNITS) return message;
    const id = this.o.platform.uuid();
    check?.();
    this.bodyStages.set(id, this.bodyProtocol.retain(id));
    let tokenCount = 0; const acknowledged = [0, 0, 0];
    try {
    await this.command(() => T(this.c, "body_captures").insert({ id, account_id: message.accountId, message_id: null, text_parts: message.bodyParts?.text?.length ?? (message.bodyText === null ? null : Math.ceil(message.bodyText.length / BODY_PART_UNITS)), html_parts: message.bodyParts?.html?.length ?? (message.bodyHtml === null ? null : Math.ceil(message.bodyHtml.length / BODY_PART_UNITS)), token_parts: 0, ready: 0 }), { check });
      for await (const part of bodyPartWrites(message.bodyText, message.bodyHtml, message.preparedBodyTokens ?? (message.bodyParts?.text || (message.bodyText && message.bodyText.length > BODY_PART_UNITS) ? prepareBodyTokens(message.bodyParts?.text ?? message.bodyText!, this.o.platform.yield, this.o.platform.bodyPreparation ?? browserBodyPreparationFactory, check) : iterateBodyTokens(message.bodyText ?? "")), message.bodyParts)) {
        await this.command(() => { check?.(); T(this.c, "body_parts").insert({ capture_id: id, ...part }); }, { check });
        if (part.ordinal !== acknowledged[part.field]!) throw new Error("Body acknowledgement is not contiguous");
        acknowledged[part.field]!++;
        if (part.field === 2) tokenCount = part.ordinal + 1;
        await this.o.platform.yield();
      }
      if (acknowledged[0] !== (message.bodyParts?.text?.length ?? Math.ceil((message.bodyText?.length ?? 0) / BODY_PART_UNITS)) || acknowledged[1] !== (message.bodyParts?.html?.length ?? Math.ceil((message.bodyHtml?.length ?? 0) / BODY_PART_UNITS))) throw new Error("Body acknowledgements are incomplete");
      await this.command(() => { check?.(); const row = T(this.c, "body_captures").get(id)!; T(this.c, "body_captures").update(row, { token_parts: tokenCount, ready: 1 }); }, { check });
      return { ...message, bodyText: null, bodyHtml: null, bodyParts: undefined, preparedBodyTokens: undefined, bodyCapture: { id, preview: bodyPreview(message.bodyText, message.bodyParts), snippet: await prepareBodySnippet(message.snippet || message.bodyText, this.o.platform.yield, message.snippet ? undefined : message.bodyParts?.text), tail: "" } };
    } catch (error) { if (this.isOpen && !this.unusable) await this.finishBodyStage(id); throw error; }
  }

  private async finishBodyStage(id: string): Promise<void> {
    this.bodyStages.get(id)?.();
    this.bodyStages.delete(id);
    await this.discardBody(id);
    await this.cleanupBodies();
  }

  private async cleanupBodies(): Promise<void> {
    await this.loaded;
    const candidates = bodyOwnership(this.db).candidates();
    let remaining = bodyOwnership(this.db).count();
    for (const id of candidates) {
      if (remaining-- === 0) break;
      try { await this.discardBody(id); }
      catch (error) { if (this.unusable && error instanceof IdbStoreClosed) return; throw error; }
      await this.o.platform.yield();
    }
  }

  private async discardBody(id: string): Promise<void> {
    while (this.open && !this.unusable) {
      if (this.bodyProtocol.held(id)) return;
      const capture = await this.read(() => T(this.c, "body_captures").get(id));
      if (!capture) return;
      if (await this.read(() => T(this.c, "body_heads").by("capture", id).length > 0)) return;
      const tx = this.idb.transaction("body_parts", "readonly");
      const keys = await new Promise<IDBValidKey[]>((resolve, reject) => { const request = tx.objectStore("body_parts").getAllKeys(IDBKeyRange.bound([id], [id, 3]), 16); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const ticket = this.bodyProtocol.ticket();
      let removed: boolean, releaseReclaim: (() => void) | undefined;
      try { removed = await this.command(() => {
        if (this.bodyProtocol.held(id) || !T(this.c, "body_captures").get(id) || T(this.c, "body_heads").by("capture", id).length) return false;
        releaseReclaim = this.bodyProtocol.claimReclaim(id);
        if (!keys.length) T(this.c, "body_captures").delete(id);
        else for (const key of keys) T(this.c, "body_parts").delete(...key as (string | number)[]);
        return true;
      }, { bodyTicket: ticket, check: () => { if (this.bodyProtocol.held(id)) throw new BodyEpochChanged(); } });
      } catch (error) { if (error instanceof BodyEpochChanged) return; throw error; }
      finally { releaseReclaim?.(); }
      if (!removed || !keys.length) return;
      await this.o.platform.yield();
    }
  }

  private ruleTests(rules: readonly import("@terno/core").FilterRule[]): BodyTest[] {
    return rules.flatMap((rule) => rule.conditions.flatMap((c) => c.field === "body" ? [{ op: c.op, value: c.value }] : c.field === "text" ? [{ op: "contains" as const, value: c.value }] : []));
  }
  private async prepareBodyTests(tests: readonly BodyTest[], ids?: readonly number[], onlyCaptures?: readonly string[], cache: BodyTestResults = new Map(), ticket = this.bodyProtocol.ticket()): Promise<BodyTestResults> {
    const results: BodyTestResults = new Map();
    this.preparedTickets.set(results, ticket);
    if (!tests.length) return results;
    const captures = onlyCaptures ? new Set(onlyCaptures) : ids ? new Set(ids.flatMap((id) => { const body = this.c.body(id); return body?.capture_id ? [body.capture_id] : []; })) : new Set([...T(this.c, "body_captures").all()].filter((r) => r.ready).map((r) => String(r.id)));
    for (const id of captures) {
      const matches = cache.get(id) ?? new Map<string, boolean>(); results.set(id, matches); cache.set(id, matches);
      for (const test of tests) { const key = bodyTestKey(test.op, test.value, test.prefix); if (!matches.has(key)) matches.set(key, await matchBodyParts(this.bodyPartSource(id, 2), test.op, test.value, test.prefix)); }
    }
    return results;
  }
  private preparedBodyTest(results: BodyTestResults, id: string, op: TextOp, value: string, prefix = false): boolean {
    const result = results.get(id)?.get(bodyTestKey(op, value, prefix));
    if (result === undefined) throw new Error("Body match was not prepared at this content revision");
    return result;
  }
  private withBodyTests<V>(results: BodyTestResults, work: () => V): V {
    return this.db.tx(() => {
    const ticket = this.preparedTickets.get(results); if (ticket) this.bodyProtocol.validate(ticket);
    const prior = this.c.bodyTest;
    this.c.bodyTest = (id, op, value, prefix) => this.preparedBodyTest(results, id, op, value, prefix);
    try { return work(); } finally { this.c.bodyTest = prior; }
    });
  }

  private readBodies(ids: Iterable<number>): Promise<void> {
    return readLazy(this.idb, this.db.table("message_bodies"), [...ids]);
  }

  /** the roots' bodies, for anything that derives categorization features */
  private prefetchRoots(threadIds: Iterable<number>): Promise<void> {
    return this.readBodies(rootRefs(this.c, threadIds).map((r) => r.messageId));
  }

  // ───────────────────────────── autocomplete (plan 18) ─────────────────────────────

  /** Headers from the in-memory rows, sent text through the lazy bodies (32 per exclusive unit, so commands interleave). */
  readonly autocomplete: AutocompleteSource;

  private autocompleteSource(): AutocompleteSource {
    let sentIds: Int32Array | null = null;
    return {
      snapshotBase: this.o.platform.files ? `/${this.o.name}.idb` : null,
      identity: `idb-${SEARCH_SCHEMA}`,
      head: async () => this.early(() => this.revision()),
      changes: async (after, through, maxCommits) => {
        const ids = await this.read(() => searchChangeIds(this.c, after, through, maxCommits));
        const out: ContactBatch[] = [];
        for (const b of ids) {
          const messages: ContactMessage[] = [];
          const removed: number[] = [];
          const spamSenders = new Set<string>();
          for (let i = 0; i < Math.max(b.messageIds.length, b.threadIds.length); i += SLICE) {
            const mIds = b.messageIds.slice(i, i + SLICE);
            const tIds = b.threadIds.slice(i, i + SLICE);
            await this.read(() => {
              const rows = this.db.table<R>("messages");
              for (const id of mIds) {
                const m = rows.get(id);
                if (m) messages.push(contactOf(m));
                else removed.push(id);
              }
              const threads = this.db.table<R>("threads");
              for (const t of tIds) {
                if (threads.get(t)?.in_spam !== 1) continue;
                for (const m of rows.by("fk_thread_id", t)) if (m.is_sent !== 1) spamSenders.add(m.from_email as string);
              }
            });
            await this.o.platform.yield();
          }
          out.push({ from: b.from, to: b.to, messages, removed, spamSenders: [...spamSenders] });
        }
        return out;
      },
      beginBuild: async () => {
        const { from, lease, messageIds } = await this.exclusive(async () => {
          const from = this.revision();
          const row: R = { id: undefined, from_seq: from.seq, created_at: Date.now() };
          this.db.tx(() => this.db.table("search_leases").insert(row));
          this.db.takeCommit();
          this.db.confirm();
          return { from, lease: row.id as number, messageIds: Int32Array.from(this.db.table("messages").rows.keys() as Iterable<number>).sort() };
        });
        const page = (at: number) =>
          this.read(() => {
            const rows = this.db.table<R>("messages");
            const docs: ContactMessage[] = [];
            const end = Math.min(messageIds.length, at + SLICE);
            for (let i = at; i < end; i++) {
              const m = rows.get(messageIds[i]!);
              if (m) docs.push(contactOf(m));
            }
            return { docs, next: end };
          });
        const release = async () => {
          if (!this.open) return;
          await this.exclusive(async () => {
            this.db.tx(() => this.db.table("search_leases").delete(lease));
            this.db.takeCommit();
            this.db.confirm();
          });
        };
        return {
          from,
          async *messages() {
            for (let at = 0; at < messageIds.length; ) {
              const p = await page(at);
              at = p.next;
              if (p.docs.length) yield p.docs;
            }
          },
          release,
        };
      },
      sentAfter: async (afterId, limit) => {
        // the learnable ids in order, collected once per build (a page per call would rescan the mailbox each time);
        // mail sent after that comes through the log
        if (afterId === 0 || !sentIds) {
          // in slices of 20,000 rows: one pass over a 300,000-message mailbox would stall the worker
          const keys = await this.read(() => Int32Array.from(this.db.table<R>("messages").rows.keys() as Iterable<number>));
          const out: number[] = [];
          for (let i = 0; i < keys.length; i += 20_000) {
            await this.o.platform.yield();
            await this.read(() => {
              const rows = this.db.table<R>("messages");
              const end = Math.min(keys.length, i + 20_000);
              for (let k = i; k < end; k++) {
                const m = rows.get(keys[k]!);
                if (m && isLearnable(m)) out.push(keys[k]!);
              }
            });
          }
          await this.o.platform.yield();
          sentIds = Int32Array.from(out).sort();
        }
        const all = sentIds;
        let lo = 0;
        let hi = all.length;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (all[mid]! <= afterId) lo = mid + 1;
          else hi = mid;
        }
        const ids = Array.from(all.subarray(lo, lo + limit));
        // the cursor is the last id looked at: a page whose bodies are all empty isn't the end
        return { texts: await this.autocomplete.sentTexts(ids), next: ids.length ? ids[ids.length - 1]! : null };
      },
      sentTexts: async (ids) => {
        const out: SentText[] = [];
        // 8 bodies per exclusive unit: commands interleave between units, and what stays is cut to 64 KB each
        for (let i = 0; i < ids.length; i += 8) {
          const chunk = ids.slice(i, i + 8);
          out.push(
            ...(await this.exclusive(async () => {
              const rows = this.db.table<R>("messages");
              const learnable = chunk.filter((id) => {
                const m = rows.get(id);
                return m !== undefined && isLearnable(m);
              });
              await this.readBodies(learnable);
              const texts: SentText[] = [];
              for (const id of learnable) {
                const stored = this.c.body(id);
                const body = stored?.capture_id ? await bodyPrefix(this.bodyPartSource(stored.capture_id, 0), SENT_TEXT_MAX) : stored?.body_text;
                if (body) texts.push(sentOf(rows.get(id)!, body));
              }
              return texts;
            })),
          );
        }
        return out;
      },
    };
  }

  // ───────────────────────────── search ─────────────────────────────

  private revision(): Revision {
    return searchHead(this.c);
  }

  readonly feed: SearchFeed = {
    head: async () => this.early(() => this.revision()),
    changes: async (after, through, maxCommits) => {
      const ids = await this.read(() => searchChangeIds(this.c, after, through, maxCommits));
      const batches: IndexBatch[] = [];
      let pending: IndexChange[] = [];
      try {
      for (const b of ids) {
        const changes: IndexChange[] = pending = [];
        for (let m = 0, t = 0; m < Math.max(1, b.messageIds.length) || t < b.threadIds.length; m += SLICE, t += SLICE) {
          const mIds = b.messageIds.slice(m, m + SLICE);
          const tIds = b.threadIds.slice(t, t + SLICE);
          if (!mIds.length && !tIds.length) break;
          // each slice is the newest committed state when read, never older than its batch (replay converges)
          changes.push(
            ...(await this.exclusive(async () => {
              await this.readBodies(mIds);
              return materializeChanges(this.c, mIds, tIds);
            })),
          );
        }
        batches.push({ from: b.from, to: b.to, changes });
        pending = [];
      }
      return batches;
      } catch (error) {
        await releaseIndexBodies(batches, this.o.platform.yield);
        await releaseBodyChanges(pending, this.o.platform.yield);
        throw error;
      }
    },
    beginBuild: async () => {
      const { from, lease, messageIds, threadIds } = await this.exclusive(async () => {
        const from = this.revision();
        const row: R = { id: undefined, from_seq: from.seq, created_at: Date.now() };
        this.db.tx(() => this.db.table("search_leases").insert(row));
        this.db.takeCommit();
        this.db.confirm();
        const sorted = (t: string) => Int32Array.from(this.db.table(t).rows.keys() as Iterable<number>).sort();
        return { from, lease: row.id as number, messageIds: [...sorted("messages")], threadIds: [...sorted("threads")] };
      });
      // the ids as of the lease, in order, once: rows written later come through the replay of (from, head]
      const page = async <D,>(table: string, ids: number[], at: number, read: (id: number) => D | null, before?: (ids: number[]) => Promise<void>) =>
        this.exclusive(async () => {
          const slice = ids.slice(at, at + SLICE);
          await before?.(slice);
          const docs: D[] = [];
          for (const id of slice) {
            const d = this.db.table<R>(table).has(id) ? read(id) : null;
            if (d) docs.push(d);
          }
          return { docs, next: at + slice.length };
        });
      const messagesAt = (at: number) =>
        page<SearchMessageDoc>("messages", messageIds, at, (id) => this.searchMessageDoc(id), (slice) => this.readBodies(slice));
      const threadsAt = (at: number) => page<SearchThreadDoc>("threads", threadIds, at, (id) => threadDoc(this.c, this.db.table<R>("threads").get(id)!));
      const held = new Set<readonly SearchMessageDoc[]>();
      const release = async () => {
        for (const page of held) await releaseMessageBodies(page, this.o.platform.yield);
        held.clear();
        if (!this.open) return;
        await this.exclusive(async () => {
          this.db.tx(() => this.db.table("search_leases").delete(lease));
          this.db.takeCommit();
          this.db.confirm();
        });
      };
      const build: SearchBuild = {
        from,
        async *messages() {
          for (let at = 0; at < messageIds.length; ) {
            const p = await messagesAt(at);
            at = p.next;
            if (p.docs.length) {
              held.add(p.docs);
              try { yield p.docs; } finally { if (messageBodiesReleased(p.docs)) held.delete(p.docs); }
            }
          }
        },
        async *threads() {
          for (let at = 0; at < threadIds.length; ) {
            const p = await threadsAt(at);
            at = p.next;
            if (p.docs.length) yield p.docs;
          }
        },
        release,
      };
      return build;
    },
  };

  /**
   * The exact scan, as one exclusive unit so no write lands between the
   * revision it answers at and its result. Bodies are read in slices only
   * when a term needs them.
   */
  private async scan<X>(req: SearchRequest, finish: (ids: number[], revision: Revision) => X, extra?: (t: R) => boolean, limit = req.limit + 1, signal?: { readonly aborted: boolean }): Promise<X> {
    for (let attempt = 0; ; attempt++) {
      // writes kept landing under two passes: the third holds the queue (still yielding to the event loop between slices)
      const out = await this.scanPass(req, finish, extra, limit, attempt >= 2, signal);
      if (out.done) return out.value;
    }
  }

  /**
   * One pass of the exact scan in time slices. Each slice is its own unit
   * (commands run between them) and checks that the revision it started at
   * still holds; the result is read in a final unit at that revision, or the
   * pass reports it must start over.
   */
  private async scanPass<X>(req: SearchRequest, finish: (ids: number[], revision: Revision) => X, extra: ((t: R) => boolean) | undefined, limit: number, hold: boolean, signal?: { readonly aborted: boolean }): Promise<{ done: true; value: X } | { done: false }> {
    const pass = async (unit: <V>(f: () => Promise<V>) => Promise<V>): Promise<{ done: true; value: X } | { done: false }> => {
      const messages = this.db.table<R>("messages");
      const start = await unit(async () => {
        const revision = this.revision();
        checkCursor(req, revision);
        return { revision, plan: planScan(this.c, req.search), ids: [...messages.rows.keys()] as number[] };
      });
      const { plan, ids, revision } = start;
      const matched = plan.messageLevel ? new Set<number>() : null;
      const excluded = new Set<number>();
      for (let i = 0; i < ids.length && !plan.impossible; ) {
        if (signal?.aborted) throw new SearchCancelledError();
        const current = await unit(async () => {
          if (!sameRevision(this.revision(), revision)) return false;
          const sliceStarted = performance.now();
          while (i < ids.length && performance.now() - sliceStarted < SCAN_SLICE_MS) {
            const chunk = ids.slice(i, i + SCAN_CHUNK);
            if (plan.needsBodies) await this.readBodies(chunk);
            const prepared = plan.needsBodies ? await this.prepareBodyTests(req.search.query.terms.filter((t) => t.field === "text").map((t) => ({ op: "contains" as const, value: t.value, prefix: t.prefix })), chunk) : new Map();
            for (const id of chunk) {
              const m = messages.get(id);
              if (!m) continue;
              let cols: ReturnType<typeof columnsOf> | null = null;
              const columns = () => {
                if (cols) return cols;
                const body = plan.needsBodies ? this.c.body(id) : null;
                cols = columnsOf(m, body?.body_text ?? null);
                if (body?.capture_id) cols.bodyTest = (value, prefix) => this.preparedBodyTest(prepared, body.capture_id!, "contains", value, prefix);
                return cols;
              };
              if (matched) {
                if (!matched.has(m.thread_id) && plan.messageOk(m, columns)) matched.add(m.thread_id);
              } else if (!excluded.has(m.thread_id) && plan.excludes(m, columns)) excluded.add(m.thread_id);
            }
            i += chunk.length;
          }
          return true;
        });
        if (!current) return { done: false };
        if (hold) this.evictBodies();
        await this.o.platform.yield();
      }
      return unit(async () => {
        if (!sameRevision(this.revision(), revision)) return { done: false } as const;
        return { done: true, value: finish(plan.impossible ? [] : scanPage(this.c, plan, matched, excluded, req.cursor, limit, extra), revision) } as const;
      });
    };
    return hold ? this.exclusive(() => pass((f) => f())) : pass((f) => this.exclusive(f));
  }

  private async searchPage(req: SearchRequest, signal?: { readonly aborted: boolean }): Promise<StoreSearchPage> {
    // the index answers from early tables (threads, memberships); a scan or the pending-body count waits for messages
    const initial = await this.early(() => {
      const revision = this.revision();
      const ram = this.instant?.at(revision);
      if (!ram) return { revision, page: null };
      const ids = ram.search(req, revision);
      return { revision, page: { items: summariesInOrder(this.c, ids.threadIds), nextCursor: ids.nextCursor, strategy: ids.strategy } };
    });
    let revision = initial.revision;
    let page: { items: ThreadSummary[]; nextCursor: SearchCursor | null; strategy: string };
    if (initial.page) {
      page = initial.page;
    } else {
      const threads = T(this.c, "threads");
      // the page is read in the scan's last unit, at the revision the scan answered for
      const scanned = await this.scan(req, (ids, at) => {
        const p = pageOf(ids, req, at, (id) => threads.get(id)!);
        return { at, items: summariesInOrder(this.c, p.threadIds), nextCursor: p.nextCursor };
      }, undefined, req.limit + 1, signal);
      revision = scanned.at;
      page = { items: scanned.items, nextCursor: scanned.nextCursor, strategy: "scan" };
    }
    const pendingBodies = await this.read(() => {
      const messages = T(this.c, "messages");
      return Math.min(PENDING_BODIES_CAP, messages.count("body_state", "none") + messages.count("body_state", "partial"));
    });
    return { items: page.items, nextCursor: page.nextCursor, revision, strategy: page.strategy, complete: true, pendingBodies };
  }

  private resolve(p: { query: string; accountId?: number; categoryId?: number; threadAttachments?: boolean; threadFilter?: ThreadFilter; now?: number }) {
    const lookup = {
      accounts: [...T(this.c, "accounts").all()].map((a) => ({ id: a.id as number, email: a.email as string, display_name: a.display_name as string })),
      categories: [...T(this.c, "categories").all()].map((x) => ({ id: x.id as number, name: x.name as string })),
    };
    return resolveSearch(parseSearch(p.query, p.now), p.query, p, lookup);
  }

  // ───────────────────────────── threads ─────────────────────────────

  readonly threads: MailStore["threads"] = {
    list: (p) => this.early(() => listThreads(this.c, p)),
    scopeIds: (p) => this.early(() => scopeThreadIds(this.c, p)),
    scopeCount: (p) => this.early(() => scopeThreadIds(this.c, p).length),
    summaries: (ids) => this.early(() => summariesInOrder(this.c, ids)),
    get: async (id, options) => this.bodyCommand(async () => {
      await this.settled();
      // exclusive: no command can add a message (or evict a body) between reading the bodies and the thread
      return this.exclusive(async () => {
        await this.readBodies(T(this.c, "messages").by("fk_thread_id", id).map((m) => m.id as number));
        const thread = getThread(this.c, id);
        if (!thread) return null;
        for (const message of thread.messages) {
          const body = this.c.body(message.id);
          if (body?.capture_id) {
            const capture = T(this.c, "body_captures").get(body.capture_id)!;
            if (options?.bodyFormat === "parts") { message.bodyReference = { version: body.capture_id, textParts: capture.text_parts, htmlParts: capture.html_parts }; continue; }
            message.bodyText = capture.text_parts === null ? null : await assembleBody(this.bodyPartSource(body.capture_id, 0));
            message.bodyHtml = capture.html_parts === null ? null : await assembleBody(this.bodyPartSource(body.capture_id, 1));
          }
        }
        return { ...thread, categorization: { auto: autoReasons(this.c, id), suggestions: pendingSuggestions(this.c, { threadId: id, limit: 5 }) } };
      });
    }),
    unsubscribeSource: async (id) => this.bodyCommand(async () => {
      await this.settled();
      return this.exclusive(async () => {
        const pick = unsubscribeCandidate(this.c, id);
        if (!pick) return null;
        // only without the header: that one message's body, never the thread's
        if (!pick.unsubscribe) await this.readBodies([pick.row.id]);
        const body = pick.unsubscribe ? undefined : T(this.c, "message_bodies").get(pick.row.id);
        return {
          messageId: pick.row.id,
          accountId: pick.row.account_id,
          fromName: pick.row.from_name,
          fromEmail: pick.row.from_email,
          unsubscribe: pick.unsubscribe,
          bodyHtml: body?.capture_id ? (T(this.c, "body_captures").get(body.capture_id)!.html_parts === null ? null : await unsubscribeBodyParts(this.bodyPartSource(String(body.capture_id), 1), true)) : (body?.body_html as string | null | undefined) ?? null,
          bodyText: body?.capture_id ? (T(this.c, "body_captures").get(body.capture_id)!.text_parts === null ? null : await unsubscribeBodyParts(this.bodyPartSource(String(body.capture_id), 0), false)) : (body?.body_text as string | null | undefined) ?? null,
        };
      });
    }),
    bodyPart: async (input) => this.exclusive(async () => {
      const message = T(this.c, "messages").get(input.messageId);
      if (!message || message.account_id !== input.accountId) throw new RpcError("STALE", L("errors.originalGone"));
      await this.readBodies([input.messageId]);
      if (this.c.body(input.messageId)?.capture_id !== input.version) throw new RpcError("STALE", L("errors.originalGone"));
      const source = this.bodyPartSource(input.version, input.field === "text" ? 0 : 1);
      try {
        const part = await source.read(input.ordinal - 1);
        if (!part) throw new RpcError("STALE", L("errors.originalGone"));
        return decodeBodyPart(part.value);
      } finally { source.close?.(); }
    }),
    counts: (now) => this.early(() => getCounts(this.c, now)),
    search: (req) => this.searchPage(req),
    searchText: async (p) => {
      // resolving account:/category: reads early tables only
      const { search, cursor } = await this.early(() => {
        const search = this.resolve(p);
        const cursor = p.cursor ? { lastDate: p.cursor.lastDate, id: p.cursor.id, queryKey: p.cursor.queryKey ?? search.key, revision: p.cursor.revision ?? this.revision() } : undefined;
        return { search, cursor };
      });
      return this.searchPage({ search, cursor, limit: p.limit }, p.signal);
    },
    act: ({ threadIds, action, signal, now }) =>
      this.command(() => {
        const flagBefore = flagEpochs(idbFlags(this.c));
        const ids = [...new Set(threadIds)];
        const r = applyThreadAction(this.c, ids, action);
        if (signal && r.threadIds.length) recordUserActions(this.c, r.threadIds, signal, now);
        const opIds = this.queueActionOps(r, action, now);
        if (action !== "moveToInbox") return { threadIds: r.threadIds, opIds, before: r.before, ...flagReconciliation(idbFlags(this.c), flagBefore) };
        // plan 86: into the Inbox means out of Gmail's tabs too, in the same command and the same undo
        const u = untabThreads(this.c, ids);
        return { threadIds: [...new Set([...r.threadIds, ...u.threadIds])], opIds: [...opIds, ...this.queueActionOps(u, "toPrimary", now)], before: mergeBefore(r.before, u.before), ...flagReconciliation(idbFlags(this.c), flagBefore) };
      }),
    restore: ({ messages, now }) =>
      this.command(() => {
        const flagBefore = flagEpochs(idbFlags(this.c));
        const r = restoreMessages(this.c, messages);
        const opIds: string[] = [];
        const versions = new Map<number, number>();
        reaffirmSavedFlagIntent(idbFlags(this.c), messages, versions);
        for (const op of r.ops) {
          if (!versions.has(op.accountId) && idbFlags(this.c).clock(op.accountId)) versions.set(op.accountId, flagTick(idbFlags(this.c), op.accountId));
          const id = enqueueOp(this.c, { accountId: op.accountId, kind: op.kind, target: { messageIds: op.messageIds } }, now, versions.get(op.accountId));
          if (id) opIds.push(id);
        }
        return { threadIds: r.threadIds, opIds, ...flagReconciliation(idbFlags(this.c), flagBefore) };
      }),
  };

  private queueActionOps(result: ActionResult, action: ThreadAction, now: number): string[] {
    const ids: string[] = [];
    for (const target of result.targets) {
      const id = enqueueOp(this.c, { accountId: target.accountId, kind: action, target: { messageIds: target.messageIds } }, now);
      if (id) ids.push(id);
    }
    return ids;
  }

  private applyFiltersTo(messageIds: readonly number[], onlyBodyFilters: boolean, now: number, opIds: string[]): Set<number> {
    const touched = new Set<number>();
    if (messageIds.length === 0) return touched;
    for (const filter of listFilters(this.c)) {
      if (!filter.enabled) continue;
      if (onlyBodyFilters && !ruleReadsBody(filter.rule)) continue;
      const matches = findRuleMatches(this.c, filter.rule, now, messageIds);
      if (matches.messageIds.length === 0) continue;
      try {
        const changed = this.db.tx(() => this.runFilterActions(filter.rule.actions, claimFilterApplications(this.c, filter.id, matches.messageIds, now), now, opIds));
        for (const id of changed) touched.add(id);
      } catch (error) {
        this.log("warn", `filter ${filter.id} (${filter.name}) failed`, error instanceof Error ? error.message : error);
      }
    }
    return touched;
  }

  private runFilterActions(actions: FilterAction[], messageIds: number[], now: number, opIds: string[]): Set<number> {
    const touched = new Set<number>();
    if (messageIds.length === 0) return touched;
    const messages = T(this.c, "messages");
    for (const action of actions) {
      // plan 116: a forward is decided after the commit, from what the mail is then (forwards.plan)
      if (action.type === "forward") continue;
      if (action.type === "addCategory") {
        if (!T(this.c, "categories").has(action.categoryId)) throw new Error(`category ${action.categoryId} doesn't exist`);
        const threads = [...new Set(messageIds.map((id) => messages.get(id)?.thread_id as number).filter((t) => t !== undefined))];
        addToCategory(this.c, { categoryId: action.categoryId, threadIds: threads, addedBy: "filter", now });
        for (const t of threads) touched.add(t);
      } else {
        const result = applyMessageAction(this.c, messageIds, action.type);
        opIds.push(...this.queueActionOps(result, action.type, now));
        for (const t of result.threadIds) touched.add(t);
      }
    }
    return touched;
  }

  private classify(classifier: ClassifierInput | null, inserted: readonly number[], bodyCompleted: readonly number[], now: number): ClassifyResult {
    if (!classifier) return NO_CLASSIFICATION;
    return classifyNewThreads(this.c, { inserted, bodyCompleted, now, mode: classifier.mode, model: classifier.model });
  }

  // ───────────────────────────── sync ─────────────────────────────

  readonly sync: MailStore["sync"] = {
    beginObservation: async (accountId, options) => {
      const repo = idbFlags(this.c);
      const check = () => { if (options.signal?.aborted) throw options.signal.reason ?? new Error("Flag observation cancelled."); };
      check();
      const clock = await this.command(() => startFlagObservation(repo, accountId, options.authoritativeFlags));
      if (!clock) return null;
      for (;;) {
        check();
        const current = await this.read(() => repo.clock(accountId));
        if (!current) throw new Error("Account no longer exists.");
        if (current.phase) break;
        await this.command(() => { try { check(); return initializeFlagStep(repo, accountId); } finally { repo.preparation = null; } }, { prefetch: async () => {
          const current = repo.clock(accountId);
          if (!current) throw new Error("Account no longer exists.");
          if (!current.phase) repo.preparation = await prepareIdbFlagPage(this.idb, repo, current);
        } });
        await this.o.platform.yield();
      }
      check();
      return this.command(() => {
        check();
        const current = repo.clock(accountId);
        if (!current) throw new Error("Account no longer exists.");
        return { accountId, protocolId: current.protocol_id, epoch: flagTick(repo, accountId) };
      });
    },
    ingest: async (batch, { applyFilters, now, classifier, observation, check, forwardEligible }) => this.bodyCommand(async () => {
      const callerCheck = check; check = () => { if (this.bodyClosing) throw new Error("The store is closing"); callerCheck?.(); };
      await this.bodyCleanup;
      const staged: IncomingMessage[] = [];
      try {
      for (const m of batch) {
        const existing = !m.captureUnavailable && m.attachments?.length ? await this.read(() => findIngestMessage(this.c, m)) : undefined;
        staged.push(await this.stageBody(m.captureUnavailable || m.attachments === undefined ? m : { ...m, attachments: await stageAttachments(this, m.accountId, m.attachments, now, this.o.platform.yield, existing ? await this.attachments.current(m.accountId, { id: existing.id }) : []) }, check));
      }
      const cache: BodyTestResults = new Map();
      return await publishBody(async () => {
      const { tests, ticket } = await this.read(() => ({ tests: applyFilters ? this.ruleTests(listFilters(this.c).filter((f) => f.enabled).map((f) => f.rule)) : [], ticket: this.bodyProtocol.ticket(check) }));
      const prepared = await this.prepareBodyTests(tests, undefined, staged.flatMap((m) => m.bodyCapture ? [m.bodyCapture.id] : []), cache, ticket);
      return await this.command(
        () => this.withBodyTests(prepared, () => {
          check?.();
          const flagBefore = flagEpochs(idbFlags(this.c));
          for (const m of staged) completeCapture(idbCaptureStorage(this.c), m.accountId, m.repair);
          const result = ingestMessages(this.c, staged as IncomingMessage[], now, observation);
          // plan 116: live mail that may be forwarded, marked with its insertion (never later, by an upsert)
          if (forwardEligible) markEligible(this.c, result.inserted, now);
          const touched = new Set(result.touchedThreads);
          const opIds: string[] = [];
          if (applyFilters) {
            for (const t of this.applyFiltersTo(result.inserted, false, now, opIds)) touched.add(t);
            for (const t of this.applyFiltersTo(result.bodyCompleted, true, now, opIds)) touched.add(t);
          }
          const c = this.classify(classifier, result.inserted, result.bodyCompleted, now);
          for (const t of c.touched) touched.add(t);
          return { inserted: result.inserted, touched: [...touched], deltas: [...result.deltas, ...c.deltas], auto: c.auto, backfill: c.backfill, uncertain: c.uncertain, opIds, ...flagReconciliation(idbFlags(this.c), flagBefore) };
        }),
        { durability: "relaxed", check, bodyTicket: this.preparedTickets.get(prepared) },
      );
      }, check); } finally { for (const m of staged) if (m.bodyCapture && this.isOpen && !this.unusable) await this.finishBodyStage(m.bodyCapture.id); }
    }),
    setBody: async (messageId, text, html, { now, classifier, attachments, bodyParts, preparedBodyTokens, captureUnavailable, repair, check, expected }) => this.bodyCommand(async () => {
      const callerCheck = check; check = () => { if (this.bodyClosing) throw new Error("The store is closing"); callerCheck?.(); };
      await this.bodyCleanup;
      const accountId = await this.read(() => T(this.c, "messages").get(messageId)?.account_id as number | undefined);
      const staged = !captureUnavailable && attachments !== undefined && accountId !== undefined ? await stageAttachments(this, accountId, attachments, now, this.o.platform.yield, await this.attachments.current(accountId, { id: messageId })) : undefined;
      const body = !captureUnavailable && accountId !== undefined ? await this.stageBody({ accountId, bodyText: text, bodyHtml: html, bodyParts, snippet: "", preparedBodyTokens }, check) : { bodyText: text, bodyHtml: html, bodyCapture: undefined };
      const cache: BodyTestResults = new Map();
      try {
      return await publishBody(async () => {
      const { tests, ticket } = await this.read(() => ({ tests: this.ruleTests(listFilters(this.c).filter((f) => f.enabled).map((f) => f.rule)), ticket: this.bodyProtocol.ticket(check) }));
      const prepared = await this.prepareBodyTests(tests, undefined, body.bodyCapture ? [body.bodyCapture.id] : [], cache, ticket); return await this.command(
        () => this.withBodyTests(prepared, () => {
          check?.();
          const flagBefore = flagEpochs(idbFlags(this.c));
          const current = expected ? T(this.c, "messages").get(messageId) : undefined;
          if (expected && (!current || current.body_state === "full" || current.account_id !== expected.accountId || current.thread_id !== expected.threadId || current.provider_msg_id !== expected.providerMsgId)) return { touched: [], deltas: [], auto: new Map(), opIds: [] };
          if (accountId !== undefined) completeCapture(idbCaptureStorage(this.c), accountId, repair);
          if (T(this.c, "imap_identity_holds").has(messageId)) return { touched: [], deltas: [], auto: new Map(), opIds: [] };
          if (!captureUnavailable) setMessageBody(this.c, messageId, body.bodyText, body.bodyHtml, "full", body.bodyCapture);
          if (staged !== undefined && !captureUnavailable) replaceAttachments(this.db, messageId, staged);
          const owner = T(this.c, "messages").get(messageId);
          if (captureUnavailable && owner) T(this.c, "messages").update(owner, { attachments_captured: 2, attachment_pending: 0 });
          if (owner) recomputeThreads(this.c, [owner.thread_id]);
          if (captureUnavailable) return { touched: owner ? [owner.thread_id] : [], deltas: [], auto: new Map(), opIds: [] };
          const opIds: string[] = [];
          const touched = this.applyFiltersTo([messageId], true, now, opIds);
          const c = this.classify(classifier, [], [messageId], now);
          for (const t of c.touched) touched.add(t);
          if (owner) touched.add(owner.thread_id);
          return { touched: [...touched], deltas: c.deltas, auto: c.auto, opIds, ...flagReconciliation(idbFlags(this.c), flagBefore) };
        }),
        { durability: "relaxed", check, bodyTicket: this.preparedTickets.get(prepared) },
      );
      }, check); } finally { if (body.bodyCapture && this.isOpen && !this.unusable) await this.finishBodyStage(body.bodyCapture.id); }
    }),
    updateFlags: (accountId, updates, observation, check) =>
      this.command(
        () => {
          check?.();
          const messages = T(this.c, "messages");
          const threads = new Set<number>();
          const reconciliation: { flagReconcileAccounts?: number[] } = {};
          for (const u of updates) {
            if (T(this.c, "imap_identity_holds").has(u.messageId)) continue;
            const identity = messages.get(u.messageId);
            if (observation && (!flagObservationValid(idbFlags(this.c), accountId, observation) || !u.expectedProviderMsgId)) continue;
            if (identity?.account_id !== accountId || (u.expectedProviderMsgId !== undefined && identity.provider_msg_id !== u.expectedProviderMsgId)) continue;
            if (u.expectedImapLocations && !sameImapLocations(u.expectedImapLocations, T(this.c, "message_locations").by("fk_message_id", u.messageId).map((row) => ({ mailbox: row.mailbox as string, uidvalidity: row.uidvalidity as number, uid: row.uid as number })))) continue;
            const pending = pendingFlagFields(this.c, accountId, u.messageId);
            const sets: [string, number | string][] = Object.entries(u.flags)
              .filter(([k, v]) => FLAG_COLUMNS[k] && !pending.has(k as LocalFlagField) && acceptFlagObservation(idbFlags(this.c), u.messageId, k as LocalFlagField, observation, Boolean(v), () => { reconciliation.flagReconcileAccounts ??= [accountId]; }))
              .map(([k, v]) => [FLAG_COLUMNS[k]!, v ? 1 : 0]);
            // plan 17 (Codex review 1, #8): Gmail's category moves change who a message is from
            if (u.gmailLabels) {
              sets.push(["gmail_labels", JSON.stringify(u.gmailLabels)]);
              // plan 86: the category, unless a move of the user's owns it until Gmail confirms it
              const category = categoryOf(u.gmailLabels)!;
              if (!pending.has("category") && acceptFlagObservation(idbFlags(this.c), u.messageId, "category", observation, category, () => { reconciliation.flagReconcileAccounts ??= [accountId]; })) sets.push(["category", category]);
            }
            if (!sets.length) continue;
            const m = messages.get(u.messageId);
            if (!m || m.account_id !== accountId) continue;
            const after = messages.update(m, Object.fromEntries(sets));
            threads.add(m.thread_id);
            // plan 17 (Codex R4): a message becoming sent, or a draft, is your mail appearing or going
            if (after.is_sent !== m.is_sent || after.is_draft !== m.is_draft) for (const t of ownMailChanged(this.db, m.id)) threads.add(t);
          }
          recomputeThreads(this.c, threads);
          return { touched: [...threads], ...reconciliation };
        },
        { durability: "relaxed" },
      ),
    remove: (ids, check) => this.command(() => { check?.(); return { touched: [...deleteMessages(this.c, ids)] }; }, { durability: "relaxed" }),
    pendingMessageIds: (accountId) => this.read(() => messagesWithPendingOps(this.c, accountId)),
    arrivals: (ids) => this.read(() => arrivalRows(this.db, ids)),
  };

  // ───────────────────────────── ops ─────────────────────────────

  private async preparedFlagOutcome<T>(id: string, run: () => T): Promise<T> {
    for (;;) {
      const result = await this.command(() => {
        const op = getOp(this.c, id);
        const clock = op && op.kind !== "send" ? idbFlags(this.c).clock(op.account_id) : null;
        if (clock && !clock.phase) return { kind: "prepare", accountId: op!.account_id } as const;
        return { kind: "value", value: run() } as const;
      });
      if (result.kind === "value") return result.value;
      await this.sync.beginObservation(result.accountId, { authoritativeFlags: true });
    }
  }

  private async recoverFlagOperations(now: number) {
    let loaded = false;
    for (;;) {
      const result = await this.command(() => {
        const clocks = idbFlags(this.c).clocks();
        if (!loaded && clocks.length) return { kind: "load" } as const;
        const initializing = clocks.find((clock) => !clock.phase);
        if (initializing) return { kind: "prepare", accountId: initializing.account_id } as const;
        return { kind: "value", value: recoverOps(this.c, now) } as const;
      }, { early: !loaded });
      if (result.kind === "value") return result.value;
      if (result.kind === "load") { await this.loaded; loaded = true; }
      else await this.sync.beginObservation(result.accountId, { authoritativeFlags: true });
    }
  }

  readonly ops: MailStore["ops"] = {
    claimReady: async (now, limit, admission) => {
      const snapshot = admission && copyOpAdmission(admission);
      return this.command(() => claimReadyOps(this.c, now, limit, snapshot), { early: true });
    },
    get: (id) => this.early(() => this.copyOp(getOp(this.c, id))),
    sendSubmission: (id) => this.early(() => {
      const op = getOp(this.c, id);
      return op?.kind === "send" ? { state: op.state, accepted: submissionAccepted(op) } : null;
    }),
    complete: (id, result, now) =>
      this.preparedFlagOutcome(id, () => {
        const op = getOp(this.c, id);
        if (op?.kind === "send" && op.state !== "running") return { touched: [], deltas: [] };
        completeOp(this.c, id, now);
        const touched: number[] = [];
        const deltas: ModelDelta[] = [];
        if (!op) return { touched, deltas };
        if (op.kind === "send") idbAssets(this.db).unlink("op", id);
        if (op.kind === "send" && result?.sendAccepted) { idbSendCopies(this.db).markSubmissionAccepted(id); publishRecipientReceipt(idbRecipientReceipts(this.db), id, result.sendAccepted.outcomes, result.sendAccepted.warning); }
        const receipt = idbSendCopies(this.db).get(id);
        if (op.kind === "send" && result?.sendAccepted && receipt?.submission === "pending" && (receipt.copyRequested || receipt.ready)) acceptCopySubmission(idbSendCopies(this.db), id, result.sendAccepted.warning);
        const ops = T(this.c, "ops");
        if (result?.warning) ops.update(ops.get(id)!, { last_error: result.warning });
        let refreshNeeded = false;
        const localId = (JSON.parse(op.target_json) as { messageIds?: number[] }).messageIds?.[0];
        if (op.kind === "send" && result && localId) {
          const messages = T(this.c, "messages");
          const local = messages.get(localId);
          if (result.providerMsgId && local && String(local.provider_msg_id ?? "").startsWith("local:")) {
            messages.update(local, { provider_msg_id: result.providerMsgId });
            bindIdbPromotedFlags(this.c, localId);
            refreshNeeded = requireIdbGmailRefresh(this.c, [localId]);
          }
          if (result.providerThreadId) {
            const row = messages.get(localId);
            if (row) touched.push(adoptProviderThread(this.c, row.thread_id, op.account_id, result.providerThreadId, undefined, deltas));
          }
        }
        return { touched, deltas, ...(refreshNeeded && { flagReconcileAccounts: [op.account_id] }) };
      }),
    fail: (id, error, retryable, now, park) =>
      this.preparedFlagOutcome(id, () => {
        const current = getOp(this.c, id);
        if (current && current.state !== "running") return current.state;
        const state = failOp(this.c, id, error, retryable, now, park);
        // plan 17 (Codex R8): a send that failed answered nobody; its thread and what it replied to count again
        const op = state === "failed" ? T(this.c, "ops").get(id) : undefined;
        const localId = op?.kind === "send" ? (JSON.parse(op.target_json) as { messageIds?: number[] }).messageIds?.[0] : undefined;
        if (localId !== undefined) {
          const m = T(this.c, "messages").get(localId);
          recomputeThreads(this.c, new Set([...(m ? [m.thread_id as number] : []), ...answeredThreads(this.db, referencesOfOwn(this.db, [localId]))]));
        }
        return state;
      }),
    markUnknown: (id, error, now, sendAccepted) => this.preparedFlagOutcome(id, () => {
      const op = getOp(this.c, id);
      if (op?.kind === "send" && op.state === "running" && sendAccepted) { idbSendCopies(this.db).markSubmissionAccepted(id); publishRecipientReceipt(idbRecipientReceipts(this.db), id, sendAccepted.outcomes, sendAccepted.warning); }
      const receipt = idbSendCopies(this.db).get(id);
      if (op?.state === "running" && sendAccepted && receipt?.submission === "pending" && (receipt.copyRequested || receipt.ready)) acceptCopySubmission(idbSendCopies(this.db), id, sendAccepted.warning);
      markOpUnknown(this.c, id, error, now);
    }),
    awaitAuth: (id, error, now) => this.command(() => awaitAuthOp(this.c, id, error, now), { early: true }),
    release: (id, now) => this.command(() => releaseOp(this.c, id, now), { early: true }),
    resumeAuth: (accountId, now) => this.command(() => resumeAuthOps(this.c, accountId, now), { early: true }),
    resumeNetwork: (accountId, now) => this.command(() => resumeNetworkOps(this.c, accountId, now), { early: true }),
    recover: (now) => this.recoverFlagOperations(now),
    nextAttemptAt: async (admission) => {
      const snapshot = admission && copyOpAdmission(admission);
      return this.read(() => nextOpAttemptAt(this.c, snapshot));
    },
    defer: (id, now, o) => {
      const refund = o.refundClaim;
      return this.command(() => deferOp(this.c, id, now, refund), { early: true });
    },
    recent: (limit) => this.early(() => listRecentOps(this.c, limit).map((op) => this.copyOp(op)!)),
    resolveUnknown: (id, resolution, now) =>
      this.preparedFlagOutcome(id, () => {
        const flagBefore = flagEpochs(idbFlags(this.c));
        const op = getOp(this.c, id);
        if (!op || op.state !== "unknown") throw new RpcError("NOT_FOUND", L("errors.opResolved"));
        const ops = T(this.c, "ops");
        if (resolution === "markSent") {
          if (op.kind !== "send" && idbFlags(this.c).clock(op.account_id)) throw new RpcError("STALE", L("errors.opResolved"));
          completeOp(this.c, id, now);
          if (op.kind === "send") idbAssets(this.db).unlink("op", id);
          const receipt = idbSendCopies(this.db).get(id);
          if (receipt?.submission === "accepted") idbSendCopies(this.db).markSubmissionAccepted(id);
          if (receipt?.submission === "accepted") T(this.c, "ops").update(T(this.c, "ops").get(id)!, { last_error: copyWarningText(receipt) });
          return { touched: [] };
        }
        if (resolution === "retry") {
          if (submissionAccepted(op) || (op.kind === "send" && typeof (JSON.parse(op.target_json) as { recoveryParentId?: unknown }).recoveryParentId === "string") || idbSendCopies(this.db).get(id)?.submission === "accepted") throw new RpcError("BAD_REQUEST", L("errors.send.alreadyAccepted"));
          if (op.kind !== "send" && idbFlags(this.c).clock(op.account_id)) {
            const ids = rearmFlagEffects(idbFlags(this.c), op);
            if (ids === null) throw new RpcError("STALE", L("errors.opResolved"));
            if (ids.length) {
              ops.update(ops.get(id)!, { target_json: JSON.stringify({ ...JSON.parse(op.target_json), messageIds: ids }) });
              const remaining = new Set(ids), targets = T(this.c, "op_targets");
              for (const target of targets.by("fk_op_id", id)) if (!remaining.has(target.message_id as number)) targets.deleteRow(target);
            }
          }
          ops.update(ops.get(id)!, { state: "queued", next_attempt_at: 0, last_error: null });
          const touched = [...new Set(T(this.c, "op_targets").by("fk_op_id", id).map((target) => T(this.c, "messages").get(target.message_id)?.thread_id as number).filter(Boolean))];
          recomputeThreads(this.c, touched);
          return { touched, ...flagReconciliation(idbFlags(this.c), flagBefore) };
        }
        settleFlagEffects(idbFlags(this.c), op, "removed");
        ops.update(ops.get(id)!, { state: "failed", last_error: "Discarded by user" });
        const target = JSON.parse(op.target_json) as { messageIds?: number[] };
        if (op.kind === "send" && target.messageIds?.length) {
          const local = T(this.c, "messages").get(target.messageIds[0]!);
          if (local && String(local.provider_msg_id ?? "").startsWith("local:")) return { touched: [...deleteMessages(this.c, [local.id])] };
        }
        return { touched: [], ...flagReconciliation(idbFlags(this.c), flagBefore) };
      }),
  };

  // ───────────────────────────── compose ─────────────────────────────

  get captureRepairs(): MailStore["captureRepairs"] { return idbCaptureRepairs(this.c, (fn, options) => this.command(fn, options), (fn) => this.read(fn), (a,after,state) => this.exclusive(() => idbCapturePage(this.idb,a,after,state))); }

  readonly attachments: MailStore["attachments"] = {
    current: (accountId, message) => this.read(() => {
      const m = "id" in message ? T(this.c, "messages").get(message.id) : T(this.c, "messages").by("provider", accountId, message.providerMsgId)[0];
      if (!m || m.account_id !== accountId) return [];
      return T(this.c, "attachments").by("fk_message_id", m.id).sort((a,b) => a.id - b.id).map((a) => ({ filename: a.filename as string, mime: a.mime as string, size: a.size as number, assetId: a.asset_id as string | undefined, contentId: a.content_id as string | null }));
    }),
    retry: (accountId, messageId, check) => this.command(() => {
      check?.();
      const r = T(this.c, "messages").get(messageId);
      if (r?.account_id !== accountId) throw assetError();
      for (const repair of T(this.c,"capture_repairs").by("fk_message_id",messageId)) if(repair.state === "blocked") retryCapture(idbCaptureStorage(this.c),accountId,repair.key,repair.revision);
      T(this.c, "messages").update(r, { attachments_captured: 0, attachment_pending: 1 });
    }, {check}),
    create: async (p) => {
      p = { ...p };
      await this.command(() => { const db = idbAssets(this.db); validateAssetCreation(db, p); db.beginOrphanGrace(p.accountId, p.now); });
      // Finite even if another caller adds backdated uploads between maintenance units.
      for (let remaining = ASSET_CLEANUP_STEPS; remaining > 0; remaining--) {
        if (!await this.command(() => cleanupAssets(idbAssets(this.db), p.accountId, p.now))) break;
        await this.o.platform.yield();
      }
      return this.command(() => createAsset(idbAssets(this.db), () => this.c.uuid(), p));
    },
    append: async (accountId, id, index, data) => this.command(() => appendAsset(idbAssets(this.db), accountId, id, index, data), { prefetch: () => readLazy(this.idb, this.db.table("attachment_bytes"), [`${id}:${index}`]) }),
    seal: async (accountId, id) => this.command(() => sealAsset(idbAssets(this.db), accountId, id)),
    info: async (accountId, id) => this.read(() => assetRef(assetRow(idbAssets(this.db), accountId, id))),
    read: async (accountId, id, index) => this.exclusive(async () => { assetRow(idbAssets(this.db), accountId, id); if (!Number.isSafeInteger(index) || index < 0) throw assetError(); const key = `${id}:${index}`; await readLazy(this.idb, this.db.table("attachment_bytes"), [key]); return idbAssets(this.db).chunk(key) ?? null; }),
    discard: async (accountId, id) => this.command(() => { const db = idbAssets(this.db); assetRow(db, accountId, id, false); if (db.pinned(id)) throw assetError(); db.remove(id); }),
  };

  private copyOp(op: import("@terno/store").OpRow | null): import("@terno/store").OpRow | null {
    if (!op || op.kind !== "send") return op;
    const receipt = idbSendCopies(this.db).get(op.id);
    const flags = sendWarningFlags(receipt?.warning ?? op.last_error);
    const summary = JSON.parse(op.target_json) as { recipientPartial?: boolean; recipientOutcomeUnknown?: boolean };
    flags.partial ||= summary.recipientPartial === true;
    flags.unknown ||= summary.recipientOutcomeUnknown === true;
    if (!receipt && !flags.partial && !flags.unknown) return op;
    return { ...op, ...(receipt && receipt.copyRequested && !receipt.retiring && { sent_copy: receipt.copy }), send_partial: flags.partial, send_recipient_unknown: flags.unknown };
  }

  readonly recipientReceipts: MailStore["recipientReceipts"] = {
    claimRecovery: async (id, expected, now, active) => {
      const previous = await this.early(() => T(this.c, "ops").get(id));
      const existing = previous?.kind === "send" && typeof previous.target_json === "string" ? (JSON.parse(previous.target_json) as { recipientRecoveryChild?: unknown }).recipientRecoveryChild : null;
      if (typeof existing === "string") return existing;
      const selected = await rejectedRecipientSelection(expected, (kind, index) => this.recipientReceipts.readPart(id, kind, index), this.o.platform.yield);
      if (!selected.length) throw new RpcError("BAD_REQUEST", L("errors.recipientReceipt.unavailable"));
      const fields: { to: Address[]; cc: Address[]; bcc: Address[] } = { to: [], cc: [], bcc: [] };
      for (const entry of selected) fields[entry.role].push({ name: entry.name, email: entry.original });
      const prepared = await recipientReceiptParts(fields, this.o.platform.yield);
      return this.command(() => {
      active?.();
      const ops = T(this.c, "ops"), op = ops.get(id);
      if (!op || typeof op.target_json !== "string" || !submissionAccepted({ kind: String(op.kind), target_json: op.target_json })) throw new RpcError("BAD_REQUEST", L("errors.recipientReceipt.unavailable"));
      const target = JSON.parse(op.target_json) as Record<string, unknown>;
      if (typeof target.recipientRecoveryChild === "string") return target.recipientRecoveryChild;
      const receipts = idbRecipientReceipts(this.db), row = requireRecoverySource(receipts.get(id), expected, idbSendCopies(this.db).get(expected.wireOwnerId ?? id));
      if (row.accountId !== op.account_id) throw new RpcError("BAD_REQUEST", L("errors.recipientReceipt.unavailable"));
      const child = enqueueOp(this.c, { accountId: row.accountId, kind: "send", target: { messageIds: [], recoveryParentId: id }, payload: { recoveryParentId: id } }, now)!;
      reserveRecipientReceipt(receipts, child, row.accountId, now, prepared, row.wireOwnerId ?? id);
      receipts.put({ ...row, childOpId: child });
      ops.update(op, { target_json: JSON.stringify({ ...target, recipientRecoveryChild: child }) });
      return child;
      });
    },
    get: (id) => this.early(() => idbRecipientReceipts(this.db).get(id)),
    list: (accountId) => this.early(() => idbRecipientReceipts(this.db).all().filter((row) => row.accountId === accountId)),
    readPart: async (id, kind, index) => this.exclusive(async () => { const header = idbRecipientReceipts(this.db).get(id); if (!header || header.retired || !Number.isSafeInteger(index) || index < 0 || index >= (kind === "envelope" ? header.parts : Math.ceil(header.count / 128))) return null; const tx = this.idb.transaction("recipient_receipt_parts", "readonly"); const done = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error("Recipient read aborted")); tx.onerror = () => {}; }); const request = tx.objectStore("recipient_receipt_parts").get(`${id}:${kind}:${index}`); const value = new Promise<unknown>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); const [row] = await Promise.all([value, done]); return row && typeof row === "object" && "data" in row && typeof row.data === "string" ? row.data : null; }),
    finishRetire: async (id) => this.command(() => finishRecipientRetirement(idbRecipientReceipts(this.db), id, idbSendCopies(this.db).get(idbRecipientReceipts(this.db).get(id)?.wireOwnerId ?? id), idbSendCopies(this.db).wirePinned(idbRecipientReceipts(this.db).get(id)?.wireOwnerId ?? id))),
    retireSlice: async (id, force) => this.command(() => {
      const receipt = idbRecipientReceipts(this.db).get(id), copy = idbSendCopies(this.db).get(id), ops = T(this.c, "ops"), op = ops.get(id);
      if (receipt && !receipt.retired) {
        if (op) ops.update(op, { last_error: clearRecipientWarning(op.last_error as string | null) });
        if (copy) idbSendCopies(this.db).put({ ...copy, warning: clearRecipientWarning(copy.warning) });
      }
      return retireRecipientSlice(idbRecipientReceipts(this.db), id, force);
    }),
  };

  readonly sendCopies: MailStore["sendCopies"] = {
    pinned: (id) => this.early(() => idbSendCopies(this.db).wirePinned(id)),
    get: (id) => this.early(() => idbSendCopies(this.db).get(id)),
    list: (accountId) => this.early(() => idbSendCopies(this.db).all().filter((r) => r.accountId === accountId && r.copyRequested).map(({ opId, accountId, submission, copy, createdAt, retiring }) => ({ opId, accountId, submission, copy, createdAt, retiring }))),
    resetWireSlice: async (id) => this.command(() => resetCopyWireSlice(idbSendCopies(this.db), id)),
    startWire: async (id, size) => this.command(() => startCopyWire(idbSendCopies(this.db), id, size)),
    appendWire: async (id, index, data) => this.command(() => appendCopyWire(idbSendCopies(this.db), id, index, data)),
    sealWire: async (id) => this.command(() => sealCopyWire(idbSendCopies(this.db), id)),
    readWire: async (id, index) => this.exclusive(async () => { const key = `${id}:${index}`; const tx = this.idb.transaction("send_copy_bytes", "readonly"); const done = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error("Sent-copy read aborted")); tx.onerror = () => {}; }); const request = tx.objectStore("send_copy_bytes").get(key); const value = new Promise<unknown>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); const [row] = await Promise.all([value, done]); return row && typeof row === "object" && "data" in row && typeof row.data === "string" ? row.data : null; }),
    accepted: async (id, warning) => this.command(() => acceptCopySubmission(idbSendCopies(this.db), id, warning)),
    record: async (id, copy, identity) => this.command(() => { recordCopy(idbSendCopies(this.db), id, copy, identity); const op = T(this.c, "ops").get(id); if (op?.state === "succeeded") T(this.c, "ops").update(op, { last_error: copyWarningText(idbSendCopies(this.db).get(id)!) }); }),
    forgetSlice: async (id, force) => this.command(() => forgetCopySlice(idbSendCopies(this.db), id, force)),
    pruneSavedSlice: async (id) => this.command(() => pruneSavedCopySlice(idbSendCopies(this.db), id)),
  };

  readonly compose: MailStore["compose"] = {
    queueSend: async (p) => this.bodyCommand(async () => {
      p = structuredClone(p);
      const preparedRecipients = (await this.accounts.get(p.accountId))?.kind === "imap" ? await recipientReceiptParts(p, this.o.platform.yield) : null;
      if (!await attachmentMessageBudgetAsync(p.bodyText, p.bodyHtml, p.attachments ?? [], this.o.platform.yield)) throw new RpcError("BAD_REQUEST", L("attachments.tooLarge"));
      const check = () => { if (this.bodyClosing) throw new Error("The store is closing"); };
      const body = await this.stageBody({ accountId: p.accountId, bodyText: p.bodyText, bodyHtml: p.bodyHtml || null, snippet: "" }, check);
      try {
      return await this.command(() => {
        check();
        // a draft is sent once: sending deletes it, so a second send of the same draft finds nothing
        const draft = p.draftId === undefined ? undefined : T(this.c, "drafts").get(p.draftId);
        if (p.draftId !== undefined && (!draft || (draft.generation ?? "") !== (p.draftGeneration ?? ""))) throw new RpcError("STALE", L("errors.draftGone"), { reason: "draftMissing" });
        if (p.scheduledAt !== undefined && !stillScheduled(this.c, p.draftId, p.scheduledAt)) throw new RpcError("STALE", L("errors.draftGone"), { reason: "unscheduled" });
        if (p.forward && !forwardSendOpen(this.c, p.forward)) throw new RpcError("STALE", L("errors.forwardGone"), { reason: "forwardGone" });
        if (draft && (draft.account_id !== p.accountId || (p.draftRevision !== undefined && p.draftRevision !== draft.revision))) throw new RpcError("STALE", L("errors.draftGone"), { reason: "draftRevision" });
        const account = getAccount(this.c, p.accountId);
        if (!account) throw new RpcError("NOT_FOUND", L("errors.accountGone"));
        const cfg = getAccountConfig<{ senderName?: string }>(this.c, p.accountId)!;
        const from: Address = { name: cfg.config.senderName || account.displayName, email: account.email };
        if (draft && p.attachments === undefined && JSON.parse(draft.attachments_json ?? "[]").length) throw assetError();
        const attachments = validateAssets(idbAssets(this.db), p.accountId, p.attachments ?? []);
        const context = draft?.reply_context_json ? JSON.parse(draft.reply_context_json) as import("@terno/core/rpc").ReplyContext : null;
        if (context && (p.draftRevision === undefined || p.subject !== draft?.subject || draft?.in_reply_to_message_id !== context.sourceId || p.inReplyToMessageId !== context.sourceId || (draft.mode !== "reply" && draft.mode !== "replyAll"))) throw new RpcError("BAD_REQUEST", L("errors.replySourceGone"));
        let inReplyTo: string | null = null;
        let references: string[] = [];
        let providerThreadId: string | null = null;
        let replyThreadId: number | null = null;
        if (p.inReplyToMessageId && draft?.mode !== "forward") {
          const original = T(this.c, "messages").get(p.inReplyToMessageId);
          if (!original || (context && original.account_id !== context.sourceAccountId)) throw new RpcError("BAD_REQUEST", L("errors.replySourceGone"));
          if (!context || !detachedReply(p.subject, context)) {
            inReplyTo = original.rfc_message_id;
            references = [...(JSON.parse(original.references_json) as string[]), ...(original.rfc_message_id ? [original.rfc_message_id] : [])];
            replyThreadId = original.thread_id;
            if (original.account_id === p.accountId) providerThreadId = T(this.c, "threads").get(original.thread_id)?.provider_thread_id ?? null;
          }
        }
        const messageId = `${this.c.uuid()}@${account.email.split("@")[1] || "terno.local"}`;
        const payload = { ...(attachments.length ? { attachments } : {}), from, to: p.to, cc: p.cc, bcc: p.bcc, subject: p.subject, text: p.bodyText, ...(p.bodyHtml ? { html: p.bodyHtml } : {}), messageId, inReplyTo, references, providerThreadId };
        const ingest = ingestMessages(
          this.c,
          [
            {
              accountId: p.accountId,
              providerMsgId: `local:${messageId}`,
              providerThreadId,
              rfcMessageId: messageId,
              inReplyTo,
              references,
              from,
              to: p.to,
              cc: p.cc,
              bcc: p.bcc,
              subject: p.subject,
              date: p.now,
              snippet: "",
              bodyText: body.bodyText,
              bodyCapture: body.bodyCapture,
              // the sent copy reads as written (the reader sanitizes it like any mail)
              bodyHtml: body.bodyHtml,
              bodyState: "full",
              listId: null,
              isRead: true,
              isStarred: false,
              inInbox: false,
              isSent: true,
              isDraft: false,
              isTrash: false,
              isSpam: false,
              hasAttachments: attachments.length > 0,
              attachments,
              size: p.bodyText.length + (p.bodyHtml?.length ?? 0),
            },
          ],
          p.now,
          undefined,
          preparedRecipients ?? undefined,
        );
        const localId = ingest.inserted[0]!;
        const opId = enqueueOp(this.c, { accountId: p.accountId, kind: "send", target: { messageIds: [localId] }, payload }, p.now)!;
        if (account.kind === "imap") { if (!preparedRecipients) throw new RpcError("BAD_REQUEST", L("errors.accountGone")); reserveRecipientReceipt(idbRecipientReceipts(this.db), opId, p.accountId, p.now, preparedRecipients); }
        if (account.kind === "imap") reserveSendCopy(idbSendCopies(this.db), opId, p.accountId, p.now, p.to.length + p.cc.length + p.bcc.length, !!(cfg.config as { appendToSent?: boolean }).appendToSent);
        linkAssets(idbAssets(this.db), "op", opId, attachments);
        if (p.draftId) T(this.c, "drafts").delete(p.draftId);
        if (p.forward) linkForwardSend(this.c, p.forward, opId, p.now);
        if (replyThreadId && p.recordReply) recordUserActions(this.c, [replyThreadId], "reply", p.now);
        return { opId, threadId: T(this.c, "messages").get(localId)!.thread_id as number, messageId: localId, deltas: ingest.deltas };
      });
      } finally { if (body.bodyCapture && this.isOpen && !this.unusable) await this.finishBodyStage(body.bodyCapture.id); }
    }),
  };

  // ───────────────────────────── filters ─────────────────────────────

  /** A rule over every message (or an id window), reading bodies in slices only if the rule looks at them. */
  private async matchAll(rule: Parameters<typeof findRuleMatches>[1], now: number, window?: { from: number; to: number }) {
    await this.settled();
    return this.exclusive(async () => {
      const messages = T(this.c, "messages");
      const needsBody = ruleNeedsBody(rule);
      const readsBody = ruleReadsBody(rule);
      // a window's ids only (no copy and sort of every key per window: a pattern's apply walks many small windows)
      const ids: number[] = [];
      for (const k of messages.rows.keys()) {
        const id = Number(k);
        if (!window || (id >= window.from && id <= window.to)) ids.push(id);
      }
      ids.sort((a, b) => a - b);
      const out = { messageIds: [] as number[], threadIds: new Set<number>() };
      for (let i = 0; i < ids.length; i += SLICE) {
        const candidates = ids.slice(i, i + SLICE);
        const slice = needsBody ? candidates.filter((id) => {
          const message = messages.get(id);
          return message?.body_state === "full" && !message.is_trash;
        }) : candidates;
        // a text rule (plan 89) reads the complete bodies only
        const full = readsBody && !needsBody ? slice.filter((id) => messages.get(id)?.body_state === "full") : slice;
        if (readsBody && full.length) await this.readBodies(full);
        const prepared = readsBody ? await this.prepareBodyTests(this.ruleTests([rule]), full) : new Map();
        const m = this.withBodyTests(prepared, () => findRuleMatches(this.c, rule, now, slice));
        out.messageIds.push(...m.messageIds);
        for (const t of m.threadIds) out.threadIds.add(t);
        if (needsBody) {
          this.evictBodies();
          if (i + SLICE < ids.length) await this.o.platform.yield();
        }
      }
      return out;
    });
  }

  readonly filters: MailStore["filters"] = {
    list: () => this.early(() => listFilters(this.c)),
    get: (id) => this.early(() => getFilter(this.c, id)),
    save: (f, now) => this.command(() => saveFilter(this.c, f, now)),
    delete: (id, expect) =>
      this.command(() => {
        const current = expect ? getFilter(this.c, id) : null;
        // plan 90: an automatic delete only takes what it made, unchanged (an edit meanwhile wins)
        if (expect && current && !sameFilterState(filterState(current), expect)) throw new RpcError("CANCELLED", L("errors.filterChanged"));
        T(this.c, "filters").delete(id);
        // plan 116: its forwards never go
        forwardRuleGone(this.c, { kind: "filter", id }, Date.now());
      }),
    preview: async (rule, now, limit) => {
      const matches = await this.matchAll(rule, now);
      return this.read(() => {
        const threads = T(this.c, "threads");
        const top = [...matches.threadIds]
          .filter((id) => threads.has(id))
          .sort((x, y) => threads.get(y)!.last_date - threads.get(x)!.last_date || y - x)
          .slice(0, limit);
        return { count: matches.threadIds.size, sample: summariesInOrder(this.c, top) };
      });
    },
    messageIdRange: () =>
      this.read(() => {
        let lo: number | null = null;
        let hi: number | null = null;
        for (const k of T(this.c, "messages").rows.keys()) {
          const id = k as number;
          lo = lo === null ? id : Math.min(lo, id);
          hi = hi === null ? id : Math.max(hi, id);
        }
        return lo === null || hi === null ? null : { lo, hi };
      }),
    matchWindow: async (rule, now, window) => (await this.matchAll(rule, now, window)).messageIds,
    matchMessages: async (rule, now, messageIds) => {
      await this.settled();
      return this.exclusive(async () => {
        const full = ruleReadsBody(rule) ? messageIds.filter((id) => T(this.c, "messages").get(id)?.body_state === "full") : [];
        if (full.length) await this.readBodies(full);
        const prepared = await this.prepareBodyTests(this.ruleTests([rule]), full);
        return this.withBodyTests(prepared, () => findRuleMatches(this.c, rule, now, messageIds).messageIds);
      });
    },
    applyChunk: (id, ruleJson, messageIds, now) =>
      this.command(() => {
        const flagBefore = flagEpochs(idbFlags(this.c));
        const current = T(this.c, "filters").get(id);
        if (!current || current.rule_json !== ruleJson) throw new RpcError("CANCELLED", L("errors.filterChanged"));
        const rule = JSON.parse(ruleJson) as FilterRule;
        const eligible = ruleNeedsBody(rule) ? messageIds.filter((messageId) => T(this.c, "messages").get(messageId)?.body_state === "full") : messageIds;
        const ids = claimFilterApplications(this.c, id, eligible, now);
        const opIds: string[] = [];
        const touched = this.runFilterActions(rule.actions, ids, now, opIds);
        return { applied: ids.length, touched: [...touched], opIds, ...flagReconciliation(idbFlags(this.c), flagBefore) };
      }),
  };

  // ───────────────────────────── categories ─────────────────────────────

  readonly folders: MailStore["folders"] = {
    list: () => this.early(() => listFolders(this.c)),
    replace: (accountId, folders, carried, rebuild) => this.command(() => replaceFolders(this.c, accountId, folders, carried, rebuild)),
    count: (accountId, keys, after, limit) => this.read(() => countFolderMessages(this.c, accountId, keys, after, limit)),
    carry: (accountId, from, to, after, limit) => this.command(() => carryFolder(this.c, accountId, from, to, after, limit)),
    clear: (accountId, key, limit) => this.command(() => clearFolder(this.c, accountId, key, limit)),
    rebuild: async (limit) => {
      const r = await this.command(() => {
        const own = rebuildFolders(this.c, limit);
        const fill = this.backfill;
        if (own.more || !fill) return own;
        // a bounded stretch of the messages each slice, the scan kept between slices (Codex R45: one command scanning
        // every message first); at most a batch of labelled ones written a slice (by message: Codex R15)
        // a batch scanned but not saved yet (its command rolled back) is written again first (Codex R18)
        if (!fill.pending) {
          fill.scan ??= T(this.c, "messages").all();
          const batch: number[] = [];
          for (let looked = 0; batch.length < Math.max(1, Math.floor(limit / 5)) && looked < 5000; looked++) {
            const next = fill.scan.next();
            if (next.done) {
              fill.done = true;
              break;
            }
            const m = next.value;
            if (typeof m.gmail_labels === "string" && m.gmail_labels.includes("Label_")) batch.push(m.id as number);
          }
          fill.pending = batch;
        }
        return { more: !fill.done, touched: [...own.touched, ...addMessageLabels(this.c, fill.pending)] };
      });
      // saved: the batch, and the folder walk's slice, are done with
      if (this.backfill) this.backfill.pending = null;
      confirmRebuilt(this.c);
      // done: the mark comes off only now, so a close before resumes the next time it opens (a batch rolled back is
      // scanned again then: Codex R18)
      if (this.backfill?.done) {
        this.backfill = null;
        await writeMeta(this.idb, { foldersPending: false });
      }
      return r;
    },
  };

  readonly folderExport: MailStore["folderExport"] = {
    ids: (target, after, limit) => this.read(() => exportIds(this.c, target, after, limit)),
    messages: async (ids) => {
      await this.settled();
      // exclusive: no command can evict a body between reading it and the message
      return this.exclusive(async () => {
        await this.readBodies(ids);
        return exportMessages(this.c, ids);
      });
    },
    body: async (id, part, at, size, lease) => this.bodyCommand(async () => {
      await this.settled();
      return this.exclusive(async () => {
        await this.readBodies([id]);
        const current = this.c.body(id);
        if (current?.capture_id) {
          const capture = T(this.c, "body_captures").get(current.capture_id)!;
          const count = part === "text" ? capture.text_parts : capture.html_parts;
          return count == null ? null : bodyPartRange(this.bodyPartSource(current.capture_id, part === "text" ? 0 : 1), count, at, size);
        }
        if (lease === undefined) {
          await this.readBodies([id]);
          return exportBody(this.c, id, part, at, size);
        }
        // the cache's copy if it has one, else the session's (no write since: it'd have let it go), else a read
        const bodies = this.db.table<R>("message_bodies");
        const held = this.exportLeases.get(lease);
        let body = held?.id === id && !bodies.rows.has(id) ? held.body : undefined;
        if (!body) {
          await this.readBodies([id]);
          body = this.c.body(id) ?? undefined;
        }
        this.exportLeases.delete(lease);
        if (body) {
          this.exportLeases.set(lease, { id, body });
          if (this.exportLeases.size > EXPORT_LEASES_MAX) this.exportLeases.delete(this.exportLeases.keys().next().value!);
        }
        return sliceBody(body ?? null, part, at, size);
      });
    }),
    release: (lease) => void this.exportLeases.delete(lease),
  };

  readonly reminders: MailStore["reminders"] = {
    list: () => this.early(() => listReminders(this.c)),
    put: (rows, cap, o) => this.command(() => putReminders(this.c, rows, cap, o?.ifAbsent), { early: true }),
    delete: (threadIds, o) => this.command(() => deleteReminders(this.c, threadIds, o?.dueBy), { early: true }),
    deleteExact: (rows) => this.command(() => deleteExactReminders(this.c, rows), { early: true }),
    // reads messages: waits for them
    answered: (rows) => this.read(() => answeredReminders(this.c, rows)),
  };

  // plan 116: messages are read by most of these, so they wait for them (the list and the next due don't)
  readonly forwards: MailStore["forwards"] = {
    active: () => this.early(() => forwardsActive(this.c)),
    setCategory: (categoryId, forward, now) => this.command(() => setCategoryForward(this.c, categoryId, forward, now)),
    plan: (p) => this.command(() => planForwards(this.c, p)),
    eligiblePage: (now, after, limit) => this.read(() => eligiblePage(this.c, now, after, limit)),
    list: (_now, limit) => this.early(() => listForwards(this.c, limit)),
    holds: (now) => this.early(() => forwardHolds(this.c, now)),
    work: (now, limit, after) => this.read(() => forwardWork(this.c, now, limit, after)),
    waitingCount: () => this.early(() => waitingCount(this.c)),
    cancelWaiting: (upTo, now) => this.command(() => cancelWaiting(this.c, upTo, now)),
    filesReady: (p, now) => this.command(() => filesReady(this.c, p, now)),
    nextDue: () => this.early(() => nextForwardDue(this.c)),
    ruleGone: (rule, now) => this.command(() => forwardRuleGone(this.c, rule, now)),
    cancel: (ids, now) => this.command(() => cancelForwards(this.c, ids, now)),
    claim: (id, now, o) => this.command(() => claimForward(this.c, id, now, o)),
    waitForFiles: (id, until, now) => this.command(() => waitForFiles(this.c, id, until, now)),
    fail: (id, reason, now) => this.command(() => failForward(this.c, id, reason, now)),
    retry: (id, now, failedOps) => this.command(() => retryForward(this.c, id, now, failedOps)),
    approve: (rule, now) => this.command(() => approveRule(this.c, rule, now)),
    stop: (rule, now) => this.command(() => stopRule(this.c, rule, now)),
    prune: (now) => this.command(() => pruneForwards(this.c, now)),
    get: (id) => this.early(() => getForward(this.c, id)),
  };

  readonly scheduled: MailStore["scheduled"] = {
    list: () => this.early(() => listScheduled(this.c)),
    get: (draftId) => this.early(() => getScheduled(this.c, draftId)),
    put: (row, cap) => this.command(() => putScheduled(this.c, row, cap), { early: true }),
    reschedule: (draftId, sendAt) => this.command(() => rescheduleScheduled(this.c, draftId, sendAt), { early: true }),
    fail: (draftId, sendAt, error, retryAt) => this.command(() => failScheduled(this.c, draftId, sendAt, error, retryAt), { early: true }),
    delete: (draftId) => this.command(() => deleteScheduled(this.c, draftId), { early: true }),
  };

  readonly categories: MailStore["categories"] = {
    list: () => this.early(() => listCategories(this.c)),
    exists: (id) => this.early(() => T(this.c, "categories").has(id)),
    create: (name, color, options) => this.command(() => createCategory(this.c, name, color, options)),
    update: (id, patch) => this.command(() => updateCategory(this.c, id, patch)),
    reorder: (ids) => this.command(() => reorderCategories(this.c, ids)),
    delete: (id) => this.command(() => {
      T(this.c, "categories").delete(id);
      // plan 116: what its trigger waited or held never goes
      forwardRuleGone(this.c, { kind: "category", id }, Date.now());
    }),
    createBatch: (categoryId, source, scope, now) => this.command(() => createBatch(this.c, categoryId, source, scope, now)),
    add: (a) =>
      this.command(
        () => {
          const r = addToCategory(this.c, a);
          if (a.batchId != null) finishBatch(this.c, a.batchId, r.added.length);
          return r;
        },
        { prefetch: () => this.prefetchRoots(a.threadIds) },
      ),
    remove: (r) => this.command(() => removeFromCategory(this.c, r), { prefetch: () => this.prefetchRoots(r.threadIds) }),
    batchThreads: (batchId) => this.read(() => batchThreads(this.c, batchId)),
    undoBatchPart: (batchId, threadIds, now) => this.command(() => undoBatchPart(this.c, batchId, threadIds, now), { prefetch: () => this.prefetchRoots(threadIds) }),
    finishUndo: (batchId, now) => this.command(() => finishUndo(this.c, batchId, now)),
    beginMove: (m) => this.command(() => beginMove(this.c, m)),
    moveOutcome: (batchId) => this.read(() => moveOutcome(this.c, batchId)),
    movePhase: (batchId) => this.early(() => movePhase(this.c, batchId)),
    movePending: (batchId) => this.read(() => movePending(this.c, batchId)),
    unfinishedMoves: () => this.early(() => unfinishedMoves(this.c)),
    trainMoveSlice: (batchId, threadIds, now) => this.command(() => trainMoveSlice(this.c, batchId, threadIds, now), { prefetch: () => this.prefetchRoots(threadIds) }),
    applyMoveSlice: (batchId, threadIds, now) => this.command(() => applyMoveSlice(this.c, batchId, threadIds, now)),
    undoMoveBegin: (batchId, now) => this.command(() => undoMoveBegin(this.c, batchId, now)),
    undoMoveSlice: (batchId, threadIds, now) => this.command(() => undoMoveSlice(this.c, batchId, threadIds, now), { prefetch: () => this.prefetchRoots(threadIds) }),
    restoreMoveSlice: (batchId, threadIds) => this.command(() => restoreMoveSlice(this.c, batchId, threadIds)),
  };

  readonly similar: MailStore["similar"] = {
    // the message indexes (late tables) must be in
    offers: (threadIds, action) => this.read(() => similarOffers(this.c, threadIds, action)),
    scopes: (threadIds) => this.read(() => similarScopesOf(this.c, threadIds)),
    resolvePage: (scope, action, targets, cursor, limit) => this.read(() => resolveSimilarPage(this.c, scope, action, targets, cursor, limit)),
    kept: (threadIds) => this.read(() => keptThreads(this.c, threadIds)),
    roots: (threadIds) => this.read(() => rootRefs(this.c, threadIds).map((r) => r.messageId)),
    // a thread whose facts aren't computed yet (person null, before the backfill) may well be a person's
    automated: (threadIds) =>
      this.read(() => {
        const ids = [...new Set(threadIds)];
        return ids.length > 0 && ids.every((id) => T(this.c, "threads").get(id)?.person === 0);
      }),
  };

  readonly storage: MailStore["storage"] = {
    // the message tables (late) must be in
    threads: (after, limit) => this.read(() => storageThreads(this.c, after, limit)),
    // strict: what it removed is gone for good once it says so (Codex R7)
    remove: (r) => this.command(() => removeStorage(this.c, r)),
    collect: (now) =>
      this.command(() => {
        const accounting = assetAccounting(this.db);
        for (const a of T(this.c, "accounts").all()) {
          if (accounting.aged(a.id as number, now - 86_400_000).length) return cleanupAssets(idbAssets(this.db), a.id as number, now);
        }
        return false;
      }),
    // the browser's own measure of everything this origin keeps (it compacts IndexedDB itself)
    footprint: async () => {
      const usage = (await globalThis.navigator?.storage?.estimate?.())?.usage;
      return typeof usage === "number" ? { bytes: usage, free: 0 } : null;
    },
    compact: async () => ({ more: false, onRestart: false }),
    compactPending: async () => false,
  };

  readonly categorize: MailStore["categorize"] = {
    quickActions: async (categoryId, threadIds, model) => {
      await this.settled();
      return this.exclusive(async () => {
        await this.prefetchRoots(threadIds.slice(0, 200));
        return quickActions(this.c, categoryId, threadIds, model);
      });
    },
    countScope: async (categoryId, given, now) => {
      const scope = resolvable(given);
      if (scope.kind === "query") return countOf((await this.categorize.resolveScope(categoryId, scope, now, COUNT_CAP + 1)).length);
      return countOf((await this.read(() => scopeThreads(this.c, categoryId, scope, COUNT_CAP + 1)))!.length);
    },
    resolveScope: async (categoryId, given, now, limit = -1) => {
      const scope = resolvable(given);
      // sender/domain/list scopes read the message indexes: the late tables must be in
      const prepared = await this.read(() => {
        const direct = scopeThreads(this.c, categoryId, scope);
        if (direct) return { ids: direct, search: null };
        if (scope.kind !== "query") return { ids: [], search: null };
        const search = this.resolve({ query: scope.query, now });
        return { ids: this.instant?.at(this.revision()) ? this.queryIdsFromIndex(search, categoryId, limit) : null, search };
      });
      const ids = prepared.ids ?? await this.scan({ search: prepared.search!, limit: limit < 0 ? Number.MAX_SAFE_INTEGER : limit }, (found) => found, (t) => scopeOpen(this.c, categoryId, t), limit);
      return limit < 0 ? ids : ids.slice(0, limit);
    },
    predict: async (threadId, model, mode, now) => {
      await this.settled();
      return this.exclusive(async () => {
        await this.prefetchRoots([threadId]);
        return predictThread(this.c, threadId, model, mode, now);
      });
    },
    pendingSuggestions: (o) => this.early(() => pendingSuggestions(this.c, o)),
    reject: (threadId, categoryId, now) => this.command(() => rejectSuggestion(this.c, threadId, categoryId, now), { prefetch: () => this.prefetchRoots([threadId]) }),
    stats: () => this.early(() => categoryStats(this.c)),
    loadSnapshot: () => this.early(() => ({ snapshot: loadSnapshot(this.c), fingerprint: examplesFingerprint(this.c) })),
    saveSnapshot: (s) => this.command(() => saveSnapshot(this.c, { ...s, fingerprint: examplesFingerprint(this.c) })),
    backfillExamples: async (limit) => {
      await this.settled();
      let rows: R[] = [];
      return this.command(() => backfillExamples(this.c, rows), {
        prefetch: async () => {
          rows = backfillRows(this.c, limit);
          await this.prefetchRoots(rows.map((r) => r.thread_id as number));
        },
      });
    },
    examples: () => this.early(() => loadExamples(this.c)),
    examplesPage: (after, limit) => this.early(() => loadExamplesPage(this.c, after, limit)),
    backgroundCandidates: (now) => this.read(() => backgroundCandidates(this.c, now)),
    threadFeatures: async (threadIds) => {
      await this.settled();
      return this.exclusive(async () => {
        await this.prefetchRoots(threadIds);
        return threadFeatures(this.c, threadIds);
      });
    },
    backfillCandidates: (now) => this.read(() => backfillCandidates(this.c, now)),
    suggestBackfill: (r) => this.command(() => ({ touched: [...suggestBackfill(this.c, r).touched] }), { prefetch: () => this.prefetchRoots(r.threadIds) }),
    matureDecisions: (now) => this.command(() => matureDecisions(this.c, now)),
    aiCandidate: (threadId) => this.read(() => aiCandidate(this.c, threadId)),
    vetoes: (threadId, sender, categoryIds, now) => this.read(() => vetoesFor(this.c, threadId, sender, categoryIds, now)),
    recordAiSuggestion: (s) =>
      this.command(() => {
        if (!aiCandidate(this.c, s.threadId)) return false;
        const v = vetoesFor(this.c, s.threadId, s.sender, [s.categoryId], s.now).get(s.categoryId);
        if (v?.hard || (v && senderVetoed(v)) || s.model.lookAlike(s.encoded)) return false;
        return T(this.c, "cls_decisions").insert({ thread_id: s.threadId, category_id: s.categoryId, kind: "suggest", p: s.p, explain_json: JSON.stringify(s.explain), at: s.now, outcome: null });
      }),
  };

  /** every match of a query through the index (bulk scopes read past one page) */
  private queryIdsFromIndex(search: ReturnType<IdbMailStore["resolve"]>, categoryId: number, limit: number): number[] {
    const revision = this.revision();
    const ram = this.instant!.at(revision)!;
    const threads = T(this.c, "threads");
    const out: number[] = [];
    let cursor: SearchCursor | undefined;
    do {
      const page = ram.search({ search, cursor, limit: 500 }, revision);
      for (const id of page.threadIds) if (scopeOpen(this.c, categoryId, threads.get(id))) out.push(id);
      cursor = page.nextCursor ?? undefined;
    } while (cursor && (limit < 0 || out.length < limit));
    return out;
  }

  // ───────────────────────────── accounts, owner, drafts, settings, secrets, learning ─────────────────────────────

  readonly accounts: MailStore["accounts"] = {
    list: () => this.early(() => listAccounts(this.c)),
    get: (id) => this.early(() => getAccount(this.c, id)),
    config: <V,>(id: number) => this.early(() => getAccountConfig<V>(this.c, id)),
    stamp: (id) =>
      this.early(() => {
        const r = T(this.c, "accounts").get(id);
        return r ? { id, email: r.email as string, createdAt: r.created_at as number } : null;
      }),
    create: (a) =>
      this.command(() => {
        const account = createAccount(this.c, a, a.now);
        // plan 17 (Codex R3): a new address of yours: every thread's facts are checked again, in slices
        startRescan(this.db);
        if (a.secret) T(this.c, "secrets").put({ name: `account:${account.id}:${a.secret.key}`, blob: a.secret.blob });
        const claimed = a.ownerClaim ? claimOwner(this.c, { ...a.ownerClaim, email: account.email, accountId: account.id }, a.now) : false;
        return { account, claimed };
      }),
    update: (id, patch) => this.command(() => updateAccount(this.c, id, patch)),
    remove: async (id) => {
      for (const row of await this.early(() => idbRecipientReceipts(this.db).all().filter((r) => r.accountId === id))) while (await this.recipientReceipts.retireSlice(row.opId, true)) await this.o.platform.yield();
      for (const row of await this.early(() => idbSendCopies(this.db).all().filter((r) => r.accountId === id))) while (await this.sendCopies.forgetSlice(row.opId, true)) await this.o.platform.yield();
      for (const row of await this.early(() => idbRecipientReceipts(this.db).all().filter((r) => r.accountId === id))) await this.recipientReceipts.finishRetire(row.opId);
      return this.command(() => {
        T(this.c, "accounts").delete(id);
        // plan 17 (Codex R3, R5): one address fewer, and its replies gone: every thread's facts are checked again
        startRescan(this.db);
        const secrets = T(this.c, "secrets");
        // a Map skips entries deleted while iterating
        for (const s of secrets.all()) if (String(s.name).startsWith(`account:${id}:`)) secrets.deleteRow(s);
        this.providerStores.delete(id);
      });
    },
    admitGoogle: (stamp, admission) => {
      const google = { ...admission }; stamp = { ...stamp };
      return this.command(() => {
      const account = T(this.c, "accounts").get(stamp.id);
      const config = getAccountConfig<Record<string, unknown>>(this.c, stamp.id)?.config;
      if (!account || account.kind !== "gmail" || account.email !== stamp.email || account.created_at !== stamp.createdAt || !config || (config.googleSubject ?? null) !== google.expectedSubject || (google.expectedSubject !== null && google.expectedSubject !== google.subject) || (google.eligible && !google.eligible())) return false;
      if (config.googleSubject !== google.subject) T(this.c, "accounts").update(account, { provider_config: JSON.stringify({ ...config, googleSubject: google.subject }) });
      return true;
      }, { early: true, check: () => { if (google.eligible && !google.eligible()) throw new CredentialAdmissionExpired(); } });
    },
    setSyncState: (id, patch) =>
      this.command(() => {
        const accounts = T(this.c, "accounts");
        const r = accounts.get(id);
        if (r) accounts.update(r, { sync_state: JSON.stringify({ ...getAccount(this.c, id)!.syncState, ...patch }) });
      }),
    setProviderConfig: (id, config) =>
      this.command(() => {
        const accounts = T(this.c, "accounts");
        const r = accounts.get(id);
        if (r) accounts.update(r, { provider_config: JSON.stringify(config) });
      }),
    // merged into the latest stored config in one command: preferences saved meanwhile stay
    setCursor: (id, cursor, check) =>
      this.command(() => {
        check?.();
        const accounts = T(this.c, "accounts");
        const r = accounts.get(id);
        if (r) accounts.update(r, { provider_config: JSON.stringify({ ...(JSON.parse(r.provider_config) as object), cursor }) });
      }),
  };

  readonly owner: MailStore["owner"] = {
    get: () => this.early(() => getOwner(this.c)),
    confirm: (o) => {
      const stamp = { ...o.stamp }, claim = { ...o.claim, evidence: { ...o.claim.evidence } }, now = o.now;
      const secret = { kind: "retain" as const, google: o.secret.google && { expectedSubject: o.secret.google.subject, subject: o.secret.google.subject }, name: o.secret.name, expectedBlob: Uint8Array.from(o.secret.kind === "retain" ? o.secret.expectedBlob : o.secret.blob) };
      return this.early(() => {
        const r = T(this.c, "owner").get(1);
        return !!r && r.account_id === claim.accountId && r.email === claim.email.toLowerCase() && r.display_name === claim.displayName && r.provider === claim.provider && r.verified_by === claim.verifiedBy && r.evidence_json === JSON.stringify(claim.evidence) && r.verified_at === now && r.updated_at === now && this.commitSecret(secret, { ...stamp, id: claim.accountId });
      });
    },
    change: (o) => {
      const stamp = { ...o.stamp }, claim = { ...o.claim, evidence: { ...o.claim.evidence } }, eligible = o.eligible;
      const secret = o.secret.kind === "retain" ? { ...o.secret, expectedBlob: Uint8Array.from(o.secret.expectedBlob) } : { ...o.secret, expectedBlob: o.secret.expectedBlob && Uint8Array.from(o.secret.expectedBlob), blob: Uint8Array.from(o.secret.blob) };
      return this.command(() => {
        const r = T(this.c, "accounts").get(claim.accountId);
        if (!r || r.created_at !== stamp.createdAt || r.email !== stamp.email) throw new RpcError("NOT_FOUND", L("errors.accountRemovedWhileVerifying", { email: stamp.email }));
        if (eligible && eligible() !== true) return false;
        if (!this.commitSecret(secret, { ...stamp, id: claim.accountId })) return false;
        changeOwner(this.c, claim, o.reason, o.now);
        return true;
      }, { check: () => { if ((eligible && eligible() !== true) || (secret.google?.eligible && !secret.google.eligible())) throw new CredentialAdmissionExpired(); } });
    },
  };

  readonly drafts: MailStore["drafts"] = {
    save: (d, now) => this.command(() => saveDraft(this.c, d, now)),
    // waits for the messages: an orphan (its original gone) is told apart from a draft whose original is loading
    list: () => this.read(() => listDrafts(this.c)),
    sourceContext: (id) => this.read(() => {
      const message = T(this.c, "messages").get(id);
      const thread = message ? T(this.c, "threads").get(message.thread_id) : undefined;
      return message && thread && message.account_id === thread.account_id ? { threadId: thread.id, accountId: thread.account_id } : null;
    }),
    delete: (id, generation) => this.command(() => {
      const drafts = T(this.c, "drafts");
      const row = drafts.get(id);
      if (row && generation !== undefined && (row.generation ?? "") !== generation) throw new RpcError("STALE", L("errors.draftGone"), { reason: "draftMissing" });
      drafts.delete(id);
    }),
    messageRef: (id) => this.read(() => (T(this.c, "messages").get(id)?.rfc_message_id as string | null | undefined) ?? null),
    findMessage: (accountId, rfc) =>
      this.read(() => {
        const id = rfc.trim().replace(/^<|>$/g, "").trim().toLowerCase();
        const m = T(this.c, "messages")
          .by("rfc", accountId, id)
          .sort((x, y) => y.id - x.id)[0];
        return m ? { id: m.id as number, threadId: m.thread_id as number } : null;
      }),
  };

  readonly providerCooldown: MailStore["providerCooldown"] = {
    read: () => this.cooldownAction(() => this.early(() => { const encoded = getSetting<string | null>(this.c, PROVIDER_COOLDOWN_KEY, null); decodeCooldown(encoded); return encoded; })),
    update: (fn) => this.cooldownAction(() => this.command(() => {
      const current = getSetting<string | null>(this.c, PROVIDER_COOLDOWN_KEY, null);
      decodeCooldown(current);
      const next = fn(current);
      if (!next || typeof next !== "object" || "then" in next) throw new Error("Cooldown callback must be synchronous");
      if (next.result !== null && (typeof next.result === "object" || typeof next.result === "function") && "then" in next.result) throw new Error("Cooldown result must be synchronous");
      encodeCooldown(decodeCooldown(next.encoded));
      setSetting(this.c, PROVIDER_COOLDOWN_KEY, next.encoded);
      return next.result;
    }, { early: true })),
    bind: (input, mailboxKey, current = () => true) => {
      const captured = { ...input };
      return this.cooldownAction(async () => {
        const stamp = captured;
        if (!mailboxKeyValid(mailboxKey)) throw new Error("Invalid private mailbox key");
        const digest = await mailboxDigest(stamp.email, (bytes) => crypto.subtle.digest("SHA-256", bytes));
        if (digest !== mailboxKey) return false;
        return this.command(() => {
          const account = T(this.c, "accounts").get(stamp.id);
          if (!current() || !account || account.kind !== "gmail" || account.email !== stamp.email || account.created_at !== stamp.createdAt) return false;
          const next = bindCooldown(getSetting<string | null>(this.c, PROVIDER_COOLDOWN_KEY, null), stamp, digest, mailboxKey);
          setSetting(this.c, PROVIDER_COOLDOWN_KEY, next);
          return decodeCooldown(next).bindings.some((b) => b.id === stamp.id && b.createdAt === stamp.createdAt && b.mailboxKey === mailboxKey && b.emailDigest === digest);
        }, { early: true });
      });
    },
  };

  readonly settings: MailStore["settings"] = {
    get: <V,>(key: string, fallback: V) => this.early(() => getSetting(this.c, key, fallback)),
    set: (key, value) => this.command(() => setSetting(this.c, key, value)),
    update: <V, Res>(key: string, fallback: V, fn: (current: V) => { value: V; result: Res }) =>
      this.command(() => {
        const { value, result } = fn(getSetting(this.c, key, fallback));
        setSetting(this.c, key, value);
        return result;
      }),
  };

  private commitSecret(intent: import("@terno/store").SecretIntent, stamp: { id: number; email: string; createdAt: number }): boolean {
    const account = T(this.c, "accounts").get(stamp.id);
    if (!account || account.email !== stamp.email || account.created_at !== stamp.createdAt) return false;
    const config = getAccountConfig<Record<string, unknown>>(this.c, stamp.id)?.config;
    if (intent.google && (account.kind !== "gmail" || !config || (config.googleSubject ?? null) !== intent.google.expectedSubject || (intent.google.expectedSubject !== null && intent.google.expectedSubject !== intent.google.subject) || (intent.google.eligible && !intent.google.eligible()))) return false;
    const secrets = T(this.c, "secrets");
    const current = secrets.get(intent.name)?.blob as Uint8Array | undefined;
    const expected = intent.expectedBlob;
    if (expected === null ? current !== undefined : !current || current.length !== expected.length || !current.every((b, i) => b === expected[i])) return false;
    if (intent.google && config!.googleSubject !== intent.google.subject) T(this.c, "accounts").update(account, { provider_config: JSON.stringify({ ...config, googleSubject: intent.google.subject }) });
    if (intent.kind === "replace" && (!current || current.length !== intent.blob.length || !current.every((b, i) => b === intent.blob[i]))) secrets.put({ name: intent.name, blob: intent.blob });
    return true;
  }

  readonly secrets: MailStore["secrets"] = {
    commit: (intent, stamp) => {
      const copy = intent.kind === "retain" ? { ...intent, expectedBlob: Uint8Array.from(intent.expectedBlob) } : { ...intent, expectedBlob: intent.expectedBlob && Uint8Array.from(intent.expectedBlob), blob: Uint8Array.from(intent.blob) };
      const account = { ...stamp };
      return this.command(() => this.commitSecret(copy, account), { early: true, check: () => { if (copy.google?.eligible && !copy.google.eligible()) throw new CredentialAdmissionExpired(); } });
    },
    names: () => this.early(() => [...T(this.c, "secrets").all()].map((s) => String(s.name)).sort()),
    get: (name) => this.early(() => (T(this.c, "secrets").get(name)?.blob as Uint8Array | undefined) ?? null),
    has: (name) => this.early(() => T(this.c, "secrets").has(name)),
    put: (name, blob) => this.command(() => void T(this.c, "secrets").put({ name, blob })),
    replace: (name, expectedBlob, nextBlob, accountStamp) => {
      const expected = Uint8Array.from(expectedBlob), next = Uint8Array.from(nextBlob);
      const stamp = accountStamp ? { ...accountStamp } : undefined;
      return this.command(() => {
        if (stamp) {
          const account = T(this.c, "accounts").get(stamp.id);
          if (!account || account.email !== stamp.email || account.created_at !== stamp.createdAt) return false;
        }
        const secrets = T(this.c, "secrets");
        const blob = secrets.get(name)?.blob as Uint8Array | undefined;
        if (!blob || blob.length !== expected.length || !blob.every((b, i) => b === expected[i])) return false;
        if (expected.length !== next.length || !expected.every((b, i) => b === next[i])) secrets.put({ name, blob: next });
        return true;
      }, { early: true });
    },
    delete: (name) => this.command(() => void T(this.c, "secrets").delete(name)),
  };

  readonly learning: MailStore["learning"] = {
    actionsSince: (since) => this.read(() => loadUserActions(this.c, since)),
    excludedKeys: () =>
      this.read(() => new Set([...[...T(this.c, "dismissed_suggestions").all()].map((r) => r.key as string), ...[...T(this.c, "filters").all()].map((f) => f.learned_key as string | null).filter((k): k is string => !!k)])),
    dismiss: (key, now) => this.command(() => void T(this.c, "dismissed_suggestions").put({ key, at: now })),
  };

  providerStore(accountId: number): ProviderStore {
    let s = this.providerStores.get(accountId);
    if (!s) this.providerStores.set(accountId, (s = new IdbProviderStore(this.c, accountId, (a,after,state) => this.exclusive(() => idbCapturePage(this.idb,a,after,state)), (fn, options) => this.command(fn, options), (fn) => this.read(fn), (after) => this.exclusive(() => idbCachedPage(this.idb, this.c, accountId, after)), (request) => this.exclusive(() => idbFlagSnapshots(this.idb, idbFlags(this.c), accountId, request)))));
    if (!Object.prototype.hasOwnProperty.call(s, "setting")) {
      const read = s.setting.bind(s);
      s.setting = <V,>(key: string): Promise<V | null> => key === PROVIDER_COOLDOWN_KEY ? Promise.resolve(null) : read<V>(key);
    }
    return s;
  }

  // ───────────────────────────── debug, dev ─────────────────────────────

  readonly debug: MailStore["debug"] = {
    snapshot: async () => {
      await this.settled();
      return this.exclusive(async () => {
        await this.readBodies([...T(this.c, "messages").rows.keys()].map(Number));
        const snap = storeSnapshot(this.c);
        for (const message of snap.messages) {
          const body = this.c.body(message.id);
          if (!body?.capture_id) continue;
          const capture = T(this.c, "body_captures").get(body.capture_id)!;
          message.bodyText = capture.text_parts === null ? null : await assembleBody(this.bodyPartSource(body.capture_id, 0));
          const doc = snap.search.messages.find((doc) => doc.messageId === message.id); if (doc) { doc.body = message.bodyText ?? ""; doc.releaseBody?.(); delete doc.releaseBody; delete doc.bodyTokenParts; }
        }
        this.evictBodies();
        return snap;
      });
    },
    verify: async () => {
      await this.settled();
      // memory and IndexedDB hold the same rows, and every index agrees with its table
      await this.exclusive(async () => {
        const stored = await readAll(this.idb, this.o.platform);
        for (const [name, rows] of stored) {
          const t = this.db.table<R>(name);
          if (rows.length !== t.size) throw new Error(`${name}: ${rows.length} rows in IndexedDB, ${t.size} in memory`);
          for (const row of rows) {
            const mine = t.rows.get(t.keyOfRow(row));
            if (!mine || JSON.stringify(mine, bytes) !== JSON.stringify(row, bytes)) throw new Error(`${name}: row ${String(t.keyOfRow(row))} differs between IndexedDB and memory`);
          }
        }
        const threads = T(this.c, "threads");
        const order = this.c.order.current(threads);
        if (order.length !== threads.size) throw new Error("the recency order lost a thread");
        for (let i = 1; i < order.length; i++) {
          const a = threads.get(order[i - 1]!)!;
          const b = threads.get(order[i]!)!;
          if (a.last_date < b.last_date || (a.last_date === b.last_date && a.id < b.id)) throw new Error("the recency order is out of order");
        }
        // each filter's order is the recency order's threads it keeps, exactly; its scope ids are those threads, ascending
        for (const f of LIST_FILTERS) {
          const filtered = this.c.filterOrders[f].current(threads);
          const expected = order.filter((id) => FILTER_TEST[f](threads.get(id)));
          if (filtered.length !== expected.length || filtered.some((id, i) => id !== expected[i])) throw new Error(`the ${f} order differs from the recency order's ${f} threads`);
          const scoped = this.c.scopes.matching(this.c, f);
          const ascending = [...expected].sort((a, b) => a - b);
          if (scoped.length !== ascending.length || scoped.some((id, i) => id !== ascending[i])) throw new Error(`the ${f} scope ids differ from the ${f} threads`);
        }
      });
    },
    resetFacts: () => this.command(() => resetFacts(this.db)),
  };

  // ───────────────────────────── facts (plan 17) ─────────────────────────────

  /** Backfill slices are commands on the late tables: they wait for messages to load (R10), like every unit that reads them. */
  readonly facts: MailStore["facts"] = {
    backfill: ({ limit }) => this.command(() => backfillSlice(this.db, this.c.facts, this.c.order, limit), { durability: "relaxed" }),
    idle: () => this.early(() => factsReady(this.db, this.c.facts)),
  };

  readonly tabs: MailStore["tabs"] = {
    backfill: ({ limit }) => this.command(() => tabsSlice(this.db, limit), { durability: "relaxed" }),
    idle: () => this.early(() => tabsIdle(this.db)),
  };

  readonly dev: MailStore["dev"] = {
    seed: async (data, options) => {
      const dataset = data as MockDataset;
      const now = options.now ?? Date.now();
      const rate = options.categorizeRate ?? 0.7;
      this.seeding = true;
      try {
        const accountIds = await this.command(() => dataset.accounts.map((a) => createAccount(this.c, { kind: a.kind, email: a.email, displayName: a.displayName, color: a.color }, now).id));
        // plan 68: listed before the mail, so IMAP locations in them are membership as they're written
        await this.command(() => dataset.accounts.forEach((a, i) => a.folders && replaceFolders(this.c, accountIds[i]!, a.folders.map(({ key, path, selectable }) => ({ key, path, selectable })))));
        const categories = await this.command(() => dataset.categories.map((cat) => ({ ...cat, id: createCategory(this.c, cat.name, cat.color).id })));
        const threadTags = new Map<number, Set<string>>();
        for (let i = 0; i < dataset.messages.length; i += 1000) {
          const chunk = dataset.messages.slice(i, i + 1000);
          await this.command(
            () => {
              const result = ingestMessages(this.c, chunk.map((m) => ({ ...m, accountId: accountIds[m.accountIndex]! })), now);
              const messages = T(this.c, "messages");
              result.inserted.forEach((messageId, j) => {
                const threadId = messages.get(messageId)!.thread_id as number;
                const tags = threadTags.get(threadId) ?? new Set();
                for (const t of chunk[j]!.tags) tags.add(t);
                threadTags.set(threadId, tags);
              });
            },
            { durability: "relaxed" },
          );
          await this.o.platform.yield();
        }
        const keep = (threadId: number) => ((threadId * 2654435761) >>> 0) / 4294967296 < rate;
        for (const cat of categories) {
          const ids = [...threadTags].filter(([id, tags]) => keep(id) && cat.tags.some((t) => tags.has(t))).map(([id]) => id);
          await this.categories.add({ categoryId: cat.id, threadIds: ids, addedBy: "user", now });
        }
        if (options.learningSignals) {
          await this.command(() => {
            const brew = [...new Set(T(this.c, "messages").by("from", "crew@morningbrew.com").sort((x, y) => y.date - x.date || y.id - x.id).map((m) => m.thread_id as number))].slice(0, 8);
            recordUserActions(this.c, brew, "archive", now - 86_400_000);
          });
        }
        return { accountIds, categoryIds: categories.map((cat) => cat.id), messageCount: T(this.c, "messages").size, threadCount: T(this.c, "threads").size };
      } finally {
        this.seeding = false;
        this.evictBodies();
      }
    },
  };
}

/** plan 68: an upgrade's folder backfill: threads per batch, and the time a command keeps taking batches */

const bodyBytes = (r: R) => 2 * ((r.body_text?.length ?? 0) + (r.body_html?.length ?? 0) + (r.body_preview?.length ?? 0));

/** Uint8Arrays compared by content */
const bytes = (_k: string, v: unknown) => (v instanceof Uint8Array ? [...v] : v);

function storeSnapshot(c: Ctx): StoreSnapshot {
  const b = (v: unknown) => v === 1;
  const byId = <X extends R>(rows: Iterable<X>) => [...rows].sort((x, y) => x.id - y.id);
  const memberships = [...T(c, "thread_categories").all()].sort((x, y) => x.thread_id - y.thread_id || x.category_id - y.category_id);
  const cats = new Map<number, number[]>();
  for (const r of memberships) cats.set(r.thread_id, [...(cats.get(r.thread_id) ?? []), r.category_id]);
  const messages = byId(T(c, "messages").all());
  const threads = byId(T(c, "threads").all());
  return {
    accounts: byId(T(c, "accounts").all()).map((a) => ({ id: a.id, email: a.email, display_name: a.display_name })),
    categories: byId(T(c, "categories").all()).map((x) => ({ id: x.id, name: x.name })),
    messages: messages.map((m) => ({
      id: m.id,
      threadId: m.thread_id,
      accountId: m.account_id,
      providerMsgId: m.provider_msg_id,
      rfcMessageId: m.rfc_message_id,
      date: m.date,
      fromName: m.from_name,
      fromEmail: m.from_email,
      recipients: m.recipients_text,
      subject: m.subject,
      bodyText: c.body(m.id)?.body_text ?? null,
      bodyState: m.body_state,
      listId: m.list_id,
      hasAttachments: b(m.has_attachments),
      isRead: b(m.is_read),
      isStarred: b(m.is_starred),
      inInbox: b(m.in_inbox),
      isSent: b(m.is_sent),
      isDraft: b(m.is_draft),
      isTrash: b(m.is_trash),
      isSpam: b(m.is_spam),
      toJson: m.to_json,
      ccJson: m.cc_json,
      replyToJson: m.reply_to_json ?? "[]",
      isBulk: b(m.is_bulk ?? 0),
      unsubscribe: m.unsubscribe ?? null,
      gmailLabels: m.gmail_labels ?? null,
      inReplyTo: m.in_reply_to ?? null,
      references: JSON.parse(m.references_json) as string[],
    })),
    threads: threads.map((t) => ({
      id: t.id,
      accountId: t.account_id,
      providerThreadId: t.provider_thread_id,
      subject: t.subject,
      snippet: t.snippet,
      lastDate: t.last_date,
      lastFromName: t.last_from_name,
      lastFromEmail: t.last_from_email,
      messageCount: t.message_count,
      unreadCount: t.unread_count,
      hasAttachments: b(t.has_attachments),
      isStarred: b(t.is_starred),
      inInbox: b(t.in_inbox),
      hasSent: b(t.has_sent),
      inTrash: b(t.in_trash),
      inSpam: b(t.in_spam),
      categoryIds: cats.get(t.id) ?? [],
      person: t.person == null ? null : t.person === 1,
      waitingSince: t.waiting_since ?? null,
    })),
    memberships: memberships.map((r) => ({ threadId: r.thread_id, categoryId: r.category_id, addedBy: r.added_by, batchId: r.batch_id })),
    examples: [...T(c, "cls_examples").all()]
      .sort((x, y) => x.thread_id - y.thread_id || x.category_id - y.category_id)
      .map((e) => ({ threadId: e.thread_id, categoryId: e.category_id, label: e.label, source: e.source, weight: e.weight, content: e.content === 1, sender: e.sender, batchId: e.batch_id })),
    ops: [...T(c, "ops").all()].sort((x, y) => x.seq - y.seq).map((o) => ({ id: o.id, accountId: o.account_id, kind: o.kind, state: o.state, attempts: o.attempts, messageIds: (JSON.parse(o.target_json) as { messageIds?: number[] }).messageIds ?? [] })),
    search: { messages: messages.map((m) => messageDoc(m, c.body(m.id)?.body_text ?? null)), threads: threads.map((t) => threadDoc(c, t)) },
  };
}

export type { Cursor };
export { toSummary };
