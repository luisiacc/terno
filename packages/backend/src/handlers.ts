import { RpcError, type Draft, type DraftAddress, type Handlers } from "@terno/core/rpc";
import { capFilterName, COUNT_CAP, LEARNED_FILTER_NAME, messageOf, proposeLearnedFilters, listFilterOf, LIST_FILTERS, searchWithFilter, type ThreadAction } from "@terno/core";
import { L } from "@terno/i18n";
import { SearchCancelledError, StaleCursorError, type AddedBy, type DraftRow, type MessageState } from "@terno/store";
import { GMAIL_SCOPES } from "@terno/mail/portable";
import type { GmailAccountConfig, ImapAccountConfig } from "@terno/mail";
import { BackendCore as Backend } from "./core";
import { forgetSignInVersion, signInVersion, admitBrowserGoogle, beginSignIn, endSignIn, googleAdmission, changeOwnerTo, gmailClaim, googleFlowActive, imapClaim, loginFailed, reconnectAccount, validateGoogleConnection } from "./identity";
import { exportMailbox, importMailbox, restorePending } from "./import";
import { countThreadScope, progressReporter, resolveThreadScope, SCOPE_CAP, UndoJournal } from "./scope";
import { SimilarFilters } from "./similar";
import { StorageMaintenance } from "./storage";
import { readAutoCategorize, readSettings, setGooglePhotoState, SettingsError, updateSettings } from "./settings";
import { authorizeGooglePhotos, PHOTO_SCOPES, photoStateFrom, setGooglePhotos } from "./icons/google";

/** How long a recipient lookup waits for the index's first build (then answers with what it has: nothing). */
const FIRST_BUILD_WAIT_MS = 250;

/** More ids than this and a bulk command runs in time-budgeted slices (plan 02 §6, plan 06). */
const ONE_GO = 20;
/** Messages a similar sweep reads per page while resolving its scope (plan 63). */
const SIMILAR_PAGE = 2000;

const ADDED_BY = { picker: "user", dnd: "user", suggestion: "suggestion", snackbar: "bulk" } as const;

const ACCOUNT_COLORS = ["indigo", "emerald", "amber", "cyan", "violet", "rose", "lime", "slate"];

function toDraft(r: DraftRow): Draft {
  return {
    id: r.id,
    generation: r.generation ?? "",
    revision: r.revision,
    format: r.format === 1 ? 1 : 2,
    accountId: r.account_id,
    threadId: r.thread_id,
    mode: r.mode,
    to: JSON.parse(r.to_json) as DraftAddress[],
    cc: JSON.parse(r.cc_json) as DraftAddress[],
    bcc: JSON.parse(r.bcc_json) as DraftAddress[],
    subject: r.subject,
    subjectEdited: r.subject_edited === 1,
    bodyText: r.body_text,
    bodyHtml: r.body_html,
    attachments: JSON.parse(r.attachments_json ?? "[]"),
    quotedText: r.quoted_text,
    includeQuote: r.include_quote === 1,
    replyContext: r.reply_context_json ? JSON.parse(r.reply_context_json) : null,
    inReplyToMessageId: r.in_reply_to_message_id,
    forwardOfMessageId: r.forward_of_message_id,
    showSourceContext: r.show_source_context === 1,
    presentationThreadId: r.presentation_thread_id ?? null,
    uiState: r.ui_state,
    updatedAt: r.updated_at,
  };
}

