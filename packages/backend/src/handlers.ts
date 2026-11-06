import { RpcError, type Draft, type DraftAddress, type Handlers } from "@terno/core/rpc";
import { capFilterName, categoryRule, folderRule, isFilterable, similarValue, COUNT_CAP, type AlwaysScope, LEARNED_FILTER_NAME, messageOf, proposeLearnedFilters, listFilterOf, LIST_FILTERS, searchWithFilter, type ThreadAction, type AccountPrefs, type Reminder, REMINDERS_MAX, SCHEDULED_MAX, FORWARD_ADDRESSES_MAX_CHARS } from "@terno/core";
import { L } from "@terno/i18n";
import { movedNothing, SearchCancelledError, StaleCursorError, type AddedBy, type DraftRow, type FolderMoved, type FollowupSnapshot, type MessageState } from "@terno/store";
import { GMAIL_SCOPES } from "@terno/mail/portable";
import type { GmailAccountConfig, ImapAccountConfig } from "@terno/mail";
import { BackendCore as Backend } from "./core";
import { forgetSignInVersion, signInVersion, admitBrowserGoogle, beginSignIn, endSignIn, googleAdmission, changeOwnerTo, gmailClaim, googleFlowActive, imapClaim, loginFailed, reconnectAccount, validateGoogleConnection } from "./identity";
import { accountLabel } from "./account-label";
import { toRpcError } from "./ai-service";
import { exportMailbox, importMailbox, restorePending } from "./import";
import { countThreadScope, progressReporter, resolveThreadScope, SCOPE_CAP, UndoJournal } from "./scope";
import { followFolderFilters, SimilarFilters } from "./similar";
import { UI_LOCALE_KEY } from "./forwarding";
import { findUnsubscribe, runUnsubscribe } from "./unsubscribe";
import { StorageMaintenance } from "./storage";
import { FolderExports } from "./folder-export";
import { deleteSnippet, listSnippets, saveSnippet } from "./snippets";
import { followFavoriteFolders, readAutoCategorize, readSettings, setGooglePhotoState, SettingsError, updateSettings } from "./settings";
import { countFolder, createFolder, deleteFolder, favoriteFolder, renameFolder } from "./folders";
import { googleClientFor } from "./google-client";
import { authorizeGooglePhotos, setGooglePhotos } from "./icons/google";
import { beginGoogleRemoval, googleGrantOf, removalMark, removedSince, revokesSettled, withdrawGoogleGrant } from "./google-revoke";

/** How long a recipient lookup waits for the index's first build (then answers with what it has: nothing). */
const FIRST_BUILD_WAIT_MS = 250;

