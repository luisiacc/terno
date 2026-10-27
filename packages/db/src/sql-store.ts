import { attachmentMessageBudgetAsync } from "@terno/core";
import { appendAsset, assetError, assetRef, assetRow, createAsset, ASSET_CLEANUP_STEPS, cleanupAssets, validateAssetCreation, linkAssets, sealAsset, stageAttachments, validateAssets } from "@terno/store";
import { sqlAssets, replaceAttachments } from "./attachments";
import { senderVetoed, type Address, type FilterAction, type ThreadAction, type ThreadSummary } from "@terno/core";
import { RpcError } from "@terno/core/rpc";
import { L } from "@terno/i18n";
import type { MockDataset } from "@terno/mock-data";
import {
  type AddedBy,
  type ClassifierInput,
  type Cursor,
  type IncomingMessage,
  type IndexBatch,
  type MailStore,
  type ModelDelta,
  type Platform,
  type ProviderStore,
  type Revision,
  type SearchCursor,
  type SearchFeed,
  type AutocompleteSource,
  type SearchRequest,
  type StoreCapabilities,
  type StoreSnapshot,
  type StoreSearchPage,
} from "@terno/store";
import { InstantSearch, type InstantSearchOptions } from "@terno/store/instant";
import { applyMessageAction, applyThreadAction, restoreMessages, type ActionResult } from "./actions";
import {
  addToCategory,
  backfillCandidates,
  backfillExamples,
  backgroundCandidates,
  batchThreads,
  beginMove,
  classifyNewThreads,
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
  rejectSuggestion,
  removeFromCategory,
  restoreMoveSlice,
  rootRefs,
  saveSnapshot,
  suggestBackfill,
  threadFeatures,
  trainMoveSlice,
  undoBatchPart,
  undoMoveBegin,
  undoMoveSlice,
  applyMoveSlice,
  unfinishedMoves,
  vetoesFor,
  type ClassifyResult,
} from "./categorize";
import { autoReasons, categoryStats, countScope, pendingSuggestions, predictThread, quickActions, resolveScope } from "./categorize-bulk";
import { startCheckpointWorker, type CheckpointWorker } from "./checkpoint";
import { adoptProviderThread, deleteMessages, findIngestMessage, ingestMessages, recomputeThreads, setMessageBody } from "./ingest";
import { answeredThreads, backfillSlice, factsIdle, ownMailChanged, referencesOfOwn, resetFacts, startRescan } from "./facts";
import { changeOwner, claimOwner, getOwner } from "./owner";
import { countScopeThreads, getCounts, getSummaries, getThread, listThreads, scopeThreadIds, SUMMARY_COLUMNS, toSummary, type SummaryRow } from "./queries";
import {
  accountStamp,
  addThreadsToCategory,
  awaitAuthOp,
  releaseOp,
  claimFilterApplications,
  claimReadyOps,
  completeOp,
  createAccount,
  createCategory,
  deleteCategory,
  deleteDraft,
  deleteFilter,
  deleteSecret,
  dismissedKeys,
  dismissSuggestion,
  enqueueOp,
  failOp,
  getAccount,
  getAccountConfig,
  getFilter,
  getOp,
  getSecret,
  secretNames,
  getSetting,
  learnedFilterKeys,
  listAccounts,
  listCategories,
  listDrafts,
  listFilters,
  listRecentOps,
  loadUserActions,
  markOpUnknown,
  messagesWithPendingOps,
  putSecret,
  recordUserActions,
  recoverOps,
  removeAccount,
  resumeAuthOps,
  resumeNetworkOps,
  nextOpAttemptAt,
  saveDraft,
  messageRef,
  findMessageByRef,
  saveFilter,
  setAccountProviderConfig,
  setAccountCursor,
  setAccountSyncState,
  setSetting,
  updateAccount,
  updateCategory,
  reorderCategories,
} from "./repos";
import { beginSearchBuild, materializeChanges, searchChangeIds, searchHead } from "./outbox";
import { SEARCH_SCHEMA_VERSION } from "./migrations";
import { findRuleMatches } from "./rules";
import { ftsTermMessages, resolveQuery } from "./search";
import { Fts5SearchEngine } from "./search-engine";
import { messageDocs, threadDocs } from "./search-docs";
import { seedDataset } from "./seed";
import { SqlProviderStore } from "./sql-provider-store";
import { sqlAutocompleteSource } from "./autocomplete";
import type { Db } from "./sqlite";

/** Ids read per slice when the feed serves a large commit (500 thread docs read in ~1 ms). */
const MATERIALIZE_SLICE = 500;

/** Counted up to here: "how much mail can't be searched yet" never pays for a huge count. */
const PENDING_BODIES_CAP = 1000;

const FLAG_COLUMNS: Record<string, string> = {
  isRead: "is_read",
  isStarred: "is_starred",
  inInbox: "in_inbox",
  isTrash: "is_trash",
  isSpam: "is_spam",
  isSent: "is_sent",
  isDraft: "is_draft",
};

const NO_CLASSIFICATION: ClassifyResult = { deltas: [], auto: new Map(), touched: new Set(), suggested: 0, uncertain: [], backfill: 0 };

export interface SqlMailStoreOptions {
  /** run WAL checkpoints on the driver's worker (desktop) */
  checkpointWorker?: boolean;
  log?: (level: "info" | "warn" | "error", message: string, extra?: unknown) => void;
  /**
   * Answer searches from the in-memory instant index whenever it is exactly
   * at the store's revision (FTS5 otherwise). Its snapshot lives beside the
   * database when the platform has files.
   */
  instantSearch?: boolean | Omit<InstantSearchOptions, "feed" | "platform" | "snapshotPath" | "identity" | "phrases" | "log">;
  /** yields for background slices and files for the search snapshot */
  platform?: Pick<Platform, "yield" | "files">;
}

/**
 * MailStore over the shared SQL layer. Each command is one synchronous
 * transaction: nothing can interleave inside it, and its Promise resolves
 * after it committed. The composite transactions that used to live in the
 * backend (ingestion with filters and classification, actions with their
 * ops, op completion, sends) are here, calling the same functions.
 */
export class SqlMailStore implements MailStore {
  readonly capabilities: StoreCapabilities;
  private readonly fts: Fts5SearchEngine;
  private readonly checkpointer: CheckpointWorker | null;
  private readonly providerStores = new Map<number, ProviderStore>();
  private readonly log: NonNullable<SqlMailStoreOptions["log"]>;

