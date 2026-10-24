import { RpcError, type Handlers } from "@unica/core/rpc";
import { COUNT_CAP, proposeLearnedFilters, type Address, type ThreadAction } from "@unica/core";
import { SearchCancelledError, StaleCursorError, type AddedBy, type DraftRow } from "@unica/store";
import type { GmailAccountConfig, ImapAccountConfig } from "@unica/mail";
import { BackendCore as Backend } from "./core";
import { changeOwnerTo, gmailClaim, imapClaim } from "./identity";
import { inverseAction, progressReporter, resolveThreadScope, ScopeUndoJournal } from "./scope";
import { readAutoCategorize, readSettings, SettingsError, updateSettings } from "./settings";

/** How a UI entry point is recorded: bulk (snackbar) adds weigh half and their content is capped per sender. */
/** More ids than this and a categorization runs in time slices (plan 02 §6). */
const SLICE_ABOVE = 200;

const ADDED_BY = { picker: "user", dnd: "user", suggestion: "suggestion", snackbar: "bulk" } as const;

const ACCOUNT_COLORS = ["indigo", "emerald", "amber", "cyan", "violet", "rose", "lime", "slate"];

function toDraft(r: DraftRow) {
  return {
    id: r.id,
    accountId: r.account_id,
    to: JSON.parse(r.to_json) as Address[],
    cc: JSON.parse(r.cc_json) as Address[],
    subject: r.subject,
    bodyText: r.body_text,
    inReplyToMessageId: r.in_reply_to_message_id,
    updatedAt: r.updated_at,
  };
}

