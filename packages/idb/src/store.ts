import { listFolders, refreshFolders, replaceFolders, threadsWithUserLabels } from "./folders";
import { COOLDOWN_TICKETS, bindCooldown, decodeCooldown, encodeCooldown, mailboxDigest, mailboxKeyValid, PROVIDER_COOLDOWN_KEY, copyOpAdmission } from "@terno/store";
import { keptThreads, resolveSimilarPage, similarOffers } from "./similar";
import { attachmentMessageBudgetAsync } from "@terno/core";
import { reaffirmSavedFlagIntent, acceptFlagObservation, flagEpochs, flagReconciliation, flagObservationValid, flagTick, initializeFlagStep, rearmFlagEffects, settleFlagEffects, startFlagObservation } from "@terno/store";
import { idbFlags, idbFlagSnapshots, prepareIdbFlagPage } from "./flag-intents";
import { appendAsset, assetError, assetRef, assetRow, createAsset, ASSET_CLEANUP_STEPS, cleanupAssets, validateAssetCreation, linkAssets, sealAsset, stageAttachments, validateAssets } from "@terno/store";
import { idbAssets, replaceAttachments } from "./attachments";
import { COUNT_CAP, LIST_FILTERS, parseSearch, resolveSearch, senderVetoed, type Address, type FilterAction, type FilterRule, type ListFilter, type ThreadAction, type ThreadFilter, type ThreadSummary } from "@terno/core";
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
import { IdbProviderStore } from "./provider-store";
import { createMemDb, EARLY_TABLES, idbExists, LATE_TABLES, LOGICAL_SCHEMA, loadAll, PartialCommit, SEARCH_SCHEMA, openIdb, persist, readAll, readLazy, writeMeta } from "./schema";
import { UncertainWriteError } from "./uncertainty";
import { answeredThreads, arrivalRows, backfillSlice, FactsQueue, factsReady, ownMailChanged, referencesOfOwn, resetFacts, startRescan } from "./facts";
import { sameRevision, SearchCancelledError, type AutocompleteSource, type ContactBatch, type ContactMessage, type SentText } from "@terno/store";
import { contactOf, isLearnable, sentOf } from "./autocomplete";
import { appendOutbox, checkCursor, columnsOf, materializeChanges, pageOf, planScan, scanPage, searchChangeIds, searchHead } from "./search";