  /** the in-memory index searches use when it is current (instantSearch option) */
  readonly instant: InstantSearch | null;
  readonly autocomplete: AutocompleteSource;

  private readonly yieldTo: () => Promise<void>;

  constructor(
    readonly db: Db,
    options: SqlMailStoreOptions = {},
  ) {
    this.fts = new Fts5SearchEngine(db);
    const platform = options.platform ?? { yield: () => new Promise<void>((r) => setTimeout(r, 0)) };
    this.yieldTo = () => platform.yield();
    this.log = options.log ?? (() => {});
    this.checkpointer = options.checkpointWorker ? startCheckpointWorker(db) : null;
    if (options.instantSearch) {
      this.instant = new InstantSearch({
        ...(options.instantSearch === true ? {} : options.instantSearch),
        feed: this.feed,
        platform,
        snapshotPath: db.path === ":memory:" ? null : `${db.path}.search`,
        identity: `sqlite-schema-${SEARCH_SCHEMA_VERSION}`,
        // inside the store's unit of work, like the engine's own answer
        phrases: (term) => ftsTermMessages(db, term),
        log: this.log,
      });
      db.onCommit(() => this.instant?.notify());
      this.instant.start();
    } else this.instant = null;
    this.autocomplete = sqlAutocompleteSource(db, this.yieldTo, `sqlite-${SEARCH_SCHEMA_VERSION}`);
    this.capabilities = {
      engine: `sqlite-${db.driver.id}`,
      search: this.instant ? `instant+${this.fts.id}` : this.fts.id,
      bulkRuleScan: "indexed",
      imapLocations: true,
      externalReaders: db.driver.features.externalReaders,
      durability: "fsync",
    };
  }

  get isOpen(): boolean {
    return this.db.isOpen;
  }

  /** Bulk writers between slices: lets the WAL checkpoint catch up so the WAL starts over (see CheckpointWorker.settle). */
  async settle(): Promise<void> {
    await this.checkpointer?.settle();
  }

  async close(): Promise<void> {
    // writes the snapshot of what changed since the last one
    await this.instant?.close();
    await this.checkpointer?.stop();
    this.db.close();
  }

  /** The revision searches answer at: the head of the search log, read in the same unit as the answer. */
  private revision(): Revision {
    return searchHead(this.db);
  }

  readonly feed: SearchFeed = {
    head: async () => searchHead(this.db),
    changes: async (after, through, maxCommits) => {
      const batches: IndexBatch[] = [];
      for (const c of searchChangeIds(this.db, after, through, maxCommits)) {
        // a large commit (a 5,000-thread move) is read in slices: each doc is still the newest committed state
        // when read, never older than its batch, which is all replaying needs to converge
        const changes = materializeChanges(this.db, c.messageIds.slice(0, MATERIALIZE_SLICE), c.threadIds.slice(0, MATERIALIZE_SLICE));
        for (let m = MATERIALIZE_SLICE, t = MATERIALIZE_SLICE; m < c.messageIds.length || t < c.threadIds.length; m += MATERIALIZE_SLICE, t += MATERIALIZE_SLICE) {
          await this.yieldTo();
          if (!this.db.isOpen) throw new Error("the store closed");
          changes.push(...materializeChanges(this.db, c.messageIds.slice(m, m + MATERIALIZE_SLICE), c.threadIds.slice(t, t + MATERIALIZE_SLICE)));
        }
        batches.push({ from: c.from, to: c.to, changes });
      }
      return batches;
    },
    beginBuild: async () => beginSearchBuild(this.db),
  };

  /**
   * One synchronous unit: the revision, the engine's answer and the
   * hydration see the same committed state. RAM answers only when it is
   * exactly at that revision; FTS5 answers otherwise (building, catching up,
   * disabled), with the same results.
   */
  private searchPage(req: SearchRequest): StoreSearchPage {
    const revision = this.revision();
    const ram = this.instant?.at(revision);
    let page: { items: ThreadSummary[]; nextCursor: SearchCursor | null; strategy: string };
    if (ram) {
      const ids = ram.search(req, revision);
      page = { items: summariesInOrder(this.db, ids.threadIds), nextCursor: ids.nextCursor, strategy: ids.strategy };
    } else page = this.fts.page(req, revision);
    const pendingBodies = this.db.get<{ c: number }>(
      "SELECT count(*) AS c FROM (SELECT 1 FROM messages WHERE body_state != 'full' LIMIT ?)",
      PENDING_BODIES_CAP,
    )!.c;
    return { items: page.items, nextCursor: page.nextCursor, revision, strategy: page.strategy, complete: true, pendingBodies };
  }

  // ───────────────────────────── threads ─────────────────────────────

  readonly threads: MailStore["threads"] = {
    list: async (p) => listThreads(this.db, p),
    summaries: async (ids) => getSummaries(this.db, ids),
    scopeIds: async (p) => scopeThreadIds(this.db, p),
    scopeCount: async (p) => countScopeThreads(this.db, p),
    get: async (id) => {
      const thread = getThread(this.db, id);
      if (!thread) return null;
      return { ...thread, categorization: { auto: autoReasons(this.db, id), suggestions: pendingSuggestions(this.db, { threadId: id, limit: 5 }) } };
    },
    counts: async (now) => getCounts(this.db, now),
    search: async (req) => this.searchPage(req),
    searchText: async (p) => {
      const search = resolveQuery(this.db, p);
      return this.searchPage({ search, cursor: p.cursor ? withKey(p.cursor, search.key, this.revision()) : undefined, limit: p.limit });
    },
    act: async ({ threadIds, action, signal, now }) =>
      this.db.tx(() => {
        const r = applyThreadAction(this.db, [...new Set(threadIds)], action);
        // only actions that changed something feed learned filters (repeats must not manufacture support)
        if (signal && r.threadIds.length) recordUserActions(this.db, r.threadIds, signal, now);
        return { threadIds: r.threadIds, opIds: this.queueActionOps(r, action, now), before: r.before };
      }),
    restore: async ({ messages, now }) =>
      this.db.tx(() => {
        const r = restoreMessages(this.db, messages);
        const opIds: string[] = [];
        for (const op of r.ops) {
          const id = enqueueOp(this.db, { accountId: op.accountId, kind: op.kind, target: { messageIds: op.messageIds } }, now);
          if (id) opIds.push(id);
        }
        return { threadIds: r.threadIds, opIds };
      }),
  };