export function createHandlers(b: Backend): Handlers {
  const store = b.store;
  const requireCategory = async (id: number) => {
    if (!(await store.categories.exists(id))) throw new RpcError("NOT_FOUND", `Category ${id} not found`);
  };
  /** Small sets in one go (same tick), large ones through the backend's slicer. */
  const sliced = async <T,>(items: T[], work: (chunk: T[]) => Promise<void>) => {
    if (items.length <= SLICE_ABOVE) await work(items);
    else await b.runSliced(items, 100, work);
  };
  /**
   * The one store command behind every UI way of filing threads; returns
   * what changed for undo. Above SLICE_ABOVE ids it runs in time slices (one
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
  const actOn = async (threadIds: readonly number[], action: ThreadAction, signal: ReturnType<typeof Backend.learningSignal> | null, progress?: (done: number) => void, alwaysSliced = false) => {
    const changed = new Set<number>();
    let done = 0;
    const run = async (chunk: number[]) => {
      const r = await store.threads.act({ threadIds: chunk, action, signal: signal ?? null, now: b.now() });
      for (const t of r.threadIds) changed.add(t);
      b.opsQueued(r.opIds);
      b.notifyChanged(r.threadIds);
      progress?.((done += chunk.length));
    };
    // small sets in one go; large ones through the slicer, starting small (an action recomputes every thread it touches)
    if (threadIds.length <= SLICE_ABOVE && !alwaysSliced) await run([...threadIds]);
    // half the usual budget: an action's commit writes every message, thread and op it touches, and that write is the
    // part of a slice whose time the disk decides
    else await b.runSliced([...threadIds], 50, run, b.options.sliceBudgetMs / 2);
    return [...changed];
  };
  const scopeUndo = new ScopeUndoJournal();
  const nextAccountColor = async () => ACCOUNT_COLORS[(await store.accounts.list()).length % ACCOUNT_COLORS.length]!;

  return {
    "app.bootstrap": async (_p, ctx) => ({
      host: { ...b.host, storage: store.capabilities.engine },
      accounts: await store.accounts.list(),
      categories: await store.categories.list(),
      counts: await store.threads.counts(),
      settings: await readSettings(store),
      // agents get the mailboxes, not the person's identity
      owner: ctx.origin === "mcp" ? null : await store.owner.get(),
      demo: b.demo,
      version: b.options.version,
    }),

    "app.export": async () => {
      const accounts = await store.accounts.list();
      const emailOf = (id: number) => accounts.find((a) => a.id === id)?.email ?? null;
      return {
        format: "unica-export" as const,
        version: 1 as const,
        exportedAt: b.now(),
        app: b.options.version,
        accounts: accounts.map((a) => ({ email: a.email, kind: a.kind, displayName: a.displayName })),
        categories: await store.categories.list(),
        filters: await store.filters.list(),
        settings: await readSettings(store),
        drafts: (await store.drafts.list()).map((d) => ({ accountEmail: emailOf(d.account_id), to: JSON.parse(d.to_json), cc: JSON.parse(d.cc_json), subject: d.subject, bodyText: d.body_text, updatedAt: d.updated_at })),
        ops: (await store.ops.recent(100_000))
          .filter((o) => o.state !== "succeeded")
          .map((o) => ({ accountEmail: emailOf(o.account_id), kind: o.kind, state: o.state, createdAt: o.created_at, lastError: o.last_error, target: JSON.parse(o.target_json), payload: JSON.parse(o.payload_json) })),
      };
    },

    "threads.list": (p) => store.threads.list(p),

    "threads.search": async (p, ctx) => {
      // Latest-wins per client: a query superseded while queued is not executed.
      const seq = (b.searchSeq.get(ctx.clientId) ?? 0) + 1;
      b.searchSeq.set(ctx.clientId, seq);
      await b.platform.yield();
      if (b.searchSeq.get(ctx.clientId) !== seq) throw new RpcError("CANCELLED", "Superseded by a newer search");
      const started = performance.now();
      b.searchAborts.get(ctx.clientId)?.abort();
      const abort = new AbortController();
      b.searchAborts.set(ctx.clientId, abort);
      try {
        const page = await store.threads.searchText({ ...p, now: b.now(), signal: abort.signal });
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
      if (!thread) throw new RpcError("NOT_FOUND", `Thread ${threadId} not found`);
      const { categorization, ...detail } = thread;
      return {
        ...detail,
        categorization: { auto: categorization.auto, suggestions: categorization.suggestions.map((s) => ({ categoryId: s.categoryId, p: s.p, reasons: s.reasons })) },
      };
    },

    "threads.act": async ({ threadIds, action }, ctx) => {
      const signal = Backend.learningSignal(action);
      // only explicit renderer actions feed learned filters
      const changed = await actOn([...new Set(threadIds)], action, signal && ctx.origin === "renderer" ? signal : null);
      return { affected: changed.length };
    },
    "threads.scopeCount": async ({ scope }) => {
      const { ids, capped } = await resolveThreadScope(b, scope);
      return { count: ids.length, capped };
    },
    "threads.actScope": async ({ scope, action, jobId }) => {
      const { ids, capped } = await resolveThreadScope(b, scope);
      if (capped) throw new RpcError("BAD_REQUEST", "Demasiadas conversaciones: acota la vista o la búsqueda");
      const progress = progressReporter(b, jobId, ids.length);
      progress(0);
      // a sweep over a whole view says nothing about senders: never a learning signal
      const changed = await actOn(ids, action, null, progress, true);
      progress(ids.length);
      const inverse = inverseAction(action, scope);
      return { undoId: inverse && changed.length ? scopeUndo.remember(inverse, changed) : null, affected: changed.length, total: ids.length };
    },
    "threads.undoScope": async ({ undoId, jobId }) => {
      const entry = scopeUndo.take(undoId);
      if (!entry) throw new RpcError("NOT_FOUND", "Esta acción ya no se puede deshacer");
      const progress = progressReporter(b, jobId, entry.threadIds.length);
      const changed = await actOn(entry.threadIds, entry.action, null, progress, true);
      progress(entry.threadIds.length);
      return { restored: changed.length };
    },

    "categories.create": async ({ name, color }) => {
      const c = await store.categories.create(name, color);
      b.server.emit("categories", await store.categories.list());
      return c;
    },
    "categories.update": async ({ id, ...patch }) => {
      const c = await store.categories.update(id, patch);
      if (!c) throw new RpcError("NOT_FOUND", `Category ${id} not found`);
      b.server.emit("categories", await store.categories.list());
      return c;
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
      // the membership commit is the long part: don't add it to the turn that parsed 5,000 ids
      await b.platform.yield();
      // memberships move in one transaction (every other category left); the training follows in slices (journaled)
      const r = await store.categories.beginMove({ to, threadIds, addedBy: ctx.origin === "mcp" ? "agent" : ADDED_BY[source], now: b.now(), source });
      b.categorizer.apply(r.deltas);
      b.notifyChanged([...new Set([...r.added, ...r.moved])]);
      await b.finishMove(r.batchId);
      return { added: r.added.length, addedIds: r.added, batchId: r.batchId, moved: r.moved };
    },
    "categories.addScope": async ({ categoryId, scope, jobId }) => {
      await requireCategory(categoryId);
      const { ids, capped } = await resolveThreadScope(b, scope);
      if (capped) throw new RpcError("BAD_REQUEST", "Demasiadas conversaciones: acota la vista o la búsqueda");
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
        // memberships and decisions come back in one transaction; examples follow in slices
        await b.finishMove(batchId);
        const r = await store.categories.undoMoveCommit(batchId, b.now());
        b.categorizer.apply(r.deltas);
        b.notifyChanged([...new Set([...r.removed, ...r.restored])]);
        await b.finishMove(batchId);
        return { removed: r.removed.length, restored: r.restored.length };
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

    "counts.get": () => store.threads.counts(),

    "filters.list": () => store.filters.list(),
    "filters.save": (p) => store.filters.save(p, b.now()),
    "filters.delete": async ({ id }) => {
      await store.filters.delete(id);
      return { ok: true as const };
    },
    "filters.preview": ({ rule, limit }) => store.filters.preview(rule, b.now(), limit),
    "filters.apply": async ({ id }) => {
      const filter = await store.filters.get(id);
      if (!filter) throw new RpcError("NOT_FOUND", `Filter ${id} not found`);
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
    "learning.accept": async ({ key }) => {
      const proposal = proposeLearnedFilters(await store.learning.actionsSince(b.now() - 60 * 86_400_000), { now: b.now() }).find((p) => p.key === key);
      if (!proposal) throw new RpcError("NOT_FOUND", "That suggestion is no longer available");
      const verb = { archive: "Archivar", trash: "Borrar", spam: "Spam" }[proposal.action];
      return store.filters.save({ name: `${verb}: ${proposal.value}`, enabled: true, source: "learned", rule: proposal.rule, learnedKey: key }, b.now());
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
        inReplyToMessageId: p.inReplyToMessageId,
        draftId: p.draftId,
        recordReply: ctx.origin === "renderer",
        now: b.now(),
      });
      b.categorizer.apply(deltas);
      b.notifyChanged([threadId]);
      b.kickWorker();
      return { opId, threadId };
    },

    "drafts.save": async (p) => toDraft(await store.drafts.save(p, b.now())),
    "drafts.list": async () => (await store.drafts.list()).map(toDraft),
    "drafts.delete": async ({ id }) => {
      await store.drafts.delete(id);
      return { ok: true as const };
    },

    "accounts.addImap": async (p) => {
      if (!b.host.capabilities.imap) throw new RpcError("UNAVAILABLE", "IMAP/SMTP needs the desktop app.");
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
          throw new RpcError("BAD_REQUEST", `Could not connect: ${error instanceof Error ? error.message : String(error)}`);
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
      b.startAccount(account);
      return account;
    },

    "accounts.connectGmail": async () => {
      const settings = await readSettings(store);
      if (!settings.gmailClientId) {
        throw new RpcError("BAD_REQUEST", "Add your Google OAuth client ID in Settings → Accounts first.");
      }
      if (!b.options.openExternal) throw new RpcError("UNAVAILABLE", "Gmail sign-in needs the desktop app.");
      const result = await b.options.providers.connectGmail({
        clientId: settings.gmailClientId,
        clientSecret: await b.getSecret("gmailClientSecret"),
        openExternal: b.options.openExternal,
        signal: b.abort.signal,
        fetch: b.net.fetchFor("mail"),
      });
      const existing = (await store.accounts.list()).find((a) => a.email === result.email.toLowerCase());
      if (existing) throw new RpcError("BAD_REQUEST", `${result.email} is already connected.`);
      const config: GmailAccountConfig = { senderName: result.name || result.email };
      const blob = await b.options.cipher.encrypt(result.refreshToken);
      const { account, claimed } = await store.accounts.create({
        kind: "gmail",
        email: result.email,
        displayName: result.email.split("@")[0]!,
        color: await nextAccountColor(),
        providerConfig: config,
        secret: { key: "refreshToken", blob },
        ownerClaim: b.canClaimOwner() ? gmailClaim({ ...result, name: result.name || result.email }) : undefined,
        now: b.now(),
      });
      await b.emitAccounts();
      if (claimed) await b.emitOwner();
      b.startAccount(account);
      return account;
    },

    "accounts.connectGmailToken": async ({ accessToken, expiresIn }) => {
      const tokens = b.options.providers.gmailTokens;
      if (!tokens) throw new RpcError("UNAVAILABLE", "This host connects Gmail with accounts.connectGmail.");
      const who = await tokens.inspect(accessToken, b.net.fetchFor("mail")).catch((error: unknown) => {
        throw new RpcError("BAD_REQUEST", error instanceof Error ? error.message : String(error));
      });
      const expiresAt = b.now() + expiresIn * 1000;
      const existing = (await store.accounts.list()).find((a) => a.email === who.email.toLowerCase());
      if (existing) {
        if (existing.kind !== "gmail") throw new RpcError("BAD_REQUEST", `${who.email} is already connected over IMAP.`);
        // reconnect: the same mailbox gets a fresh token and syncs what it missed
        tokens.set(existing.id, accessToken, expiresAt);
        await b.resumeAuth(existing.id);
        void b.syncAccount(existing.id);
        return existing;
      }
      const config: GmailAccountConfig = { senderName: who.name || who.email };
      const { account, claimed } = await store.accounts.create({
        kind: "gmail",
        email: who.email,
        displayName: who.email.split("@")[0]!,
        color: await nextAccountColor(),
        providerConfig: config,
        ownerClaim: b.canClaimOwner() ? gmailClaim({ ...who, name: who.name || who.email }) : undefined,
        now: b.now(),
      });
      tokens.set(account.id, accessToken, expiresAt);
      await b.emitAccounts();
      if (claimed) await b.emitOwner();
      b.startAccount(account);
      return account;
    },

    "accounts.update": async ({ id, ...patch }) => {
      const account = await store.accounts.update(id, patch);
      if (!account) throw new RpcError("NOT_FOUND", "Account not found");
      await b.emitAccounts();
      return account;
    },

    "accounts.remove": async ({ id }) => {
      const wasOwner = (await store.owner.get())?.accountId === id;
      await b.dropAccount(id);
      // the owner row survives: its account_id is cleared (ON DELETE SET NULL)
      await store.accounts.remove(id);
      await b.emitAccounts();
      if (wasOwner) await b.emitOwner();
      b.notifyChanged([]);
      return { ok: true as const };
    },

    "settings.update": async (patch) => {
      const endpoint = patch.ai?.baseURL ?? (await readSettings(store)).ai.profiles.compatible?.baseURL;
      const endpointIsLocal = endpoint ? await b.net.isLoopbackEndpoint(endpoint) : false;
      try {
        const wasLocal = (await readSettings(store)).localMode;
        const next = await updateSettings(store, patch, { endpointIsLocal });
        if (next.localMode !== wasLocal) await b.publishPolicy();
        return next;
      } catch (error) {
        if (error instanceof SettingsError) throw new RpcError("BAD_REQUEST", error.message);
        throw error;
      }
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

    "identity.get": () => store.owner.get(),
    "identity.changeOwner": ({ accountId, password }) => changeOwnerTo(b, accountId, password),

    "ops.list": async () => (await store.ops.recent(100)).map((op) => b.opInfo(op)),
    "ops.resolveUnknown": async ({ opId, resolution }) => {
      const r = await store.ops.resolveUnknown(opId, resolution, b.now());
      if (resolution === "retry") b.kickWorker();
      if (r.touched.length) b.notifyChanged(r.touched);
      return { ok: true as const };
    },

    "sync.now": async ({ accountId }) => {
      const ids = accountId ? [accountId] : (await store.accounts.list()).map((a) => a.id);
      for (const id of ids) void b.syncAccount(id);
      return { ok: true as const };
    },
  };
}
