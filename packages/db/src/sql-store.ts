import { bodyPrefix, bodyTestKey, bodyPartRange, CORPUS_TEXTS_MAX, finishBodyClose, readPassages, readThreadContext } from "@terno/store";
import { releaseIndexBodies, releaseBodyChanges, type IndexChange } from "@terno/store";
import { publishBody } from "@terno/store";
import { resolvable, parseSearch, searchTerms } from "@terno/core";
import { bodyUpgradePending, BodyUpgradeRequired, BODY_UPGRADE_APPLICATION_ID, BODY_READY_APPLICATION_ID } from "./body-upgrade";
import { unsubscribeBodyParts, decodeBodyPart } from "@terno/store";
import { needsCount, messagesHere, allDigests, beginDigest, clearDigests, digestFacts, digestLive, getDigest, latestDigest, pendingDigestDays, pruneDigests, waitingAmong, waitingPage, writeDigest } from "./today";
import { clearReplies, finishReply, getReply, transitionReply } from "./replies";
import { activeFollowups, claimFollowupNotice, clearFollowups, closeAnsweredFollowups, endFollowupTop, finishFollowups, followupLiveSent, followupScanCandidates, followupSendConfirmed, followupSource, getFollowup, makeFollowupsDue, nextFollowupDue, pruneFollowups, pruneSentMarks, queueScan, restoreFollowups, sentMarkCount, sentMarkPage, threadFollowups, updateFollowup } from "./followups";
import { addAskTurn, askAccountsOf, askHeaders, askMatching, askNewest, askText, askTurnCount, askTurns, clearAsk, listAskConversations, removeAskConversation, removeAskForAccount, restoreAskConversation } from "./ask";
import { retainBody, observeBodyRetirement, bodyReadReference, sqlBodyParts, cleanupBodies, finishBodyStage, withBodySelection, hydrateBodyReference, stageBody, prepareBodyMatches, withBodyMatches } from "./body-parts";
import { sqlCaptureRepairs, sqlCaptureStorage } from "./capture-repair";
import { unsubscribeSource } from "./unsubscribe";
import { completeCapture, retryCapture } from "@terno/store";
import { requireSqlGmailRefresh } from "./ingest";
import { prepareRecipientCorrespondents, prepareRecipientFts } from "./recipient-fts-preparation";
import { recipientReceiptParts, reserveRecipientReceipt, publishRecipientReceipt, retireRecipientSlice, finishRecipientRetirement, requireRecoverySource, rejectedRecipientSelection } from "@terno/store";
import { sqlRecipientReceipts } from "./recipient-receipts";
import { detachedReply } from "@terno/store";
import { sqlSendCopies } from "./send-copies";
import { reserveSendCopy, startCopyWire, appendCopyWire, sealCopyWire, acceptCopySubmission, recordCopy, forgetCopySlice, pruneSavedCopySlice, resetCopyWireSlice, copyWarningText, clearRecipientWarning, sendWarningFlags, submissionAccepted } from "@terno/store";
import { isFolderOp, movesToFolder, type FolderFilterMove } from "@terno/store";
import { leaveFolder, moveMessagesToFolder, moveThreadsToFolder, settleFolderOp } from "./folder-move";
import { carryFolder, clearFolder, countFolderMessages, listFolders, rebuildFolders, replaceFolders } from "./folders";
import { exportBody, exportIds, exportMessages } from "./folder-export";
import { COOLDOWN_TICKETS, bindCooldown, decodeCooldown, encodeCooldown, mailboxDigest, mailboxKeyValid, PROVIDER_COOLDOWN_KEY, copyOpAdmission } from "@terno/store";
import { attachmentMessageBudgetAsync } from "@terno/core";
import { mergeBefore, sameImapLocations, reaffirmSavedFlagIntent, acceptFlagObservation, flagEpochs, flagReconciliation, flagObservationValid, flagTick, initializeFlagStep, rearmFlagEffects, settleFlagEffects, startFlagObservation } from "@terno/store";
import { bindSqlPromotedFlags, sqlFlags } from "./flag-intents";
import { appendAsset, assetError, assetRef, assetRow, createAsset, ASSET_CLEANUP_STEPS, cleanupAssets, validateAssetCreation, linkAssets, sealAsset, stageAttachments, validateAssets } from "@terno/store";
import { sqlAssets, replaceAttachments } from "./attachments";
import { categoryOf, ruleAwaitsBody, senderVetoed, type MessageTerm, type Address, type FilterAction, type FilterRule, type ThreadAction, type ThreadSummary } from "@terno/core";
import { RpcError } from "@terno/core/rpc";
import { L } from "@terno/i18n";
import type { MockDataset } from "@terno/mock-data";
import {
  type AddedBy,
  type ClassifierInput,
  type Cursor,
  type IncomingMessage,
  type LocalFlagField,
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
import { applyMessageAction, applyThreadAction, restoreMessages, untabThreads, type ActionResult } from "./actions";
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
  abandonMove,
  vetoesFor,
  aiFilingBar,
  categoryEvidence,
  type ClassifyResult,
} from "./categorize";
import { keptThreads, resolveSimilarPage, similarOffers, similarScopesOf } from "./similar";
import { clearJudgments, clearWriting, commitGeneration, commitProfiles, corpusHeaders, corpusUsable, editProfile, generationForDraft, generationForMessage, generationPairs, judgeProfile, listProfiles, readProfiles, resetProfile, sentTo as writingSentTo, threadRecipients, threadsWith as writingThreadsWith, transferGeneration } from "./writing";
import { attemptSummary, clearNewMail, clearSummaries, consumeNewMail, dropPendingSummaries, dropSummary, failSummary, finishSummary, getSummary, lastSummaryFailure, markNewMail, newMailPage, pendingSummaries, pendingSummaryCount, pruneNewMail, pruneSummaries, summarySources } from "./ai-summaries";
import { cancelWaiting, filesReady, waitingCount, forwardRuleGone, forwardWork, approveRule, cancelForwards, claimForward, eligiblePage, failForward, forwardHolds, forwardSendOpen, forwardsActive, getForward, linkForwardSend, listForwards, markEligible, nextForwardDue, planForwards, pruneForwards, retryForward, setCategoryForward, stopRule, waitForFiles } from "./forwards";
import { deleteScheduled, failScheduled, getScheduled, listScheduled, putScheduled, rescheduleScheduled, stillScheduled } from "./scheduled";
import { answeredReminders, deleteExactReminders, deleteReminders, listReminders, putReminders } from "./reminders";
import { COMPACT_KEY, compactPages, footprint, incrementalVacuum, removeStorage, storageThreads } from "./storage";
import { autoReasons, categoryStats, countScope, pendingSuggestions, predictThread, quickActions, resolveScope } from "./categorize-bulk";
import { startCheckpointWorker, type CheckpointWorker } from "./checkpoint";
import { adoptProviderThread, deleteMessages, findIngestMessage, ingestMessages, recomputeThreads, setMessageBody } from "./ingest";
import { tabsIdle, tabsSlice } from "./tabs";
import { answeredThreads, arrivalRows, backfillSlice, factsIdle, ownMailChanged, referencesOfOwn, resetFacts, startRescan } from "./facts";
import { changeOwner, claimOwner, getOwner } from "./owner";
import { countScopeThreads, getCounts, getSummaries, getThread, warmThreadRead, listThreads, scopeThreadIds, SUMMARY_COLUMNS, toSummary, type SummaryRow } from "./queries";
import {
  accountStamp,
  addThreadsToCategory,
  awaitAuthOp,
  releaseOp,
  deferOp,
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
  pendingFlagFields,
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
import { ftsIndexedTermMessages, ftsTermMessages, resolveQuery } from "./search";
import { Fts5SearchEngine } from "./search-engine";
import { messageDocs, threadDocs } from "./search-docs";
import { seedDataset } from "./seed";
import { SqlProviderStore } from "./sql-provider-store";
import { sqlAutocompleteSource } from "./autocomplete";
import type { Db } from "./sqlite";

/** Ids read per slice when the feed serves a large commit (500 thread docs read in ~1 ms). */
const MATERIALIZE_SLICE = 500;

/** Counted up to here: "how much mail can't be searched yet" never pays for a huge count. */
class ReadyPhraseRequired extends Error {
  constructor(readonly term: MessageTerm, readonly candidates: readonly number[]) { super("Captured phrase preparation required"); }
}

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

const NO_CLASSIFICATION: ClassifyResult = { deltas: [], auto: new Map(), touched: new Set(), suggested: 0, backfill: 0 };

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
  private cooldownActions = 0;
  private cooldownAction<V>(fn: () => Promise<V>): Promise<V> {
    if (this.cooldownActions >= COOLDOWN_TICKETS) return Promise.reject(new Error("Private cooldown action capacity"));
    this.cooldownActions++;
    return Promise.resolve().then(fn).catch(() => { throw new Error("Private cooldown action failed"); }).finally(() => { this.cooldownActions--; });
  }

  readonly capabilities: StoreCapabilities;
  private readonly fts: Fts5SearchEngine;
  private readonly checkpointer: CheckpointWorker | null;
  private readonly providerStores = new Map<number, ProviderStore>();
  private readonly log: NonNullable<SqlMailStoreOptions["log"]>;

  /** the in-memory index searches use when it is current (instantSearch option) */
  readonly instant: InstantSearch | null;
  readonly autocomplete: AutocompleteSource;

  private readonly yieldTo: () => Promise<void>;
  private readonly bodyCleanup: Promise<void>;
  private readyPhrases: Map<string, number[]> | undefined;
  private bodyClosing = false;
  private bodyClose: Promise<void> | undefined;
  private bodyCleanupFailure: { error: unknown } | undefined;
  private readonly bodyCommands = new Set<Promise<unknown>>();
  private bodyGarbage: Promise<void> | undefined;
  private bodyGarbageAgain = false;
  private queueBodyGarbage(retired = false): void {
    if (this.bodyClosing) return;
    if (this.bodyGarbage) { this.bodyGarbageAgain ||= retired; return; }
    const task = Promise.resolve().then(() => cleanupBodies(this.db, this.yieldTo)).catch((error: unknown) => { this.bodyCleanupFailure ??= { error }; this.log("warn", "Body cleanup will resume after reopening the mailbox"); }).finally(() => { if (this.bodyGarbage === task) this.bodyGarbage = undefined; if (this.bodyGarbageAgain) { this.bodyGarbageAgain = false; this.queueBodyGarbage(); } });
    this.bodyGarbage = task;
  }

  private bodyCommand<V>(work: () => Promise<V>): Promise<V> {
    if (this.bodyClosing) return Promise.reject(new Error("The store is closing"));
    const command = work(); this.bodyCommands.add(command);
    void command.finally(() => this.bodyCommands.delete(command)).catch(() => {});
    return command;
  }

  constructor(
    readonly db: Db,
    options: SqlMailStoreOptions = {},
  ) {
    if (bodyUpgradePending(db)) {
      if (db.get("SELECT 1 FROM message_bodies LIMIT 1")) throw new BodyUpgradeRequired();
      db.tx(() => { db.run("UPDATE settings SET value_json='{}' WHERE key='body_parts_upgrade'"); db.exec(`PRAGMA application_id=${BODY_READY_APPLICATION_ID}`); });
    }
    if (db.get<{ application_id: number }>("PRAGMA application_id")?.application_id === BODY_UPGRADE_APPLICATION_ID) db.exec(`PRAGMA application_id=${BODY_READY_APPLICATION_ID}`);
    this.fts = new Fts5SearchEngine(db);
    const platform = options.platform ?? { yield: () => new Promise<void>((r) => setTimeout(r, 0)) };
    this.yieldTo = () => platform.yield();
    this.bodyCleanup = cleanupBodies(db, this.yieldTo);
    void this.bodyCleanup.catch(() => {});
    this.log = options.log ?? (() => {});
    observeBodyRetirement(db, () => this.queueBodyGarbage(true));
    db.onCommit(() => { if (!this.bodyClosing && db.get("SELECT 1 FROM body_captures WHERE owned=0 AND ready=1 LIMIT 1")) this.queueBodyGarbage(); });
    this.checkpointer = options.checkpointWorker ? startCheckpointWorker(db) : null;
    if (options.instantSearch) {
      this.instant = new InstantSearch({
        ...(options.instantSearch === true ? {} : options.instantSearch),
        feed: this.feed,
        platform,
        snapshotPath: db.path === ":memory:" ? null : `${db.path}.search`,
        identity: `sqlite-schema-${SEARCH_SCHEMA_VERSION}`,
        // inside the store's unit of work, like the engine's own answer
        phrases: (term, candidates) => {
          if (term.field === "text" && this.readyPhrases && db.get("SELECT 1 FROM body_heads LIMIT 1")) {
            const ids = this.readyPhrases?.get(bodyTestKey("contains", term.value, term.prefix));
            if (!ids) throw new ReadyPhraseRequired(term, candidates);
            return ids;
          }
          return ftsTermMessages(db, term);
        },
        log: this.log,
      });
      db.onCommit(() => this.instant?.notify());
      this.instant.start();
    } else this.instant = null;
    this.autocomplete = sqlAutocompleteSource(db, this.yieldTo, `sqlite-${SEARCH_SCHEMA_VERSION}`, (work) => this.bodyCommand(work));
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

  close(): Promise<void> {
    if (this.bodyClose) return this.bodyClose;
    this.bodyClosing = true;
    return this.bodyClose = finishBodyClose([
      () => Promise.allSettled(this.bodyCommands),
      () => this.instant?.close(),
      () => this.checkpointer?.stop(),
      () => this.bodyCleanup,
      () => this.bodyGarbage,
      () => cleanupBodies(this.db, this.yieldTo),
      () => { if (this.bodyCleanupFailure) throw this.bodyCleanupFailure.error; },
      () => { if (this.db.isOpen) this.db.close(); },
    ]);
  }

  /** The revision searches answer at: the head of the search log, read in the same unit as the answer. */
  private revision(): Revision {
    return searchHead(this.db);
  }

  readonly feed: SearchFeed = {
    head: async () => searchHead(this.db),
    changes: async (after, through, maxCommits) => {
      const batches: IndexBatch[] = [];
      let pending: IndexChange[] = [];
      try {
      for (const c of searchChangeIds(this.db, after, through, maxCommits)) {
        // a large commit (a 5,000-thread move) is read in slices: each doc is still the newest committed state
        // when read, never older than its batch, which is all replaying needs to converge
        const changes = pending = materializeChanges(this.db, c.messageIds.slice(0, MATERIALIZE_SLICE), c.threadIds.slice(0, MATERIALIZE_SLICE));
        for (let m = MATERIALIZE_SLICE, t = MATERIALIZE_SLICE; m < c.messageIds.length || t < c.threadIds.length; m += MATERIALIZE_SLICE, t += MATERIALIZE_SLICE) {
          await this.yieldTo();
          if (!this.db.isOpen) throw new Error("the store closed");
          changes.push(...materializeChanges(this.db, c.messageIds.slice(m, m + MATERIALIZE_SLICE), c.threadIds.slice(t, t + MATERIALIZE_SLICE)));
        }
        batches.push({ from: c.from, to: c.to, changes });
        pending = [];
      }
      return batches;
      } catch (error) {
        await releaseIndexBodies(batches, this.yieldTo);
        await releaseBodyChanges(pending, this.yieldTo);
        throw error;
      }
    },
    beginBuild: async () => beginSearchBuild(this.db),
  };

  /**
   * One synchronous unit: the revision, the engine's answer and the
   * hydration see the same committed state. RAM answers only when it is
   * exactly at that revision; FTS5 answers otherwise (building, catching up,
   * disabled), with the same results.
   */
  private async searchPage(req: SearchRequest): Promise<StoreSearchPage> {
    const phrases = new Map<string, number[]>(), revision = this.revision();
    const check = () => {
      const current = this.revision();
      if (current.epoch !== revision.epoch || current.seq !== revision.seq) throw new RpcError("STALE", L("errors.mail.processingBusy"), { reason: "revision" });
    };
    for (;;) {
      try {
        const ready = this.db.tx(() => {
          check();
          if (!this.instant?.at(revision)) return null;
          const prior = this.readyPhrases; this.readyPhrases = phrases;
          try { return this.searchPreparedPage(req); } finally { this.readyPhrases = prior; }
        });
        if (ready) return ready;
        break;
      } catch (error) {
        if (!(error instanceof ReadyPhraseRequired)) throw error;
        const ids = this.db.tx(() => { check(); return ftsIndexedTermMessages(this.db, error.term); });
        const test = { op: "contains" as const, value: error.term.value, prefix: error.term.prefix };
        for (let at = 0; at < error.candidates.length; at += 500) {
          const captures = this.db.tx(() => {
            check();
            return this.db.all<{ capture_id: string }>("SELECT capture_id FROM body_heads WHERE message_id IN (SELECT value FROM json_each(?))", JSON.stringify(error.candidates.slice(at, at + 500))).map((row) => row.capture_id);
          });
          const matches = await prepareBodyMatches(this.db, [test], this.yieldTo, captures, "selected", new Map(), check);
          const found = withBodyMatches(this.db, matches, () => this.db.all<{ id: number }>("SELECT message_id AS id FROM body_heads WHERE capture_id IN (SELECT value FROM json_each(?)) AND terno_part_match(capture_id,'contains',?,?)", JSON.stringify(captures), test.value, test.prefix ? 1 : 0));
          for (const row of found) ids.push(row.id);
          await this.yieldTo(); check();
        }
        phrases.set(bodyTestKey("contains", error.term.value, error.term.prefix), [...new Set(ids)]);
      }
    }
    const bodyTests = searchTerms(req.search.query).filter((t) => t.field === "text").map((t) => ({ op: "contains" as const, value: t.value, prefix: t.prefix }));
    const matches = await prepareBodyMatches(this.db, bodyTests, this.yieldTo);
    return withBodyMatches(this.db, matches, () => this.searchPreparedPage(req));
  }

  private searchPreparedPage(req: SearchRequest): StoreSearchPage {
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
    get: async (id, options) => this.bodyCommand(() => (warmThreadRead(this.db, id), withBodySelection(this.db, () => {
      const found = getThread(this.db, id);
      const value = found ? { ...found, messages: found.messages.map((message) => ({ ...message })), categorization: { auto: autoReasons(this.db, id), suggestions: pendingSuggestions(this.db, { threadId: id, limit: 5 }) } } : null;
      return { value, ids: value?.messages.map((message) => message.id) ?? [] };
    }, async (thread, references) => {
      if (!thread) return null;
      for (const message of thread.messages) {
        const reference = references.get(message.id);
        if (!reference) continue;
        if (options?.bodyFormat === "parts") { message.bodyText = null; message.bodyHtml = null; message.bodyReference = reference; }
        else Object.assign(message, await hydrateBodyReference(this.db, reference, this.yieldTo));
      }
      return thread;
    }))),
    unsubscribeSource: async (id) => this.bodyCommand(async () => {
      const result = unsubscribeSource(this.db, id);
      if (!result || result.unsubscribe) return result;
      const reference = bodyReadReference(this.db, result.messageId);
      if (reference) {
        const release = retainBody(this.db, reference.version);
        try {
        result.bodyText = reference.textParts === null ? null : await unsubscribeBodyParts(sqlBodyParts(this.db, reference.version, 0, this.yieldTo), false);
        result.bodyHtml = reference.htmlParts === null ? null : await unsubscribeBodyParts(sqlBodyParts(this.db, reference.version, 1, this.yieldTo), true);
        if (bodyReadReference(this.db, result.messageId)?.version !== reference.version) throw new RpcError("STALE", L("errors.originalGone"));
        } finally { release(); }
      }
      return result;
    }),
    bodyPart: async (input) => this.bodyCommand(async () => {
      const current = () => !!this.db.get("SELECT 1 FROM messages m JOIN body_heads b ON b.message_id=m.id WHERE m.id=? AND m.account_id=? AND b.capture_id=?", input.messageId, input.accountId, input.version);
      if (!current()) throw new RpcError("STALE", L("errors.originalGone"));
      const source = sqlBodyParts(this.db, input.version, input.field === "text" ? 0 : 1, this.yieldTo);
      try {
        const part = await source.read(input.ordinal - 1);
        if (!part || !current()) throw new RpcError("STALE", L("errors.originalGone"));
        return decodeBodyPart(part.value);
      } finally { source.close?.(); }
    }),
    counts: async (now) => getCounts(this.db, now),
    search: async (req) => this.bodyCommand(() => this.searchPage(req)),
    searchText: async (p) => this.bodyCommand(async () => {
      const search = resolveQuery(this.db, p);
      return this.searchPage({ search, cursor: p.cursor ? withKey(p.cursor, search.key, this.revision()) : undefined, limit: p.limit });
    }),
    act: async ({ threadIds, action, signal, now }) =>
      this.db.tx(() => {
        const flagBefore = flagEpochs(sqlFlags(this.db));
        const ids = [...new Set(threadIds)];
        const r = applyThreadAction(this.db, ids, action);
        // only actions that changed something feed learned filters (repeats must not manufacture support)
        if (signal && r.threadIds.length) recordUserActions(this.db, r.threadIds, signal, now);
        const opIds = this.queueActionOps(r, action, now);
        if (action !== "moveToInbox") return { threadIds: r.threadIds, opIds, before: r.before, ...flagReconciliation(sqlFlags(this.db), flagBefore) };
        // plan 86: into the Inbox means out of Gmail's tabs too, in the same command and the same undo
        const u = untabThreads(this.db, ids);
        return { threadIds: [...new Set([...r.threadIds, ...u.threadIds])], opIds: [...opIds, ...this.queueActionOps(u, "toPrimary", now)], before: mergeBefore(r.before, u.before), ...flagReconciliation(sqlFlags(this.db), flagBefore) };
      }),
    restore: async ({ messages, now }) =>
      this.db.tx(() => {
        const flagBefore = flagEpochs(sqlFlags(this.db));
        const r = restoreMessages(this.db, messages);
        const opIds: string[] = [];
        const versions = new Map<number, number>();
        reaffirmSavedFlagIntent(sqlFlags(this.db), messages, versions);
        for (const op of r.ops) {
          if (!versions.has(op.accountId) && sqlFlags(this.db).clock(op.accountId)) versions.set(op.accountId, flagTick(sqlFlags(this.db), op.accountId));
          const id = enqueueOp(this.db, { accountId: op.accountId, kind: op.kind, target: { messageIds: op.messageIds } }, now, versions.get(op.accountId));
          if (id) opIds.push(id);
        }
        return { threadIds: r.threadIds, opIds, ...flagReconciliation(sqlFlags(this.db), flagBefore) };
      }),
    moveToFolder: async (c) =>
      this.db.tx(() => {
        const flagBefore = flagEpochs(sqlFlags(this.db));
        const r = moveThreadsToFolder(this.db, c);
        return { threadIds: r.threadIds, opIds: r.opIds, before: r.archived.before, moved: r.moved, kept: r.kept, leftInbox: r.archived.threadIds, ...flagReconciliation(sqlFlags(this.db), flagBefore) };
      }),
    leaveFolder: async (c) => this.db.tx(() => leaveFolder(this.db, c)),
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
  private applyFiltersTo(messageIds: readonly number[], onlyBodyFilters: boolean, now: number, opIds: string[], folderMoves: FolderFilterMove[]): Set<number> {
    const touched = new Set<number>();
    if (messageIds.length === 0) return touched;
    const filters = listFilters(this.db).filter((f) => f.enabled && (!onlyBodyFilters || ruleAwaitsBody(f.rule)));
    // plan 128: what reached the Inbox, read before any filter acts: an archive (or another folder's) doesn't change who else moves
    const inbox = filters.some((f) => movesToFolder(f.rule)) ? new Set(this.db.all<{ id: number }>("SELECT id FROM messages WHERE in_inbox = 1 AND id IN (SELECT value FROM json_each(?))", JSON.stringify(messageIds)).map((m) => m.id)) : null;
    for (const filter of filters) {
      const matches = findRuleMatches(this.db, filter.rule, now, messageIds);
      if (matches.messageIds.length === 0) continue;
      try {
        const moves: FolderFilterMove[] = [];
        // claims + actions + ops atomically (a savepoint inside the command)
        const changed = this.db.tx(() => this.runFilterActions(filter.rule.actions, claimFilterApplications(this.db, filter.id, matches.messageIds, now), now, opIds, moves, inbox));
        // only once its savepoint held: a later action failing leaves no move behind
        folderMoves.push(...moves);
        for (const id of changed) touched.add(id);
      } catch (error) {
        // e.g. the filter points at a deleted category: skip it, keep ingesting
        this.log("warn", `filter ${filter.id} (${filter.name}) failed`, error instanceof Error ? error.message : error);
      }
    }
    return touched;
  }

  private runFilterActions(actions: FilterAction[], messageIds: number[], now: number, opIds: string[], folderMoves: FolderFilterMove[], inbox: ReadonlySet<number> | null): Set<number> {
    const touched = new Set<number>();
    if (messageIds.length === 0) return touched;
    for (const action of actions) {
      // plan 116: a forward is decided after the commit, from what the mail is then (forwards.plan)
      if (action.type === "forward") continue;
      // plan 128: made last (flushFolderMoves), when the categories that keep a thread in the Inbox are all known
      if (action.type === "moveToFolder") {
        const ids = inbox ? messageIds.filter((id) => inbox.has(id)) : messageIds;
        if (ids.length) folderMoves.push({ accountId: action.accountId, folder: action.folder, messageIds: ids });
        continue;
      }
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

  /** Plan 128: the collected moves. One failing, or a folder that isn't there, stops only that one: the mail stays where it is, and ingest goes on. */
  private flushFolderMoves(moves: readonly FolderFilterMove[], now: number, opIds: string[], touched: Set<number>): void {
    for (const move of moves) {
      try {
        const r = this.db.tx(() => moveMessagesToFolder(this.db, { ...move, now }));
        if (!r) {
          this.log("warn", `filter move: folder not found on account ${move.accountId}`);
          continue;
        }
        opIds.push(...r.opIds);
        for (const t of r.threadIds) touched.add(t);
      } catch (error) {
        this.log("warn", `filter move failed on account ${move.accountId}`, error instanceof Error ? error.message : error);
      }
    }
  }

  private classify(classifier: ClassifierInput | null, inserted: readonly number[], bodyCompleted: readonly number[], now: number): ClassifyResult {
    if (!classifier) return NO_CLASSIFICATION;
    return classifyNewThreads(this.db, { inserted, bodyCompleted, now, mode: classifier.mode, model: classifier.model });
  }

  // ───────────────────────────── sync ─────────────────────────────

  readonly sync: MailStore["sync"] = {
    beginObservation: async (accountId, options) => {
      const repo = sqlFlags(this.db);
      const check = () => { if (options.signal?.aborted) throw options.signal.reason ?? new Error("Flag observation cancelled."); };
      check();
      const clock = this.db.tx(() => startFlagObservation(repo, accountId, options.authoritativeFlags));
      if (!clock) return null;
      for (;;) {
        check();
        const current = repo.clock(accountId);
        if (!current) throw new Error("Account no longer exists.");
        if (current.phase) break;
        this.db.tx(() => initializeFlagStep(repo, accountId));
        await this.yieldTo();
      }
      check();
      return this.db.tx(() => ({ accountId, protocolId: repo.clock(accountId)!.protocol_id, epoch: flagTick(repo, accountId) }));
    },
    // Messages, filter claims, filter actions and their ops, and the categorizer's decisions
    // commit together: a crash can't record a filter as applied without its effects, nor an
    // auto-categorization without its message.
    ingest: async (batch, { applyFilters, now, classifier, observation, check, forwardEligible, newMail, liveSent }) => this.bodyCommand(async () => {
      const callerCheck = check; check = () => { if (this.bodyClosing) throw new Error("The store is closing"); callerCheck?.(); };
      await this.bodyCleanup;
      const staged: IncomingMessage[] = [];
      try {
      for (const m of batch) {
        const existing = !m.captureUnavailable && m.attachments?.length ? findIngestMessage(this.db, m) : undefined;
        staged.push(await stageBody(this.db, m.captureUnavailable || m.attachments === undefined ? m : { ...m, attachments: await stageAttachments(this, m.accountId, m.attachments, now, this.yieldTo, existing ? await this.attachments.current(m.accountId, { id: existing.id }) : []) }, this.yieldTo, check));
      }
      const cache = new Map<string, Map<string, boolean>>();
      return await publishBody(async () => {
      const tests = applyFilters ? listFilters(this.db).filter((f) => f.enabled).flatMap((f) => f.rule.conditions.flatMap((c) => c.field === "body" ? [{ op: c.op, value: c.value }] : c.field === "text" ? [{ op: "contains" as const, value: c.value }] : [])) : [];
      const matches = await prepareBodyMatches(this.db, tests, this.yieldTo, staged.flatMap((m) => m.bodyCapture ? [m.bodyCapture.id] : []), false, cache, check);
      return withBodyMatches(this.db, matches, () => this.db.tx(() => {
        check?.();
        const flagBefore = flagEpochs(sqlFlags(this.db));
        for (const m of staged) completeCapture(sqlCaptureStorage(this.db), m.accountId, m.repair);
          const result = ingestMessages(this.db, staged as IncomingMessage[], now, observation);
        // plan 116: live mail that may be forwarded, marked with its insertion (never later, by an upsert)
        if (forwardEligible) markEligible(this.db, result.inserted, now);
        // plan 131 revision 5: the same for the AI features, whether or not its text is here or a classifier is ready
        if (newMail) markNewMail(this.db, result.inserted, now, newMail);
        // plan 142: mail you sent from elsewhere ends the waits before it, and is read if the feature is on
        if (liveSent) followupLiveSent(this.db, result.inserted, now, liveSent.wanted, liveSent.since);
        const touched = new Set(result.touchedThreads);
        const opIds: string[] = [];
        const folderMoves: FolderFilterMove[] = [];
        if (applyFilters) {
          for (const t of this.applyFiltersTo(result.inserted, false, now, opIds, folderMoves)) touched.add(t);
          // bodies that arrived through an upsert may now satisfy body filters
          for (const t of this.applyFiltersTo(result.bodyCompleted, true, now, opIds, folderMoves)) touched.add(t);
        }
        const c = this.classify(classifier, result.inserted, result.bodyCompleted, now);
        for (const t of c.touched) touched.add(t);
        this.flushFolderMoves(folderMoves, now, opIds, touched);
        return { inserted: result.inserted, touched: [...touched], deltas: [...result.deltas, ...c.deltas], auto: c.auto, backfill: c.backfill, opIds, ...flagReconciliation(sqlFlags(this.db), flagBefore) };
      }));
      }, check); } finally {
        for (const m of staged) if (m.bodyCapture) await finishBodyStage(this.db, m.bodyCapture.id, this.yieldTo);
      }
    }),
    setBody: async (messageId, text, html, { now, classifier, attachments, bodyParts, preparedBodyTokens, captureUnavailable, repair, check, expected }) => this.bodyCommand(async () => {
      const callerCheck = check; check = () => { if (this.bodyClosing) throw new Error("The store is closing"); callerCheck?.(); };
      await this.bodyCleanup;
      const accountId = this.db.get<{ account_id: number }>("SELECT account_id FROM messages WHERE id = ?", messageId)?.account_id;
      const staged = !captureUnavailable && attachments !== undefined && accountId !== undefined ? await stageAttachments(this, accountId, attachments, now, this.yieldTo, await this.attachments.current(accountId, { id: messageId })) : undefined;
      const body = !captureUnavailable && accountId !== undefined ? await stageBody(this.db, { accountId, bodyText: text, bodyHtml: html, bodyParts, snippet: "", preparedBodyTokens }, this.yieldTo, check) : { bodyText: text, bodyHtml: html, bodyCapture: undefined };
      const cache = new Map<string, Map<string, boolean>>();
      try {
      return await publishBody(async () => {
      const tests = listFilters(this.db).filter((f) => f.enabled).flatMap((f) => f.rule.conditions.flatMap((c) => c.field === "body" ? [{ op: c.op, value: c.value }] : c.field === "text" ? [{ op: "contains" as const, value: c.value }] : []));
      const matches = await prepareBodyMatches(this.db, tests, this.yieldTo, body.bodyCapture ? [body.bodyCapture.id] : [], false, cache, check); return withBodyMatches(this.db, matches, () => this.db.tx(() => {
        check?.();
        const current = expected ? this.db.get<{ account_id: number; thread_id: number; provider_msg_id: string; body_state: string }>("SELECT account_id,thread_id,provider_msg_id,body_state FROM messages WHERE id=?", messageId) : undefined;
        if (expected && (!current || current.body_state === "full" || current.account_id !== expected.accountId || current.thread_id !== expected.threadId || current.provider_msg_id !== expected.providerMsgId)) return { touched: [], deltas: [], auto: new Map(), opIds: [] };
        if (accountId !== undefined) completeCapture(sqlCaptureStorage(this.db), accountId, repair);
        const flagBefore = flagEpochs(sqlFlags(this.db));
        if (this.db.get("SELECT 1 FROM imap_identity_holds WHERE message_id=?", messageId)) return { touched: [], deltas: [], auto: new Map(), opIds: [] };
        if (!captureUnavailable) setMessageBody(this.db, messageId, body.bodyText, body.bodyHtml, "full", body.bodyCapture);
        if (staged !== undefined && !captureUnavailable) replaceAttachments(this.db, messageId, staged);
        const owner = this.db.get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE id = ?", messageId);
        if (captureUnavailable) this.db.run("UPDATE messages SET attachments_captured = 2 WHERE id = ?", messageId);
        if (owner) recomputeThreads(this.db, [owner.thread_id]);
        if (captureUnavailable) return { touched: owner ? [owner.thread_id] : [], deltas: [], auto: new Map(), opIds: [] };
        const opIds: string[] = [];
        const folderMoves: FolderFilterMove[] = [];
        const touched = this.applyFiltersTo([messageId], true, now, opIds, folderMoves);
        // the body was the missing piece: reclassify once
        const c = this.classify(classifier, [], [messageId], now);
        for (const t of c.touched) touched.add(t);
        this.flushFolderMoves(folderMoves, now, opIds, touched);
        if (owner) touched.add(owner.thread_id);
        return { touched: [...touched], deltas: c.deltas, auto: c.auto, opIds, ...flagReconciliation(sqlFlags(this.db), flagBefore) };
      }));
      }, check); } finally { if (body.bodyCapture) await finishBodyStage(this.db, body.bodyCapture.id, this.yieldTo); }
    }),
    updateFlags: async (accountId, updates, observation, check) =>
      this.db.tx(() => {
        check?.();
        // read inside this unit: a user action committed just before is honoured
        const pending = pendingFlagFields(this.db, accountId, updates.map((u) => u.messageId));
        const threads = new Set<number>();
        const reconciliation: { flagReconcileAccounts?: number[] } = {};
        for (const u of updates) {
          if (this.db.get("SELECT 1 FROM imap_identity_holds WHERE message_id=?", u.messageId)) continue;
          if (observation && (!flagObservationValid(sqlFlags(this.db), accountId, observation) || !u.expectedProviderMsgId)) continue;
          const identity = this.db.get<{ account_id: number; provider_msg_id: string | null }>("SELECT account_id,provider_msg_id FROM messages WHERE id=?", u.messageId);
          if (identity?.account_id !== accountId || (u.expectedProviderMsgId !== undefined && identity.provider_msg_id !== u.expectedProviderMsgId)) continue;
          if (u.expectedImapLocations && !sameImapLocations(u.expectedImapLocations, this.db.all<{ mailbox: string; uidvalidity: number; uid: number }>("SELECT mailbox,uidvalidity,uid FROM message_locations WHERE message_id=?", u.messageId))) continue;
          const owned = pending.get(u.messageId);
          const sets: [string, number | string][] = Object.entries(u.flags)
            .filter(([k, v]) => FLAG_COLUMNS[k] && !owned?.has(k as LocalFlagField) && acceptFlagObservation(sqlFlags(this.db), u.messageId, k as LocalFlagField, observation, Boolean(v), () => { reconciliation.flagReconcileAccounts ??= [accountId]; }))
            .map(([k, v]) => [FLAG_COLUMNS[k]!, v ? 1 : 0]);
          // plan 17 (Codex review 1, #8): Gmail's category moves (Promotions ↔ Primary) change who a message is from
          if (u.gmailLabels) {
            sets.push(["gmail_labels", JSON.stringify(u.gmailLabels)]);
            // plan 86: the category, unless a move of the user's owns it until Gmail confirms it
            const category = categoryOf(u.gmailLabels)!;
            if (!owned?.has("category") && acceptFlagObservation(sqlFlags(this.db), u.messageId, "category", observation, category, () => { reconciliation.flagReconcileAccounts ??= [accountId]; })) sets.push(["category", category]);
          }
          if (!sets.length) continue;
          // plan 17 (Codex R4): a message becoming sent, or a draft, or spam (plan 153), is your mail appearing or going
          const sentOrDraft = "isSent" in u.flags || "isDraft" in u.flags || "isSpam" in u.flags;
          const before = sentOrDraft ? this.db.get<{ is_sent: number; is_draft: number; is_spam: number }>("SELECT is_sent, is_draft, is_spam FROM messages WHERE id = ? AND account_id = ?", u.messageId, accountId) : undefined;
          const r = this.db.get<{ thread_id: number; is_sent: number; is_draft: number; is_spam: number }>(
            `UPDATE messages SET ${sets.map(([c]) => `${c} = ?`).join(", ")} WHERE id = ? AND account_id = ? RETURNING thread_id, is_sent, is_draft, is_spam`,
            ...sets.map(([, v]) => v),
            u.messageId,
            accountId,
          );
          if (!r) continue;
          threads.add(r.thread_id);
          if (before && (before.is_sent !== r.is_sent || before.is_draft !== r.is_draft || before.is_spam !== r.is_spam)) for (const t of ownMailChanged(this.db, u.messageId)) threads.add(t);
        }
        recomputeThreads(this.db, threads);
        return { touched: [...threads], ...reconciliation };
      }),
    remove: async (ids, check) => { check?.(); return { touched: [...deleteMessages(this.db, ids)] }; },
    pendingMessageIds: async (accountId) => messagesWithPendingOps(this.db, accountId),
    arrivals: async (ids) => arrivalRows(this.db, ids),
  };

  // ───────────────────────────── ops ─────────────────────────────

  private async preparedFlagOutcome<T>(id: string, run: () => T | Promise<T>): Promise<T> {
    const op = getOp(this.db, id);
    const clock = op?.kind !== "send" && op && sqlFlags(this.db).clock(op.account_id);
    if (clock && !clock.phase) await this.sync.beginObservation(op!.account_id, { authoritativeFlags: true });
    return run();
  }

  private async recoverFlagOperations(now: number) {
    for (const clock of sqlFlags(this.db).clocks()) if (!clock.phase) await this.sync.beginObservation(clock.account_id, { authoritativeFlags: true });
    return recoverOps(this.db, now);
  }

  readonly ops: MailStore["ops"] = {
    claimReady: async (now, limit, admission) => claimReadyOps(this.db, now, limit, undefined, admission && copyOpAdmission(admission)),
    get: async (id) => this.copyOp(getOp(this.db, id)),
    sendSubmission: async (id) => {
      const op = this.db.get<Pick<import("@terno/store").OpRow, "kind" | "state" | "target_json">>("SELECT kind,state,target_json FROM ops WHERE id=?", id);
      return op?.kind === "send" ? { state: op.state, accepted: submissionAccepted(op) } : null;
    },
    complete: async (id, result, now, o) =>
      this.preparedFlagOutcome(id, () => this.db.tx(() => {
        const op = getOp(this.db, id);
        if (op?.kind === "send" && op.state !== "running") return { touched: [], deltas: [] };
        completeOp(this.db, id, now);
        const touched: number[] = [];
        const deltas: ModelDelta[] = [];
        if (!op) return { touched, deltas };
        // plan 127: Gmail's labels change now, and membership stops reading the op
        if (isFolderOp(op.kind)) touched.push(...settleFolderOp(this.db, op, true));
        if (op.kind === "send") sqlAssets(this.db).unlink("op", id);
        if (op.kind === "send" && result?.sendAccepted) { sqlSendCopies(this.db).markSubmissionAccepted(id); publishRecipientReceipt(sqlRecipientReceipts(this.db), id, result.sendAccepted.outcomes, result.sendAccepted.warning); }
        const receipt = sqlSendCopies(this.db).get(id);
        if (op.kind === "send" && result?.sendAccepted && receipt?.submission === "pending" && (receipt.copyRequested || receipt.ready)) acceptCopySubmission(sqlSendCopies(this.db), id, result.sendAccepted.warning);
        if (result?.warning) this.db.run("UPDATE ops SET last_error = ? WHERE id = ?", result.warning, id);
        let refreshNeeded = false;
        const localId = (JSON.parse(op.target_json) as { messageIds?: number[] }).messageIds?.[0];
        // plan 142 revision 3: only a confirmed send closes a wait, in the commit that records it
        if (op.kind === "send" && localId) followupSendConfirmed(this.db, localId, now, o?.followup === true, o?.since);
        if (op.kind === "send" && result && localId) {
          if (result.providerMsgId) {
            const changed = this.db.run("UPDATE messages SET provider_msg_id = ? WHERE id = ? AND provider_msg_id LIKE 'local:%'", result.providerMsgId, localId);
            if (changed.changes) {
              bindSqlPromotedFlags(this.db, localId);
              refreshNeeded = requireSqlGmailRefresh(this.db, [localId]);
            }
          }
          if (result.providerThreadId) {
            // a conversation we started gets its Gmail thread id, so replies land in it
            const row = this.db.get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE id = ?", localId);
            if (row) touched.push(adoptProviderThread(this.db, row.thread_id, op.account_id, result.providerThreadId, undefined, deltas));
          }
        }
        return { touched, deltas, ...(refreshNeeded && { flagReconcileAccounts: [op.account_id] }) };
      })),
    fail: async (id, error, retryable, now, park) =>
      this.preparedFlagOutcome(id, () => this.db.tx(() => {
        const current = getOp(this.db, id);
        if (current && current.state !== "running") return current.state;
        const state = failOp(this.db, id, error, retryable, now, park);
        if (state === "failed" && current && isFolderOp(current.kind)) settleFolderOp(this.db, current, false);
        // plan 17 (Codex R8): a send that failed answered nobody; its thread and what it replied to count again
        const op = state === "failed" ? getOp(this.db, id) : null;
        const localId = op?.kind === "send" ? (JSON.parse(op.target_json) as { messageIds?: number[] }).messageIds?.[0] : undefined;
        if (localId !== undefined) {
          const row = this.db.get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE id = ?", localId);
          recomputeThreads(this.db, new Set([...(row ? [row.thread_id] : []), ...answeredThreads(this.db, referencesOfOwn(this.db, [localId]))]));
        }
        return state;
      })),
    markUnknown: async (id, error, now, sendAccepted) => this.preparedFlagOutcome(id, () => this.db.tx(() => {
      const op = getOp(this.db, id);
      if (op?.kind === "send" && op.state === "running" && sendAccepted) { sqlSendCopies(this.db).markSubmissionAccepted(id); publishRecipientReceipt(sqlRecipientReceipts(this.db), id, sendAccepted.outcomes, sendAccepted.warning); }
      const receipt = sqlSendCopies(this.db).get(id);
      if (op?.state === "running" && sendAccepted && receipt?.submission === "pending" && (receipt.copyRequested || receipt.ready)) acceptCopySubmission(sqlSendCopies(this.db), id, sendAccepted.warning);
      markOpUnknown(this.db, id, error, now);
      // plan 127: no longer counted as on its way: the folder shows what's known until a pass finds where it is
      if (op && isFolderOp(op.kind)) settleFolderOp(this.db, op, false);
    })),
    awaitAuth: async (id, error, now) => awaitAuthOp(this.db, id, error, now),
    release: async (id, now) => releaseOp(this.db, id, now),
    resumeAuth: async (accountId, now) => this.db.tx(() => resumeAuthOps(this.db, accountId, now)),
    resumeNetwork: async (accountId, now) => this.db.tx(() => resumeNetworkOps(this.db, accountId, now)),
    recover: async (now) => this.recoverFlagOperations(now),
    nextAttemptAt: async (admission) => nextOpAttemptAt(this.db, admission && copyOpAdmission(admission)),
    defer: async (id, now, o) => deferOp(this.db, id, now, o.refundClaim),
    recent: async (limit) => listRecentOps(this.db, limit).map((op) => this.copyOp(op)!),
    resolveUnknown: async (id, resolution, now) =>
      this.preparedFlagOutcome(id, () => this.db.tx(() => {
        const flagBefore = flagEpochs(sqlFlags(this.db));
        const op = getOp(this.db, id);
        if (!op || op.state !== "unknown") throw new RpcError("NOT_FOUND", L("errors.opResolved"));
        if (resolution === "markSent") {
          if (op.kind !== "send" && sqlFlags(this.db).clock(op.account_id)) throw new RpcError("STALE", L("errors.opResolved"));
          completeOp(this.db, id, now);
          if (op.kind === "send") sqlAssets(this.db).unlink("op", id);
          const receipt = sqlSendCopies(this.db).get(id);
          if (receipt?.submission === "accepted") sqlSendCopies(this.db).markSubmissionAccepted(id);
          if (receipt?.submission === "accepted") this.db.run("UPDATE ops SET last_error=? WHERE id=?", copyWarningText(receipt), id);
          return { touched: [] };
        }
        if (resolution === "retry") {
          if (submissionAccepted(op) || (op.kind === "send" && typeof (JSON.parse(op.target_json) as { recoveryParentId?: unknown }).recoveryParentId === "string") || sqlSendCopies(this.db).get(id)?.submission === "accepted") throw new RpcError("BAD_REQUEST", L("errors.send.alreadyAccepted"));
          if (op.kind !== "send" && sqlFlags(this.db).clock(op.account_id)) {
            const ids = rearmFlagEffects(sqlFlags(this.db), op);
            if (ids === null) throw new RpcError("STALE", L("errors.opResolved"));
            if (ids.length) {
              this.db.run("UPDATE ops SET target_json=? WHERE id=?", JSON.stringify({ ...JSON.parse(op.target_json), messageIds: ids }), id);
              this.db.run("DELETE FROM op_targets WHERE op_id=? AND message_id NOT IN (SELECT value FROM json_each(?))", id, JSON.stringify(ids));
            }
          }
          this.db.run("UPDATE ops SET state = 'queued', next_attempt_at = 0, last_error = NULL WHERE id = ?", id);
          const touched = this.db.all<{thread_id:number}>("SELECT DISTINCT m.thread_id FROM messages m JOIN op_targets t ON t.message_id=m.id WHERE t.op_id=?", id).map((r) => r.thread_id);
          recomputeThreads(this.db, touched);
          return { touched, ...flagReconciliation(sqlFlags(this.db), flagBefore) };
        }
        settleFlagEffects(sqlFlags(this.db), op, "removed");
        this.db.run("UPDATE ops SET state = 'failed', last_error = 'Discarded by user' WHERE id = ?", id);
        const target = JSON.parse(op.target_json) as { messageIds?: number[] };
        if (op.kind === "send" && target.messageIds?.length) {
          const local = this.db.get<{ id: number }>("SELECT id FROM messages WHERE id = ? AND provider_msg_id LIKE 'local:%'", target.messageIds[0]!);
          // deleteMessages recomputes (or deletes) the thread so no empty Sent entry remains
          if (local) return { touched: [...deleteMessages(this.db, [local.id])] };
        }
        return { touched: [], ...flagReconciliation(sqlFlags(this.db), flagBefore) };
      })),
  };

  // ───────────────────────────── compose ─────────────────────────────

  get captureRepairs(): MailStore["captureRepairs"] { return sqlCaptureRepairs(this.db); }

  readonly attachments: MailStore["attachments"] = {
    current: async (accountId, message) => this.db.all<{ filename: string; mime: string; size: number; assetId?: string; contentId: string | null }>(
      `SELECT a.filename, a.mime, a.size, a.asset_id AS assetId, a.content_id AS contentId FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.account_id = ? AND ${"id" in message ? "m.id" : "m.provider_msg_id"} = ? ORDER BY a.id`, accountId, "id" in message ? message.id : message.providerMsgId,
    ),
    retry: async (accountId, messageId, check) => this.db.tx(() => {
      check?.();
      const r = this.db.get<{ account_id: number }>("SELECT account_id FROM messages WHERE id = ?", messageId);
      if (r?.account_id !== accountId) throw assetError();
      for (const repair of this.db.all<import("@terno/store").CaptureRepairRow>("SELECT * FROM capture_repairs WHERE account_id=? AND message_id=? AND state='blocked'", accountId,messageId)) retryCapture(sqlCaptureStorage(this.db),accountId,repair.key,repair.revision);
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

  private copyOp(op: import("@terno/store").OpRow | null): import("@terno/store").OpRow | null {
    if (!op || op.kind !== "send") return op;
    const receipt = sqlSendCopies(this.db).get(op.id);
    const flags = sendWarningFlags(receipt?.warning ?? op.last_error);
    const summary = JSON.parse(op.target_json) as { recipientPartial?: boolean; recipientOutcomeUnknown?: boolean };
    flags.partial ||= summary.recipientPartial === true;
    flags.unknown ||= summary.recipientOutcomeUnknown === true;
    if (!receipt && !flags.partial && !flags.unknown) return op;
    return { ...op, ...(receipt && receipt.copyRequested && !receipt.retiring && { sent_copy: receipt.copy }), send_partial: flags.partial, send_recipient_unknown: flags.unknown };
  }

  readonly recipientReceipts: MailStore["recipientReceipts"] = {
    claimRecovery: async (id, expected, now, active) => {
      const previous = this.db.get<{ target_json: string }>("SELECT target_json FROM ops WHERE id=? AND kind='send'", id);
      const existing = previous ? (JSON.parse(previous.target_json) as { recipientRecoveryChild?: unknown }).recipientRecoveryChild : null;
      if (typeof existing === "string") return existing;
      const selected = await rejectedRecipientSelection(expected, (kind, index) => this.recipientReceipts.readPart(id, kind, index), this.yieldTo);
      if (!selected.length) throw new RpcError("BAD_REQUEST", L("errors.recipientReceipt.unavailable"));
      const fields: { to: Address[]; cc: Address[]; bcc: Address[] } = { to: [], cc: [], bcc: [] };
      for (const entry of selected) fields[entry.role].push({ name: entry.name, email: entry.original });
      const prepared = await recipientReceiptParts(fields, this.yieldTo);
      return this.db.tx(() => {
      active?.();
      const op = this.db.get<Pick<import("@terno/store").OpRow, "kind" | "account_id" | "target_json">>("SELECT kind,account_id,target_json FROM ops WHERE id=?", id);
      if (!op || !submissionAccepted(op)) throw new RpcError("BAD_REQUEST", L("errors.recipientReceipt.unavailable"));
      const target = JSON.parse(op.target_json) as Record<string, unknown>;
      if (typeof target.recipientRecoveryChild === "string") return target.recipientRecoveryChild;
      const receipts = sqlRecipientReceipts(this.db), row = requireRecoverySource(receipts.get(id), expected, sqlSendCopies(this.db).get(expected.wireOwnerId ?? id));
      if (row.accountId !== op.account_id) throw new RpcError("BAD_REQUEST", L("errors.recipientReceipt.unavailable"));
      const child = enqueueOp(this.db, { accountId: row.accountId, kind: "send", target: { messageIds: [], recoveryParentId: id }, payload: { recoveryParentId: id } }, now)!;
      reserveRecipientReceipt(receipts, child, row.accountId, now, prepared, row.wireOwnerId ?? id);
      receipts.put({ ...row, childOpId: child });
      this.db.run("UPDATE ops SET target_json=? WHERE id=?", JSON.stringify({ ...target, recipientRecoveryChild: child }), id);
      return child;
      });
    },
    get: async (id) => sqlRecipientReceipts(this.db).get(id),
    list: async (accountId) => sqlRecipientReceipts(this.db).all().filter((row) => row.accountId === accountId),
    readPart: async (id, kind, index) => {
      const row = sqlRecipientReceipts(this.db).get(id);
      if (!row || row.retired || !Number.isSafeInteger(index) || index < 0 || index >= (kind === "envelope" ? row.parts : Math.ceil(row.count / 128))) return null;
      return this.db.get<{ data: string }>("SELECT data FROM recipient_receipt_parts WHERE id=?", `${id}:${kind}:${index}`)?.data ?? null;
    },
    finishRetire: async (id) => this.db.tx(() => finishRecipientRetirement(sqlRecipientReceipts(this.db), id, sqlSendCopies(this.db).get(sqlRecipientReceipts(this.db).get(id)?.wireOwnerId ?? id), sqlSendCopies(this.db).wirePinned(sqlRecipientReceipts(this.db).get(id)?.wireOwnerId ?? id))),
    retireSlice: async (id, force) => this.db.tx(() => {
      const receipt = sqlRecipientReceipts(this.db).get(id), copy = sqlSendCopies(this.db).get(id);
      if (receipt && !receipt.retired) {
        const op = this.db.get<{ last_error: string | null }>("SELECT last_error FROM ops WHERE id=?", id);
        if (op) this.db.run("UPDATE ops SET last_error=? WHERE id=?", clearRecipientWarning(op.last_error), id);
        if (copy) sqlSendCopies(this.db).put({ ...copy, warning: clearRecipientWarning(copy.warning) });
      }
      return retireRecipientSlice(sqlRecipientReceipts(this.db), id, force);
    }),
  };

  readonly sendCopies: MailStore["sendCopies"] = {
    pinned: async (id) => sqlSendCopies(this.db).wirePinned(id),
    get: (id) => Promise.resolve(sqlSendCopies(this.db).get(id)),
    list: (accountId) => Promise.resolve(sqlSendCopies(this.db).all().filter((r) => r.accountId === accountId && r.copyRequested).map(({ opId, accountId, submission, copy, createdAt, retiring }) => ({ opId, accountId, submission, copy, createdAt, retiring }))),
    resetWireSlice: async (id) => this.db.tx(() => resetCopyWireSlice(sqlSendCopies(this.db), id)),
    startWire: async (id, size) => this.db.tx(() => startCopyWire(sqlSendCopies(this.db), id, size)),
    appendWire: async (id, index, data) => this.db.tx(() => appendCopyWire(sqlSendCopies(this.db), id, index, data)),
    sealWire: async (id) => this.db.tx(() => sealCopyWire(sqlSendCopies(this.db), id)),
    readWire: async (id, index) => sqlSendCopies(this.db).chunk(id, index),
    accepted: async (id, warning) => this.db.tx(() => acceptCopySubmission(sqlSendCopies(this.db), id, warning)),
    record: async (id, copy, identity) => this.db.tx(() => { recordCopy(sqlSendCopies(this.db), id, copy, identity); this.db.run("UPDATE ops SET last_error=? WHERE id=? AND state='succeeded'", copyWarningText(sqlSendCopies(this.db).get(id)!), id); }),
    forgetSlice: async (id, force) => this.db.tx(() => forgetCopySlice(sqlSendCopies(this.db), id, force)),
    pruneSavedSlice: async (id) => this.db.tx(() => pruneSavedCopySlice(sqlSendCopies(this.db), id)),
  };

  readonly compose: MailStore["compose"] = {
    // Optimistic local copy + durable send op, atomically: a crash can't lose or duplicate the send.
    queueSend: async (p) => this.bodyCommand(async () => {
      p = structuredClone(p);
      const preparedRecipients = (await this.accounts.get(p.accountId))?.kind === "imap" ? await recipientReceiptParts(p, this.yieldTo) : null;
      const ftsTokens = preparedRecipients ? await prepareRecipientFts(this.db, p, this.yieldTo) : undefined;
      const correspondentChunks = preparedRecipients ? await prepareRecipientCorrespondents(p, this.yieldTo) : undefined;
      if (!await attachmentMessageBudgetAsync(p.bodyText, p.bodyHtml, p.attachments ?? [], this.yieldTo)) throw new RpcError("BAD_REQUEST", L("attachments.tooLarge"));
      if (preparedRecipients) await this.yieldTo();
      const check = () => { if (this.bodyClosing) throw new Error("The store is closing"); };
      const body = await stageBody(this.db, { accountId: p.accountId, bodyText: p.bodyText, bodyHtml: p.bodyHtml || null, snippet: "" }, this.yieldTo, check);
      try {
      return this.db.tx(() => {
        check();
        // a draft is sent once: sending deletes it, so a second send of the same draft finds nothing
        const draft = p.draftId === undefined ? undefined : this.db.get<{ account_id: number; revision: number; generation: string; attachments_json: string; reply_context_json: string | null; in_reply_to_message_id: number | null; mode: string; subject: string }>("SELECT account_id, revision, generation, attachments_json, reply_context_json, in_reply_to_message_id, mode, subject FROM drafts WHERE id = ?", p.draftId);
        if (p.draftId !== undefined && (!draft || (draft.generation ?? "") !== (p.draftGeneration ?? ""))) throw new RpcError("STALE", L("errors.draftGone"), { reason: "draftMissing" });
        if (p.scheduledAt !== undefined && !stillScheduled(this.db, p.draftId, p.scheduledAt)) throw new RpcError("STALE", L("errors.draftGone"), { reason: "unscheduled" });
        if (p.forward && !forwardSendOpen(this.db, p.forward)) throw new RpcError("STALE", L("errors.forwardGone"), { reason: "forwardGone" });
        if (draft && (draft.account_id !== p.accountId || (p.draftRevision !== undefined && p.draftRevision !== draft.revision))) throw new RpcError("STALE", L("errors.draftGone"), { reason: "draftRevision" });
        const account = getAccount(this.db, p.accountId);
        if (!account) throw new RpcError("NOT_FOUND", L("errors.accountGone"));
        const cfg = getAccountConfig<{ senderName?: string }>(this.db, p.accountId)!;
        const from: Address = { name: cfg.config.senderName || account.displayName, email: account.email };
        if (draft && p.attachments === undefined && JSON.parse(draft.attachments_json ?? "[]").length) throw assetError();
        const attachments = validateAssets(sqlAssets(this.db), p.accountId, p.attachments ?? []);
        const context = draft?.reply_context_json ? JSON.parse(draft.reply_context_json) as import("@terno/core/rpc").ReplyContext : null;
        if (context && (p.draftRevision === undefined || p.subject !== draft?.subject || draft?.in_reply_to_message_id !== context.sourceId || p.inReplyToMessageId !== context.sourceId || (draft.mode !== "reply" && draft.mode !== "replyAll"))) throw new RpcError("BAD_REQUEST", L("errors.replySourceGone"));
        let inReplyTo: string | null = null;
        let references: string[] = [];
        let providerThreadId: string | null = null;
        let replyThreadId: number | null = null;
        if (p.inReplyToMessageId && draft?.mode !== "forward") {
          const original = this.db.get<{ rfc_message_id: string | null; references_json: string; thread_id: number; account_id: number }>(
            "SELECT rfc_message_id, references_json, thread_id, account_id FROM messages WHERE id = ?",
            p.inReplyToMessageId,
          );
          if (!original || (context && original.account_id !== context.sourceAccountId)) throw new RpcError("BAD_REQUEST", L("errors.replySourceGone"));
          if (!context || !detachedReply(p.subject, context)) {
            inReplyTo = original.rfc_message_id;
            references = [...(JSON.parse(original.references_json) as string[]), ...(original.rfc_message_id ? [original.rfc_message_id] : [])];
            replyThreadId = original.thread_id;
            if (original.account_id === p.accountId) {
              providerThreadId = this.db.get<{ provider_thread_id: string | null }>("SELECT provider_thread_id FROM threads WHERE id = ?", original.thread_id)?.provider_thread_id ?? null;
            }
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
          preparedRecipients ? { ...preparedRecipients, ftsTokens, correspondentChunks } : undefined,
        );
        const localId = ingest.inserted[0]!;
        const payloadJson = preparedRecipients
          ? `${JSON.stringify({ ...payload, to: undefined, cc: undefined, bcc: undefined }).slice(0, -1)},"to":${preparedRecipients.toJson},"cc":${preparedRecipients.ccJson},"bcc":${preparedRecipients.bccJson}}`
          : undefined;
        const opId = enqueueOp(this.db, { accountId: p.accountId, kind: "send", target: { messageIds: [localId] }, payload }, p.now, undefined, payloadJson)!;
        if (account.kind === "imap") { if (!preparedRecipients) throw new RpcError("BAD_REQUEST", L("errors.accountGone")); reserveRecipientReceipt(sqlRecipientReceipts(this.db), opId, p.accountId, p.now, preparedRecipients); }
        if (account.kind === "imap") reserveSendCopy(sqlSendCopies(this.db), opId, p.accountId, p.now, p.to.length + p.cc.length + p.bcc.length, !!(cfg.config as { appendToSent?: boolean }).appendToSent);
        linkAssets(sqlAssets(this.db), "op", opId, attachments);
        if (p.draftId) transferGeneration(this.db, { draftId: p.draftId, draftGeneration: p.draftGeneration ?? "", messageId: localId, opId, transfer: p.writing, now: p.now });
        if (p.draftId) deleteDraft(this.db, p.draftId);
        if (p.forward) linkForwardSend(this.db, p.forward, opId, p.now);
        if (replyThreadId && p.recordReply) recordUserActions(this.db, [replyThreadId], "reply", p.now);
        const threadId = this.db.get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE id = ?", localId)!.thread_id;
        return { opId, threadId, messageId: localId, deltas: ingest.deltas };
      });
      } finally { if (body.bodyCapture) await finishBodyStage(this.db, body.bodyCapture.id, this.yieldTo); }
    }),
  };

  // ───────────────────────────── AI on new mail (plans 131, 132) ─────────────────────────────

  readonly newMail: MailStore["newMail"] = {
    page: async (want, after, limit) => newMailPage(this.db, want, after, limit),
    consume: async (want, messageIds) => consumeNewMail(this.db, want, messageIds),
    clear: async (want) => clearNewMail(this.db, want),
    prune: async (now) => pruneNewMail(this.db, now),
  };

  private summaryClears = 0;

  private followupClears = 0;

  private digestClears = 0;
  readonly today: MailStore["today"] = {
    waitingPage: async (o) => waitingPage(this.db, o),
    waitingAmong: async (ids, now) => waitingAmong(this.db, ids, now),
    needsCount: async (now) => needsCount(this.db, now),
    digestFacts: async (ids) => digestFacts(this.db, ids),
    digestLive: async (ids) => digestLive(this.db, ids),
    messagesHere: async (ids) => messagesHere(this.db, ids),
    digest: {
      get: async (day) => getDigest(this.db, day),
      latest: async (day) => latestDigest(this.db, day),
      begin: async (day, watermark, pending, generation) => generation === this.digestClears && beginDigest(this.db, day, watermark, pending),
      write: async (row, generation) => {
        if (generation !== this.digestClears) return false;
        writeDigest(this.db, row);
        return true;
      },
      pendingDays: async () => pendingDigestDays(this.db),
      all: async () => allDigests(this.db),
      prune: async (keepFrom) => pruneDigests(this.db, keepFrom),
      clear: async () => {
        this.digestClears++;
        clearDigests(this.db);
      },
      clearGeneration: () => this.digestClears,
    },
  };
  private replyClears = 0;
  readonly replies: MailStore["replies"] = {
    get: async (threadId) => getReply(this.db, threadId),
    finish: async (w) => (w.clearGeneration === this.replyClears ? finishReply(this.db, w) : "cleared"),
    transition: async (threadId, from, to) => transitionReply(this.db, threadId, from, to),
    clear: async () => {
      this.replyClears++;
      clearReplies(this.db);
    },
    clearGeneration: () => this.replyClears,
  };
  readonly followups: MailStore["followups"] = {
    marks: {
      page: async (after, limit) => sentMarkPage(this.db, after, limit),
      count: async () => sentMarkCount(this.db),
      queueScan: async (ids, now) => queueScan(this.db, ids, now),
      consume: async (id) => void this.db.run("DELETE FROM ai_sent_mail WHERE message_id = ?", id),
      clear: async () => void this.db.run("DELETE FROM ai_sent_mail"),
      prune: async (now) => pruneSentMarks(this.db, now),
    },
    scanCandidates: async (since, limit) => followupScanCandidates(this.db, since, limit),
    source: async (id) => followupSource(this.db, id),
    finish: async (w) => (w.clearGeneration === this.followupClears ? finishFollowups(this.db, w) : "gone"),
    active: async () => activeFollowups(this.db),
    ofThread: async (id) => threadFollowups(this.db, id),
    get: async (id) => getFollowup(this.db, id),
    nextDue: async () => nextFollowupDue(this.db),
    makeDue: async (now) => makeFollowupsDue(this.db, now),
    claimNotice: async (ids, now) => claimFollowupNotice(this.db, ids, now),
    closeAnswered: async (ids, now) => closeAnsweredFollowups(this.db, ids, now),
    endTop: async (ids) => endFollowupTop(this.db, ids),
    update: async (id, revision, patch) => updateFollowup(this.db, id, revision, patch),
    restore: async (rows) => restoreFollowups(this.db, rows),
    prune: async (now) => pruneFollowups(this.db, now),
    clear: async () => {
      this.followupClears++;
      clearFollowups(this.db);
    },
    clearGeneration: () => this.followupClears,
  };

  private askClears = 0;

  readonly ask: MailStore["ask"] = {
    passages: (req) => this.bodyCommand(() => readPassages(req, {
      matching: (query, threadIds, signal, workParts) => askMatching(this.db, query, threadIds, this.yieldTo, signal, workParts),
      newest: async (threadIds) => askNewest(this.db, threadIds),
      headers: async (ids) => askHeaders(this.db, ids),
      text: async (id) => askText(this.db, id, this.yieldTo),
    })),
    sourceStates: async (ids) => new Map([...askHeaders(this.db, ids)].map(([id, m]) => [id, { state: m.spam ? "spam" : m.trash ? "trash" : "ok", threadId: m.threadId }] as const)),
    history: {
      // the check and the write are one synchronous step, as is clear
      add: async (write) => (write.clearGeneration === this.askClears ? addAskTurn(this.db, write) : null),
      list: async () => listAskConversations(this.db),
      turns: async (id) => askTurns(this.db, id),
      turnCount: async (id) => askTurnCount(this.db, id),
      accountsOf: async (id) => askAccountsOf(this.db, id),
      remove: async (id) => removeAskConversation(this.db, id),
      restore: async (copy) => restoreAskConversation(this.db, copy),
      removeForAccount: async (accountId) => removeAskForAccount(this.db, accountId),
      clear: async () => {
        this.askClears++;
        clearAsk(this.db);
      },
      clearGeneration: () => this.askClears,
    },
  };

  readonly aiSummaries: MailStore["aiSummaries"] = {
    get: async (threadId) => getSummary(this.db, threadId),
    sources: async (threadId) => summarySources(this.db, threadId),
    text: async (requests) => this.bodyCommand(async () => {
      const out = new Map<number, string | null>();
      for (const { messageId, limit } of requests) {
        const reference = bodyReadReference(this.db, messageId);
        if (!reference) {
          out.set(messageId, this.db.get<{ text: string | null }>("SELECT substr(body_text, 1, ?) AS text FROM message_bodies WHERE message_id = ?", limit, messageId)?.text ?? null);
          continue;
        }
        if (reference.textParts === null) { out.set(messageId, null); continue; }
        const release = retainBody(this.db, reference.version);
        try { out.set(messageId, await bodyPrefix(sqlBodyParts(this.db, reference.version, 0, this.yieldTo), limit)); }
        finally { release(); }
      }
      return out;
    }),
    pending: async (after, limit) => pendingSummaries(this.db, after, limit),
    pendingCount: async () => pendingSummaryCount(this.db),
    lastFailure: async () => lastSummaryFailure(this.db),
    attempt: async (threadId, kind, max, now) => attemptSummary(this.db, threadId, kind, max, now),
    fail: async (threadId, kind, now) => failSummary(this.db, threadId, kind, now),
    drop: async (threadId, expectThrough) => dropSummary(this.db, threadId, expectThrough),
    // the check and the write are one synchronous step, as is clear: neither can land between the other's parts
    finish: async (write) => (write.clearGeneration === this.summaryClears ? finishSummary(this.db, write) : "gone"),
    dropPending: async () => dropPendingSummaries(this.db),
    clear: async () => {
      this.summaryClears++;
      clearSummaries(this.db);
    },
    clearGeneration: () => this.summaryClears,
    prune: async (now, maxRows) => pruneSummaries(this.db, now, maxRows),
  };

  // ───────────────────────────── drafting (plan 133) ─────────────────────────────

  readonly writing: MailStore["writing"] = {
    corpus: {
      headers: async (p) => corpusHeaders(this.db, p),
      texts: async (ids) => (await this.autocomplete.sentTexts(ids.slice(0, CORPUS_TEXTS_MAX))).map((t) => ({ id: t.id, text: t.text })),
      usable: async (ids) => corpusUsable(this.db, ids),
    },
    sentTo: async (p) => writingSentTo(this.db, p, this.yieldTo),
    threadsWith: async (p) => writingThreadsWith(this.db, p, this.yieldTo),
    threadContext: async (threadId, budget) => {
      const sources = await this.aiSummaries.sources(threadId);
      return sources ? readThreadContext(sources, threadRecipients(this.db, threadId), budget, (requests) => this.aiSummaries.text(requests)) : null;
    },
    profiles: {
      read: async (keys) => readProfiles(this.db, keys),
      list: async (p) => listProfiles(this.db, p),
      commit: async (c) => commitProfiles(this.db, c),
      judge: async (w) => judgeProfile(this.db, w),
      edit: async (e) => editProfile(this.db, e),
      reset: async (scopeKey, language) => resetProfile(this.db, scopeKey, language),
      clearJudgments: async (accountId) => clearJudgments(this.db, accountId),
      clear: async (stateKeys) => clearWriting(this.db, stateKeys),
    },
    generations: {
      commit: async (c) => commitGeneration(this.db, c),
      forDraft: async (draftId) => generationForDraft(this.db, draftId),
      forMessage: async (messageId) => generationForMessage(this.db, messageId),
      pairs: async (p) => generationPairs(this.db, p),
    },
  };

  // ───────────────────────────── forwards (plan 116) ─────────────────────────────

  readonly forwards: MailStore["forwards"] = {
    active: async () => forwardsActive(this.db),
    setCategory: async (categoryId, forward, now) => setCategoryForward(this.db, categoryId, forward, now),
    plan: async (p) => planForwards(this.db, p),
    eligiblePage: async (now, after, limit) => eligiblePage(this.db, now, after, limit),
    list: async (_now, limit) => listForwards(this.db, limit),
    holds: async (now) => forwardHolds(this.db, now),
    work: async (now, limit, after) => forwardWork(this.db, now, limit, after),
    waitingCount: async () => waitingCount(this.db),
    cancelWaiting: async (upTo, now) => cancelWaiting(this.db, upTo, now),
    filesReady: async (p, now) => this.db.tx(() => filesReady(this.db, p, now)),
    nextDue: async () => nextForwardDue(this.db),
    ruleGone: async (rule, now) => forwardRuleGone(this.db, rule, now),
    cancel: async (ids, now) => cancelForwards(this.db, ids, now),
    claim: async (id, now, o) => claimForward(this.db, id, now, o),
    waitForFiles: async (id, until, now) => waitForFiles(this.db, id, until, now),
    fail: async (id, reason, now) => failForward(this.db, id, reason, now),
    retry: async (id, now, failedOps) => retryForward(this.db, id, now, failedOps),
    approve: async (rule, now) => approveRule(this.db, rule, now),
    stop: async (rule, now) => stopRule(this.db, rule, now),
    prune: async (now) => pruneForwards(this.db, now),
    get: async (id) => getForward(this.db, id),
  };

  // ───────────────────────────── filters ─────────────────────────────

  readonly filters: MailStore["filters"] = {
    list: async () => listFilters(this.db),
    get: async (id) => getFilter(this.db, id),
    save: async (f, now) => saveFilter(this.db, f, now),
    delete: async (id, expect) => deleteFilter(this.db, id, expect),
    preview: async (rule, now, limit) => this.bodyCommand(async () => {
      const prepared = await prepareBodyMatches(this.db, rule.conditions.flatMap((c) => c.field === "body" ? [{ op: c.op, value: c.value }] : c.field === "text" ? [{ op: "contains" as const, value: c.value }] : []), this.yieldTo);
      const matches = withBodyMatches(this.db, prepared, () => findRuleMatches(this.db, rule, now));
      const top = this.db
        .all<{ id: number }>(
          "SELECT id FROM threads WHERE id IN (SELECT value FROM json_each(?)) ORDER BY last_date DESC, id DESC LIMIT ?",
          JSON.stringify(matches.threadIds),
          limit,
        )
        .map((r) => r.id);
      return { count: matches.threadIds.length, sample: getSummaries(this.db, top) };
    }),
    messageIdRange: async () => {
      const r = this.db.get<{ lo: number | null; hi: number | null }>("SELECT min(id) AS lo, max(id) AS hi FROM messages")!;
      return r.lo === null || r.hi === null ? null : { lo: r.lo, hi: r.hi };
    },
    matchWindow: async (rule, now, window) => this.bodyCommand(async () => {
      const prepared = await prepareBodyMatches(this.db, rule.conditions.flatMap((c) => c.field === "body" ? [{ op: c.op, value: c.value }] : c.field === "text" ? [{ op: "contains" as const, value: c.value }] : []), this.yieldTo);
      return withBodyMatches(this.db, prepared, () => findRuleMatches(this.db, rule, now, undefined, window).messageIds);
    }),
    messageWalk: () => {
      let before = Number.MAX_SAFE_INTEGER;
      return {
        next: async (limit) => {
          const ids = this.db.all<{ id: number }>("SELECT id FROM messages WHERE id < ? ORDER BY id DESC LIMIT ?", before, limit).map((r) => r.id);
          if (ids.length) before = ids[ids.length - 1]!;
          return ids;
        },
      };
    },
    threadsOf: async (ids) => this.db.all<{ thread_id: number }>("SELECT DISTINCT thread_id FROM messages WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(ids)).map((r) => r.thread_id),
    actionFacts: async (ids, categoryId) =>
      this.db
        .all<{ id: number; account_id: number; subject: string; last_date: number; last_from_name: string; last_from_email: string; message_count: number; unread_count: number; is_starred: number; has_sent: number; in_inbox: number; in_trash: number; in_spam: number; in_category: number }>(
          `SELECT t.id, t.account_id, t.subject, t.last_date, t.last_from_name, t.last_from_email, t.message_count, t.unread_count, t.is_starred, t.has_sent, t.in_inbox, t.in_trash, t.in_spam,
             EXISTS (SELECT 1 FROM thread_categories c WHERE c.thread_id = t.id AND c.category_id = ?) AS in_category
           FROM threads t WHERE t.id IN (SELECT value FROM json_each(?))`,
          categoryId ?? -1,
          JSON.stringify(ids),
        )
        .map((t) => ({ id: t.id, accountId: t.account_id, subject: t.subject, lastDate: t.last_date, lastFromName: t.last_from_name, lastFromEmail: t.last_from_email, messageCount: t.message_count, unread: t.unread_count > 0, starred: !!t.is_starred, replied: !!t.has_sent, inInbox: !!t.in_inbox, inTrash: !!t.in_trash, inSpam: !!t.in_spam, inCategory: !!t.in_category })),
    matchMessages: async (rule, now, messageIds) => this.bodyCommand(async () => {
      const tests = rule.conditions.flatMap((c) => c.field === "body" ? [{ op: c.op, value: c.value }] : c.field === "text" ? [{ op: "contains" as const, value: c.value }] : []);
      // only these messages' bodies: a walk's windows would otherwise each reread the whole mailbox (plan 143's review)
      const captures = tests.length ? this.db.all<{ id: string }>("SELECT DISTINCT capture_id AS id FROM body_heads WHERE message_id IN (SELECT value FROM json_each(?))", JSON.stringify(messageIds)).map((r) => r.id) : [];
      const prepared = await prepareBodyMatches(this.db, tests, this.yieldTo, captures, "selected");
      return withBodyMatches(this.db, prepared, () => findRuleMatches(this.db, rule, now, messageIds).messageIds);
    }),
    applyChunk: async (id, ruleJson, messageIds, now) =>
      this.db.tx(() => {
        const flagBefore = flagEpochs(sqlFlags(this.db));
        // edited (or deleted) while it was being applied: stop, don't recreate stale claims
        const current = this.db.get<{ rule_json: string }>("SELECT rule_json FROM filters WHERE id = ?", id);
        if (!current || current.rule_json !== ruleJson) throw new RpcError("CANCELLED", L("errors.filterChanged"));
        const rule = JSON.parse(ruleJson) as FilterRule;
        const eligible = rule.conditions.some((c) => c.field === "body")
          ? this.db.all<{ id: number }>("SELECT id FROM messages WHERE body_state = 'full' AND id IN (SELECT value FROM json_each(?))", JSON.stringify(messageIds)).map((m) => m.id)
          : messageIds;
        const ids = claimFilterApplications(this.db, id, eligible, now);
        const opIds: string[] = [];
        const folderMoves: FolderFilterMove[] = [];
        // asked for by hand: wherever the mail is now, not only the Inbox (plan 128)
        const touched = this.runFilterActions(rule.actions, ids, now, opIds, folderMoves, null);
        this.flushFolderMoves(folderMoves, now, opIds, touched);
        return { applied: ids.length, touched: [...touched], opIds, ...flagReconciliation(sqlFlags(this.db), flagBefore) };
      }),
  };

  // ───────────────────────────── categories ─────────────────────────────

  readonly folders: MailStore["folders"] = {
    list: async () => listFolders(this.db),
    replace: async (accountId, folders, carried, rebuild) => replaceFolders(this.db, accountId, folders, carried, rebuild),
    rebuild: async (limit) => rebuildFolders(this.db, limit),
    count: async (accountId, keys, after, limit) => countFolderMessages(this.db, accountId, keys, after, limit),
    carry: async (accountId, from, to, after, limit) => carryFolder(this.db, accountId, from, to, after, limit),
    clear: async (accountId, key, limit) => clearFolder(this.db, accountId, key, limit),
  };

  readonly folderExport: MailStore["folderExport"] = {
    ids: async (target, after, limit) => exportIds(this.db, target, after, limit),
    messages: async (ids) => exportMessages(this.db, ids),
    body: async (id, part, at, size) => this.bodyCommand(() => withBodySelection(this.db, () => ({ value: exportBody(this.db, id, part, at, size), ids: [id] }), async (inline, references) => {
      const reference = references.get(id);
      if (!reference) return inline;
      const count = part === "text" ? reference.textParts : reference.htmlParts;
      return count === null ? null : bodyPartRange(sqlBodyParts(this.db, reference.version, part === "text" ? 0 : 1, this.yieldTo), count, at, size);
    })),
    // a byte range a call: nothing held
    release: () => {},
  };

  readonly categories: MailStore["categories"] = {
    list: async () => listCategories(this.db),
    exists: async (id) => this.db.get("SELECT 1 FROM categories WHERE id = ?", id) !== undefined,
    hasThreads: async (id) => this.db.get("SELECT 1 FROM thread_categories WHERE category_id = ? LIMIT 1", id) !== undefined,
    create: async (name, color, options) => createCategory(this.db, name, color, options),
    update: async (id, patch) => updateCategory(this.db, id, patch),
    reorder: async (ids) => reorderCategories(this.db, ids),
    delete: async (id) => this.db.tx(() => {
      deleteCategory(this.db, id);
      // plan 116: what its trigger waited or held never goes
      forwardRuleGone(this.db, { kind: "category", id }, Date.now());
    }),
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
    abandonMove: async (batchId) => abandonMove(this.db, batchId),
    trainMoveSlice: async (batchId, threadIds, now) => trainMoveSlice(this.db, batchId, threadIds, now),
    applyMoveSlice: async (batchId, threadIds, now) => applyMoveSlice(this.db, batchId, threadIds, now),
    undoMoveBegin: async (batchId, now) => undoMoveBegin(this.db, batchId, now),
    undoMoveSlice: async (batchId, threadIds, now) => undoMoveSlice(this.db, batchId, threadIds, now),
    restoreMoveSlice: async (batchId, threadIds) => restoreMoveSlice(this.db, batchId, threadIds),
  };

  readonly reminders: MailStore["reminders"] = {
    list: async () => listReminders(this.db),
    put: async (rows, cap, o) => putReminders(this.db, rows, cap, o?.ifAbsent),
    delete: async (threadIds, o) => deleteReminders(this.db, threadIds, o?.dueBy),
    deleteExact: async (rows) => deleteExactReminders(this.db, rows),
    answered: async (rows) => answeredReminders(this.db, rows),
  };

  readonly scheduled: MailStore["scheduled"] = {
    list: async () => listScheduled(this.db),
    get: async (draftId) => getScheduled(this.db, draftId),
    put: async (row, cap) => putScheduled(this.db, row, cap),
    reschedule: async (draftId, sendAt) => rescheduleScheduled(this.db, draftId, sendAt),
    fail: async (draftId, sendAt, error, retryAt) => failScheduled(this.db, draftId, sendAt, error, retryAt),
    delete: async (draftId) => deleteScheduled(this.db, draftId),
  };

  readonly similar: MailStore["similar"] = {
    offers: async (threadIds, action) => similarOffers(this.db, threadIds, action),
    scopes: async (threadIds) => similarScopesOf(this.db, threadIds),
    resolvePage: async (scope, action, targets, cursor, limit) => resolveSimilarPage(this.db, scope, action, targets, cursor, limit),
    kept: async (threadIds) => keptThreads(this.db, threadIds),
    roots: async (threadIds) => rootRefs(this.db, threadIds).map((r) => r.messageId),
    automated: async (threadIds) => {
      const ids = [...new Set(threadIds)];
      // a thread whose facts aren't computed yet (person NULL, before the backfill) may well be a person's
      const r = this.db.get<{ n: number; known: number }>("SELECT count(*) n, count(CASE WHEN t.person = 0 THEN 1 END) known FROM json_each(?) j JOIN threads t ON t.id = j.value", JSON.stringify(ids))!;
      return r.n === ids.length && r.n > 0 && r.known === r.n;
    },
  };

  readonly storage: MailStore["storage"] = {
    threads: async (after, limit) => storageThreads(this.db, after, limit),
    remove: async (r) => removeStorage(this.db, r),
    collect: async (now) =>
      this.db.tx(() => {
        const account = this.db.get<{ account_id: number }>("SELECT account_id FROM attachment_orphans WHERE grace_started_at < ? LIMIT 1", now - 86_400_000);
        return account ? cleanupAssets(sqlAssets(this.db), account.account_id, now) : false;
      }),
    footprint: async () => footprint(this.db),
    compact: async (pages) => {
      if (incrementalVacuum(this.db)) return { ...compactPages(this.db, pages), onRestart: false };
      // an older file can't give pages back without a VACUUM: where the host runs one on open, it's asked for (plan 69)
      if (!this.db.driver.features.compactOnOpen || this.db.path === ":memory:" || !footprint(this.db).free) return { more: false, onRestart: false };
      setSetting(this.db, COMPACT_KEY, { state: "pending" });
      return { more: false, onRestart: true };
    },
    compactPending: async () => getSetting<{ state?: string }>(this.db, COMPACT_KEY, {}).state === "pending",
  };

  private async preparedScope<V>(scope: import("@terno/core").CategorizeScope, work: () => V): Promise<V> {
    return this.bodyCommand(async () => {
    const resolved = resolvable(scope);
    const tests = resolved.kind === "query" ? searchTerms(parseSearch(resolved.query)).filter((t) => t.field === "text").map((t) => ({ op: "contains" as const, value: t.value, prefix: t.prefix })) : [];
    const matches = await prepareBodyMatches(this.db, tests, this.yieldTo);
    return withBodyMatches(this.db, matches, work);
    });
  }

  readonly categorize: MailStore["categorize"] = {
    quickActions: async (categoryId, threadIds, model) => quickActions(this.db, categoryId, threadIds, model),
    countScope: async (categoryId, scope, now) => this.preparedScope(scope, () => countScope(this.db, categoryId, scope, now)),
    resolveScope: async (categoryId, scope, now, limit) => this.preparedScope(scope, () => resolveScope(this.db, categoryId, scope, now, limit)),
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
    recordAiFiling: async (f) =>
      this.db.tx(() => {
        const none = { outcome: "none" as const, deltas: [] };
        if (!this.aiCandidate(f.threadId)) return none;
        const v = vetoesFor(this.db, f.threadId, f.sender, [f.categoryId], f.now).get(f.categoryId);
        if (v?.hard || (v && senderVetoed(v)) || f.model.lookAlike(f.encoded)) return none;
        const bar = aiFilingBar(this.db, f.categoryId);
        if (bar === "gone") return none;
        const decide = (kind: "auto" | "suggest", explain: typeof f.explain) =>
          this.db.run("INSERT INTO cls_decisions (thread_id, category_id, kind, p, explain_json, at) VALUES (?, ?, ?, ?, ?, ?)", f.threadId, f.categoryId, kind, f.p, JSON.stringify(explain), f.now);
        if (bar === "suggest") {
          decide("suggest", f.suggestExplain);
          return { outcome: "suggested" as const, deltas: [] };
        }
        decide("auto", f.explain);
        this.db.run("INSERT OR IGNORE INTO thread_categories (thread_id, category_id, added_by, added_at) VALUES (?, ?, 'auto', ?)", f.threadId, f.categoryId, f.now);
        return { outcome: "filed" as const, deltas: [{ op: "unbackground" as const, threadId: f.threadId }] };
      }),
    categoryEvidence: async (o) => categoryEvidence(this.db, o),
  };

  /** New-mail-like (inbox, not spam/trash/draft) and nobody decided on it yet. */
  private aiCandidate(threadId: number): boolean {
    const root = rootRefs(this.db, [threadId])[0];
    if (!root || !root.inInbox || root.spam || root.trash || root.draft) return false;
    return !this.db.get(
      `SELECT 1 FROM thread_categories WHERE thread_id = ? UNION ALL SELECT 1 FROM cls_decisions WHERE thread_id = ?
       UNION ALL SELECT 1 FROM cls_examples WHERE thread_id = ? LIMIT 1`,
      threadId, threadId, threadId,
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
    remove: async (id) => {
      for (const row of sqlRecipientReceipts(this.db).all().filter((r) => r.accountId === id)) while (await this.recipientReceipts.retireSlice(row.opId, true)) await this.yieldTo();
      for (const row of sqlSendCopies(this.db).all().filter((r) => r.accountId === id)) while (await this.sendCopies.forgetSlice(row.opId, true)) await this.yieldTo();
      for (const row of sqlRecipientReceipts(this.db).all().filter((r) => r.accountId === id)) await this.recipientReceipts.finishRetire(row.opId);
      return this.db.tx(() => {
        removeAccount(this.db, id);
        // plan 17 (Codex R3, R5): one address fewer, and its replies gone: every thread's facts are checked again
        startRescan(this.db);
        this.db.run("DELETE FROM secrets WHERE name LIKE ?", `account:${id}:%`);
        this.providerStores.delete(id);
      });
    },
    admitGoogle: async (stamp, google) => this.db.tx(() => {
      const account = accountStamp(this.db, stamp.id);
      const config = getAccountConfig<Record<string, unknown>>(this.db, stamp.id)?.config;
      if (!account || getAccount(this.db, stamp.id)?.kind !== "gmail" || account.email !== stamp.email || account.createdAt !== stamp.createdAt || !config || (config.googleSubject ?? null) !== google.expectedSubject || (google.expectedSubject !== null && google.expectedSubject !== google.subject) || (google.eligible && !google.eligible())) return false;
      if (config.googleSubject !== google.subject) setAccountProviderConfig(this.db, stamp.id, { ...config, googleSubject: google.subject });
      return true;
    }),
    setSyncState: async (id, patch) => setAccountSyncState(this.db, id, patch),
    setProviderConfig: async (id, config) => setAccountProviderConfig(this.db, id, config),
    setCursor: async (id, cursor, check) => { check?.(); setAccountCursor(this.db, id, cursor); },
  };

  readonly owner: MailStore["owner"] = {
    get: async () => getOwner(this.db),
    confirm: async (c) => this.db.tx(() => {
      const owner = this.db.get(`SELECT 1 FROM owner WHERE id = 1 AND account_id = ? AND email = ? AND display_name = ? AND provider = ? AND verified_by = ? AND evidence_json = ? AND verified_at = ? AND updated_at = ?`, c.claim.accountId, c.claim.email.toLowerCase(), c.claim.displayName, c.claim.provider, c.claim.verifiedBy, JSON.stringify(c.claim.evidence), c.now, c.now);
      return !!owner && this.commitSecret({ kind: "retain", google: c.secret.google && { expectedSubject: c.secret.google.subject, subject: c.secret.google.subject }, name: c.secret.name, expectedBlob: c.secret.kind === "retain" ? c.secret.expectedBlob : c.secret.blob }, { ...c.stamp, id: c.claim.accountId });
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
    sourceContext: async (id) => this.db.get<{ threadId: number; accountId: number }>("SELECT t.id AS threadId, t.account_id AS accountId FROM messages m JOIN threads t ON t.id = m.thread_id AND t.account_id = m.account_id WHERE m.id = ?", id) ?? null,
    delete: async (id, generation) => deleteDraft(this.db, id, generation),
    messageRef: async (id) => messageRef(this.db, id),
    findMessage: async (accountId, rfc) => findMessageByRef(this.db, accountId, rfc),
  };

  readonly providerCooldown: MailStore["providerCooldown"] = {
    read: () => this.cooldownAction(async () => { const encoded = getSetting<string | null>(this.db, PROVIDER_COOLDOWN_KEY, null); decodeCooldown(encoded); return encoded; }),
    update: (fn) => this.cooldownAction(async () => this.db.tx(() => {
      const current = getSetting<string | null>(this.db, PROVIDER_COOLDOWN_KEY, null);
      decodeCooldown(current);
      const next = fn(current);
      if (!next || typeof next !== "object" || "then" in next) throw new Error("Cooldown callback must be synchronous");
      if (next.result !== null && (typeof next.result === "object" || typeof next.result === "function") && "then" in next.result) throw new Error("Cooldown result must be synchronous");
      encodeCooldown(decodeCooldown(next.encoded));
      setSetting(this.db, PROVIDER_COOLDOWN_KEY, next.encoded);
      return next.result;
    })),
    bind: (input, mailboxKey, current = () => true) => {
      const captured = { ...input };
      return this.cooldownAction(async () => {
        const stamp = captured;
        if (!mailboxKeyValid(mailboxKey)) throw new Error("Invalid private mailbox key");
        const digest = await mailboxDigest(stamp.email, (bytes) => crypto.subtle.digest("SHA-256", bytes));
        if (digest !== mailboxKey) return false;
        return this.db.tx(() => {
          const account = accountStamp(this.db, stamp.id);
          const kind = this.db.get<{ kind: string }>("SELECT kind FROM accounts WHERE id = ?", stamp.id)?.kind;
          if (!current() || !account || kind !== "gmail" || account.email !== stamp.email || account.createdAt !== stamp.createdAt) return false;
          const next = bindCooldown(getSetting<string | null>(this.db, PROVIDER_COOLDOWN_KEY, null), stamp, digest, mailboxKey);
          setSetting(this.db, PROVIDER_COOLDOWN_KEY, next);
          return decodeCooldown(next).bindings.some((b) => b.id === stamp.id && b.createdAt === stamp.createdAt && b.mailboxKey === mailboxKey && b.emailDigest === digest);
        });
      });
    },
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
    const config = getAccountConfig<Record<string, unknown>>(this.db, stamp.id)?.config;
    if (intent.google && (getAccount(this.db, stamp.id)?.kind !== "gmail" || !config || (config.googleSubject ?? null) !== intent.google.expectedSubject || (intent.google.expectedSubject !== null && intent.google.expectedSubject !== intent.google.subject) || (intent.google.eligible && !intent.google.eligible()))) return false;
    const current = getSecret(this.db, intent.name);
    const expected = intent.expectedBlob;
    if (expected === null ? current !== null : !current || current.length !== expected.length || !current.every((b, i) => b === expected[i])) return false;
    if (intent.google && config!.googleSubject !== intent.google.subject) setAccountProviderConfig(this.db, stamp.id, { ...config, googleSubject: intent.google.subject });
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
    if (!s) this.providerStores.set(accountId, (s = new SqlProviderStore(this.db, accountId, () => this.settle())));
    if (!Object.prototype.hasOwnProperty.call(s, "setting")) {
      const read = s.setting.bind(s);
      s.setting = <V,>(key: string): Promise<V | null> => key === PROVIDER_COOLDOWN_KEY ? Promise.resolve(null) : read<V>(key);
    }
    return s;
  }

  // ───────────────────────────── facts (plan 17) ─────────────────────────────

  readonly facts: MailStore["facts"] = {
    backfill: async ({ limit }) => this.db.tx(() => backfillSlice(this.db, limit)),
    idle: async () => factsIdle(this.db),
  };

  readonly tabs: MailStore["tabs"] = {
    backfill: async ({ limit }) => this.db.tx(() => tabsSlice(this.db, limit)),
    idle: async () => tabsIdle(this.db),
  };

  readonly debug: MailStore["debug"] = {
    snapshot: async () => this.bodyCommand(() => withBodySelection(this.db, () => {
      const value = storeSnapshot(this.db);
      return { value, ids: value.messages.map((message) => message.id) };
    }, async (snapshot, references) => {
        for (const message of snapshot.messages) {
          const reference = references.get(message.id);
          if (!reference) continue;
          const body = await hydrateBodyReference(this.db, reference, this.yieldTo);
          message.bodyText = body.bodyText;
          const doc = snapshot.search.messages.find((doc) => doc.messageId === message.id);
          if (doc) { doc.body = body.bodyText ?? ""; delete doc.bodyTokenParts; }
        }
        return snapshot;
    })),
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
  store = openingSqlTargets.get(store)?.() ?? store;
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
      unsubscribe: (m.unsubscribe as string | null) ?? null,
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
    // The selected batch owns hydration; debug metadata does not create a second token-reader lifetime.
    search: { messages: messageDocs(db, undefined, false), threads: threadDocs(db) },
  };
}

const openingSqlTargets = new WeakMap<MailStore, () => SqlMailStore | undefined>();

/** Admission adapter only: one asynchronous opener, no ordinary command or second connection until it settles. */
export function openingSqlStore(open: (signal: AbortSignal) => Promise<SqlMailStore>, capabilities: StoreCapabilities, autocomplete: Pick<AutocompleteSource, "identity" | "snapshotBase">): MailStore {
  const abort = new AbortController();
  let target: SqlMailStore | undefined, opening = true, closed = false, closing: Promise<void> | undefined;
  const opened = Promise.resolve().then(() => open(abort.signal)).then(async (store) => {
    if (closed) { await store.close(); throw abort.signal.reason ?? new Error("Mailbox opening cancelled"); }
    target = store; opening = false; return store;
  });
  const ready = opened.then(() => {});
  void ready.catch(() => { opening = false; });
  const namespace = (owner: (store: SqlMailStore) => object, isAutocomplete = false): object => new Proxy({}, { get(_object, member) {
    if (member === "then") return undefined;
    if (isAutocomplete && (member === "identity" || member === "snapshotBase")) return target ? Reflect.get(owner(target), member) : autocomplete[member];
    return async (...args: unknown[]) => {
      const store = await opened;
      if (closed) throw new Error("The store is closed");
      const object = owner(store), method = Reflect.get(object, member);
      if (typeof method !== "function") throw new Error("Unknown store command");
      return Reflect.apply(method, object, args);
    };
  } });
  const names = new Set(["feed", "threads", "sync", "ops", "attachments", "recipientReceipts", "sendCopies", "compose", "filters", "folders", "categories", "reminders", "similar", "storage", "categorize", "accounts", "owner", "drafts", "providerCooldown", "settings", "secrets", "learning", "facts", "debug", "dev", "autocomplete", "captureRepairs", "tabs"]);
  const namespaces = new Map<PropertyKey, object>();
  const facade = new Proxy({} as MailStore, { get(object, member) {
    if (Object.hasOwn(object, member)) return Reflect.get(object, member);
    if (member === "ready") return ready;
    if (member === "then") return undefined;
    if (member === "isOpen") return !closed && (opening || (target?.isOpen ?? false));
    if (member === "capabilities") return target?.capabilities ?? capabilities;
    if (member === "instant") return target?.instant ?? null;
    if (member === "cancelOpening") return async () => { if (opening) abort.abort(new DOMException("Mailbox opening cancelled", "AbortError")); await opened.catch(() => {}); };
    if (member === "close") return () => closing ??= (async () => { closed = true; if (opening) abort.abort(new DOMException("Mailbox opening cancelled", "AbortError")); const store = await opened.catch(() => undefined); if (store) await store.close(); })();
    if (member === "providerStore") return (id: number) => target ? target.providerStore(id) : namespace((store) => store.providerStore(id));
    if (typeof member === "string" && names.has(member)) {
      if (target) return Reflect.get(target, member);
      let object = namespaces.get(member);
      if (!object) namespaces.set(member, object = namespace((store) => Reflect.get(store, member), member === "autocomplete"));
      return object;
    }
    const value = target && Reflect.get(target, member);
    return typeof value === "function" ? value.bind(target) : value;
  }, getOwnPropertyDescriptor(object, member) {
    const own = Reflect.getOwnPropertyDescriptor(object, member);
    if (own || !target) return own;
    let owner: object | null = target;
    while (owner) {
      const descriptor = Reflect.getOwnPropertyDescriptor(owner, member);
      if (descriptor) return descriptor.get ? { configurable: true, enumerable: descriptor.enumerable, get: descriptor.get.bind(target) } : { ...descriptor, configurable: true };
      owner = Reflect.getPrototypeOf(owner) as object | null;
    }
    return undefined;
  } });
  openingSqlTargets.set(facade, () => target);
  return facade;
}