export function createHandlers(b: Backend): Handlers {
  const store = b.store;
  const storage = new StorageMaintenance(b);
  let attachmentCalls = 0;
  let settingsUpdates = Promise.resolve();
  const attachmentCall = async <T,>(origin: string, work: () => Promise<T>): Promise<T> => {
    if (origin !== "renderer" || attachmentCalls >= 2) throw new RpcError("UNAVAILABLE", L("attachments.busy"));
    attachmentCalls++;
    try { return await work(); } finally { attachmentCalls--; }
  };
  const requireCategory = async (id: number) => {
    if (!(await store.categories.exists(id))) throw new RpcError("NOT_FOUND", L("errors.categoryGone"));
  };
  /** A handful in one go (same tick), more through time-budgeted slices (a thread's filing trains on its features). */
  const sliced = async <T,>(items: T[], work: (chunk: T[]) => Promise<void>) => {
    if (items.length <= ONE_GO) await work(items);
    else await b.runBudgeted(items, work);
  };
  /**
   * The one store command behind every UI way of filing threads; returns
   * what changed for undo. Above ONE_GO ids it runs in time slices (one
   * batch, several transactions) so interactive RPCs keep flowing.
   */
  const fileThreads = async (categoryId: number, threadIds: readonly number[], addedBy: AddedBy, source: string, progress?: (done: number) => void) => {
    await requireCategory(categoryId);
    const batchId = await store.categories.createBatch(categoryId, source, { kind: "threads" }, b.now());
    const added: number[] = [];
    let done = 0;
    await sliced([...new Set(threadIds)], async (chunk) => {
      const r = await store.categories.add({ categoryId, threadIds: chunk, addedBy, now: b.now(), batchId });
      b.categorizer.apply(r.deltas);
      added.push(...r.added);
      b.notifyChanged(chunk);
      progress?.((done += chunk.length));
    });
    return { added: added.length, addedIds: added, batchId: added.length ? batchId : null };
  };
  /**
   * A thread action over many threads: one store command (transaction, ops
   * per account) per slice. Explicit renderer picks are a learning signal;
   * scope sweeps and agents are not.
   */
  const actOn = async (
    threadIds: readonly number[],
    action: ThreadAction,
    signal: ReturnType<typeof Backend.learningSignal> | null,
    progress?: (done: number) => void,
    alwaysSliced = false,
    o: { narrow?: (chunk: number[]) => Promise<number[]>; partialUndo?: boolean } = {},
  ) => {
    const changed = new Set<number>();
    const before: MessageState[] = [];
    let done = 0;
    const run = async (slice: number[]) => {
      // a sweep re-reads what it may still touch, in the same turn as the act (plan 63: a star added meanwhile wins)
      const chunk = o.narrow ? await o.narrow(slice) : slice;
      const r = chunk.length ? await store.threads.act({ threadIds: chunk, action, signal: signal ?? null, now: b.now() }) : { threadIds: [], before: [], opIds: [], flagReconcileAccounts: [] };
      for (const t of r.threadIds) changed.add(t);
      for (const m of r.before) before.push(m);
      b.opsQueued(r.opIds);
      b.reconcileFlags(r.flagReconcileAccounts);
      b.notifyChanged(r.threadIds);
      progress?.((done += slice.length));
    };
    try {
      // a handful in one go; more in time-budgeted slices (an action recomputes every thread it touches and writes their ops)
      if (threadIds.length <= ONE_GO && !alwaysSliced) await run([...threadIds]);
      else await b.runBudgeted([...threadIds], run);
    } catch (error) {
      // the slices that committed stay undoable: the error carries their undo
      if (!o.partialUndo || before.length === 0) throw error;
      const undoId = undoJournal.remember(before);
      if (error instanceof RpcError) throw new RpcError(error.code, error.message, { undoId }, { expected: error.expected, diag: error.diag, i18n: error.i18n, cause: error });
      throw new RpcError("INTERNAL", error instanceof Error ? error.message : String(error), { undoId }, { expected: false, cause: error });
    }
    // what an undo puts back: these messages, exactly as they were
    return { threads: [...changed], undoId: before.length ? undoJournal.remember(before) : null };
  };
  const undoJournal = new UndoJournal();
  /** Puts these messages back as they were: one store command (transaction, ops per account) per slice, like the action. */
  const restore = async (before: MessageState[], jobId: string | undefined) => {
    const progress = progressReporter(b, jobId, before.length);
    const restored = new Set<number>();
    let done = 0;
    progress(0);
    await b.runBudgeted(
      before,
      async (chunk) => {
        const r = await store.threads.restore({ messages: chunk, now: b.now() });
        for (const t of r.threadIds) restored.add(t);
        b.opsQueued(r.opIds);
        b.reconcileFlags(r.flagReconcileAccounts);
        b.notifyChanged(r.threadIds);
        progress((done += chunk.length));
      },
      // a message costs less than a thread: a bigger first probe
      { initial: 16 },
    );
    return restored;
  };
  const similarFilters = new SimilarFilters(store, () => b.now());
  let resolveQueue: Promise<unknown> = Promise.resolve();
  const resolving = <T,>(work: () => Promise<T>): Promise<T> => {
    const next = resolveQueue.then(work, work);
    resolveQueue = next.catch(() => undefined);
    return next;
  };
  const nextAccountColor = async () => ACCOUNT_COLORS[(await store.accounts.list()).length % ACCOUNT_COLORS.length]!;

  return {
    "app.bootstrap": async (_p, ctx) => ({
      host: { ...b.host, storage: store.capabilities.engine },
      accounts: await store.accounts.list(),
      categories: await store.categories.list(),
      folders: await store.folders.list(),
      counts: await store.threads.counts(b.now()),
      // plan 17 (Codex R12): the quick filters this backend knows; a renderer offers only these
      filters: [...LIST_FILTERS],
      settings: await readSettings(store),
      // agents get the mailboxes, not the person's identity
      owner: ctx.origin === "mcp" ? null : await store.owner.get(),
      demo: b.demo,
      version: b.options.version,
    }),

    "app.export": () => exportMailbox(b),

    "app.import": ({ data }) => importMailbox(b, data),

    // the Waiting filter reads its window from the backend's clock
    "threads.list": (p) => store.threads.list({ ...p, now: b.now() }),

    "threads.search": async ({ unreadOnly, filter: asked, ...p }, ctx) => {
      // Latest-wins per client: a query superseded while queued is not executed.
      const seq = (b.searchSeq.get(ctx.clientId) ?? 0) + 1;
      b.searchSeq.set(ctx.clientId, seq);
      await b.platform.yield();
      // i18n-ignore: never shown; the list drops CANCELLED (state/list.ts)
      if (b.searchSeq.get(ctx.clientId) !== seq) throw new RpcError("CANCELLED", "Superseded by a newer search");
      const started = performance.now();
      // this query supersedes the one still running, whatever it turns out to be
      b.searchAborts.get(ctx.clientId)?.abort();
      // the quick filter is part of the query (cursors and the instant engine see one query); asking for its opposite too matches nothing
      const filter = listFilterOf({ filter: asked, unreadOnly });
      const { query, threadFilter } = filter ? searchWithFilter(p.query, filter, b.now()) : { query: p.query, threadFilter: undefined };
      if (query === null) return { items: [], nextCursor: null, strategy: "none", tookMs: performance.now() - started, complete: true };
      const abort = new AbortController();
      b.searchAborts.set(ctx.clientId, abort);
      try {
        // attachments, people, waiting are the conversation's: the engine keeps those threads before paging
        const page = await store.threads.searchText({ ...p, query, threadFilter, now: b.now(), signal: abort.signal });
        return {
          items: page.items,
          nextCursor: page.nextCursor,
          strategy: page.strategy,
          tookMs: performance.now() - started,
          // what the user sees: every stored body is searchable and the answer is exact
          complete: page.complete && page.pendingBodies === 0,
        };
      } catch (error) {
        // the renderer refetches from the top and reconciles its window (live-list policy)
        if (error instanceof StaleCursorError) throw new RpcError("STALE", error.message, { reason: error.reason });
        if (error instanceof SearchCancelledError) throw new RpcError("CANCELLED", error.message);
        throw error;
      } finally {
        if (b.searchAborts.get(ctx.clientId) === abort) b.searchAborts.delete(ctx.clientId);
      }
    },

    "threads.get": async ({ threadId }) => {
      const thread = await store.threads.get(threadId);
      if (!thread) throw new RpcError("NOT_FOUND", L("errors.threadGone"));
      const { categorization, ...detail } = thread;
      return {
        ...detail,
        categorization: { auto: categorization.auto, suggestions: categorization.suggestions.map((s) => ({ categoryId: s.categoryId, p: s.p, reasons: s.reasons })) },
      };
    },

    "threads.act": async ({ threadIds, action }, ctx) => {
      const signal = Backend.learningSignal(action);
      // only explicit renderer actions feed learned filters
      const r = await actOn([...new Set(threadIds)], action, signal && ctx.origin === "renderer" ? signal : null);
      return { affected: r.threads.length, undoId: r.undoId };
    },
    "threads.scopeCount": ({ scope }) => countThreadScope(b, scope),
    "threads.actScope": async ({ scope, action, jobId }) => {
      const { ids, capped } = await resolveThreadScope(b, scope);
      if (capped) throw new RpcError("BAD_REQUEST", L("errors.tooManyThreads"));
      const progress = progressReporter(b, jobId, ids.length);
      progress(0);
      // a sweep over a whole view says nothing about senders: never a learning signal
      const r = await actOn(ids, action, null, progress, true);
      progress(ids.length);
      return { undoId: r.undoId, affected: r.threads.length, total: ids.length };
    },
    "threads.undo": async ({ undoId, jobId }) => {
      const before = undoJournal.take(undoId);
      if (!before) throw new RpcError("NOT_FOUND", L("errors.undoGone"));
      try {
        return { restored: (await restore(before, jobId)).size };
      } catch (error) {
        // restoring is idempotent: a retry repeats all of it
        undoJournal.putBack(undoId, before);
        throw error;
      }
    },

    "similar.offers": ({ threadIds, action }) => store.similar.offers(threadIds, action),
    "similar.apply": async ({ threadIds, scope, action, jobId, filterName }) => {
      const targets = new Set(threadIds);
      // resolved once, in pages of the scope's messages with a turn between them, refused as soon as it passes the cap;
      // one sweep resolves at a time (a store keeps a few walks between pages: sweeps never crowd out each other's)
      const { ids, skipped } = await resolving(async () => {
        const cap = b.options.similarCap ?? SCOPE_CAP;
        const found = new Set<number>();
        // the valued threads left out, and only those (one found later, unstarred meanwhile, leaves it): bounded like the scope
        const left = new Set<number>();
        for (let cursor: number | null = null; ; ) {
          const page = await store.similar.resolvePage(scope, action, threadIds, cursor, b.options.similarPage ?? SIMILAR_PAGE);
          for (const id of page.ids) {
            found.add(id);
            left.delete(id);
          }
          for (const id of page.kept) if (!found.has(id) && left.size <= cap + COUNT_CAP) left.add(id);
          if (found.size > cap) throw new RpcError("BAD_REQUEST", L("errors.tooManyThreads"));
          if (page.next === null) break;
          cursor = page.next;
          await b.yieldTurn();
        }
        return { ids: [...found], skipped: left.size };
      });
      const progress = progressReporter(b, jobId, ids.length);
      progress(0);
      let late = 0;
      // a sweep, never a learning signal; what was starred or replied meanwhile stays (the targets don't)
      const narrow = async (chunk: number[]) => {
        const kept = new Set(await store.similar.kept(chunk.filter((id) => !targets.has(id))));
        late += kept.size;
        return chunk.filter((id) => !kept.has(id));
      };
      const r = await actOn(ids, action, null, progress, true, { narrow, partialUndo: true });
      progress(ids.length);
      let filter: { id: number; filterUndo: number | null } | null = null;
      let filterFailed = false;
      if (action === "spam") {
        try {
          const f = await similarFilters.ensure(scope, action, filterName);
          filter = { id: f.filter.id, filterUndo: f.filterUndo };
        } catch (error) {
          // the mail moved and stays undoable: the result says the filter is missing
          filterFailed = true;
          b.log("warn", "similar filter failed", error instanceof Error ? error.message : error);
        }
      }
      return { affected: r.threads.length, skipped: Math.min(skipped + late, COUNT_CAP), undoId: r.undoId, filter, filterFailed };
    },
    "similar.always": ({ scope, action, filterName }) => similarFilters.ensure(scope, action, filterName),
    "similar.undo": async ({ undoId, filterUndo, jobId }) => {
      // the filter first: no new mail is caught while the threads come back
      if (filterUndo !== null) await similarFilters.undo(filterUndo);
      if (undoId === null) return { restored: 0 };
      const before = undoJournal.take(undoId);
      if (!before) throw new RpcError("NOT_FOUND", L("errors.undoGone"));
      try {
        return { restored: (await restore(before, jobId)).size };
      } catch (error) {
        // restoring is idempotent: a retry repeats all of it
        undoJournal.putBack(undoId, before);
        throw error;
      }
    },
    "categories.create": async ({ name, color }) => {
      const c = await store.categories.create(name, color);
      b.server.emit("categories", await store.categories.list());
      return c;
    },
    "categories.update": async ({ id, ...patch }) => {
      const c = await store.categories.update(id, patch);
      if (!c) throw new RpcError("NOT_FOUND", L("errors.categoryGone"));
      b.server.emit("categories", await store.categories.list());
      return c;
    },
    "categories.reorder": async ({ ids }) => {
      const list = await store.categories.reorder(ids);
      b.server.emit("categories", list);
      return list;
    },
    "categories.delete": async ({ id }) => {
      await store.categories.delete(id);
      b.categorizer.dropCategory(id);
      b.server.emit("categories", await store.categories.list());
      b.notifyChanged([]);
      return { ok: true as const };
    },
    "categories.addThreads": ({ categoryId, threadIds, source }, ctx) => fileThreads(categoryId, threadIds, ctx.origin === "mcp" ? "agent" : ADDED_BY[source], source),
    "categories.moveThreads": async ({ to, threadIds, source }, ctx) => {
      await requireCategory(to);
      // don't add the move to the turn that parsed 5,000 ids, nor to what that turn scheduled
      await b.yieldTurn();
      // recorded at once; memberships move in slices (every other category left, each row journaled), then the training
      const { batchId } = await store.categories.beginMove({ to, threadIds, addedBy: ctx.origin === "mcp" ? "agent" : ADDED_BY[source], now: b.now(), source });
      await b.finishMove(batchId);
      const r = await store.categories.moveOutcome(batchId);
      return { added: r.added.length, addedIds: r.added, batchId, moved: r.moved };
    },
    "categories.addScope": async ({ categoryId, scope, jobId }) => {
      await requireCategory(categoryId);
      const { ids, capped } = await resolveThreadScope(b, scope);
      if (capped) throw new RpcError("BAD_REQUEST", L("errors.tooManyThreads"));
      const progress = progressReporter(b, jobId, ids.length);
      progress(0);
      // a selection of a whole view weighs like the snackbar's bulk adds
      const r = await fileThreads(categoryId, ids, "bulk", "selection", progress);
      progress(ids.length);
      return { added: r.added, batchId: r.batchId };
    },
    "categories.removeThreads": async ({ categoryId, threadIds, reason }) => {
      let removed = 0;
      await sliced([...new Set(threadIds)], async (chunk) => {
        const r = await store.categories.remove({ categoryId, threadIds: chunk, reason, now: b.now() });
        b.categorizer.apply(r.deltas);
        removed += r.removed.length;
        b.notifyChanged(chunk);
      });
      return { removed };
    },
    "categorize.quickActions": async ({ categoryId, threadIds }) => {
      await requireCategory(categoryId);
      return store.categorize.quickActions(categoryId, threadIds, b.categorizer.model);
    },
    "categorize.count": ({ categoryId, scope }) => store.categorize.countScope(categoryId, scope, b.now()),
    "categorize.preview": async ({ categoryId, scope, limit }) => {
      const ids = await store.categorize.resolveScope(categoryId, scope, b.now(), COUNT_CAP + 1);
      return { count: Math.min(ids.length, COUNT_CAP), capped: ids.length > COUNT_CAP, sample: await store.threads.summaries(ids.slice(0, limit)) };
    },
    "categorize.apply": async ({ categoryId, scope }, ctx) => {
      await requireCategory(categoryId);
      // the set is fixed here, once: filing changes the scope's own "not yet in the category" predicate
      const ids = await store.categorize.resolveScope(categoryId, scope, b.now());
      const batchId = await store.categories.createBatch(categoryId, "snackbar", scope, b.now());
      const addedBy = ctx.origin === "mcp" ? "agent" : "bulk";
      let added = 0;
      await b.runSliced(ids, 100, async (chunk) => {
        const r = await store.categories.add({ categoryId, threadIds: chunk, addedBy, now: b.now(), batchId });
        b.categorizer.apply(r.deltas);
        added += r.added.length;
        b.notifyChanged(r.added);
      });
      return { batchId: added ? batchId : null, added };
    },
    "categorize.predict": async ({ threadId }) => {
      const model = b.categorizer.model;
      return model ? store.categorize.predict(threadId, model, await readAutoCategorize(store), b.now()) : [];
    },
    "categorize.suggestions": async ({ categoryId, limit }) => {
      const pending = await store.categorize.pendingSuggestions({ categoryId, limit });
      const summaries = new Map((await store.threads.summaries([...new Set(pending.map((s) => s.threadId))])).map((t) => [t.id, t]));
      return {
        items: pending.flatMap((s) => {
          const t = summaries.get(s.threadId);
          return t ? [{ ...t, prediction: { categoryId: s.categoryId, p: s.p, decision: "suggest" as const, reasons: s.reasons } }] : [];
        }),
      };
    },
    "categorize.feedback": async ({ threadId, categoryId, verdict }) => {
      await requireCategory(categoryId);
      if (verdict === "accept") {
        await fileThreads(categoryId, [threadId], "suggestion", "suggestion");
        return { ok: true as const };
      }
      b.categorizer.apply(await store.categorize.reject(threadId, categoryId, b.now()));
      b.notifyChanged([threadId]);
      return { ok: true as const };
    },
    "categorize.stats": () => store.categorize.stats(),
    "categorize.undo": async ({ batchId }) => {
      if ((await store.categories.movePhase(batchId)) !== null) {
        // a move still being applied or trained finishes first; an undo cut short (a failure, a crash) picks up where it was
        const phase = await store.categories.movePhase(batchId);
        if (phase === "moving" || phase === "training") await b.finishMove(batchId);
        if ((await store.categories.movePhase(batchId)) === "done") await store.categories.undoMoveBegin(batchId, b.now());
        // memberships and decisions come back in slices, then the examples
        const tally = { removed: new Set<number>(), restored: new Set<number>() };
        await b.finishMove(batchId, tally);
        return { removed: tally.removed.size, restored: tally.restored.size };
      }
      let removed = 0;
      await sliced(await store.categories.batchThreads(batchId), async (chunk) => {
        const r = await store.categories.undoBatchPart(batchId, chunk, b.now());
        b.categorizer.apply(r.deltas);
        removed += r.removed.length;
        b.notifyChanged(r.removed);
      });
      await store.categories.finishUndo(batchId, b.now());
      return { removed };
    },

    "counts.get": () => store.threads.counts(b.now()),

    "filters.list": () => store.filters.list(),
    "filters.save": (p) => store.filters.save(p, b.now()),
    "filters.delete": async ({ id }) => {
      await store.filters.delete(id);
      return { ok: true as const };
    },
    "filters.preview": ({ rule, limit }) => store.filters.preview(rule, b.now(), limit),
    "filters.apply": async ({ id }) => {
      const filter = await store.filters.get(id);
      if (!filter) throw new RpcError("NOT_FOUND", L("errors.filterGone"));
      // match in id windows, yielding between them: no single long synchronous scan
      const bounds = await store.filters.messageIdRange();
      const matched: number[] = [];
      for (let from = bounds?.lo ?? 1; bounds && from <= bounds.hi; from += 4000) {
        matched.push(...(await store.filters.matchWindow(filter.rule, b.now(), { from, to: from + 3999 })));
        await b.platform.yield();
      }
      const touched = new Set<number>();
      let applied = 0;
      // time-sliced so a huge bulk apply doesn't freeze list/search
      const capturedRule = JSON.stringify(filter.rule);
      await b.runSliced(matched, 20, async (chunk) => {
        const r = await store.filters.applyChunk(id, capturedRule, chunk, b.now());
        for (const t of r.touched) touched.add(t);
        applied += r.applied;
        b.opsQueued(r.opIds);
        b.reconcileFlags(r.flagReconcileAccounts);
      });
      b.notifyChanged(touched);
      return { matchedMessages: applied, affectedThreads: touched.size };
    },
    "filters.generate": ({ prompt }, ctx) => b.aiService.generateFilter(prompt, ctx.clientId),

    "learning.proposals": async () =>
      proposeLearnedFilters(await store.learning.actionsSince(b.now() - 60 * 86_400_000), {
        now: b.now(),
        excludedKeys: await store.learning.excludedKeys(),
      }),
    "learning.accept": async ({ key, name }) => {
      const proposal = proposeLearnedFilters(await store.learning.actionsSince(b.now() - 60 * 86_400_000), { now: b.now() }).find((p) => p.key === key);
      if (!proposal) throw new RpcError("NOT_FOUND", L("errors.suggestionGone"));
      const fallback = capFilterName(L(LEARNED_FILTER_NAME[proposal.action], { value: proposal.value }).message);
      return store.filters.save({ name: name ?? fallback, enabled: true, source: "learned", rule: proposal.rule, learnedKey: key }, b.now());
    },
    "learning.dismiss": async ({ key }) => {
      await store.learning.dismiss(key, b.now());
      return { ok: true as const };
    },

    "compose.send": async (p, ctx) => {
      const { opId, threadId, deltas } = await store.compose.queueSend({
        accountId: p.accountId,
        to: p.to,
        cc: p.cc,
        bcc: p.bcc,
        subject: p.subject,
        bodyText: p.bodyText,
        // HTML only from the renderer, which builds it from a document (agents send text)
        bodyHtml: ctx.origin === "renderer" && p.bodyHtml ? p.bodyHtml : undefined,
        inReplyToMessageId: p.inReplyToMessageId,
        draftId: p.draftId,
        draftRevision: p.draftRevision,
        draftGeneration: p.draftGeneration,
        attachments: p.attachments,
        recordReply: ctx.origin === "renderer",
        now: b.now(),
      });
      b.categorizer.apply(deltas);
      b.notifyChanged([threadId]);
      b.kickWorker();
      return { opId, threadId };
    },

    "attachments.retry": (p, ctx) => attachmentCall(ctx.origin, async () => {
      await store.attachments.retry(p.accountId, p.messageId);
      await b.syncAccount(p.accountId);
      return { ok: true as const };
    }),
    "attachments.create": (p, ctx) => attachmentCall(ctx.origin, () => store.attachments.create({ ...p, now: b.now() })),
    "attachments.append": (p, ctx) => attachmentCall(ctx.origin, async () => { await store.attachments.append(p.accountId, p.assetId, p.index, p.dataBase64); return { ok: true as const }; }),
    "attachments.seal": (p, ctx) => attachmentCall(ctx.origin, async () => { await store.attachments.seal(p.accountId, p.assetId); return { ok: true as const }; }),
    "attachments.info": (p, ctx) => attachmentCall(ctx.origin, () => store.attachments.info(p.accountId, p.assetId)),
    "attachments.read": (p, ctx) => attachmentCall(ctx.origin, async () => ({ dataBase64: await store.attachments.read(p.accountId, p.assetId, p.index) })),
    "attachments.discard": (p, ctx) => attachmentCall(ctx.origin, async () => { await store.attachments.discard(p.accountId, p.assetId); return { ok: true as const }; }),

    "drafts.save": async (p, ctx) => {
      // a rich body only from the renderer (an agent's save is plain text, and rewrites the body)
      const saved = await store.drafts.save(ctx.origin === "renderer" ? p : { ...p, bodyHtml: "" }, b.now());
      return saved ? toDraft(saved) : null;
    },
    "compose.warm": async () => {
      void b.warmAutocomplete();
      return { ok: true as const };
    },
    "compose.suggestRecipients": async ({ query, exclude, accountId, limit }) => {
      let r = b.autocomplete.suggestRecipients(query, { exclude, accountId, limit });
      if (!r.ready) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([b.warmAutocomplete(), new Promise((resolve) => (timer = setTimeout(resolve, FIRST_BUILD_WAIT_MS)))]);
        clearTimeout(timer);
        r = b.autocomplete.suggestRecipients(query, { exclude, accountId, limit });
      }
      return r;
    },
    "compose.recipientInitials": async ({ accountId }) => {
      await b.warmAutocomplete();
      // enough per letter that the next few letters can narrow them on the client
      return b.autocomplete.initials({ accountId, limit: 20 });
    },
    "compose.suggestText": async ({ before, names, me }) => {
      if (!b.autocomplete.warmed) void b.warmAutocomplete();
      return { text: b.autocomplete.suggestText({ before, names, me }) };
    },
    "drafts.list": async () => (await store.drafts.list()).map(toDraft),
    "drafts.sourceContext": ({ messageId }) => store.drafts.sourceContext(messageId),
    "drafts.delete": async ({ id, generation }) => {
      await store.drafts.delete(id, generation ?? "");
      return { ok: true as const };
    },

    "accounts.addImap": async (p) => {
      if (!b.host.capabilities.imap) throw new RpcError("UNAVAILABLE", L("errors.imapNeedsDesktop"));
      const config: ImapAccountConfig = {
        imap: p.imap,
        smtp: p.smtp,
        senderName: p.displayName || p.email,
        appendToSent: !/gmail\.com$/i.test(p.imap.host),
      };
      if (p.verify) {
        try {
          await b.options.providers.verifyImap(config, p.password);
        } catch (error) {
          throw loginFailed("errors.couldNotConnect", p.email, error);
        }
      }
      // only a live login establishes the owner; it is claimed in the same transaction as the account
      const claim = p.verify && b.canClaimOwner();
      // encrypt first, so the account, its password and the ownership commit together
      const blob = await b.options.cipher.encrypt(p.password);
      const { account, claimed } = await store.accounts.create({
        kind: "imap",
        email: p.email,
        displayName: p.displayName || p.email,
        color: await nextAccountColor(),
        providerConfig: config,
        secret: { key: "password", blob },
        ownerClaim: claim ? imapClaim({ email: p.email }, config, p.displayName || p.email) : undefined,
        now: b.now(),
      });
      await b.emitAccounts();
      if (claimed) await b.emitOwner();
      // what an import kept for this mailbox goes in now
      await restorePending(b);
      b.startAccount(account);
      return account;
    },

    "accounts.connectGmail": async () => {
      const settings = await readSettings(store);
      if (!settings.gmailClientId) {
        throw new RpcError("BAD_REQUEST", L("errors.gmailClientIdMissing"));
      }
      if (!b.options.openExternal) throw new RpcError("UNAVAILABLE", L("errors.googleConnectNeedsDesktop"));
      const result = await b.options.providers.connectGmail({
        clientId: settings.gmailClientId,
        clientSecret: await b.getSecret("gmailClientSecret"),
        openExternal: b.options.openExternal,
        signal: b.abort.signal,
        fetch: b.net.fetchFor("mail"),
        // plan 22: photos from Google come on with the account (the user can untick them on Google's screen)
        scopes: [...GMAIL_SCOPES, ...PHOTO_SCOPES],
      });
      googleFlowActive(b);
      validateGoogleConnection(result, "initial");
      if (result.refreshToken === null) throw new RpcError("BAD_REQUEST", L("errors.google.invalidResponse"));
      const existing = (await store.accounts.list()).find((a) => a.email === result.email.toLowerCase());
      if (existing) throw new RpcError("BAD_REQUEST", L("errors.alreadyConnected", { email: result.email }));
      const config: GmailAccountConfig = { senderName: result.name || result.email, googleSubject: result.sub! };
      const blob = await b.options.cipher.encrypt(result.refreshToken);
      const color = await nextAccountColor();
      googleFlowActive(b);
      const { account, claimed } = await store.accounts.create({
        kind: "gmail",
        email: result.email,
        displayName: result.email.split("@")[0]!,
        color,
        providerConfig: config,
        secret: { key: "refreshToken", blob },
        ownerClaim: b.canClaimOwner() ? gmailClaim({ ...result, name: result.name || result.email }) : undefined,
        now: b.now(),
      });
      await b.emitAccounts();
      if (claimed) await b.emitOwner();
      // what an import kept for this mailbox goes in now
      await restorePending(b);
      b.startAccount(account);
      const photos = photoStateFrom(result.grantedScopes ?? []);
      if (photos.connections || photos.otherContacts) {
        await setGooglePhotoState(store, account.id, photos);
        void b.icons.syncPeople(account.id, photos).catch(() => {});
      }
      return account;
    },

    "accounts.connectGmailToken": async ({ accessToken, expiresIn, accountId }) => {
      const tokens = b.options.providers.gmailTokens;
      // i18n-ignore: a wiring mistake (only the web build calls this, and it has the broker), for developers
      if (!tokens) throw new RpcError("UNAVAILABLE", "This host connects Gmail with accounts.connectGmail.");
      if (!/^[\x21-\x7e]+$/.test(accessToken) || (accountId !== undefined && (!Number.isSafeInteger(accountId) || accountId <= 0))) throw new RpcError("BAD_REQUEST", L("errors.google.invalidResponse"));
      const expiresAt = b.now() + expiresIn * 1000;
      const snapshots = new Map(await Promise.all((await store.accounts.list()).map(async (account) => [account.id, { generation: b.credentialsOf(account.id), version: signInVersion(b, account.id), stamp: (await store.accounts.stamp(account.id))!, config: (await store.accounts.config<GmailAccountConfig>(account.id))!.config }] as const)));
      let flow = accountId !== undefined ? beginSignIn(b, accountId) : undefined;
      let flowId = accountId;
      try {
        const who = await tokens.inspect(accessToken, b.net.fetchFor("mail"), { signal: b.abort.signal }).catch((error: unknown) => {
          throw new RpcError("BAD_REQUEST", messageOf(error));
        });
        googleFlowActive(b);
        validateGoogleConnection(who);
        if (expiresAt <= b.now()) throw new RpcError("BAD_REQUEST", L("errors.google.invalidResponse"));
        if (accountId !== undefined) {
          // plan 25: signing this account in again: another Google account picked in the popup changes nothing
          const expected = await store.accounts.get(accountId);
          if (!expected || expected.kind !== "gmail") throw new RpcError("NOT_FOUND", L("errors.accountGone"));
          if (expected.email.toLowerCase() !== who.email.toLowerCase()) throw new RpcError("BAD_REQUEST", L("errors.googleConnectedOther", { got: who.email, expected: expected.email }));
        }
        const existing = (await store.accounts.list()).find((a) => a.email === who.email.toLowerCase());
        if (accountId !== undefined && existing?.id !== accountId) throw new RpcError("NOT_FOUND", L("errors.accountGone"));
        if (existing) {
          if (existing.kind !== "gmail") throw new RpcError("BAD_REQUEST", L("errors.alreadyConnectedImap", { email: who.email }));
          const snapshot = snapshots.get(existing.id);
          if (!snapshot || snapshot.generation !== b.credentialsOf(existing.id) || (accountId === undefined && snapshot.version !== signInVersion(b, existing.id))) throw new RpcError("BAD_REQUEST", L("errors.google.cancelled"));
          if (accountId === undefined && snapshot.config.googleSubject === undefined) throw new RpcError("BAD_REQUEST", L("errors.google.invalidResponse"));
          flow ??= beginSignIn(b, existing.id);
          flowId = existing.id;
          const admission = await googleAdmission(b, existing.id, flow);
          if (admission.expectedSubject !== (snapshot.config.googleSubject ?? null)) throw new RpcError("BAD_REQUEST", L("errors.google.invalidResponse"));
          await admitBrowserGoogle(b, existing, who, accessToken, expiresAt, flow, { ...admission, stamp: snapshot.stamp });
          void b.syncAccount(existing.id);
          return existing;
        }
        const config: GmailAccountConfig = { senderName: who.name || who.email, googleSubject: who.sub! };
        const color = await nextAccountColor();
        googleFlowActive(b);
        if (expiresAt <= b.now()) throw new RpcError("BAD_REQUEST", L("errors.google.invalidResponse"));
        const { account, claimed } = await store.accounts.create({
          kind: "gmail",
          email: who.email,
          displayName: who.email.split("@")[0]!,
          color,
          providerConfig: config,
          ownerClaim: b.canClaimOwner() ? gmailClaim({ ...who, name: who.name || who.email }) : undefined,
          now: b.now(),
        });
        tokens.set(account.id, accessToken, expiresAt);
        await b.emitAccounts();
        if (claimed) await b.emitOwner();
        // what an import kept for this mailbox goes in now
        await restorePending(b);
        b.startAccount(account);
        return account;
      } finally { if (flow && flowId !== undefined) await endSignIn(b, flowId, flow); }
    },

    "accounts.reconnect": ({ id, password }) => reconnectAccount(b, id, password),

    "accounts.update": async ({ id, ...patch }) => {
      const account = await store.accounts.update(id, patch);
      if (!account) throw new RpcError("NOT_FOUND", L("errors.accountGone"));
      await b.emitAccounts();
      return account;
    },

    "accounts.remove": async ({ id }) => {
      const wasOwner = (await store.owner.get())?.accountId === id;
      await b.dropAccount(id, { remove: true });
      // plan 22: its photo lists and photos go with it
      await setGooglePhotoState(store, id, null);
      await b.icons.dropPhotos(id);
      // the owner row survives: its account_id is cleared (ON DELETE SET NULL)
      await store.accounts.remove(id);
      b.accountRemoved(id);
      forgetSignInVersion(b, id);
      // nobody from a removed account lingers in suggestions
      await b.autocomplete.reset();
      await b.emitAccounts();
      if (wasOwner) await b.emitOwner();
      b.notifyChanged([]);
      return { ok: true as const };
    },

    "storage.report": () => storage.report(),
    "storage.remove": ({ buckets, olderThanDays, jobId }) => storage.remove({ buckets, olderThanDays, jobId }),

    "settings.update": (patch) => {
      // Keep committed settings and their notifications in the same order.
      const updating = settingsUpdates.then(async () => {
        const endpoint = patch.ai?.baseURL ?? (await readSettings(store)).ai.profiles.compatible?.baseURL;
        const endpointIsLocal = endpoint ? await b.net.isLoopbackEndpoint(endpoint) : false;
        try {
          const was = await readSettings(store);
          const next = await updateSettings(store, patch, { endpointIsLocal });
          b.aiAssist.settingsChanged(patch);
          if (next.localMode !== was.localMode || next.errorReports !== was.errorReports || next.language !== was.language) await b.publishPolicy();
          if (next.composeSuggestions !== was.composeSuggestions) await b.autocomplete.setPhrases(next.composeSuggestions);
          // plan 22: website icons turned off (or local mode took the default away): nothing in flight lands, windows forget them
          if (next.senderIcons !== was.senderIcons) b.icons.invalidate();
          // plan 41: the badge follows at once; notifications turned off drop what was pending
          if (next.dockBadge !== was.dockBadge || next.notifications !== was.notifications || next.notificationPreview !== was.notificationPreview) await b.attention.refresh();
          return next;
        } catch (error) {
          if (error instanceof SettingsError) throw new RpcError("BAD_REQUEST", messageOf(error));
          throw error;
        }
      });
      settingsUpdates = updating.then(() => {}, () => {});
      return updating;
    },
    "settings.setSecret": async ({ name, value }) => {
      if (value) await b.setSecret(name, value);
      else await store.secrets.delete(name);
      return { ok: true as const };
    },

    "ai.providers": () => b.aiService.providers(),
    "ai.listModels": ({ provider, baseURL, preset }) => b.aiService.listModels({ provider, baseURL, preset }),
    "ai.test": ({ provider, model, baseURL, preset }) => b.aiService.test({ provider, model, baseURL, preset }),
    "ai.setKey": ({ provider, preset, value }) => b.aiService.setKey(provider, preset, value),
    "ai.confirmKey": ({ provider, preset }) => b.aiService.confirmKey(provider, preset),

    "identity.get": () => store.owner.get(),
    "identity.changeOwner": ({ accountId, password }) => changeOwnerTo(b, accountId, password),

    "agents.status": () => ({ available: b.agents !== null, connected: b.agents?.connected() ?? 0, tokenSince: b.agents?.tokenSince() ?? null }),
    "agents.rotateToken": () => {
      if (!b.agents) throw new RpcError("UNAVAILABLE", L("errors.agentsNeedDesktop"));
      return b.agents.rotate();
    },

    "ops.recipientReceipts": async ({ accountId }) => {
      const rows = await store.recipientReceipts.list(accountId);
      return Promise.all(rows.map(async (row) => { const [source, op] = await Promise.all([store.sendCopies.get(row.wireOwnerId ?? row.opId), store.ops.sendSubmission(row.opId)]); return { opId: row.opId, createdAt: row.createdAt, count: row.count, parts: row.parts, state: row.state, retired: row.retired, childOpId: row.childOpId, sourceAvailable: !!source?.ready && !source.retiring && source.size > 0 && source.chunks > 0, outcomeUncertain: op?.state === "unknown" && !op.accepted }; }));
    },
    "ops.recipientReceiptPart": ({ opId, kind, index }) => store.recipientReceipts.readPart(opId, kind, index),
    "ops.recoverRejectedRecipients": async ({ opId }) => ({ opId: await b.recoverRejectedRecipients(opId) }),
    "ops.forgetRecipientReceipt": async ({ opId }) => { await b.forgetRecipientReceipt(opId); return { ok: true as const }; },
    "ops.sentCopies": ({ accountId }) => store.sendCopies.list(accountId),
    "ops.repairSentCopy": async ({ opId }) => { return { copy: await b.repairSentCopy(opId) }; },
    "ops.forgetSentCopy": async ({ opId }) => { await b.forgetSentCopy(opId); return { ok: true as const }; },
    "ops.list": async () => (await store.ops.recent(100)).map((op) => b.opInfo(op)),
    "ops.resolveUnknown": async ({ opId, resolution }) => {
      const r = await store.ops.resolveUnknown(opId, resolution, b.now());
      b.reconcileFlags(r.flagReconcileAccounts);
      if (resolution === "retry") b.kickWorker();
      if (r.touched.length) b.notifyChanged(r.touched);
      return { ok: true as const };
    },

    "sync.now": async ({ accountId, reason }) => {
      await b.retryNow(accountId ?? null, reason);
      return { ok: true as const };
    },
    "icons.lookup": ({ emails }) => b.icons.lookup(emails),
    "icons.data": ({ ids }) => b.icons.data(ids),
    "icons.forget": async () => {
      await b.icons.forget();
      return { ok: true as const };
    },
    "icons.googlePhotos": ({ accountId, on, later }) => setGooglePhotos(b, accountId, on, later),
    "icons.authorizeGoogle": (p) => authorizeGooglePhotos(b, p),

    "sync.network": ({ online }) => {
      b.networkChanged(online, online ? "online" : "offline");
      return { ok: true as const };
    },
  };
}