  /** Provider ops for a locally applied action, one per account. */
  private queueActionOps(result: ActionResult, action: ThreadAction, now: number): string[] {
    const ids: string[] = [];
    for (const target of result.targets) {
      const id = enqueueOp(this.db, { accountId: target.accountId, kind: action, target: { messageIds: target.messageIds } }, now);
      if (id) ids.push(id);
    }
    return ids;
  }

  // ───────────────────────────── filters on incoming mail ─────────────────────────────

  /** Enabled filters on new (or newly body-complete) messages. Automated: never a learning signal. */
  private applyFiltersTo(messageIds: readonly number[], onlyBodyFilters: boolean, now: number, opIds: string[]): Set<number> {
    const touched = new Set<number>();
    if (messageIds.length === 0) return touched;
    for (const filter of listFilters(this.db)) {
      if (!filter.enabled) continue;
      if (onlyBodyFilters && !filter.rule.conditions.some((c) => c.field === "body")) continue;
      const matches = findRuleMatches(this.db, filter.rule, now, messageIds);
      if (matches.messageIds.length === 0) continue;
      try {
        // claims + actions + ops atomically (a savepoint inside the command)
        const changed = this.db.tx(() => this.runFilterActions(filter.rule.actions, claimFilterApplications(this.db, filter.id, matches.messageIds, now), now, opIds));
        for (const id of changed) touched.add(id);
      } catch (error) {
        // e.g. the filter points at a deleted category: skip it, keep ingesting
        this.log("warn", `filter ${filter.id} (${filter.name}) failed`, error instanceof Error ? error.message : error);
      }
    }
    return touched;
  }