/** More ids than this and a bulk command runs in time-budgeted slices (plan 02 §6, plan 06). */
const ONE_GO = 20;
/** plan 87: what ends a due reminder (the conversation put away; reading or starring it doesn't) */
const ENDS_REMINDER: ReadonlySet<ThreadAction> = new Set(["archive", "trash", "spam"]);
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
  const folderExports = new FolderExports(b);
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
  /** plan 87: the due reminders a filing into a category hidden from the Inbox ended (it leaves the Inbox), by batch, for its undo */
  const filedReminders = new Map<number, Reminder[]>();
  const filedTops = new Map<number, FollowupSnapshot[]>();
  const endDueIfHidden = async (categoryId: number, threadIds: readonly number[], batchId: number | null) => {
    if (batchId === null || !(await store.categories.list()).some((c) => c.id === categoryId && !c.showInInbox)) return;
    const tops = await b.followups.endTop(threadIds);
    if (tops.length) filedTops.set(batchId, tops);
    for (const key of filedTops.keys()) if (filedTops.size > 16) filedTops.delete(key);
    const ended = await b.reminders.endDue(threadIds);
    if (ended.length === 0) return;
    filedReminders.set(batchId, ended);
    for (const key of filedReminders.keys()) if (filedReminders.size > 16) filedReminders.delete(key);
  };
  /** Its undo puts them back first: refused (the cap), nothing is taken back */
  const restoreFiled = async (batchId: number) => {
    const ended = filedReminders.get(batchId);
    if (ended && !(await b.reminders.restore([], ended))) throw new RpcError("BAD_REQUEST", L("errors.remindersFull", { max: REMINDERS_MAX }));
    filedReminders.delete(batchId);
    await b.followups.putBack(filedTops.get(batchId) ?? []);
    filedTops.delete(batchId);
  };
  /** Plan 116: an agent sets up no filing into a category that forwards, unless agents may send. */
  const agentMayFile = async (categoryIds: readonly number[]) => {
    if (!categoryIds.length || (await readSettings(store)).allowAgentSend) return;
    const forwarding = new Set((await store.categories.list()).filter((c) => c.forward?.enabled).map((c) => c.id));
    if (categoryIds.some((id) => forwarding.has(id))) throw new RpcError("FORBIDDEN", L("errors.forwardAgent"));
  };
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
    await endDueIfHidden(categoryId, added, added.length ? batchId : null);
    // plan 116: new mail filed here may go (one conversation by hand, a suggestion, an agent; never a bulk filing)
    if (added.length && addedBy !== "bulk" && !(addedBy === "user" && threadIds.length > 1)) b.planForwards({ threadIds: added, filed: addedBy === "user" ? added : [] });
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
    // plan 87: a due reminder ends when its conversation is put away (else the Inbox's top brings it back); Undo restores it
    const ended: Reminder[] = [];
    const tops: FollowupSnapshot[] = [];
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
      if (ENDS_REMINDER.has(action)) {
        for (const x of await b.reminders.endDue(chunk)) ended.push(x);
        // plan 142: a follow-up leaves the Inbox's top the same way; the list keeps it
        for (const x of await b.followups.endTop(chunk)) tops.push(x);
      }
      progress?.((done += slice.length));
    };
    try {
      // a handful in one go; more in time-budgeted slices (an action recomputes every thread it touches and writes their ops)
      if (threadIds.length <= ONE_GO && !alwaysSliced) await run([...threadIds]);
      else await b.runBudgeted([...threadIds], run);
    } catch (error) {
      // the slices that committed stay undoable: the error carries their undo
      if (!o.partialUndo || (before.length === 0 && ended.length === 0 && tops.length === 0)) throw error;
      const undoId = remember(before, ended, tops);
      if (error instanceof RpcError) throw new RpcError(error.code, error.message, { undoId }, { expected: error.expected, diag: error.diag, i18n: error.i18n, cause: error });
      throw new RpcError("INTERNAL", error instanceof Error ? error.message : String(error), { undoId }, { expected: false, cause: error });
    }
    // what an undo puts back: these messages, exactly as they were
    return { threads: [...changed], undoId: before.length || ended.length || tops.length ? remember(before, ended, tops) : null };
  };
  const undoJournal = new UndoJournal();
  /** plan 87: the reminders an action ended, by its undo id (as many as the journal keeps) */
  const endedReminders = new Map<number, Reminder[]>();
  const endedTops = new Map<number, FollowupSnapshot[]>();
  const remember = (before: MessageState[], ended: Reminder[], tops: FollowupSnapshot[] = []) => {
    const id = undoJournal.remember(before);
    if (tops.length) endedTops.set(id, tops);
    for (const key of endedTops.keys()) if (endedTops.size > 16) endedTops.delete(key);
    if (ended.length) endedReminders.set(id, ended);
    for (const key of endedReminders.keys()) if (endedReminders.size > 16) endedReminders.delete(key);
    return id;
  };
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
  /** plan 127: what each slice of a folder move changed, by its undo id: an undo takes it out of the folder first */
  const folderMoves = new Map<number, FolderMoved[]>();
  /**
   * Plan 127: a folder move over these threads, one store command per slice. Never a learning signal. An undo id holds
   * it all, also after a failure partway (the slices that committed stay undoable).
   */
  const requireFolder = async (accountId: number, folder: string) => {
    const listed = (await store.folders.list()).filter((f) => f.accountId === accountId);
    if (!listed.some((f) => f.key === folder && f.selectable)) throw new RpcError("NOT_FOUND", L("errors.folderExport.gone"));
    return listed;
  };
  const moveToFolder = async (accountId: number, folder: string, from: string | null, threadIds: readonly number[], progress?: (done: number) => void, narrow?: (chunk: number[]) => Promise<number[]>) => {
    const listed = await requireFolder(accountId, folder);
    const source = from !== null && from !== folder && listed.some((f) => f.key === from) ? from : null;
    const moved: FolderMoved[] = [];
    const before: MessageState[] = [];
    const ended: Reminder[] = [];
    const changed = new Set<number>();
    let kept = 0;
    let done = 0;
    const tops: FollowupSnapshot[] = [];
    const save = () => {
      if (!moved.length && !before.length && !ended.length && !tops.length) return null;
      const id = remember(before, ended, tops);
      folderMoves.set(id, moved);
      for (const key of folderMoves.keys()) if (folderMoves.size > 16) folderMoves.delete(key);
      return id;
    };
    try {
      await b.runBudgeted([...threadIds], async (slice) => {
        // plan 143: what may still move is read again before each slice
        const chunk = narrow ? await narrow(slice) : slice;
        if (!chunk.length) return void progress?.((done += slice.length));
        const r = await store.threads.moveToFolder({ threadIds: chunk, accountId, folder, from: source, now: b.now() });
        for (const t of r.threadIds) changed.add(t);
        for (const m of r.before) before.push(m);
        if (!movedNothing(r.moved)) moved.push(r.moved);
        kept += r.kept.length;
        b.opsQueued(r.opIds);
        b.reconcileFlags(r.flagReconcileAccounts);
        b.notifyChanged(r.threadIds);
        // a due reminder ends when its conversation is put away, as an archive's does
        if (r.leftInbox.length) for (const x of await b.reminders.endDue(r.leftInbox)) ended.push(x);
        if (r.leftInbox.length) for (const x of await b.followups.endTop(r.leftInbox)) tops.push(x);
        progress?.((done += slice.length));
      });
    } catch (error) {
      const undoId = save();
      if (undoId === null) throw error;
      if (error instanceof RpcError) throw new RpcError(error.code, error.message, { undoId }, { expected: error.expected, diag: error.diag, i18n: error.i18n, cause: error });
      throw new RpcError("INTERNAL", error instanceof Error ? error.message : String(error), { undoId }, { expected: false, cause: error });
    }
    return { affected: changed.size, kept, undoId: save() };
  };
  /** Takes back an action by its undo id: its messages, then the reminders it ended (plan 87). How many threads came back. */
  const undoActs = async (undoId: number, jobId: string | undefined) => {
    const before = undoJournal.take(undoId);
    if (!before) throw new RpcError("NOT_FOUND", L("errors.undoGone"));
    try {
      // the reminders it ended first: refused (the cap), nothing is taken back and the Undo stays for a retry
      const ended = endedReminders.get(undoId);
      if (ended && !(await b.reminders.restore([], ended))) throw new RpcError("BAD_REQUEST", L("errors.remindersFull", { max: REMINDERS_MAX }));
      // plan 127: out of the folder first: the moveToInbox the restore queues then finds each message in place
      const left = new Set<number>();
      for (const m of folderMoves.get(undoId) ?? []) {
        const r = await store.threads.leaveFolder({ moved: m, now: b.now() });
        for (const t of r.threadIds) left.add(t);
        b.opsQueued(r.opIds);
        b.notifyChanged(r.threadIds);
        await b.yieldTurn();
      }
      folderMoves.delete(undoId);
      const restored = before.length ? await restore(before, jobId) : new Set<number>();
      endedReminders.delete(undoId);
      await b.followups.putBack(endedTops.get(undoId) ?? []);
      endedTops.delete(undoId);
      return new Set([...left, ...restored]).size;
    } catch (error) {
      // restoring is idempotent: a retry repeats all of it
      undoJournal.putBack(undoId, before);
      throw error;
    }
  };
  /** A move taken back, in slices: one cut short (a failure, a crash) picks up where it was. */
  const undoMove = async (batchId: number) => {
    // a move still being applied or trained finishes first
    const phase = await store.categories.movePhase(batchId);
    // its journal is gone: saying "undone" would be a lie
    if (phase === "expired") throw new RpcError("NOT_FOUND", L("errors.moveExpired"));
    if (phase === "moving" || phase === "training") await b.finishMove(batchId);
    if ((await store.categories.movePhase(batchId)) === "done") await store.categories.undoMoveBegin(batchId, b.now());
    // memberships and decisions come back in slices, then the examples
    const tally = { removed: new Set<number>(), restored: new Set<number>() };
    await b.finishMove(batchId, tally);
    return { removed: tally.removed.size, restored: tally.restored.size };
  };
  const similarFilters = new SimilarFilters(store, () => b.now());
  // plan 143: its steps go through these same journals; nothing about a sentence gets its own way of moving mail
  b.actions.bind({
    act: async (ids, action, narrow, progress) => {
      const r = await actOn(ids, action, null, progress, true, { narrow, partialUndo: true });
      return { undoId: r.undoId };
    },
    toFolder: async (accountId, folder, ids, narrow, progress) => {
      const r = await moveToFolder(accountId, folder, null, ids, progress, narrow);
      return { undoId: r.undoId };
    },
    toCategory: async (categoryId, slice, narrow, record) => {
      await requireCategory(categoryId);
      // `bulk`, and nothing planned: a sentence never forwards (revision 1)
      const { batchId } = await store.categories.beginMove({ to: categoryId, threadIds: slice, addedBy: "bulk", now: b.now(), source: "sentence" });
      // read after the batch is written, and committed in that same turn (revision 10): nothing can arrive or Stop between them, in either store
      const threadIds = await narrow(slice);
      try {
        if (threadIds.length) {
          const r = await store.categories.applyMoveSlice(batchId, threadIds, b.now());
          b.categorizer.apply(r.deltas);
          b.notifyChanged(r.touched);
        }
      } finally {
        // what it didn't reach stays out of it: nothing's left for the next start. One slice is one transaction, so a failed one did nothing.
        await store.categories.abandonMove(batchId);
      }
      if (!threadIds.length) return;
      const step = { batchId, ended: [] as unknown[], tops: [] as unknown[] };
      if ((await store.categories.list()).some((c) => c.id === categoryId && !c.showInInbox)) {
        step.ended = await b.reminders.endDue(threadIds);
        step.tops = await b.followups.endTop(threadIds);
      }
      // committed: it counts and has its Undo, whatever training does next (revision 5). A failed training resumes at the next start.
      record(step);
      await b.finishMove(batchId);
    },
    undoActs,
    undoMove: async ({ batchId, ended, tops }) => {
      // the reminders first: refused (the cap), nothing is taken back and the Undo stays for a retry
      if (ended.length && !(await b.reminders.restore([], ended as Reminder[]))) throw new RpcError("BAD_REQUEST", L("errors.remindersFull", { max: REMINDERS_MAX }));
      await b.followups.putBack(tops as FollowupSnapshot[]);
      const r = await undoMove(batchId);
      return r.restored + r.removed;
    },
    ensureFilter: async (rule, name) => {
      const f = await similarFilters.ensureRule(rule, name, undefined, { asked: true });
      return { filterUndo: f.filterUndo };
    },
    undoFilter: (filterUndo) => similarFilters.undo(filterUndo),
    categoriesChanged: async () => {
      b.server.emit("categories", await store.categories.list());
      b.notifyChanged([]);
    },
  });
  /** filters being applied to existing mail (plan 89: one job each) */
  const applying = new Set<number>();
  let resolveQueue: Promise<unknown> = Promise.resolve();
  const resolving = <T,>(work: () => Promise<T>): Promise<T> => {
    const next = resolveQueue.then(work, work);
    resolveQueue = next.catch(() => undefined);
    return next;
  };
  const nextAccountColor = async () => ACCOUNT_COLORS[(await store.accounts.list()).length % ACCOUNT_COLORS.length]!;
  /** accounts.remove's work; a Gmail account's grant is withdrawn at Google after it's gone here (plan 125) */
  const removeAccount = async (id: number, wasOwner: boolean, gmail: boolean): Promise<{ ok: true; google?: "revoked" | "failed" }> => {
    await b.dropAccount(id, { remove: true });
    // plan 125: read once nothing can replace it (dropAccount ended the account's sign-ins and renewals)
    const grant = gmail ? await googleGrantOf(b, id) : undefined;
    // plan 22: its photo lists and photos go with it
    await setGooglePhotoState(store, id, null);
    await b.icons.dropPhotos(id);
    // plan 107: and its favorite folders, in the one turn of its folder list with the account row (Codex code review
    // round 11 #3: a favorite waiting for the list found the account still there and was written after the cleanup)
    await b.withFolderList(id, async () => {
      await b.writeFavorites(() => followFavoriteFolders(store, id, { deleted: "all" }));
      await followFolderFilters(store, id, { deleted: "all" }, b.now(), (m, d) => b.log("warn", m, d));
      // the owner row survives: its account_id is cleared (ON DELETE SET NULL)
      await store.accounts.remove(id);
    });
    b.accountRemoved(id);
    // plan 141: what questions drew on it goes, and what's asking on it stops
    await b.ask.accountRemoved(id);
    b.actions.invalidate(id);
    forgetSignInVersion(b, id);
    // nobody from a removed account lingers in suggestions
    await b.autocomplete.reset();
    await b.emitAccounts();
    if (wasOwner) await b.emitOwner();
    b.notifyChanged([]);
    // plan 125: gone here first; then Terno's access at Google is withdrawn (bounded, never undoing the removal)
    if (grant === undefined) return { ok: true as const };
    return { ok: true as const, google: await withdrawGoogleGrant(b, grant) };
  };

  return {
    "app.bootstrap": async (_p, ctx) => {
      const [accounts, categories, folders, counts, settings, owner] = await Promise.all([
        store.accounts.list(),
        store.categories.list(),
        store.folders.list(),
        store.threads.counts(b.now()),
        readSettings(store),
        // agents get the mailboxes, not the person's identity
        ctx.origin === "mcp" ? null : store.owner.get(),
      ]);
      return {
        host: { ...b.host, storage: store.capabilities.engine },
        accounts: await b.accountViews(accounts),
        categories,
        folders,
        counts,
        // plan 17 (Codex R12): the quick filters this backend knows; a renderer offers only these
        filters: [...LIST_FILTERS],
        settings,
        owner,
        demo: b.demo,
        devAi: b.options.devAi && ctx.origin !== "mcp" ? { anthropic: Boolean(b.options.devAi.anthropic), openai: Boolean(b.options.devAi.openai), jev: Boolean(b.options.devAi.jev) } : null,
        version: b.options.version,
      };
    },

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

    "reader.hydrate": async ({ threadId, messageId }, ctx) => {
      if (ctx.origin !== "renderer") throw new RpcError("FORBIDDEN", L("attachments.unavailable"));
      return b.hydrateBody(threadId, messageId);
    },

    "threads.get": async ({ threadId, bodyFormat }) => {
      const thread = await store.threads.get(threadId, { bodyFormat });
      if (!thread) throw new RpcError("NOT_FOUND", L("errors.threadGone"));
      const { categorization, ...detail } = thread;
      return {
        ...detail,
        categorization: { auto: categorization.auto, suggestions: categorization.suggestions.map((s) => ({ categoryId: s.categoryId, p: s.p, reasons: s.reasons })) },
      };
    },

    "threads.bodyPart": (input) => store.threads.bodyPart(input),

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
      return { restored: await undoActs(undoId, jobId) };
    },

    "reminders.list": () => b.reminders.refresh(),
    "reminders.set": async ({ threadIds, dueAt, kind }) => {
      const r = await b.reminders.set([...new Set(threadIds)], dueAt, kind);
      if (!r) throw new RpcError("BAD_REQUEST", L("errors.remindersFull", { max: REMINDERS_MAX }));
      return r;
    },
    "reminders.clear": async ({ threadIds, dueOnly, exact }) => ({ cleared: exact ? await b.reminders.clearExact(exact, dueOnly ?? false) : await b.reminders.clear(threadIds, dueOnly ?? false) }),
    "reminders.restore": async ({ drop, put }) => {
      if (!(await b.reminders.restore(drop, put))) throw new RpcError("BAD_REQUEST", L("errors.remindersFull", { max: REMINDERS_MAX }));
      return { ok: true as const };
    },
    "reminders.threads": async ({ dueOnly, accountId }) => {
      const now = b.now();
      const rows = (await b.reminders.refresh()).reminders.filter((r) => !dueOnly || r.dueAt <= now);
      const at = new Map(rows.map((r) => [r.threadId, r.dueAt]));
      const items = (await store.threads.summaries([...at.keys()])).filter((t) => !t.inTrash && !t.inSpam && (accountId === undefined || t.accountId === accountId));
      // the Inbox's top: the newest due first; the Reminders list: the soonest first
      items.sort((x, y) => (dueOnly ? at.get(y.id)! - at.get(x.id)! : at.get(x.id)! - at.get(y.id)!) || y.id - x.id);
      return { items };
    },

    "folders.moveThreads": ({ accountId, folder, from, threadIds, jobId }) => {
      const progress = progressReporter(b, jobId, threadIds.length);
      return moveToFolder(accountId, folder, from, threadIds, progress);
    },
    "folders.moveScope": async ({ accountId, folder, from, scope, filterName, jobId }) => {
      await requireFolder(accountId, folder);
      // plan 128: the filter first, so mail that arrives while the set moves is caught by it (the set is fixed below)
      let filter: { id: number; filterUndo: number | null; retargeted: { from: string } | null } | null = null;
      let filterFailed = false;
      try {
        const f = await similarFilters.ensureRule(folderRule(scope, accountId, folder), filterName);
        filter = { id: f.filter.id, filterUndo: f.filterUndo, retargeted: f.retargetedFolder };
      } catch (error) {
        // the mail still moves and stays undoable: the result says the filter is missing
        filterFailed = true;
        const partial = error instanceof RpcError ? (error.details as { filterUndo?: unknown } | undefined)?.filterUndo : undefined;
        if (typeof partial === "number") filter = { id: 0, filterUndo: partial, retargeted: null };
        b.log("warn", "folder filter failed", error instanceof Error ? error.message : error);
      }
      try {
        // resolved once, as a sweep is: filing changes the scope's own "not in it yet"
        const ids = await resolving(async () => {
          const cap = b.options.similarCap ?? SCOPE_CAP;
          const found = new Set<number>();
          for (let cursor: number | null = null; ; ) {
            const page = await store.similar.resolvePage(scope, { accountId, folder }, [], cursor, b.options.similarPage ?? SIMILAR_PAGE);
            for (const id of page.ids) found.add(id);
            if (found.size > cap) throw new RpcError("BAD_REQUEST", L("errors.tooManyThreads"));
            if (page.next === null) break;
            cursor = page.next;
            await b.yieldTurn();
          }
          return [...found];
        });
        const progress = progressReporter(b, jobId, ids.length);
        progress(0);
        const r = await moveToFolder(accountId, folder, from, ids, progress);
        progress(ids.length);
        return { ...r, filter, filterFailed };
      } catch (error) {
        // what moved and the filter stay: the renderer can still undo both
        const filterUndo = filter?.filterUndo ?? null;
        if (filterUndo === null) throw error;
        const undoId = error instanceof RpcError ? ((error.details as { undoId?: number } | undefined)?.undoId ?? null) : null;
        if (error instanceof RpcError) throw new RpcError(error.code, error.message, { undoId, filterUndo }, { expected: error.expected, diag: error.diag, i18n: error.i18n, cause: error });
        throw new RpcError("INTERNAL", error instanceof Error ? error.message : String(error), { undoId, filterUndo }, { expected: false, cause: error });
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
          // what committed before the failure still comes back with Undo (Codex review)
          const partial = error instanceof RpcError ? (error.details as { filterUndo?: unknown } | undefined)?.filterUndo : undefined;
          if (typeof partial === "number") filter = { id: 0, filterUndo: partial };
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
      return { restored: await undoActs(undoId, jobId) };
    },
    "categories.create": async ({ name, color, showInInbox }) => {
      const c = await store.categories.create(name, color, { showInInbox });
      b.server.emit("categories", await store.categories.list());
      return c;
    },
    "categories.update": async ({ id, ...patch }) => {
      const c = await store.categories.update(id, patch);
      if (!c) throw new RpcError("NOT_FOUND", L("errors.categoryGone"));
      b.server.emit("categories", await store.categories.list());
      // plan 83: the Inbox's lists and counts (and the Dock) follow what it shows
      if (patch.showInInbox !== undefined) b.notifyChanged([]);
      return c;
    },
    "categories.reorder": async ({ ids }) => {
      const list = await store.categories.reorder(ids);
      b.server.emit("categories", list);
      return list;
    },
    "categories.delete": async ({ id }) => {
      await store.categories.delete(id);
      await b.forwards.rules();
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
      await endDueIfHidden(to, threadIds, batchId);
      // plan 116: one conversation dragged here by hand may go (a drag of several never)
      if (r.added.length && threadIds.length === 1) b.planForwards({ threadIds: r.added, filed: ctx.origin === "mcp" ? [] : r.added });
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
    "categories.removeSender": async ({ categoryId, email }) => {
      await requireCategory(categoryId);
      // the set is fixed once, by the same search as "Search mail from X", inside the category
      const { ids, capped } = await resolveThreadScope(b, { kind: "search", query: `from:${email}`, categoryId });
      if (capped) throw new RpcError("BAD_REQUEST", L("errors.tooManyThreads"));
      // a move that only leaves: every row, example and decision journaled, so categorize.undo is exact
      const { batchId } = await store.categories.beginMove({ to: categoryId, threadIds: ids, addedBy: "user", now: b.now(), source: "sender", leave: true });
      try {
        await b.finishMove(batchId);
      } catch (error) {
        // what was applied stays journaled (and resumes at the next start): the renderer can still undo it
        throw new RpcError("INTERNAL", error instanceof Error ? error.message : String(error), { batchId }, { expected: false, cause: error });
      }
      const { moved } = await store.categories.moveOutcome(batchId);
      return { batchId: moved.length ? batchId : null, removed: moved };
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
    "categorize.apply": async ({ categoryId, scope, always, filterName, move }, ctx) => {
      await requireCategory(categoryId);
      // plan 80: the filter first, so mail that arrives while the set is filed is caught by it (the set is fixed below)
      let filter: { id: number; filterUndo: number | null; retargeted: { from: number } | null } | null = null;
      let filterFailed = false;
      if (always && isFilterable(scope)) {
        // plan 116: an agent's "always" is a filter filing new mail here: not into a category that forwards, unless agents may send
        if (ctx.origin === "mcp") await agentMayFile([categoryId]);
        try {
          const f = await similarFilters.ensureRule(categoryRule(scope, categoryId), filterName ?? (scope.kind === "words" ? scope.terms.join(", ") : similarValue(scope)));
          filter = { id: f.filter.id, filterUndo: f.filterUndo, retargeted: f.retargeted };
        } catch (error) {
          // the mail is still filed and undoable: the result says the filter is missing
          filterFailed = true;
          // what committed before the failure (a filter made, then another failing to turn off) still comes back with Undo
          const partial = error instanceof RpcError ? (error.details as { filterUndo?: unknown } | undefined)?.filterUndo : undefined;
          if (typeof partial === "number") filter = { id: 0, filterUndo: partial, retargeted: null };
          b.log("warn", "category filter failed", error instanceof Error ? error.message : error);
        }
      }
      const addedBy = ctx.origin === "mcp" ? "agent" : "bulk";
      let added = 0;
      let batchId = 0;
      // plan 91: a move's batch is journaled from its start: a failure partway still names it
      let moving = false;
      // from here a failure still names the filter made above (plan 81: resolving or the batch failing stranded it)
      try {
        // the set is fixed here, once: filing changes the scope's own "not yet in the category" predicate
        // never what's already in the category (plan 91, review): a thread deliberately in it and another keeps both
        const ids = await store.categorize.resolveScope(categoryId, scope, b.now());
        // that read can be a whole mailbox's: the first slice gets a turn of its own, so the two aren't one stall (plan 139)
        await b.platform.yield();
        if (move) {
          // plan 91: an exclusive move of the whole set, like a drag (other categories left, every row journaled)
          if (ids.length === 0) return { batchId: null, added: 0, filter, filterFailed };
          ({ batchId } = await store.categories.beginMove({ to: categoryId, threadIds: ids, addedBy, now: b.now(), source: "snackbar" }));
          moving = true;
          await b.finishMove(batchId);
          const r = await store.categories.moveOutcome(batchId);
          const changed = new Set([...r.added, ...r.moved]);
          return { batchId: changed.size ? batchId : null, added: changed.size, filter, filterFailed };
        }
        batchId = await store.categories.createBatch(categoryId, always ? "always" : "snackbar", scope, b.now());
        await b.runSliced(ids, 100, async (chunk) => {
          const r = await store.categories.add({ categoryId, threadIds: chunk, addedBy, now: b.now(), batchId });
          b.categorizer.apply(r.deltas);
          added += r.added.length;
          b.notifyChanged(r.added);
        });
      } catch (error) {
        // what committed stays filed (a move's journal holds it), and the filter stays: the renderer can still undo both
        const details = { batchId: added || moving ? batchId : null, filterUndo: filter?.filterUndo ?? null };
        throw new RpcError("INTERNAL", error instanceof Error ? error.message : String(error), details, { expected: false, cause: error });
      }
      return { batchId: added ? batchId : null, added, filter, filterFailed };
    },
    /**
     * Plan 91: what one action offers next, the same everywhere (snackbars, menus): the scopes the targets share,
     * each with what it would change now, and whether every target came from a sender that isn't a person.
     */
    "offers.forAction": async ({ threadIds, action }) => {
      // known not to be a person's, every one (not merely "not known to be": the facts may still be coming)
      const automated = await store.similar.automated(threadIds);
      if (typeof action === "string" || "folder" in action) return { ...(await store.similar.offers(threadIds, action)), automated };
      await requireCategory(action.category);
      const { senderName, scopes } = await store.similar.scopes(threadIds);
      const offers = await Promise.all(
        // what it would still change: not the targets (already there), nothing already in the category
        scopes.map(async (scope) => ({ scope, ...(await store.categorize.countScope(action.category, scope, b.now())), skipped: 0 })),
      );
      return { senderName, offers, automated };
    },
    /** Plan 96: what Unsubscribe would do here, read when the menu opens (no network). */
    "unsubscribe.find": ({ threadId }) => findUnsubscribe(store, threadId),
    "unsubscribe.run": ({ threadId, messageId, method, target }) =>
      runUnsubscribe(
        {
          store,
          transport: b.unsubscribeTransport,
          assert: (url) => b.net.assert("unsubscribe", url),
          signal: b.abort.signal,
          send: async (accountId, mail) => {
            const { opId, threadId: sent, deltas } = await store.compose.queueSend({ accountId, to: [{ name: "", email: mail.to }], cc: [], bcc: [], subject: mail.subject, bodyText: mail.body, recordReply: false, now: b.now() });
            b.categorizer.apply(deltas);
            b.notifyChanged([sent]);
            b.kickWorker();
            return opId;
          },
        },
        threadId,
        { messageId, method, target },
      ),
    "categorize.alwaysOffers": async ({ categoryId, threadId }) => {
      await requireCategory(categoryId);
      const { senderName, scopes } = await store.similar.scopes([threadId]);
      // the narrower first: the same subject from them, then everything from them
      const always = (["subject", "sender"] as const).flatMap((kind) => scopes.filter((s): s is AlwaysScope => s.kind === kind));
      const offers = await Promise.all(always.map(async (scope) => ({ scope, ...(await store.categorize.countScope(categoryId, scope, b.now())) })));
      return { senderName, offers };
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
      await restoreFiled(batchId);
      if ((await store.categories.movePhase(batchId)) !== null) {
        const { removed, restored } = await undoMove(batchId);
        return { removed, restored };
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

    "snippets.list": () => listSnippets(store),
    "snippets.save": (p) => saveSnippet(store, p, b.now()),
    "snippets.delete": async ({ id }) => {
      await deleteSnippet(store, id);
      return { ok: true as const };
    },

    "filters.list": () => store.filters.list(),
    "filters.save": async (p, ctx) => {
      // plan 116: an agent never sets up forwarding (a way to send mail elsewhere), nor changes a filter that forwards
      if (ctx.origin === "mcp") {
        const previous = p.id === undefined ? null : await store.filters.get(p.id);
        if (p.rule.actions.some((a) => a.type === "forward") || previous?.rule.actions.some((a) => a.type === "forward")) throw new RpcError("FORBIDDEN", L("errors.forwardAgent"));
        // nor files new mail into a category that forwards, unless agents may send (its filing would send mail elsewhere)
        await agentMayFile(p.rule.actions.flatMap((a) => (a.type === "addCategory" ? [a.categoryId] : [])));
      }
      // plan 128: a new target has to be there; one that went away since doesn't stop the filter being renamed
      const before = p.id === undefined ? [] : ((await store.filters.get(p.id))?.rule.actions ?? []);
      for (const a of p.rule.actions) if (a.type === "moveToFolder" && !before.some((x) => x.type === "moveToFolder" && x.accountId === a.accountId && x.folder === a.folder)) await requireFolder(a.accountId, a.folder);
      const f = await store.filters.save(p, b.now());
      await b.forwards.rules();
      return f;
    },
    "filters.setEnabled": async ({ ids, enabled }) => {
      const r = await similarFilters.setEnabled(ids, enabled);
      await b.forwards.rules();
      return r;
    },
    "filters.autoFor": async ({ categoryId, threadIds }) => {
      const mine = (await store.filters.list()).filter((f) => f.auto && f.enabled && f.rule.actions.some((a) => a.type === "addCategory" && a.categoryId === categoryId));
      if (mine.length === 0) return { filters: [] };
      // what sender and subject rules decide on: each thread's root inbound message (≤ 200), the first match enough
      const roots = await store.similar.roots(threadIds);
      const found: { id: number; name: string }[] = [];
      for (const f of mine) {
        if ((await store.filters.matchMessages(f.rule, b.now(), roots)).length) found.push({ id: f.id, name: f.name });
        await b.yieldTurn();
      }
      return { filters: found };
    },
    "filters.delete": async ({ id }) => {
      await store.filters.delete(id);
      await b.forwards.rules();
      return { ok: true as const };
    },
    "filters.preview": ({ rule, limit }) => store.filters.preview(rule, b.now(), limit),
    "filters.apply": async ({ id, jobId }) => {
      // plan 89: one apply of a filter at a time (taken before the first await, released whatever happens)
      if (applying.has(id)) throw new RpcError("BAD_REQUEST", L("errors.filterApplying"));
      applying.add(id);
      let applied = 0;
      const touched = new Set<number>();
      try {
        const filter = await store.filters.get(id);
        if (!filter) throw new RpcError("NOT_FOUND", L("errors.filterGone"));
        // match in id windows, yielding between them: no single long synchronous scan; a pattern costs a JS call a message,
        // so its windows are smaller (perf gate: no stall over 50 ms while it runs)
        const bounds = await store.filters.messageIdRange();
        const step = filter.rule.conditions.some((c) => c.field !== "hasAttachment" && c.field !== "account" && c.field !== "ageDays" && c.op === "matches") ? 1000 : 4000;
        const span = bounds ? bounds.hi - bounds.lo + 1 : 0;
        const checking = progressReporter(b, jobId, span);
        checking(0);
        const matched: number[] = [];
        for (let from = bounds?.lo ?? 1; bounds && from <= bounds.hi; from += step) {
          matched.push(...(await store.filters.matchWindow(filter.rule, b.now(), { from, to: from + step - 1 })));
          checking(Math.min(span, from + step - bounds.lo));
          await b.platform.yield();
        }
        const progress = progressReporter(b, jobId, matched.length);
        let done = 0;
        // time-sliced so a huge bulk apply doesn't freeze list/search
        const capturedRule = JSON.stringify(filter.rule);
        await b.runSliced(matched, 20, async (chunk) => {
          const r = await store.filters.applyChunk(id, capturedRule, chunk, b.now());
          for (const t of r.touched) touched.add(t);
          applied += r.applied;
          b.opsQueued(r.opIds);
          b.reconcileFlags(r.flagReconcileAccounts);
          progress((done += chunk.length));
        });
        return { matchedMessages: applied, affectedThreads: touched.size };
      } catch (error) {
        if (error instanceof RpcError && applied === 0) throw error;
        // what committed stays applied: the error says how much
        const details = { matchedMessages: applied, affectedThreads: touched.size };
        throw new RpcError("INTERNAL", error instanceof Error ? error.message : String(error), details, { expected: false, cause: error });
      } finally {
        applying.delete(id);
        b.notifyChanged(touched);
      }
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
      const r = await b.queueComposeSend(p, { renderer: ctx.origin === "renderer" });
      // a scheduled draft sent now (another window's Send): its row went with it
      if (p.draftId !== undefined && b.scheduled.has(p.draftId)) b.scheduled.poke();
      return r;
    },
    "compose.schedule": async ({ sendAt, ...p }, ctx) => {
      const params = ctx.origin === "renderer" ? p : { ...p, bodyHtml: undefined, authoredText: undefined };
      const r = await b.scheduled.schedule(params, sendAt);
      if (r === "stale") throw new RpcError("STALE", L("errors.draftGone"), { reason: "draftRevision" });
      if (r === "full") throw new RpcError("BAD_REQUEST", L("errors.scheduledFull", { max: SCHEDULED_MAX }));
      return { ok: true as const };
    },
    // plan 116
    "forwards.list": () => b.forwards.refresh(),
    "forwards.cancel": async ({ ids }) => ({ cancelled: await b.forwards.cancel(ids) }),
    "forwards.cancelWaiting": async ({ upTo }) => ({ cancelled: await b.forwards.cancelWaiting(upTo) }),
    "forwards.retry": async ({ id }) => {
      if (!(await b.forwards.retry(id))) throw new RpcError("BAD_REQUEST", L("errors.forwardNotRetryable"));
      return { ok: true as const };
    },
    "forwards.answer": async ({ rule, keep }) => {
      await b.forwards.answer(rule, keep);
      // a category's trigger shows as off in the sidebar (Settings → Filters reads its list when it opens)
      if (!keep && rule.kind === "category") b.server.emit("categories", await store.categories.list());
      return { ok: true as const };
    },
    "categories.setForward": async ({ categoryId, forward }) => {
      if (forward && JSON.stringify(forward.addresses).length > FORWARD_ADDRESSES_MAX_CHARS) throw new RpcError("BAD_REQUEST", L("filters.invalid.forwardTooMany"));
      if (!(await store.forwards.setCategory(categoryId, forward, b.now()))) throw new RpcError("NOT_FOUND", L("errors.categoryGone"));
      await b.forwards.rules();
      b.forwards.poke();
      const list = await store.categories.list();
      b.server.emit("categories", list);
      return list.find((c) => c.id === categoryId)!;
    },
    "app.locale": async ({ locale }) => {
      // the language a forward is written in when the setting follows the system (the backend can't see the system's)
      if ((await store.settings.get<string | null>(UI_LOCALE_KEY, null)) !== locale) await store.settings.set(UI_LOCALE_KEY, locale);
      return { ok: true as const };
    },
    "scheduled.list": () => b.scheduled.refresh(),
    "scheduled.reschedule": async ({ draftId, sendAt }) => {
      if (!(await b.scheduled.reschedule(draftId, sendAt))) throw new RpcError("NOT_FOUND", L("errors.scheduledGone"));
      return { ok: true as const };
    },
    "scheduled.cancel": async ({ draftId }) => {
      if (!(await b.scheduled.cancel(draftId))) throw new RpcError("NOT_FOUND", L("errors.scheduledGone"));
      return { ok: true as const };
    },
    "scheduled.ackFailed": async ({ ids }) => {
      await b.scheduled.ackFailed(ids);
      return { ok: true as const };
    },

    "captureRepairs.list": (p, ctx) => attachmentCall(ctx.origin, () => store.captureRepairs.list(p.accountId, p.after)),
    "captureRepairs.retry": (p, ctx) => attachmentCall(ctx.origin, async () => { return { repair: await b.retryCapture(p.accountId, p.key, p.revision) }; }),
    "attachments.retry": (p, ctx) => attachmentCall(ctx.origin, async () => {
      await b.retryAttachments(p.accountId, p.messageId);
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
      // plan 94: an edit to a scheduled draft (another window still had it open) wins: it is a draft again
      if (saved && (b.scheduled.has(saved.id) || (p.id !== undefined && b.scheduled.has(p.id)))) {
        if (await store.scheduled.delete(saved.id)) b.server.emit("drafts", { reason: "scheduled" });
        b.scheduled.poke();
      }
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
    // plan 94: a scheduled draft isn't for editing (it shows as scheduled)
    "drafts.list": async () => {
      const scheduled = new Set((await store.scheduled.list()).map((x) => x.draftId));
      return (await store.drafts.list()).filter((d) => !scheduled.has(d.id)).map(toDraft);
    },
    "drafts.sourceContext": ({ messageId }) => store.drafts.sourceContext(messageId),
    "drafts.delete": async ({ id, generation }) => {
      await store.drafts.delete(id, generation ?? "");
      b.scheduled.touched();
      return { ok: true as const };
    },

    "accounts.addImap": async (p) => {
      if (!b.host.capabilities.imap) throw new RpcError("UNAVAILABLE", L("errors.imapNeedsDesktop"));
      const config: ImapAccountConfig & AccountPrefs = {
        imap: p.imap,
        smtp: p.smtp,
        senderName: p.displayName || p.email,
        appendToSent: !/gmail\.com$/i.test(p.imap.host),
        // plan 79: the days asked for when connecting are this account's own window
        ...(p.syncWindowDays !== undefined && { syncWindowDays: p.syncWindowDays }),
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
      const label = accountLabel(p.displayName || p.email, p.email, await store.accounts.list());
      const { account, claimed } = await store.accounts.create({
        kind: "imap",
        email: p.email,
        displayName: label.displayName,
        color: await nextAccountColor(),
        providerConfig: config,
        secret: { key: "password", blob },
        ownerClaim: claim ? imapClaim({ email: p.email }, config, p.displayName || p.email) : undefined,
        now: b.now(),
      });
      // the account it now shares a name with shows its address too
      for (const r of label.renames) await store.accounts.update(r.id, { displayName: r.displayName });
      await b.emitAccounts();
      if (claimed) await b.emitOwner();
      // what an import kept for this mailbox goes in now
      await restorePending(b);
      b.startAccount(account);
      return (await b.accountViews([account]))[0]!;
    },

    "accounts.connectGmail": async ({ syncWindowDays }) => {
      // plan 123: the client this build carries; a build without one can't connect Google
      const oauth = await googleClientFor(b);
      if (!oauth) throw new RpcError("BAD_REQUEST", L("errors.google.noClient"));
      if (!b.options.openExternal) throw new RpcError("UNAVAILABLE", L("errors.googleConnectNeedsDesktop"));
      // plan 125: a removal's revoke would end the grant this consent is about to make for the same person
      await revokesSettled(b);
      const mark = removalMark(b);
      const google = await b.initialGoogleRequests(true);
      const result = await b.options.providers.connectGmail({
        clientId: oauth.clientId,
        clientSecret: oauth.clientSecret,
        openExternal: b.options.openExternal,
        signal: b.abort.signal,
        fetch: b.net.fetchFor("mail"),
        google,
        // plan 125: mail only; contacts are asked for when the user turns photos on (Settings → Appearance)
        scopes: GMAIL_SCOPES,
      }).finally(() => google.close());
      googleFlowActive(b);
      validateGoogleConnection(result, "initial");
      if (result.refreshToken === null) throw new RpcError("BAD_REQUEST", L("errors.google.invalidResponse"));
      // plan 125: removed while this consent was open: that removal's revoke ends the grant just made
      if (removedSince(b, mark, result.email)) {
        await revokesSettled(b);
        throw new RpcError("BAD_REQUEST", L("errors.google.removedWhileConnecting", { email: result.email }));
      }
      const existing = (await store.accounts.list()).find((a) => a.email === result.email.toLowerCase());
      if (existing) throw new RpcError("BAD_REQUEST", L("errors.alreadyConnected", { email: result.email }));
      const config: GmailAccountConfig & AccountPrefs = { senderName: result.name || result.email, googleSubject: result.sub!, googleClientId: oauth.clientId, ...(syncWindowDays !== undefined && { syncWindowDays }) };
      const blob = await b.options.cipher.encrypt(result.refreshToken);
      const color = await nextAccountColor();
      const label = accountLabel(result.email.split("@")[0]!, result.email, await store.accounts.list());
      googleFlowActive(b);
      const { account, claimed } = await store.accounts.create({
        kind: "gmail",
        email: result.email,
        displayName: label.displayName,
        color,
        providerConfig: config,
        secret: { key: "refreshToken", blob },
        ownerClaim: b.canClaimOwner() ? gmailClaim({ ...result, name: result.name || result.email }) : undefined,
        now: b.now(),
      });
      // the account it now shares a name with shows its address too
      for (const r of label.renames) await store.accounts.update(r.id, { displayName: r.displayName });
      await b.emitAccounts();
      if (claimed) await b.emitOwner();
      // what an import kept for this mailbox goes in now
      await restorePending(b);
      b.startAccount(account);
      return (await b.accountViews([account]))[0]!;
    },

    "accounts.connectGmailToken": async ({ accessToken, expiresIn, accountId, syncWindowDays }) => {
      const tokens = b.options.providers.gmailTokens;
      // i18n-ignore: a wiring mistake (only the web build calls this, and it has the broker), for developers
      if (!tokens) throw new RpcError("UNAVAILABLE", "This host connects Gmail with accounts.connectGmail.");
      if (!/^[\x21-\x7e]+$/.test(accessToken) || (accountId !== undefined && (!Number.isSafeInteger(accountId) || accountId <= 0))) throw new RpcError("BAD_REQUEST", L("errors.google.invalidResponse"));
      const expiresAt = b.now() + expiresIn * 1000;
      const snapshots = new Map(await Promise.all((await store.accounts.list()).map(async (account) => [account.id, { generation: b.credentialsOf(account.id), version: signInVersion(b, account.id), stamp: (await store.accounts.stamp(account.id))!, config: (await store.accounts.config<GmailAccountConfig>(account.id))!.config }] as const)));
      let flow = accountId !== undefined ? beginSignIn(b, accountId) : undefined;
      let flowId = accountId;
      try {
        const google = await b.initialGoogleRequests(false, accountId);
        const who = await tokens.inspect(accessToken, b.net.fetchFor("mail"), { signal: b.abort.signal, google }).catch((error: unknown) => {
          throw new RpcError("BAD_REQUEST", messageOf(error));
        }).finally(() => google.close());
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
          const known = await b.initialGoogleRequests(false, existing.id);
          known.close();
          const snapshot = snapshots.get(existing.id);
          if (!snapshot || snapshot.generation !== b.credentialsOf(existing.id) || (accountId === undefined && snapshot.version !== signInVersion(b, existing.id))) throw new RpcError("BAD_REQUEST", L("errors.google.cancelled"));
          if (accountId === undefined && snapshot.config.googleSubject === undefined) throw new RpcError("BAD_REQUEST", L("errors.google.invalidResponse"));
          flow ??= beginSignIn(b, existing.id);
          flowId = existing.id;
          const admission = await googleAdmission(b, existing.id, flow);
          if (admission.expectedSubject !== (snapshot.config.googleSubject ?? null)) throw new RpcError("BAD_REQUEST", L("errors.google.invalidResponse"));
          await admitBrowserGoogle(b, existing, who, accessToken, expiresAt, flow, { ...admission, stamp: snapshot.stamp });
          void b.syncAccount(existing.id);
          return (await b.accountViews([existing]))[0]!;
        }
        // a new mailbox only: one already here (reconnected above) keeps its window
        const config: GmailAccountConfig & AccountPrefs = { senderName: who.name || who.email, googleSubject: who.sub!, ...(syncWindowDays !== undefined && { syncWindowDays }) };
        const color = await nextAccountColor();
        const label = accountLabel(who.email.split("@")[0]!, who.email, await store.accounts.list());
        googleFlowActive(b);
        if (expiresAt <= b.now()) throw new RpcError("BAD_REQUEST", L("errors.google.invalidResponse"));
        const { account, claimed } = await store.accounts.create({
          kind: "gmail",
          email: who.email,
          displayName: label.displayName,
          color,
          providerConfig: config,
          ownerClaim: b.canClaimOwner() ? gmailClaim({ ...who, name: who.name || who.email }) : undefined,
          now: b.now(),
        });
        for (const r of label.renames) await store.accounts.update(r.id, { displayName: r.displayName });
        tokens.set(account.id, accessToken, expiresAt);
        await b.emitAccounts();
        if (claimed) await b.emitOwner();
        // what an import kept for this mailbox goes in now
        await restorePending(b);
        b.startAccount(account);
        return (await b.accountViews([account]))[0]!;
      } finally { if (flow && flowId !== undefined) await endSignIn(b, flowId, flow); }
    },

    "accounts.reconnect": async ({ id, password }) => (await b.accountViews([await reconnectAccount(b, id, password)]))[0]!,

    "accounts.update": async ({ id, ...patch }) => {
      const before = patch.syncWindowDays !== undefined ? await store.accounts.get(id) : null;
      const account = await store.accounts.update(id, patch);
      if (!account) throw new RpcError("NOT_FOUND", L("errors.accountGone"));
      // plan 101: a wider effective window downloads the older mail (an override, or one removed for a wider General)
      let result = account;
      if (before) {
        const general = (await readSettings(store)).syncWindowDays;
        await b.widenWindow(id, before.syncWindowDays ?? general, account.syncWindowDays ?? general);
        // the account as it is now, its request included (Codex review: the reply mustn't hide the pill)
        result = (await store.accounts.get(id)) ?? account;
      }
      await b.emitAccounts();
      // plan 86: what the Inbox shows changed (lists reload, the counts and the Dock follow)
      if (patch.separateTabs !== undefined) b.notifyChanged([]);
      if (patch.followups === false) b.followups.accountOff(id);
      return (await b.accountViews([result]))[0]!;
    },

    "accounts.remove": async ({ id }) => {
      const wasOwner = (await store.owner.get())?.accountId === id;
      const before = await store.accounts.get(id);
      // plan 125: from the first step, a new Google sign-in waits for this removal and its revoke
      const removal = before?.kind === "gmail" && b.options.providers.revokeGoogle ? beginGoogleRemoval(b, before.email) : null;
      try {
        return await removeAccount(id, wasOwner, before?.kind === "gmail");
      } finally { removal?.end(); }
    },
    // plan 107: folder changes, favorites and the .mbox export (filled in by their commits)
    "folders.create": ({ accountId, parent, name }) => createFolder(b, accountId, parent, name),
    "folders.rename": ({ accountId, key, name }) => renameFolder(b, accountId, key, name),
    "folders.delete": ({ accountId, key }) => deleteFolder(b, accountId, key),
    "folders.count": ({ accountId, key }) => countFolder(b, accountId, key),
    "folders.favorite": ({ accountId, folder, view, on }) => favoriteFolder(b, { accountId, folder, view }, on),
    "folders.exportStart": (p, ctx) => folderExports.start(p.folder !== null ? { accountId: p.accountId, folder: p.folder } : { accountId: p.accountId, view: p.view! }, ctx.clientId, p.requestId),
    "folders.exportNext": (p, ctx) => folderExports.next(p.exportId, ctx.clientId),
    "folders.exportCancel": (p, ctx) => folderExports.cancel(p.exportId, ctx.clientId),

    "storage.report": () => storage.report(),
    "storage.remove": async ({ buckets, olderThanDays, jobId }) => {
      // plan 101: what the user removes isn't fetched back by a backfill still pending
      await b.cancelBackfills();
      await b.emitAccounts();
      return storage.remove({ buckets, olderThanDays, jobId });
    },

    "settings.update": (patch) => {
      // Keep committed settings and their notifications in the same order.
      const updating = settingsUpdates.then(async () => {
        try {
          // i18n-ignore: a caller's bug: only a local build offers this
          if (patch.devAi && !b.options.devAi) throw new RpcError("BAD_REQUEST", "Dev mode is only for a local build");
          const was = await readSettings(store);
          const next = await updateSettings(store, patch, b.now());
          if (next.devAi !== was.devAi) {
            b.aiService.devAiChanged();
            b.summaries.settingsChanged(next);
            b.followups.settingsChanged(next);
            b.ask.settingsChanged(next.ask.enabled);
            b.aiAssist.targetChanged();
          }
          b.aiAssist.settingsChanged(patch);
          if (patch.ai && (patch.ai.provider !== undefined || patch.ai.model !== undefined || patch.ai.baseURL !== undefined || patch.ai.preset !== undefined || patch.ai.tasks)) b.aiService.configChanged();
          // plan 132: turned off, nothing further goes; a change may unblock what was paused
          if (patch.ai || patch.summaries) b.summaries.settingsChanged(next);
          if (patch.ask) b.ask.settingsChanged(next.ask.enabled);
          if (patch.ai || patch.followups) b.followups.settingsChanged(next);
          if (next.localMode !== was.localMode || next.errorReports !== was.errorReports || next.language !== was.language) await b.publishPolicy();
          if (next.composeSuggestions !== was.composeSuggestions) await b.autocomplete.setPhrases(next.composeSuggestions);
          // plan 22: website icons turned off: nothing in flight lands, windows forget them
          if (next.senderIcons !== was.senderIcons) b.icons.invalidate();
          // plan 41: the badge follows at once; notifications turned off drop what was pending
          if (next.dockBadge !== was.dockBadge || next.notifications !== was.notifications || next.notificationPreview !== was.notificationPreview) await b.attention.refresh();
          // plan 101: a wider General window: the accounts that follow it download their older mail
          if (next.syncWindowDays > was.syncWindowDays) {
            for (const account of await store.accounts.list()) if (account.syncWindowDays === null) await b.widenWindow(account.id, was.syncWindowDays, next.syncWindowDays);
            await b.emitAccounts();
          }
          return next;
        } catch (error) {
          if (error instanceof SettingsError) throw new RpcError("BAD_REQUEST", messageOf(error));
          throw error;
        }
      });
      settingsUpdates = updating.then(() => {}, () => {});
      return updating;
    },
    "ai.providers": () => b.aiService.providers(),
    "ai.listModels": ({ provider, baseURL, preset }) => b.aiService.listModels({ provider, baseURL, preset }),
    "ai.test": ({ provider, model, baseURL, preset }) => b.aiService.test({ provider, model, baseURL, preset }),
    "ai.setKey": async ({ provider, preset, value }) => {
      const next = await b.aiService.setKey(provider, preset, value);
      b.summaries.settingsChanged(next);
      b.followups.settingsChanged(next);
      b.ask.settingsChanged(next.ask.enabled);
      // plan 134: a JEV key chooses where categorization runs
      b.aiAssist.targetChanged();
      return next;
    },
    "ai.cancel": ({ requestId }, ctx) => {
      b.aiService.cancel(requestId, ctx.clientId);
      return { ok: true };
    },
    "ai.usage": () => b.aiService.limiter.report(),
    "ai.confirmKey": async ({ provider, preset }) => {
      const next = await b.aiService.confirmKey(provider, preset);
      b.summaries.settingsChanged(next);
      b.followups.settingsChanged(next);
      return next;
    },
    "ai.summarize": ({ threadId, requestId, acknowledge }, ctx) => b.summaries.request(threadId, requestId, ctx.clientId, acknowledge),
    "ai.summaries.get": ({ threadId }) => b.summaries.read(threadId),
    "ai.summaries.status": () => b.summaries.status(),
    "ai.summaries.clear": async () => {
      await b.summaries.clear();
      await b.ask.clear();
      b.actions.invalidate(null);
      await b.followups.clear();
      return { ok: true };
    },
    // plan 142: renderer only; none of these is in MCP_ALLOWED
    "followups.list": () => b.followups.look(),
    "followups.threads": async ({ onTop, accountId }) => ({ items: await b.followups.threads(onTop, accountId) }),
    "followups.act": ({ id, revision, action, dueAt }) => b.followups.act(id, revision, action, dueAt),
    "followups.undo": async ({ undoId }) => {
      await b.followups.undoAct(undoId);
      return { ok: true };
    },
    "followups.seen": async ({ threadId }) => {
      await b.followups.endTop([threadId]);
      return { ok: true };
    },
    "followups.status": () => b.followups.status(),
    "followups.scanOffer": () => b.followups.scanOffer(),
    "followups.scan": async () => ({ queued: await b.followups.scan() }),
    // plan 141: renderer only; none of these is in MCP_ALLOWED
    "ai.ask": (p, ctx) => b.ask.ask(p, ctx.clientId),
    "ai.actionStart": (p, ctx) => b.actions.start(p, ctx.clientId).catch((error: unknown) => { throw toRpcError(error); }),
    "ai.actionPage": (p, ctx) => b.actions.page(p.previewId, p.offset, p.limit, p.leftOut, ctx.clientId),
    "ai.actionToggle": async (p, ctx) => b.actions.toggle(p.previewId, p.threadId, p.included, ctx.clientId),
    "ai.actionIncludeSkipped": async (p, ctx) => b.actions.includeSkipped(p.previewId, p.included, ctx.clientId),
    "ai.actionCheck": (p, ctx) => b.actions.check(p, ctx.clientId).catch((error: unknown) => { throw toRpcError(error); }),
    "ai.actionApply": (p, ctx) => b.actions.apply(p, ctx.clientId),
    "ai.actionStop": async (p, ctx) => {
      b.actions.stop(p.previewId, ctx.clientId);
      return { ok: true as const };
    },
    "ai.actionCancel": async (p, ctx) => {
      b.actions.cancel(p.previewId, ctx.clientId);
      return { ok: true as const };
    },
    "ai.actionUndo": (p) => b.actions.undo(p.token, p.jobId),
    "ai.askOlder": (p, ctx) => b.ask.older(p, ctx.clientId),
    "ai.askHistory": () => b.ask.history(),
    "ai.askConversation": ({ conversationId }) => b.ask.conversation(conversationId),
    "ai.askSources": ({ messageIds }) => b.ask.sourceViews(messageIds),
    "ai.askDelete": async ({ conversationId }) => {
      await b.ask.remove(conversationId);
      return { ok: true };
    },
    "ai.askRestore": async ({ conversationId }) => {
      await b.ask.restore(conversationId);
      return { ok: true };
    },

    // plan 133: renderer only; none of these is in MCP_ALLOWED
    "ai.compose": (p, ctx) => b.writing.compose(p, ctx.clientId),
    "ai.composeEnd": ({ session }, ctx) => {
      b.writing.endSession(session, ctx.clientId);
      return { ok: true };
    },
    "ai.resolveIntent": (p, ctx) => b.writing.resolveIntent(p, ctx.clientId),
    "writing.activate": async () => {
      await b.writing.learner.activate();
      return { ok: true };
    },
    "writing.prefs.get": () => b.writing.getPrefs(),
    "writing.prefs.set": (patch) => b.writing.setPrefs(patch),
    "writing.profiles.list": (p) => b.writing.listProfiles(p),
    "writing.profiles.edit": (p) => b.writing.editProfile(p),
    "writing.profiles.reset": async ({ scopeKey, language }) => {
      await b.writing.resetProfile(scopeKey, language);
      return { ok: true };
    },
    "writing.profiles.rebuild": async ({ accountId }) => {
      await b.writing.learner.rebuild(accountId);
      return { ok: true };
    },
    "writing.profiles.clear": async () => {
      await b.writing.clearProfiles();
      return { ok: true };
    },
    "writing.studyStyle": async ({ requestId, confirm }, ctx) => {
      try {
        return await b.writing.learner.study({ requestId, clientId: ctx.clientId, ...(confirm ? { confirm } : {}) });
      } catch (error) {
        throw toRpcError(error);
      }
    },
    "writing.commitGeneration": async (p) => ({ ok: await b.writing.commitGeneration(p) }),

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
      // plan 87: a window's focus looks at reminders too (a timer runs late while a laptop sleeps; the web hears of no wake)
      if (reason === "focus") {
        b.refreshReminders();
        b.scheduled.poke();
      }
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