const PENDING_BODIES_CAP = 1000;
/** bodies kept in memory after a unit of work (read ahead or written), by count and bytes; the rest stay in IndexedDB */
const BODY_CACHE = 2000;
const BODY_CACHE_BYTES = 8 * 1024 * 1024;
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
  /** the browser's indexedDB (fake-indexeddb in Node tests) */
  factory: IDBFactory;
  platform: Pick<Platform, "uuid" | "yield" | "files">;
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
  private inflight: Promise<unknown> | null = null;
  private open = true;
  private unusable = false;
  private seeding = false;
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
      body: (id) => {
        const r = bodies.get(id);
        if (r) return { body_text: r.body_text ?? null, body_html: r.body_html ?? null };
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
    const idb = await openIdb(o.factory, o.name);
    try {
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
      // plan 65 (SQL v24): a mailbox from before gets its Gmail memberships once, after its messages load; the mark
      // goes in with the upgrade and comes off only when they're saved, so a close or a failure meanwhile resumes (Codex R1)
      const foldersPending = (typeof meta.logicalSchema === "number" && meta.logicalSchema < 24) || meta.foldersPending === true;
      if (meta.logicalSchema === undefined) await writeMeta(idb, { logicalSchema: LOGICAL_SCHEMA, createdAt: Date.now() });
      else if (meta.logicalSchema !== LOGICAL_SCHEMA || foldersPending) await writeMeta(idb, { logicalSchema: LOGICAL_SCHEMA, ...(foldersPending && { foldersPending: true }) });
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
      if (foldersPending) {
        void store
          .command(() => refreshFolders(store.c, threadsWithUserLabels(store.c)))
          .then(() => (store.open ? writeMeta(idb, { foldersPending: false }) : undefined))
          .catch((error: unknown) => store.log("error", "could not index folders", error instanceof Error ? error.message : error));
      }
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

  async close(): Promise<void> {
    if (!this.open) return;
    try {
      await this.instant?.close();
    } finally {
      await this.loaded.catch(() => {});
      await this.queue.catch(() => {});
      this.open = false;
      this.idb.close();
    }
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
  private command<V>(fn: () => V, o: { prefetch?: () => Promise<void>; durability?: "strict" | "relaxed"; early?: boolean } = {}): Promise<V> {
    return this.exclusive(async () => {
      await o.prefetch?.();
      const result = this.db.tx(fn);
      const touched = this.db.touched(["messages", "message_bodies", "threads", "thread_categories"]);
      const messageIds = new Set<number>([...touched.get("messages")!, ...touched.get("message_bodies")!].map(Number));
      const threadIds = new Set<number>([...touched.get("threads")!.map(Number), ...touched.get("thread_categories")!.map((k) => (JSON.parse(k as string) as number[])[0]!)]);
      if (messageIds.size || threadIds.size) this.db.tx(() => appendOutbox(this.c, [...messageIds].sort((a, b) => a - b), [...threadIds].sort((a, b) => a - b), Date.now()));
      const commit = this.db.takeCommit();
      if (commit) {
        let release!: () => void;
        this.inflight = new Promise<void>((resolve) => { release = resolve; });
        try {
          await persist(this.idb, commit, o.durability ?? "strict", this.o.platform);
          this.db.confirm();
        } catch (error) {
          if (error instanceof PartialCommit || error instanceof UncertainWriteError) {
            this.unusable = true;
            this.idb.close();
            throw error instanceof PartialCommit ? error.original : error;
          }
          this.db.revert();
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
    if (!this.open || this.unusable) throw new Error("the store is closed");
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
    const chunks = this.db.table("attachment_bytes");
    chunks.evict([...chunks.rows.keys()]);
    // No pending undo remains here; cold-delete keys need not outlive their committed unit.
    chunks.absent.clear();
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
                const body = this.c.body(id)?.body_text;
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
      for (const b of ids) {
        const changes = [];
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
      }
      return batches;
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
        page<SearchMessageDoc>("messages", messageIds, at, (id) => messageDoc(this.db.table<R>("messages").get(id)!, this.c.body(id)?.body_text ?? null), (slice) => this.readBodies(slice));
      const threadsAt = (at: number) => page<SearchThreadDoc>("threads", threadIds, at, (id) => threadDoc(this.c, this.db.table<R>("threads").get(id)!));
      const release = async () => {
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
            if (p.docs.length) yield p.docs;
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
            for (const id of chunk) {
              const m = messages.get(id);
              if (!m) continue;
              let cols: ReturnType<typeof columnsOf> | null = null;
              const columns = () => (cols ??= columnsOf(m, plan.needsBodies ? (this.c.body(id)?.body_text ?? null) : null));
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
    get: async (id) => {
      await this.settled();
      // exclusive: no command can add a message (or evict a body) between reading the bodies and the thread
      return this.exclusive(async () => {
        await this.readBodies(T(this.c, "messages").by("fk_thread_id", id).map((m) => m.id as number));
        const thread = getThread(this.c, id);
        if (!thread) return null;
        return { ...thread, categorization: { auto: autoReasons(this.c, id), suggestions: pendingSuggestions(this.c, { threadId: id, limit: 5 }) } };
      });
    },
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
        const r = applyThreadAction(this.c, [...new Set(threadIds)], action);
        if (signal && r.threadIds.length) recordUserActions(this.c, r.threadIds, signal, now);
        return { threadIds: r.threadIds, opIds: this.queueActionOps(r, action, now), before: r.before, ...flagReconciliation(idbFlags(this.c), flagBefore) };
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
      if (onlyBodyFilters && !filter.rule.conditions.some((cond) => cond.field === "body")) continue;
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
    ingest: async (batch, { applyFilters, now, classifier, observation }) => {
      const staged: IncomingMessage[] = [];
      for (const m of batch) {
        const existing = !m.captureUnavailable && m.attachments?.length ? await this.read(() => findIngestMessage(this.c, m)) : undefined;
        staged.push(m.captureUnavailable || m.attachments === undefined ? m : { ...m, attachments: await stageAttachments(this, m.accountId, m.attachments, now, this.o.platform.yield, existing ? await this.attachments.current(m.accountId, { id: existing.id }) : []) });
      }
      return this.command(
        () => {
          const flagBefore = flagEpochs(idbFlags(this.c));
          const result = ingestMessages(this.c, staged as IncomingMessage[], now, observation);
          const touched = new Set(result.touchedThreads);
          const opIds: string[] = [];
          if (applyFilters) {
            for (const t of this.applyFiltersTo(result.inserted, false, now, opIds)) touched.add(t);
            for (const t of this.applyFiltersTo(result.bodyCompleted, true, now, opIds)) touched.add(t);
          }
          const c = this.classify(classifier, result.inserted, result.bodyCompleted, now);
          for (const t of c.touched) touched.add(t);
          return { inserted: result.inserted, touched: [...touched], deltas: [...result.deltas, ...c.deltas], auto: c.auto, backfill: c.backfill, uncertain: c.uncertain, opIds, ...flagReconciliation(idbFlags(this.c), flagBefore) };
        },
        { durability: "relaxed" },
      );
    },
    setBody: async (messageId, text, html, { now, classifier, attachments, captureUnavailable }) => {
      const accountId = await this.read(() => T(this.c, "messages").get(messageId)?.account_id as number | undefined);
      const staged = !captureUnavailable && attachments !== undefined && accountId !== undefined ? await stageAttachments(this, accountId, attachments, now, this.o.platform.yield, await this.attachments.current(accountId, { id: messageId })) : undefined;
      return this.command(
        () => {
          const flagBefore = flagEpochs(idbFlags(this.c));
          if (!captureUnavailable) setMessageBody(this.c, messageId, text, html, "full");
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
        },
        { durability: "relaxed" },
      );
    },
    updateFlags: (accountId, updates, observation) =>
      this.command(
        () => {
          const messages = T(this.c, "messages");
          const threads = new Set<number>();
          for (const u of updates) {
            const identity = messages.get(u.messageId);
            if (observation && (!flagObservationValid(idbFlags(this.c), accountId, observation) || !u.expectedProviderMsgId || identity?.account_id !== accountId || identity.provider_msg_id !== u.expectedProviderMsgId)) continue;
            const pending = pendingFlagFields(this.c, accountId, u.messageId);
            const sets: [string, number | string][] = Object.entries(u.flags)
              .filter(([k]) => FLAG_COLUMNS[k] && !pending.has(k as LocalFlagField) && acceptFlagObservation(idbFlags(this.c), u.messageId, k as LocalFlagField, observation))
              .map(([k, v]) => [FLAG_COLUMNS[k]!, v ? 1 : 0]);
            // plan 17 (Codex review 1, #8): Gmail's category moves change who a message is from
            if (u.gmailLabels) sets.push(["gmail_labels", JSON.stringify(u.gmailLabels)]);
            if (!sets.length) continue;
            const m = messages.get(u.messageId);
            if (!m || m.account_id !== accountId) continue;
            const after = messages.update(m, Object.fromEntries(sets));
            threads.add(m.thread_id);
            // plan 17 (Codex R4): a message becoming sent, or a draft, is your mail appearing or going
            if (after.is_sent !== m.is_sent || after.is_draft !== m.is_draft) for (const t of ownMailChanged(this.db, m.id)) threads.add(t);
          }
          recomputeThreads(this.c, threads);
          return { touched: [...threads] };
        },
        { durability: "relaxed" },
      ),
    remove: (ids) => this.command(() => ({ touched: [...deleteMessages(this.c, ids)] }), { durability: "relaxed" }),
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
    get: (id) => this.early(() => getOp(this.c, id)),
    complete: (id, result, now) =>
      this.preparedFlagOutcome(id, () => {
        const op = getOp(this.c, id);
        completeOp(this.c, id, now);
        const touched: number[] = [];
        const deltas: ModelDelta[] = [];
        if (!op) return { touched, deltas };
        if (op.kind === "send") idbAssets(this.db).unlink("op", id);
        const ops = T(this.c, "ops");
        if (result?.warning) ops.update(ops.get(id)!, { last_error: result.warning });
        const localId = (JSON.parse(op.target_json) as { messageIds?: number[] }).messageIds?.[0];
        if (op.kind === "send" && result && localId) {
          const messages = T(this.c, "messages");
          const local = messages.get(localId);
          if (result.providerMsgId && local && String(local.provider_msg_id ?? "").startsWith("local:")) messages.update(local, { provider_msg_id: result.providerMsgId });
          if (result.providerThreadId) {
            const row = messages.get(localId);
            if (row) touched.push(adoptProviderThread(this.c, row.thread_id, op.account_id, result.providerThreadId, undefined, deltas));
          }
        }
        return { touched, deltas };
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
    markUnknown: (id, error, now) => this.preparedFlagOutcome(id, () => markOpUnknown(this.c, id, error, now)),
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
    recent: (limit) => this.early(() => listRecentOps(this.c, limit)),
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
          return { touched: [] };
        }
        if (resolution === "retry") {
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

  readonly attachments: MailStore["attachments"] = {
    current: (accountId, message) => this.read(() => {
      const m = "id" in message ? T(this.c, "messages").get(message.id) : T(this.c, "messages").by("provider", accountId, message.providerMsgId)[0];
      if (!m || m.account_id !== accountId) return [];
      return T(this.c, "attachments").by("fk_message_id", m.id).sort((a,b) => a.id - b.id).map((a) => ({ filename: a.filename as string, mime: a.mime as string, size: a.size as number, assetId: a.asset_id as string | undefined, contentId: a.content_id as string | null }));
    }),
    retry: (accountId, messageId) => this.command(() => {
      const r = T(this.c, "messages").get(messageId);
      if (r?.account_id !== accountId) throw assetError();
      T(this.c, "messages").update(r, { attachments_captured: 0, attachment_pending: 1 });
    }),
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

  readonly compose: MailStore["compose"] = {
    queueSend: async (p) => {
      p = structuredClone(p);
      if (!await attachmentMessageBudgetAsync(p.bodyText, p.bodyHtml, p.attachments ?? [], this.o.platform.yield)) throw new RpcError("BAD_REQUEST", L("attachments.tooLarge"));
      return this.command(() => {
        // a draft is sent once: sending deletes it, so a second send of the same draft finds nothing
        const draft = p.draftId === undefined ? undefined : T(this.c, "drafts").get(p.draftId);
        if (p.draftId !== undefined && (!draft || (draft.generation ?? "") !== (p.draftGeneration ?? ""))) throw new RpcError("STALE", L("errors.draftGone"), { reason: "draftMissing" });
        if (draft && (draft.account_id !== p.accountId || (p.draftRevision !== undefined && p.draftRevision !== draft.revision))) throw new RpcError("STALE", L("errors.draftGone"), { reason: "draftRevision" });
        const account = getAccount(this.c, p.accountId);
        if (!account) throw new RpcError("NOT_FOUND", L("errors.accountGone"));
        const cfg = getAccountConfig<{ senderName?: string }>(this.c, p.accountId)!;
        const from: Address = { name: cfg.config.senderName || account.displayName, email: account.email };
        if (draft && p.attachments === undefined && JSON.parse(draft.attachments_json ?? "[]").length) throw assetError();
        const attachments = validateAssets(idbAssets(this.db), p.accountId, p.attachments ?? []);
        let inReplyTo: string | null = null;
        let references: string[] = [];
        let providerThreadId: string | null = null;
        let replyThreadId: number | null = null;
        if (p.inReplyToMessageId) {
          const original = T(this.c, "messages").get(p.inReplyToMessageId);
          if (original) {
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
              bodyText: p.bodyText,
              // the sent copy reads as written (the reader sanitizes it like any mail)
              bodyHtml: p.bodyHtml || null,
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
        );
        const localId = ingest.inserted[0]!;
        const opId = enqueueOp(this.c, { accountId: p.accountId, kind: "send", target: { messageIds: [localId] }, payload }, p.now)!;
        linkAssets(idbAssets(this.db), "op", opId, attachments);
        if (p.draftId) T(this.c, "drafts").delete(p.draftId);
        if (replyThreadId && p.recordReply) recordUserActions(this.c, [replyThreadId], "reply", p.now);
        return { opId, threadId: T(this.c, "messages").get(localId)!.thread_id as number, deltas: ingest.deltas };
      });
    },
  };

  // ───────────────────────────── filters ─────────────────────────────

  /** A rule over every message (or an id window), reading bodies in slices only if the rule looks at them. */
  private async matchAll(rule: Parameters<typeof findRuleMatches>[1], now: number, window?: { from: number; to: number }) {
    await this.settled();
    return this.exclusive(async () => {
      const messages = T(this.c, "messages");
      const needsBody = ruleNeedsBody(rule);
      const ids = [...messages.rows.keys()].map(Number).filter((id) => !window || (id >= window.from && id <= window.to)).sort((a, b) => a - b);
      const out = { messageIds: [] as number[], threadIds: new Set<number>() };
      for (let i = 0; i < ids.length; i += SLICE) {
        const candidates = ids.slice(i, i + SLICE);
        const slice = needsBody ? candidates.filter((id) => {
          const message = messages.get(id);
          return message?.body_state === "full" && !message.is_trash;
        }) : candidates;
        if (needsBody && slice.length) await this.readBodies(slice);
        const m = findRuleMatches(this.c, rule, now, slice);
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
    delete: (id) => this.command(() => void T(this.c, "filters").delete(id)),
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
    replace: (accountId, folders) => this.command(() => replaceFolders(this.c, accountId, folders)),
  };

  readonly categories: MailStore["categories"] = {
    list: () => this.early(() => listCategories(this.c)),
    exists: (id) => this.early(() => T(this.c, "categories").has(id)),
    create: (name, color) => this.command(() => createCategory(this.c, name, color)),
    update: (id, patch) => this.command(() => updateCategory(this.c, id, patch)),
    reorder: (ids) => this.command(() => reorderCategories(this.c, ids)),
    delete: (id) => this.command(() => void T(this.c, "categories").delete(id)),
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
    resolvePage: (scope, action, targets, cursor, limit) => this.read(() => resolveSimilarPage(this.c, scope, action, targets, cursor, limit)),
    kept: (threadIds) => this.read(() => keptThreads(this.c, threadIds)),
  };

  readonly categorize: MailStore["categorize"] = {
    quickActions: async (categoryId, threadIds, model) => {
      await this.settled();
      return this.exclusive(async () => {
        await this.prefetchRoots(threadIds.slice(0, 200));
        return quickActions(this.c, categoryId, threadIds, model);
      });
    },
    countScope: async (categoryId, scope, now) => countOf((await this.categorize.resolveScope(categoryId, scope, now, COUNT_CAP + 1)).length),
    resolveScope: async (categoryId, scope, now, limit = -1) => {
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
    remove: (id) =>
      this.command(() => {
        T(this.c, "accounts").delete(id);
        // plan 17 (Codex R3, R5): one address fewer, and its replies gone: every thread's facts are checked again
        startRescan(this.db);
        const secrets = T(this.c, "secrets");
        // a Map skips entries deleted while iterating
        for (const s of secrets.all()) if (String(s.name).startsWith(`account:${id}:`)) secrets.deleteRow(s);
        this.providerStores.delete(id);
      }),
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
    setCursor: (id, cursor) =>
      this.command(() => {
        const accounts = T(this.c, "accounts");
        const r = accounts.get(id);
        if (r) accounts.update(r, { provider_config: JSON.stringify({ ...(JSON.parse(r.provider_config) as object), cursor }) });
      }),
  };

  readonly owner: MailStore["owner"] = {
    get: () => this.early(() => getOwner(this.c)),
    confirm: (o) => {
      const stamp = { ...o.stamp }, claim = { ...o.claim, evidence: { ...o.claim.evidence } }, now = o.now;
      const secret = { kind: "retain" as const, name: o.secret.name, expectedBlob: Uint8Array.from(o.secret.kind === "retain" ? o.secret.expectedBlob : o.secret.blob) };
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
      });
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
    bind: (input, mailboxKey) => {
      const captured = { ...input };
      return this.cooldownAction(async () => {
        const stamp = captured;
        if (!mailboxKeyValid(mailboxKey)) throw new Error("Invalid private mailbox key");
        const digest = await mailboxDigest(stamp.email, (bytes) => crypto.subtle.digest("SHA-256", bytes));
        if (digest !== mailboxKey) return false;
        return this.command(() => {
          const account = T(this.c, "accounts").get(stamp.id);
          if (!account || account.kind !== "gmail" || account.email !== stamp.email || account.created_at !== stamp.createdAt) return false;
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
    const secrets = T(this.c, "secrets");
    const current = secrets.get(intent.name)?.blob as Uint8Array | undefined;
    const expected = intent.expectedBlob;
    if (expected === null ? current !== undefined : !current || current.length !== expected.length || !current.every((b, i) => b === expected[i])) return false;
    if (intent.kind === "replace" && (!current || current.length !== intent.blob.length || !current.every((b, i) => b === intent.blob[i]))) secrets.put({ name: intent.name, blob: intent.blob });
    return true;
  }

  readonly secrets: MailStore["secrets"] = {
    commit: (intent, stamp) => {
      const copy = intent.kind === "retain" ? { ...intent, expectedBlob: Uint8Array.from(intent.expectedBlob) } : { ...intent, expectedBlob: intent.expectedBlob && Uint8Array.from(intent.expectedBlob), blob: Uint8Array.from(intent.blob) };
      const account = { ...stamp };
      return this.command(() => this.commitSecret(copy, account), { early: true });
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
    if (!s) this.providerStores.set(accountId, (s = new IdbProviderStore(this.c, accountId, (fn) => this.command(fn), (fn) => this.read(fn), (request) => this.exclusive(() => idbFlagSnapshots(this.idb, idbFlags(this.c), accountId, request)))));
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

  readonly dev: MailStore["dev"] = {
    seed: async (data, options) => {
      const dataset = data as MockDataset;
      const now = options.now ?? Date.now();
      const rate = options.categorizeRate ?? 0.7;
      this.seeding = true;
      try {
        const accountIds = await this.command(() => dataset.accounts.map((a) => createAccount(this.c, { kind: a.kind, email: a.email, displayName: a.displayName, color: a.color }, now).id));
        // plan 65: listed before the mail, so IMAP locations in them are membership as they're written
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

const bodyBytes = (r: R) => 2 * ((r.body_text?.length ?? 0) + (r.body_html?.length ?? 0));

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