  private runFilterActions(actions: FilterAction[], messageIds: number[], now: number, opIds: string[]): Set<number> {
    const touched = new Set<number>();
    if (messageIds.length === 0) return touched;
    for (const action of actions) {
      if (action.type === "addCategory") {
        const threads = this.db
          .all<{ thread_id: number }>("SELECT DISTINCT thread_id FROM messages WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(messageIds))
          .map((r) => r.thread_id);
        addThreadsToCategory(this.db, action.categoryId, threads, "filter", now);
        for (const t of threads) touched.add(t);
      } else {
        const result = applyMessageAction(this.db, messageIds, action.type);
        opIds.push(...this.queueActionOps(result, action.type, now));
        for (const t of result.threadIds) touched.add(t);
      }
    }
    return touched;
  }

  private classify(classifier: ClassifierInput | null, inserted: readonly number[], bodyCompleted: readonly number[], now: number): ClassifyResult {
    if (!classifier) return NO_CLASSIFICATION;
    return classifyNewThreads(this.db, { inserted, bodyCompleted, now, mode: classifier.mode, model: classifier.model });
  }

  // ───────────────────────────── sync ─────────────────────────────

  readonly sync: MailStore["sync"] = {
    // Messages, filter claims, filter actions and their ops, and the categorizer's decisions
    // commit together: a crash can't record a filter as applied without its effects, nor an
    // auto-categorization without its message.
    ingest: async (batch, { applyFilters, now, classifier }) => {
      const staged: IncomingMessage[] = [];
      for (const m of batch) {
        const existing = !m.captureUnavailable && m.attachments?.length ? findIngestMessage(this.db, m) : undefined;
        staged.push(m.captureUnavailable || m.attachments === undefined ? m : { ...m, attachments: await stageAttachments(this, m.accountId, m.attachments, now, this.yieldTo, existing ? await this.attachments.current(m.accountId, { id: existing.id }) : []) });
      }
      return this.db.tx(() => {
        const result = ingestMessages(this.db, staged as IncomingMessage[], now);
        const touched = new Set(result.touchedThreads);
        const opIds: string[] = [];
        if (applyFilters) {
          for (const t of this.applyFiltersTo(result.inserted, false, now, opIds)) touched.add(t);
          // bodies that arrived through an upsert may now satisfy body filters
          for (const t of this.applyFiltersTo(result.bodyCompleted, true, now, opIds)) touched.add(t);
        }
        const c = this.classify(classifier, result.inserted, result.bodyCompleted, now);
        for (const t of c.touched) touched.add(t);
        return { inserted: result.inserted, touched: [...touched], deltas: [...result.deltas, ...c.deltas], auto: c.auto, backfill: c.backfill, uncertain: c.uncertain, opIds };
      });
    },
    setBody: async (messageId, text, html, { now, classifier, attachments, captureUnavailable }) => {
      const accountId = this.db.get<{ account_id: number }>("SELECT account_id FROM messages WHERE id = ?", messageId)?.account_id;
      const staged = !captureUnavailable && attachments !== undefined && accountId !== undefined ? await stageAttachments(this, accountId, attachments, now, this.yieldTo, await this.attachments.current(accountId, { id: messageId })) : undefined;
      return this.db.tx(() => {
        setMessageBody(this.db, messageId, text, html, captureUnavailable ? "partial" : "full");
        if (staged !== undefined && !captureUnavailable) replaceAttachments(this.db, messageId, staged);
        const owner = this.db.get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE id = ?", messageId);
        if (captureUnavailable) this.db.run("UPDATE messages SET attachments_captured = 2 WHERE id = ?", messageId);
        if (owner) recomputeThreads(this.db, [owner.thread_id]);
        if (captureUnavailable) return { touched: owner ? [owner.thread_id] : [], deltas: [], auto: new Map(), opIds: [] };
        const opIds: string[] = [];
        const touched = this.applyFiltersTo([messageId], true, now, opIds);
        // the body was the missing piece: reclassify once
        const c = this.classify(classifier, [], [messageId], now);
        for (const t of c.touched) touched.add(t);
        if (owner) touched.add(owner.thread_id);
        return { touched: [...touched], deltas: c.deltas, auto: c.auto, opIds };
      });
    },
    updateFlags: async (accountId, updates) =>
      this.db.tx(() => {
        // read inside this unit: a user action committed just before is honoured
        const pending = messagesWithPendingOps(this.db, accountId);
        const threads = new Set<number>();
        for (const u of updates) {
          // optimistic local state wins until its op settles; Gmail's labels aren't optimistic state (Codex review 2, #5)
          if (pending.has(u.messageId)) {
            const r = u.gmailLabels ? this.db.get<{ thread_id: number }>("UPDATE messages SET gmail_labels = ? WHERE id = ? AND account_id = ? RETURNING thread_id", JSON.stringify(u.gmailLabels), u.messageId, accountId) : undefined;
            if (r) threads.add(r.thread_id);
            continue;
          }
          const sets: [string, number | string][] = Object.entries(u.flags)
            .filter(([k]) => FLAG_COLUMNS[k])
            .map(([k, v]) => [FLAG_COLUMNS[k]!, v ? 1 : 0]);
          // plan 17 (Codex review 1, #8): Gmail's category moves (Promotions ↔ Primary) change who a message is from
          if (u.gmailLabels) sets.push(["gmail_labels", JSON.stringify(u.gmailLabels)]);
          if (!sets.length) continue;
          // plan 17 (Codex R4): a message becoming sent, or a draft, is your mail appearing or going
          const sentOrDraft = "isSent" in u.flags || "isDraft" in u.flags;
          const before = sentOrDraft ? this.db.get<{ is_sent: number; is_draft: number }>("SELECT is_sent, is_draft FROM messages WHERE id = ? AND account_id = ?", u.messageId, accountId) : undefined;
          const r = this.db.get<{ thread_id: number; is_sent: number; is_draft: number }>(
            `UPDATE messages SET ${sets.map(([c]) => `${c} = ?`).join(", ")} WHERE id = ? AND account_id = ? RETURNING thread_id, is_sent, is_draft`,
            ...sets.map(([, v]) => v),
            u.messageId,
            accountId,
          );
          if (!r) continue;
          threads.add(r.thread_id);
          if (before && (before.is_sent !== r.is_sent || before.is_draft !== r.is_draft)) for (const t of ownMailChanged(this.db, u.messageId)) threads.add(t);
        }
        recomputeThreads(this.db, threads);
        return { touched: [...threads] };
      }),
    remove: async (ids) => ({ touched: [...deleteMessages(this.db, ids)] }),
    pendingMessageIds: async (accountId) => messagesWithPendingOps(this.db, accountId),
  };

  // ───────────────────────────── ops ─────────────────────────────

  readonly ops: MailStore["ops"] = {
    claimReady: async (now, limit) => claimReadyOps(this.db, now, limit),
    get: async (id) => getOp(this.db, id),
    complete: async (id, result, now) =>
      this.db.tx(() => {
        const op = getOp(this.db, id);
        completeOp(this.db, id, now);
        const touched: number[] = [];
        const deltas: ModelDelta[] = [];
        if (!op) return { touched, deltas };
        if (op.kind === "send") sqlAssets(this.db).unlink("op", id);
        if (result?.warning) this.db.run("UPDATE ops SET last_error = ? WHERE id = ?", result.warning, id);
        const localId = (JSON.parse(op.target_json) as { messageIds?: number[] }).messageIds?.[0];
        if (op.kind === "send" && result && localId) {
          if (result.providerMsgId) {
            this.db.run("UPDATE messages SET provider_msg_id = ? WHERE id = ? AND provider_msg_id LIKE 'local:%'", result.providerMsgId, localId);
          }
          if (result.providerThreadId) {
            // a conversation we started gets its Gmail thread id, so replies land in it
            const row = this.db.get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE id = ?", localId);
            if (row) touched.push(adoptProviderThread(this.db, row.thread_id, op.account_id, result.providerThreadId, undefined, deltas));
          }
        }
        return { touched, deltas };
      }),
    fail: async (id, error, retryable, now, park) =>
      this.db.tx(() => {
        const current = getOp(this.db, id);
        if (current && current.state !== "running") return current.state;
        const state = failOp(this.db, id, error, retryable, now, park);
        // plan 17 (Codex R8): a send that failed answered nobody; its thread and what it replied to count again
        const op = state === "failed" ? getOp(this.db, id) : null;
        const localId = op?.kind === "send" ? (JSON.parse(op.target_json) as { messageIds?: number[] }).messageIds?.[0] : undefined;
        if (localId !== undefined) {
          const row = this.db.get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE id = ?", localId);
          recomputeThreads(this.db, new Set([...(row ? [row.thread_id] : []), ...answeredThreads(this.db, referencesOfOwn(this.db, [localId]))]));
        }
        return state;
      }),
    markUnknown: async (id, error, now) => markOpUnknown(this.db, id, error, now),
    awaitAuth: async (id, error, now) => awaitAuthOp(this.db, id, error, now),
    release: async (id, now) => releaseOp(this.db, id, now),
    resumeAuth: async (accountId, now) => this.db.tx(() => resumeAuthOps(this.db, accountId, now)),
    resumeNetwork: async (accountId, now) => this.db.tx(() => resumeNetworkOps(this.db, accountId, now)),
    recover: async (now) => recoverOps(this.db, now),
    nextAttemptAt: async () => nextOpAttemptAt(this.db),
    recent: async (limit) => listRecentOps(this.db, limit),
    resolveUnknown: async (id, resolution, now) =>
      this.db.tx(() => {
        const op = getOp(this.db, id);
        if (!op || op.state !== "unknown") throw new RpcError("NOT_FOUND", L("errors.opResolved"));
        if (resolution === "markSent") {
          completeOp(this.db, id, now);
          if (op.kind === "send") sqlAssets(this.db).unlink("op", id);
          return { touched: [] };
        }
        if (resolution === "retry") {
          this.db.run("UPDATE ops SET state = 'queued', next_attempt_at = 0, last_error = NULL WHERE id = ?", id);
          return { touched: [] };
        }
        this.db.run("UPDATE ops SET state = 'failed', last_error = 'Discarded by user' WHERE id = ?", id);
        const target = JSON.parse(op.target_json) as { messageIds?: number[] };
        if (op.kind === "send" && target.messageIds?.length) {
          const local = this.db.get<{ id: number }>("SELECT id FROM messages WHERE id = ? AND provider_msg_id LIKE 'local:%'", target.messageIds[0]!);
          // deleteMessages recomputes (or deletes) the thread so no empty Sent entry remains
          if (local) return { touched: [...deleteMessages(this.db, [local.id])] };
        }
        return { touched: [] };
      }),
  };

  // ───────────────────────────── compose ─────────────────────────────

  readonly attachments: MailStore["attachments"] = {
    current: async (accountId, message) => this.db.all<{ filename: string; mime: string; size: number; assetId?: string; contentId: string | null }>(
      `SELECT a.filename, a.mime, a.size, a.asset_id AS assetId, a.content_id AS contentId FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.account_id = ? AND ${"id" in message ? "m.id" : "m.provider_msg_id"} = ? ORDER BY a.id`, accountId, "id" in message ? message.id : message.providerMsgId,
    ),
    retry: async (accountId, messageId) => this.db.tx(() => {
      const r = this.db.get<{ account_id: number }>("SELECT account_id FROM messages WHERE id = ?", messageId);
      if (r?.account_id !== accountId) throw assetError();
      this.db.run("UPDATE messages SET attachments_captured = 0 WHERE id = ?", messageId);
    }),
    create: async (p) => {
      p = { ...p };
      await this.db.tx(() => { const db = sqlAssets(this.db); validateAssetCreation(db, p); db.beginOrphanGrace(p.accountId, p.now); });
      // Finite even if another caller adds backdated uploads between maintenance units.
      for (let remaining = ASSET_CLEANUP_STEPS; remaining > 0; remaining--) {
        if (!await this.db.tx(() => cleanupAssets(sqlAssets(this.db), p.accountId, p.now))) break;
        await this.yieldTo();
      }
      return this.db.tx(() => createAsset(sqlAssets(this.db), () => this.db.uuid(), p));
    },
    append: async (accountId, id, index, data) => this.db.tx(() => appendAsset(sqlAssets(this.db), accountId, id, index, data)),
    seal: async (accountId, id) => this.db.tx(() => sealAsset(sqlAssets(this.db), accountId, id)),
    info: async (accountId, id) => assetRef(assetRow(sqlAssets(this.db), accountId, id)),
    read: async (accountId, id, index) => Promise.resolve().then(() => { assetRow(sqlAssets(this.db), accountId, id); if (!Number.isSafeInteger(index) || index < 0) throw assetError(); return sqlAssets(this.db).chunk(`${id}:${index}`) ?? null; }),
    discard: async (accountId, id) => this.db.tx(() => { const db = sqlAssets(this.db); assetRow(db, accountId, id, false); if (db.pinned(id)) throw assetError(); db.remove(id); }),
  };

  readonly compose: MailStore["compose"] = {
    // Optimistic local copy + durable send op, atomically: a crash can't lose or duplicate the send.
    queueSend: async (p) => {
      p = structuredClone(p);
      if (!await attachmentMessageBudgetAsync(p.bodyText, p.bodyHtml, p.attachments ?? [], this.yieldTo)) throw new RpcError("BAD_REQUEST", L("attachments.tooLarge"));
      return this.db.tx(() => {
        const account = getAccount(this.db, p.accountId);
        if (!account) throw new RpcError("NOT_FOUND", L("errors.accountGone"));
        const cfg = getAccountConfig<{ senderName?: string }>(this.db, p.accountId)!;
        const from: Address = { name: cfg.config.senderName || account.displayName, email: account.email };
        // a draft is sent once: sending deletes it, so a second send of the same draft finds nothing
        const draft = p.draftId === undefined ? undefined : this.db.get<{ account_id: number; revision: number; attachments_json: string }>("SELECT account_id, revision, attachments_json FROM drafts WHERE id = ?", p.draftId);
        if (p.draftId !== undefined && (!draft || draft.account_id !== p.accountId || (p.draftRevision !== undefined && p.draftRevision !== draft.revision))) throw new RpcError("STALE", L("errors.draftGone"));
        if (draft && p.attachments === undefined && JSON.parse(draft.attachments_json ?? "[]").length) throw assetError();
        const attachments = validateAssets(sqlAssets(this.db), p.accountId, p.attachments ?? []);
        let inReplyTo: string | null = null;
        let references: string[] = [];
        let providerThreadId: string | null = null;
        let replyThreadId: number | null = null;
        if (p.inReplyToMessageId) {
          const original = this.db.get<{ rfc_message_id: string | null; references_json: string; thread_id: number; account_id: number }>(
            "SELECT rfc_message_id, references_json, thread_id, account_id FROM messages WHERE id = ?",
            p.inReplyToMessageId,
          );
          if (!original) throw new RpcError("NOT_FOUND", L("errors.originalGone"));
          inReplyTo = original.rfc_message_id;
          references = [...(JSON.parse(original.references_json) as string[]), ...(original.rfc_message_id ? [original.rfc_message_id] : [])];
          replyThreadId = original.thread_id;
          if (original.account_id === p.accountId) {
            providerThreadId = this.db.get<{ provider_thread_id: string | null }>("SELECT provider_thread_id FROM threads WHERE id = ?", original.thread_id)!.provider_thread_id;
          }
        }
        const messageId = `${this.db.uuid()}@${account.email.split("@")[1] || "terno.local"}`;
        const payload = { ...(attachments.length ? { attachments } : {}), from, to: p.to, cc: p.cc, bcc: p.bcc, subject: p.subject, text: p.bodyText, ...(p.bodyHtml ? { html: p.bodyHtml } : {}), messageId, inReplyTo, references, providerThreadId };
        const ingest = ingestMessages(
          this.db,
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
        const opId = enqueueOp(this.db, { accountId: p.accountId, kind: "send", target: { messageIds: [localId] }, payload }, p.now)!;
        linkAssets(sqlAssets(this.db), "op", opId, attachments);
        if (p.draftId) deleteDraft(this.db, p.draftId);
        if (replyThreadId && p.recordReply) recordUserActions(this.db, [replyThreadId], "reply", p.now);
        const threadId = this.db.get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE id = ?", localId)!.thread_id;
        return { opId, threadId, deltas: ingest.deltas };
      });
    },
  };

  // ───────────────────────────── filters ─────────────────────────────

  readonly filters: MailStore["filters"] = {
    list: async () => listFilters(this.db),
    get: async (id) => getFilter(this.db, id),
    save: async (f, now) => saveFilter(this.db, f, now),
    delete: async (id) => deleteFilter(this.db, id),
    preview: async (rule, now, limit) => {
      const matches = findRuleMatches(this.db, rule, now);
      const top = this.db
        .all<{ id: number }>(
          "SELECT id FROM threads WHERE id IN (SELECT value FROM json_each(?)) ORDER BY last_date DESC, id DESC LIMIT ?",
          JSON.stringify(matches.threadIds),
          limit,
        )
        .map((r) => r.id);
      return { count: matches.threadIds.length, sample: getSummaries(this.db, top) };
    },
    messageIdRange: async () => {
      const r = this.db.get<{ lo: number | null; hi: number | null }>("SELECT min(id) AS lo, max(id) AS hi FROM messages")!;
      return r.lo === null || r.hi === null ? null : { lo: r.lo, hi: r.hi };
    },
    matchWindow: async (rule, now, window) => findRuleMatches(this.db, rule, now, undefined, window).messageIds,
    applyChunk: async (id, ruleJson, messageIds, now) =>
      this.db.tx(() => {
        // edited (or deleted) while it was being applied: stop, don't recreate stale claims
        const current = this.db.get<{ rule_json: string }>("SELECT rule_json FROM filters WHERE id = ?", id);
        if (!current || current.rule_json !== ruleJson) throw new RpcError("CANCELLED", L("errors.filterChanged"));
        const rule = JSON.parse(ruleJson) as { actions: FilterAction[] };
        const ids = claimFilterApplications(this.db, id, messageIds, now);
        const opIds: string[] = [];
        const touched = this.runFilterActions(rule.actions, ids, now, opIds);
        return { applied: ids.length, touched: [...touched], opIds };
      }),
  };

  // ───────────────────────────── categories ─────────────────────────────

  readonly categories: MailStore["categories"] = {
    list: async () => listCategories(this.db),
    exists: async (id) => this.db.get("SELECT 1 FROM categories WHERE id = ?", id) !== undefined,
    create: async (name, color) => createCategory(this.db, name, color),
    update: async (id, patch) => updateCategory(this.db, id, patch),
    reorder: async (ids) => reorderCategories(this.db, ids),
    delete: async (id) => this.db.tx(() => deleteCategory(this.db, id)),
    createBatch: async (categoryId, source, scope, now) => createBatch(this.db, categoryId, source, scope, now),
    add: async (a) =>
      this.db.tx(() => {
        const r = addToCategory(this.db, a);
        if (a.batchId != null) finishBatch(this.db, a.batchId, r.added.length);
        return r;
      }),
    remove: async (r) => removeFromCategory(this.db, r),
    batchThreads: async (batchId) => batchThreads(this.db, batchId),
    undoBatchPart: async (batchId, threadIds, now) => undoBatchPart(this.db, batchId, threadIds, now),
    finishUndo: async (batchId, now) => finishUndo(this.db, batchId, now),
    beginMove: async (m) => beginMove(this.db, m),
    moveOutcome: async (batchId) => moveOutcome(this.db, batchId),
    movePhase: async (batchId) => movePhase(this.db, batchId),
    movePending: async (batchId) => movePending(this.db, batchId),
    unfinishedMoves: async () => unfinishedMoves(this.db),
    trainMoveSlice: async (batchId, threadIds, now) => trainMoveSlice(this.db, batchId, threadIds, now),
    applyMoveSlice: async (batchId, threadIds, now) => applyMoveSlice(this.db, batchId, threadIds, now),
    undoMoveBegin: async (batchId, now) => undoMoveBegin(this.db, batchId, now),
    undoMoveSlice: async (batchId, threadIds, now) => undoMoveSlice(this.db, batchId, threadIds, now),
    restoreMoveSlice: async (batchId, threadIds) => restoreMoveSlice(this.db, batchId, threadIds),
  };

  readonly categorize: MailStore["categorize"] = {
    quickActions: async (categoryId, threadIds, model) => quickActions(this.db, categoryId, threadIds, model),
    countScope: async (categoryId, scope, now) => countScope(this.db, categoryId, scope, now),
    resolveScope: async (categoryId, scope, now, limit) => resolveScope(this.db, categoryId, scope, now, limit),
    predict: async (threadId, model, mode, now) => predictThread(this.db, threadId, model, mode, now),
    pendingSuggestions: async (o) => pendingSuggestions(this.db, o),
    reject: async (threadId, categoryId, now) => rejectSuggestion(this.db, threadId, categoryId, now),
    stats: async () => categoryStats(this.db),
    loadSnapshot: async () => ({ snapshot: loadSnapshot(this.db), fingerprint: examplesFingerprint(this.db) }),
    saveSnapshot: async (s) => saveSnapshot(this.db, { ...s, fingerprint: examplesFingerprint(this.db) }),
    backfillExamples: async (limit) => backfillExamples(this.db, limit),
    examples: async () => loadExamples(this.db),
    examplesPage: async (after, limit) => loadExamplesPage(this.db, after, limit),
    backgroundCandidates: async (now) => backgroundCandidates(this.db, now),
    threadFeatures: async (threadIds) => threadFeatures(this.db, threadIds),
    backfillCandidates: async (now) => backfillCandidates(this.db, now),
    suggestBackfill: async (r) => ({ touched: [...suggestBackfill(this.db, r).touched] }),
    matureDecisions: async (now) => matureDecisions(this.db, now),
    aiCandidate: async (threadId) => this.aiCandidate(threadId),
    vetoes: async (threadId, sender, categoryIds, now) => vetoesFor(this.db, threadId, sender, categoryIds, now),
    recordAiSuggestion: async (s) =>
      this.db.tx(() => {
        // the provider took a while: the user or the model may have spoken since
        if (!this.aiCandidate(s.threadId)) return false;
        const v = vetoesFor(this.db, s.threadId, s.sender, [s.categoryId], s.now).get(s.categoryId);
        if (v?.hard || (v && senderVetoed(v)) || s.model.lookAlike(s.encoded)) return false;
        this.db.run(
          "INSERT INTO cls_decisions (thread_id, category_id, kind, p, explain_json, at) VALUES (?, ?, 'suggest', ?, ?, ?)",
          s.threadId,
          s.categoryId,
          s.p,
          JSON.stringify(s.explain),
          s.now,
        );
        return true;
      }),
  };

  /** New-mail-like (inbox, not spam/trash/draft) and nobody decided on it yet. */
  private aiCandidate(threadId: number): boolean {
    const root = rootRefs(this.db, [threadId])[0];
    if (!root || !root.inInbox || root.spam || root.trash || root.draft) return false;
    return !this.db.get(
      `SELECT 1 FROM thread_categories WHERE thread_id = ?1 UNION ALL SELECT 1 FROM cls_decisions WHERE thread_id = ?1
       UNION ALL SELECT 1 FROM cls_examples WHERE thread_id = ?1 LIMIT 1`,
      threadId,
    );
  }

  // ───────────────────────────── accounts, owner ─────────────────────────────

  readonly accounts: MailStore["accounts"] = {
    list: async () => listAccounts(this.db),
    get: async (id) => getAccount(this.db, id),
    config: async <T>(id: number) => getAccountConfig<T>(this.db, id),
    stamp: async (id) => accountStamp(this.db, id),
    create: async (a) =>
      this.db.tx(() => {
        const account = createAccount(this.db, a, a.now);
        // plan 17 (Codex R3): a new address of yours: every thread's facts are checked again, in slices
        startRescan(this.db);
        if (a.secret) putSecret(this.db, `account:${account.id}:${a.secret.key}`, a.secret.blob);
        const claimed = a.ownerClaim ? claimOwner(this.db, { ...a.ownerClaim, email: account.email, accountId: account.id }, a.now) : false;
        return { account, claimed };
      }),
    update: async (id, patch) => updateAccount(this.db, id, patch),
    remove: async (id) =>
      this.db.tx(() => {
        removeAccount(this.db, id);
        // plan 17 (Codex R3, R5): one address fewer, and its replies gone: every thread's facts are checked again
        startRescan(this.db);
        this.db.run("DELETE FROM secrets WHERE name LIKE ?", `account:${id}:%`);
        this.providerStores.delete(id);
      }),
    setSyncState: async (id, patch) => setAccountSyncState(this.db, id, patch),
    setProviderConfig: async (id, config) => setAccountProviderConfig(this.db, id, config),
    setCursor: async (id, cursor) => setAccountCursor(this.db, id, cursor),
  };

  readonly owner: MailStore["owner"] = {
    get: async () => getOwner(this.db),
    confirm: async (c) => this.db.tx(() => {
      const owner = this.db.get(`SELECT 1 FROM owner WHERE id = 1 AND account_id = ? AND email = ? AND display_name = ? AND provider = ? AND verified_by = ? AND evidence_json = ? AND verified_at = ? AND updated_at = ?`, c.claim.accountId, c.claim.email.toLowerCase(), c.claim.displayName, c.claim.provider, c.claim.verifiedBy, JSON.stringify(c.claim.evidence), c.now, c.now);
      return !!owner && this.commitSecret({ kind: "retain", name: c.secret.name, expectedBlob: c.secret.kind === "retain" ? c.secret.expectedBlob : c.secret.blob }, { ...c.stamp, id: c.claim.accountId });
    }),
    change: async (c) =>
      this.db.tx(() => {
        const now = accountStamp(this.db, c.claim.accountId);
        if (!now || now.createdAt !== c.stamp.createdAt || now.email !== c.stamp.email) {
          throw new RpcError("NOT_FOUND", L("errors.accountRemovedWhileVerifying", { email: c.stamp.email }));
        }
        if (c.eligible && c.eligible() !== true) return false;
        if (!this.commitSecret(c.secret, { ...c.stamp, id: c.claim.accountId })) return false;
        changeOwner(this.db, c.claim, c.reason, c.now);
        return true;
      }),
  };

  readonly drafts: MailStore["drafts"] = {
    save: async (d, now) => this.db.tx(() => saveDraft(this.db, d, now)),
    list: async () => listDrafts(this.db),
    delete: async (id) => deleteDraft(this.db, id),
    messageRef: async (id) => messageRef(this.db, id),
    findMessage: async (accountId, rfc) => findMessageByRef(this.db, accountId, rfc),
  };

  readonly settings: MailStore["settings"] = {
    get: async <T>(key: string, fallback: T) => getSetting(this.db, key, fallback),
    set: async (key, value) => setSetting(this.db, key, value),
    update: async <T, R>(key: string, fallback: T, fn: (current: T) => { value: T; result: R }) =>
      this.db.tx(() => {
        const { value, result } = fn(getSetting(this.db, key, fallback));
        setSetting(this.db, key, value);
        return result;
      }),
  };

  private commitSecret(intent: import("@terno/store").SecretIntent, stamp: { id: number; email: string; createdAt: number }): boolean {
    const account = accountStamp(this.db, stamp.id);
    if (!account || account.email !== stamp.email || account.createdAt !== stamp.createdAt) return false;
    const current = getSecret(this.db, intent.name);
    const expected = intent.expectedBlob;
    if (expected === null ? current !== null : !current || current.length !== expected.length || !current.every((b, i) => b === expected[i])) return false;
    if (intent.kind === "replace" && (!current || current.length !== intent.blob.length || !current.every((b, i) => b === intent.blob[i]))) putSecret(this.db, intent.name, intent.blob);
    return true;
  }

  readonly secrets: MailStore["secrets"] = {
    commit: async (intent, stamp) => this.db.tx(() => this.commitSecret(intent, stamp)),
    names: async () => secretNames(this.db),
    get: async (name) => getSecret(this.db, name),
    has: async (name) => getSecret(this.db, name) !== null,
    put: async (name, blob) => putSecret(this.db, name, blob),
    replace: async (name, expected, next, stamp) => this.db.tx(() => {
      const predicate = "name = ? AND blob = ?" + (stamp ? " AND EXISTS (SELECT 1 FROM accounts WHERE id = ? AND email = ? AND created_at = ?)" : "");
      const params = stamp ? [name, expected, stamp.id, stamp.email, stamp.createdAt] : [name, expected];
      if (expected.length === next.length && expected.every((b, i) => b === next[i])) {
        return this.db.get(`SELECT name FROM secrets WHERE ${predicate}`, ...params) !== undefined;
      }
      return this.db.run(`UPDATE secrets SET blob = ? WHERE ${predicate}`, next, ...params).changes === 1;
    }),
    delete: async (name) => deleteSecret(this.db, name),
  };

  readonly learning: MailStore["learning"] = {
    actionsSince: async (since) => loadUserActions(this.db, since),
    excludedKeys: async () => new Set([...dismissedKeys(this.db), ...learnedFilterKeys(this.db)]),
    dismiss: async (key, now) => dismissSuggestion(this.db, key, now),
  };

  providerStore(accountId: number): ProviderStore {
    let s = this.providerStores.get(accountId);
    if (!s) this.providerStores.set(accountId, (s = new SqlProviderStore(this.db, accountId)));
    return s;
  }

  // ───────────────────────────── facts (plan 17) ─────────────────────────────

  readonly facts: MailStore["facts"] = {
    backfill: async ({ limit }) => this.db.tx(() => backfillSlice(this.db, limit)),
    idle: async () => factsIdle(this.db),
  };

  readonly debug: MailStore["debug"] = {
    snapshot: async () => storeSnapshot(this.db),
    verify: async () => {
      // rank=1 compares the index against the external content, not only its own structure
      this.db.exec("INSERT INTO messages_fts(messages_fts, rank) VALUES('integrity-check', 1)");
    },
    resetFacts: async () => resetFacts(this.db),
  };

  readonly dev: MailStore["dev"] = {
    seed: async (data, options) => seedDataset(this.db, data as MockDataset, options),
  };
}

/** Summaries of threads already in (last_date DESC, id DESC) order, in one prepared statement whatever their number. */
function summariesInOrder(db: Db, ids: readonly number[]): ThreadSummary[] {
  if (ids.length === 0) return [];
  return db
    .all<SummaryRow>(`SELECT ${SUMMARY_COLUMNS} FROM threads t WHERE t.id IN (SELECT value FROM json_each(?)) ORDER BY t.last_date DESC, t.id DESC`, JSON.stringify(ids))
    .map(toSummary);
}

/** Keyset-only cursors (older renderers) continue at the current revision; full cursors are checked by the engine. */
function withKey(cursor: Cursor & Partial<Pick<SearchCursor, "revision" | "queryKey">>, key: string, revision: Revision): SearchCursor {
  return { lastDate: cursor.lastDate, id: cursor.id, queryKey: cursor.queryKey ?? key, revision: cursor.revision ?? revision };
}

/** Tests and SQL-only tooling: the database under a SqlMailStore. */
export function sqlDb(store: MailStore): Db {
  if (!(store instanceof SqlMailStore)) throw new Error(`not a SQL store: ${store.capabilities.engine}`);
  return store.db;
}

function storeSnapshot(db: Db): StoreSnapshot {
  const b = (v: unknown) => v === 1;
  const cats = new Map<number, number[]>();
  const memberships = db
    .all<{ thread_id: number; category_id: number; added_by: AddedBy; batch_id: number | null }>("SELECT thread_id, category_id, added_by, batch_id FROM thread_categories ORDER BY thread_id, category_id")
    .map((r) => {
      cats.set(r.thread_id, [...(cats.get(r.thread_id) ?? []), r.category_id]);
      return { threadId: r.thread_id, categoryId: r.category_id, addedBy: r.added_by, batchId: r.batch_id };
    });
  return {
    accounts: db.all("SELECT id, email, display_name FROM accounts ORDER BY id"),
    categories: db.all("SELECT id, name FROM categories ORDER BY id"),
    messages: db.all<Record<string, unknown>>("SELECT m.*, b.body_text FROM messages m LEFT JOIN message_bodies b ON b.message_id = m.id ORDER BY m.id").map((m) => ({
      id: m.id as number,
      threadId: m.thread_id as number,
      accountId: m.account_id as number,
      providerMsgId: m.provider_msg_id as string | null,
      rfcMessageId: m.rfc_message_id as string | null,
      date: m.date as number,
      fromName: m.from_name as string,
      fromEmail: m.from_email as string,
      recipients: m.recipients_text as string,
      subject: m.subject as string,
      bodyText: m.body_text as string | null,
      bodyState: m.body_state as "none" | "partial" | "full",
      listId: m.list_id as string | null,
      hasAttachments: b(m.has_attachments),
      isRead: b(m.is_read),
      isStarred: b(m.is_starred),
      inInbox: b(m.in_inbox),
      isSent: b(m.is_sent),
      isDraft: b(m.is_draft),
      isTrash: b(m.is_trash),
      isSpam: b(m.is_spam),
      toJson: m.to_json as string,
      ccJson: m.cc_json as string,
      replyToJson: m.reply_to_json as string,
      isBulk: b(m.is_bulk),
      gmailLabels: m.gmail_labels as string | null,
      inReplyTo: m.in_reply_to as string | null,
      references: JSON.parse(m.references_json as string) as string[],
    })),
    threads: db.all<Record<string, unknown>>("SELECT * FROM threads ORDER BY id").map((t) => ({
      id: t.id as number,
      accountId: t.account_id as number,
      providerThreadId: t.provider_thread_id as string | null,
      subject: t.subject as string,
      snippet: t.snippet as string,
      lastDate: t.last_date as number,
      lastFromName: t.last_from_name as string,
      lastFromEmail: t.last_from_email as string,
      messageCount: t.message_count as number,
      unreadCount: t.unread_count as number,
      hasAttachments: b(t.has_attachments),
      isStarred: b(t.is_starred),
      inInbox: b(t.in_inbox),
      hasSent: b(t.has_sent),
      inTrash: b(t.in_trash),
      inSpam: b(t.in_spam),
      categoryIds: cats.get(t.id as number) ?? [],
      person: t.person === null ? null : t.person === 1,
      waitingSince: t.waiting_since as number | null,
    })),
    memberships,
    examples: db
      .all<{ thread_id: number; category_id: number; label: 1 | -1; source: string; weight: number; content: number; sender: string; batch_id: number | null }>(
        "SELECT thread_id, category_id, label, source, weight, content, sender, batch_id FROM cls_examples ORDER BY thread_id, category_id",
      )
      .map((e) => ({ threadId: e.thread_id, categoryId: e.category_id, label: e.label, source: e.source, weight: e.weight, content: e.content === 1, sender: e.sender, batchId: e.batch_id })),
    ops: db
      .all<{ id: string; account_id: number; kind: string; state: StoreSnapshot["ops"][number]["state"]; attempts: number; target_json: string }>("SELECT id, account_id, kind, state, attempts, target_json FROM ops ORDER BY seq")
      .map((o) => ({ id: o.id, accountId: o.account_id, kind: o.kind, state: o.state, attempts: o.attempts, messageIds: (JSON.parse(o.target_json) as { messageIds?: number[] }).messageIds ?? [] })),
    search: { messages: messageDocs(db), threads: threadDocs(db) },
  };
}
