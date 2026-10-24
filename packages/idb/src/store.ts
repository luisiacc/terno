import { COUNT_CAP, parseSearch, resolveSearch, senderVetoed, type Address, type FilterAction, type ThreadAction, type ThreadSummary } from "@unica/core";
import { RpcError } from "@unica/core/rpc";
import type { MockDataset } from "@unica/mock-data";
import {
  AWAITING_AUTH,
  type ClassifierInput,
  type ClassifyResult,
  type Cursor,
  type IncomingMessage,
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
} from "@unica/store";
import { InstantSearch, WEB_SEARCH_MEMORY, type InstantSearchOptions } from "@unica/store/instant";
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
  recomputeThreads,
  recordUserActions,
  recoverOps,
  resumeAuthOps,
  ruleNeedsBody,
  saveDraft,
  saveFilter,
  setMessageBody,
  setSetting,
  summariesInOrder,
  T,
  ThreadOrder,
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
import { createMemDb, EARLY_TABLES, idbExists, LATE_TABLES, LOGICAL_SCHEMA, loadAll, SEARCH_SCHEMA, openIdb, persist, readAll, readLazy, writeMeta } from "./schema";
import { sameRevision, SearchCancelledError } from "@unica/store";
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
  /** the mailbox: one IndexedDB database per name (unica-<name>) */
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
  readonly capabilities: StoreCapabilities;
  readonly instant: InstantSearch | null;
  private readonly c: Ctx;
  private queue: Promise<unknown> = Promise.resolve();
  /** the late tables (messages and their satellites) are in memory */
  private loaded: Promise<void> = Promise.resolve();
  private inflight: Promise<unknown> | null = null;
  private open = true;
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
    const bodies = db.table<R>("message_bodies");
    this.c = {
      db,
      order,
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
    this.capabilities = { engine: "indexeddb", search: this.instant ? "instant+scan" : "scan", bulkRuleScan: "scan", imapLocations: true, externalReaders: false, durability: "browser" };
  }

  /** Opens (creating) the mailbox and mirrors it in memory. */
  static async open(o: IdbMailStoreOptions): Promise<IdbMailStore> {
    const idb = await openIdb(o.factory, o.name);
    const db = createMemDb();
    const timings: Record<string, number> = {};
    const meta = await loadAll(idb, db, timings, EARLY_TABLES, () => o.platform.yield());
    if (!db.table("search_state").get(1)) {
      // a new database: its epoch, the search log's head
      db.tx(() => db.table("search_state").insert({ id: 1, epoch: o.platform.uuid(), seq: 0, bytes: 0 }));
      const commit = db.takeCommit()!;
      await persist(idb, commit, "strict");
      db.confirm();
    }
    if (meta.logicalSchema === undefined) await writeMeta(idb, { logicalSchema: LOGICAL_SCHEMA, createdAt: Date.now() });
    const store = new IdbMailStore(idb, db, o);
    Object.assign(store.openTimings, timings);
    // the first screen needs none of it: messages load while it paints (writes to these tables wait for them)
    store.loaded = loadAll(idb, db, {}, LATE_TABLES, () => o.platform.yield()).then(
      () => undefined,
      (error: unknown) => {
        store.log("error", "could not load the mailbox", error instanceof Error ? error.message : error);
        throw error;
      },
    );
    return store;
  }

  static exists(factory: IDBFactory, name: string): Promise<boolean> {
    return idbExists(factory, name);
  }

  get isOpen(): boolean {
    return this.open;
  }

  get name(): string {
    return this.o.name;
  }

  /** resolves once every table is in memory (messages load after open) */
  whenLoaded(): Promise<void> {
    return this.loaded;
  }

  async close(): Promise<void> {
    if (!this.open) return;
    await this.instant?.close();
    await this.queue.catch(() => {});
    this.open = false;
    this.idb.close();
  }

  // ───────────────────────────── units of work ─────────────────────────────

  /** One at a time: commands, scans and feed slices never interleave with a command. `early` units touch only early tables. */
  private exclusive<V>(fn: () => Promise<V>, early = false): Promise<V> {
    // a unit that needs the late tables waits for them before queueing, so it never holds up early units
    const enqueue = () => {
      const run = this.queue.then(async () => {
        if (!this.open) throw new Error("the store is closed");
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
        const write = persist(this.idb, commit, o.durability ?? "strict");
        this.inflight = write;
        try {
          await write;
          this.db.confirm();
        } catch (error) {
          this.db.revert();
          throw error;
        } finally {
          this.inflight = null;
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
  }

  /** `early`: reads only early tables (answers while messages load) */
  private async read<V>(fn: () => V, early = false): Promise<V> {
    if (!early) await this.loaded;
    await this.settled();
    return fn();
  }

  private early<V>(fn: () => V): Promise<V> {
    return this.read(fn, true);
  }

  private evictBodies(): void {
    if (this.seeding || this.db.inTransaction) return;
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
    await this.settled();
    let revision = this.revision();
    const ram = this.instant?.at(revision);
    let page: { items: ThreadSummary[]; nextCursor: SearchCursor | null; strategy: string };
    if (ram) {
      const ids = ram.search(req, revision);
      page = { items: summariesInOrder(this.c, ids.threadIds), nextCursor: ids.nextCursor, strategy: ids.strategy };
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
    await this.loaded;
    const messages = T(this.c, "messages");
    const pendingBodies = Math.min(PENDING_BODIES_CAP, messages.count("body_state", "none") + messages.count("body_state", "partial"));
    return { items: page.items, nextCursor: page.nextCursor, revision, strategy: page.strategy, complete: true, pendingBodies };
  }

  private resolve(p: { query: string; accountId?: number; categoryId?: number; now?: number }) {
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
    counts: () => this.early(() => getCounts(this.c)),
    search: (req) => this.searchPage(req),
    searchText: async (p) => {
      await this.settled();
      // resolving account:/category: reads early tables only
      const search = this.resolve(p);
      const cursor = p.cursor ? { lastDate: p.cursor.lastDate, id: p.cursor.id, queryKey: p.cursor.queryKey ?? search.key, revision: p.cursor.revision ?? this.revision() } : undefined;
      return this.searchPage({ search, cursor, limit: p.limit }, p.signal);
    },
    act: ({ threadIds, action, signal, now }) =>
      this.command(() => {
        const r = applyThreadAction(this.c, [...new Set(threadIds)], action);
        if (signal && r.threadIds.length) recordUserActions(this.c, r.threadIds, signal, now);
        return { threadIds: r.threadIds, opIds: this.queueActionOps(r, action, now), before: r.before };
      }),
    restore: ({ messages, now }) =>
      this.command(() => {
        const r = restoreMessages(this.c, messages);
        const opIds: string[] = [];
        for (const op of r.ops) {
          const id = enqueueOp(this.c, { accountId: op.accountId, kind: op.kind, target: { messageIds: op.messageIds } }, now);
          if (id) opIds.push(id);
        }
        return { threadIds: r.threadIds, opIds };
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
    ingest: (batch, { applyFilters, now, classifier }) =>
      this.command(
        () => {
          const result = ingestMessages(this.c, batch as IncomingMessage[], now);
          const touched = new Set(result.touchedThreads);
          const opIds: string[] = [];
          if (applyFilters) {
            for (const t of this.applyFiltersTo(result.inserted, false, now, opIds)) touched.add(t);
            for (const t of this.applyFiltersTo(result.bodyCompleted, true, now, opIds)) touched.add(t);
          }
          const c = this.classify(classifier, result.inserted, result.bodyCompleted, now);
          for (const t of c.touched) touched.add(t);
          return { inserted: result.inserted, touched: [...touched], deltas: [...result.deltas, ...c.deltas], auto: c.auto, backfill: c.backfill, uncertain: c.uncertain, opIds };
        },
        { durability: "relaxed" },
      ),
    setBody: (messageId, text, html, { now, classifier }) =>
      this.command(
        () => {
          setMessageBody(this.c, messageId, text, html, "full");
          const owner = T(this.c, "messages").get(messageId);
          if (owner) recomputeThreads(this.c, [owner.thread_id]);
          const opIds: string[] = [];
          const touched = this.applyFiltersTo([messageId], true, now, opIds);
          const c = this.classify(classifier, [], [messageId], now);
          for (const t of c.touched) touched.add(t);
          if (owner) touched.add(owner.thread_id);
          return { touched: [...touched], deltas: c.deltas, auto: c.auto, opIds };
        },
        { durability: "relaxed" },
      ),
    updateFlags: (accountId, updates) =>
      this.command(
        () => {
          const pending = messagesWithPendingOps(this.c, accountId);
          const messages = T(this.c, "messages");
          const threads = new Set<number>();
          for (const u of updates) {
            if (pending.has(u.messageId)) continue;
            const sets = Object.entries(u.flags).filter(([k]) => FLAG_COLUMNS[k]);
            if (!sets.length) continue;
            const m = messages.get(u.messageId);
            if (!m || m.account_id !== accountId) continue;
            messages.update(m, Object.fromEntries(sets.map(([k, v]) => [FLAG_COLUMNS[k]!, v ? 1 : 0])));
            threads.add(m.thread_id);
          }
          recomputeThreads(this.c, threads);
          return { touched: [...threads] };
        },
        { durability: "relaxed" },
      ),
    remove: (ids) => this.command(() => ({ touched: [...deleteMessages(this.c, ids)] }), { durability: "relaxed" }),
    pendingMessageIds: (accountId) => this.read(() => messagesWithPendingOps(this.c, accountId)),
  };

  // ───────────────────────────── ops ─────────────────────────────

  readonly ops: MailStore["ops"] = {
    claimReady: (now, limit) => this.command(() => claimReadyOps(this.c, now, limit), { early: true }),
    get: (id) => this.early(() => getOp(this.c, id)),
    complete: (id, result, now) =>
      this.command(() => {
        const op = getOp(this.c, id);
        completeOp(this.c, id, now);
        const touched: number[] = [];
        const deltas: ModelDelta[] = [];
        if (!op) return { touched, deltas };
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
    fail: (id, error, retryable, now) => this.command(() => failOp(this.c, id, error, retryable, now)),
    markUnknown: (id, error, now) => this.command(() => markOpUnknown(this.c, id, error, now)),
    awaitAuth: (id, error, now) => this.command(() => awaitAuthOp(this.c, id, error, now), { early: true }),
    resumeAuth: (accountId, now) => this.command(() => resumeAuthOps(this.c, accountId, now), { early: true }),
    recover: (now) => this.command(() => recoverOps(this.c, now), { early: true }),
    nextAttemptAt: () =>
      this.read(() => {
        let t: number | null = null;
        for (const o of T(this.c, "ops").by("state", "queued")) if (o.next_attempt_at < AWAITING_AUTH) t = t === null ? o.next_attempt_at : Math.min(t, o.next_attempt_at);
        return t;
      }),
    recent: (limit) => this.early(() => listRecentOps(this.c, limit)),
    resolveUnknown: (id, resolution, now) =>
      this.command(() => {
        const op = getOp(this.c, id);
        if (!op || op.state !== "unknown") throw new RpcError("NOT_FOUND", "No unresolved operation with that id");
        const ops = T(this.c, "ops");
        if (resolution === "markSent") {
          completeOp(this.c, id, now);
          return { touched: [] };
        }
        if (resolution === "retry") {
          ops.update(ops.get(id)!, { state: "queued", next_attempt_at: 0, last_error: null });
          return { touched: [] };
        }
        ops.update(ops.get(id)!, { state: "failed", last_error: "Discarded by user" });
        const target = JSON.parse(op.target_json) as { messageIds?: number[] };
        if (op.kind === "send" && target.messageIds?.length) {
          const local = T(this.c, "messages").get(target.messageIds[0]!);
          if (local && String(local.provider_msg_id ?? "").startsWith("local:")) return { touched: [...deleteMessages(this.c, [local.id])] };
        }
        return { touched: [] };
      }),
  };

  // ───────────────────────────── compose ─────────────────────────────

  readonly compose: MailStore["compose"] = {
    queueSend: (p) =>
      this.command(() => {
        const account = getAccount(this.c, p.accountId);
        if (!account) throw new RpcError("NOT_FOUND", "Account not found");
        const cfg = getAccountConfig<{ senderName?: string }>(this.c, p.accountId)!;
        const from: Address = { name: cfg.config.senderName || account.displayName, email: account.email };
        // a draft is sent once: sending deletes it, so a second send of the same draft finds nothing
        if (p.draftId !== undefined && !T(this.c, "drafts").get(p.draftId)) throw new RpcError("STALE", "Este borrador ya se envió o se descartó");
        let inReplyTo: string | null = null;
        let references: string[] = [];
        let providerThreadId: string | null = null;
        let replyThreadId: number | null = null;
        if (p.inReplyToMessageId) {
          const original = T(this.c, "messages").get(p.inReplyToMessageId);
          if (!original) throw new RpcError("NOT_FOUND", "Original message not found");
          inReplyTo = original.rfc_message_id;
          references = [...(JSON.parse(original.references_json) as string[]), ...(original.rfc_message_id ? [original.rfc_message_id] : [])];
          replyThreadId = original.thread_id;
          if (original.account_id === p.accountId) providerThreadId = T(this.c, "threads").get(original.thread_id)!.provider_thread_id;
        }
        const messageId = `${this.c.uuid()}@${account.email.split("@")[1] || "unica.local"}`;
        const payload = { from, to: p.to, cc: p.cc, bcc: p.bcc, subject: p.subject, text: p.bodyText, messageId, inReplyTo, references, providerThreadId };
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
              bodyHtml: null,
              bodyState: "full",
              listId: null,
              isRead: true,
              isStarred: false,
              inInbox: false,
              isSent: true,
              isDraft: false,
              isTrash: false,
              isSpam: false,
              hasAttachments: false,
              size: p.bodyText.length,
            },
          ],
          p.now,
        );
        const localId = ingest.inserted[0]!;
        const opId = enqueueOp(this.c, { accountId: p.accountId, kind: "send", target: { messageIds: [localId] }, payload }, p.now)!;
        if (p.draftId) T(this.c, "drafts").delete(p.draftId);
        if (replyThreadId && p.recordReply) recordUserActions(this.c, [replyThreadId], "reply", p.now);
        return { opId, threadId: T(this.c, "messages").get(localId)!.thread_id as number, deltas: ingest.deltas };
      }),
  };

  // ───────────────────────────── filters ─────────────────────────────

  /** A rule over every message (or an id window), reading bodies in slices only if the rule looks at them. */
  private async matchAll(rule: Parameters<typeof findRuleMatches>[1], now: number, window?: { from: number; to: number }) {
    await this.settled();
    return this.exclusive(async () => {
      const ids = [...T(this.c, "messages").rows.keys()].map(Number).filter((id) => !window || (id >= window.from && id <= window.to)).sort((a, b) => a - b);
      const out = { messageIds: [] as number[], threadIds: new Set<number>() };
      for (let i = 0; i < ids.length; i += SLICE) {
        const slice = ids.slice(i, i + SLICE);
        if (ruleNeedsBody(rule)) await this.readBodies(slice);
        const m = findRuleMatches(this.c, rule, now, slice);
        out.messageIds.push(...m.messageIds);
        for (const t of m.threadIds) out.threadIds.add(t);
        if (ruleNeedsBody(rule)) this.evictBodies();
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
        const current = T(this.c, "filters").get(id);
        if (!current || current.rule_json !== ruleJson) throw new RpcError("CANCELLED", "The filter changed while it was being applied");
        const rule = JSON.parse(ruleJson) as { actions: FilterAction[] };
        const ids = claimFilterApplications(this.c, id, messageIds, now);
        const opIds: string[] = [];
        const touched = this.runFilterActions(rule.actions, ids, now, opIds);
        return { applied: ids.length, touched: [...touched], opIds };
      }),
  };

  // ───────────────────────────── categories ─────────────────────────────

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
    movePhase: (batchId) => this.early(() => movePhase(this.c, batchId)),
    movePending: (batchId) => this.read(() => movePending(this.c, batchId)),
    unfinishedMoves: () => this.early(() => unfinishedMoves(this.c)),
    trainMoveSlice: (batchId, threadIds, now) => this.command(() => trainMoveSlice(this.c, batchId, threadIds, now), { prefetch: () => this.prefetchRoots(threadIds) }),
    applyMoveSlice: (batchId, threadIds, now) => this.command(() => applyMoveSlice(this.c, batchId, threadIds, now)),
    undoMoveBegin: (batchId, now) => this.command(() => undoMoveBegin(this.c, batchId, now)),
    undoMoveSlice: (batchId, threadIds, now) => this.command(() => undoMoveSlice(this.c, batchId, threadIds, now), { prefetch: () => this.prefetchRoots(threadIds) }),
    restoreMoveSlice: (batchId, threadIds) => this.command(() => restoreMoveSlice(this.c, batchId, threadIds)),
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
      await this.loaded;
      await this.settled();
      const direct = scopeThreads(this.c, categoryId, scope);
      if (direct) return limit < 0 ? direct : direct.slice(0, limit);
      if (scope.kind !== "query") return [];
      // the query's own matches, minus what bulk filing never reaches
      const search = this.resolve({ query: scope.query, now });
      const ids = this.instant?.at(this.revision())
        ? this.queryIdsFromIndex(search, categoryId, limit)
        : await this.scan({ search, limit: limit < 0 ? Number.MAX_SAFE_INTEGER : limit }, (found) => found, (t) => scopeOpen(this.c, categoryId, t), limit);
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
      this.read(() => {
        const r = T(this.c, "accounts").get(id);
        return r ? { id, email: r.email as string, createdAt: r.created_at as number } : null;
      }),
    create: (a) =>
      this.command(() => {
        const account = createAccount(this.c, a, a.now);
        if (a.secret) T(this.c, "secrets").put({ name: `account:${account.id}:${a.secret.key}`, blob: a.secret.blob });
        const claimed = a.ownerClaim ? claimOwner(this.c, { ...a.ownerClaim, email: account.email, accountId: account.id }, a.now) : false;
        return { account, claimed };
      }),
    update: (id, patch) => this.command(() => updateAccount(this.c, id, patch)),
    remove: (id) =>
      this.command(() => {
        T(this.c, "accounts").delete(id);
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
    change: (o) =>
      this.command(() => {
        const r = T(this.c, "accounts").get(o.claim.accountId);
        if (!r || r.created_at !== o.stamp.createdAt || r.email !== o.stamp.email) throw new RpcError("NOT_FOUND", `${o.stamp.email} se quitó mientras se verificaba; no se cambió nada.`);
        T(this.c, "secrets").put({ name: o.secret.name, blob: o.secret.blob });
        changeOwner(this.c, o.claim, o.reason, o.now);
      }),
  };

  readonly drafts: MailStore["drafts"] = {
    save: (d, now) => this.command(() => saveDraft(this.c, d, now)),
    // waits for the messages: an orphan (its original gone) is told apart from a draft whose original is loading
    list: () => this.read(() => listDrafts(this.c)),
    delete: (id) => this.command(() => void T(this.c, "drafts").delete(id)),
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

  readonly secrets: MailStore["secrets"] = {
    get: (name) => this.early(() => (T(this.c, "secrets").get(name)?.blob as Uint8Array | undefined) ?? null),
    has: (name) => this.early(() => T(this.c, "secrets").has(name)),
    put: (name, blob) => this.command(() => void T(this.c, "secrets").put({ name, blob })),
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
    if (!s) this.providerStores.set(accountId, (s = new IdbProviderStore(this.c, accountId, (fn) => this.command(fn), (fn) => this.read(fn))));
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
      const stored = await readAll(this.idb);
      await this.exclusive(async () => {
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
      });
    },
  };

  readonly dev: MailStore["dev"] = {
    seed: async (data, options) => {
      const dataset = data as MockDataset;
      const now = options.now ?? Date.now();
      const rate = options.categorizeRate ?? 0.7;
      this.seeding = true;
      try {
        const accountIds = await this.command(() => dataset.accounts.map((a) => createAccount(this.c, { kind: a.kind, email: a.email, displayName: a.displayName, color: a.color }, now).id));
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
