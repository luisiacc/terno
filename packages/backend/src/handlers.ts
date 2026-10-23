import { RpcError, type Handlers } from "@unica/core/rpc";
import { proposeLearnedFilters, type Address } from "@unica/core";
import {
  addToCategory,
  applyThreadAction,
  autoReasons,
  categoryStats,
  COUNT_CAP,
  countScope,
  pendingSuggestions,
  predictThread,
  quickActions,
  rejectSuggestion,
  resolveScope,
  type AddedBy,
  createBatch,
  finishBatch,
  removeFromCategory,
  batchThreads,
  finishUndo,
  undoBatchPart,
  beginMove,
  isMoveBatch,
  undoMoveCommit,
  claimFilterApplications,
  claimOwner,
  completeOp,
  createAccount,
  createCategory,
  deleteCategory,
  deleteMessages,
  deleteDraft,
  deleteFilter,
  dismissedKeys,
  dismissSuggestion,
  enqueueOp,
  findRuleMatches,
  getAccount,
  getAccountConfig,
  getCounts,
  getFilter,
  getOp,
  getOwner,
  getSummaries,
  getThread,
  ingestMessages,
  learnedFilterKeys,
  listAccounts,
  listCategories,
  listDrafts,
  listFilters,
  listRecentOps,
  listThreads,
  loadUserActions,
  putSecret,
  recordUserActions,
  removeAccount,
  saveDraft,
  saveFilter,
  searchIsComplete,
  searchThreads,
  updateAccount,
  updateCategory,
  type DraftRow,
} from "@unica/db";
import type { GmailAccountConfig, ImapAccountConfig, SendPayload } from "@unica/mail";
import { Backend } from "./backend";
import { changeOwnerTo, gmailClaim, imapClaim } from "./identity";
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
  const db = () => b.db;
  const requireCategory = (id: number) => {
    if (!db().get("SELECT 1 FROM categories WHERE id = ?", id)) throw new RpcError("NOT_FOUND", `Category ${id} not found`);
  };
  /** Small sets in one go (same tick), large ones through the backend's slicer. */
  const sliced = async <T,>(items: T[], work: (chunk: T[]) => void) => {
    if (items.length <= SLICE_ABOVE) work(items);
    else await b.runSliced(items, 100, work);
  };
  /**
   * The one store command behind every UI way of filing threads; returns
   * what changed for undo. Above SLICE_ABOVE ids it runs in time slices (one
   * batch, several transactions) so interactive RPCs keep flowing.
   */
  const fileThreads = async (categoryId: number, threadIds: readonly number[], addedBy: AddedBy, source: string) => {
    requireCategory(categoryId);
    const batchId = createBatch(db(), categoryId, source, { kind: "threads" }, b.now());
    const added: number[] = [];
    await sliced([...new Set(threadIds)], (chunk) => {
      const r = db().tx(() => {
        const r = addToCategory(db(), { categoryId, threadIds: chunk, addedBy, now: b.now(), batchId });
        finishBatch(db(), batchId, r.added.length);
        return r;
      });
      b.categorizer.apply(r.deltas);
      added.push(...r.added);
      b.notifyChanged(chunk);
    });
    return { added: added.length, addedIds: added, batchId: added.length ? batchId : null };
  };
  const nextAccountColor = () => ACCOUNT_COLORS[listAccounts(db()).length % ACCOUNT_COLORS.length]!;

  return {
    "app.bootstrap": (_p, ctx) => ({
      accounts: listAccounts(db()),
      categories: listCategories(db()),
      counts: getCounts(db()),
      settings: readSettings(db()),
      // agents get the mailboxes, not the person's identity
      owner: ctx.origin === "mcp" ? null : getOwner(db()),
      demo: b.demo,
      version: b.options.version,
    }),

    "threads.list": (p) => listThreads(db(), p),

    "threads.search": async (p, ctx) => {
      // Latest-wins per client: a query superseded while queued is not executed.
      const seq = (b.searchSeq.get(ctx.clientId) ?? 0) + 1;
      b.searchSeq.set(ctx.clientId, seq);
      await b.platform.yield();
      if (b.searchSeq.get(ctx.clientId) !== seq) throw new RpcError("CANCELLED", "Superseded by a newer search");
      const started = performance.now();
      const result = searchThreads(db(), { ...p, now: b.now() });
      return { ...result, tookMs: performance.now() - started, complete: searchIsComplete(db()) };
    },

    "threads.get": ({ threadId }) => {
      const thread = getThread(db(), threadId);
      if (!thread) throw new RpcError("NOT_FOUND", `Thread ${threadId} not found`);
      const suggestions = pendingSuggestions(db(), { threadId, limit: 5 }).map((s) => ({ categoryId: s.categoryId, p: s.p, reasons: s.reasons }));
      return { ...thread, categorization: { auto: autoReasons(db(), threadId), suggestions } };
    },

    "threads.act": ({ threadIds, action }, ctx) => {
      const result = db().tx(() => {
        const r = applyThreadAction(db(), [...new Set(threadIds)], action);
        const signal = Backend.learningSignal(action);
        // only explicit renderer actions that actually changed something feed learned filters
        // (re-archiving an archived thread or repeating ids must not manufacture support)
        if (signal && ctx.origin === "renderer" && r.threadIds.length) recordUserActions(db(), r.threadIds, signal, b.now());
        b.queueActionOps(r, action);
        return r;
      });
      b.notifyChanged(result.threadIds);
      return { affected: result.threadIds.length };
    },

    "categories.create": ({ name, color }) => {
      const c = createCategory(db(), name, color);
      b.server.emit("categories", listCategories(db()));
      return c;
    },
    "categories.update": ({ id, ...patch }) => {
      const c = updateCategory(db(), id, patch);
      if (!c) throw new RpcError("NOT_FOUND", `Category ${id} not found`);
      b.server.emit("categories", listCategories(db()));
      return c;
    },
    "categories.delete": ({ id }) => {
      deleteCategory(db(), id);
      b.categorizer.dropCategory(id);
      b.server.emit("categories", listCategories(db()));
      b.notifyChanged([]);
      return { ok: true as const };
    },
    "categories.addThreads": ({ categoryId, threadIds, source }, ctx) => fileThreads(categoryId, threadIds, ctx.origin === "mcp" ? "agent" : ADDED_BY[source], source),
    "categories.moveThreads": async ({ from, to, threadIds, source }, ctx) => {
      requireCategory(from);
      requireCategory(to);
      // memberships move in one transaction; the training follows in slices (journaled)
      const r = beginMove(db(), { from, to, threadIds, addedBy: ctx.origin === "mcp" ? "agent" : ADDED_BY[source], now: b.now(), source });
      b.categorizer.apply(r.deltas);
      b.notifyChanged([...new Set([...r.added, ...r.moved])]);
      await b.finishMove(r.batchId);
      return { added: r.added.length, addedIds: r.added, batchId: r.batchId, moved: r.moved };
    },
    "categories.removeThreads": async ({ categoryId, threadIds, reason }) => {
      let removed = 0;
      await sliced([...new Set(threadIds)], (chunk) => {
        const r = removeFromCategory(db(), { categoryId, threadIds: chunk, reason, now: b.now() });
        b.categorizer.apply(r.deltas);
        removed += r.removed.length;
        b.notifyChanged(chunk);
      });
      return { removed };
    },
    "categorize.quickActions": ({ categoryId, threadIds }) => {
      requireCategory(categoryId);
      return quickActions(db(), categoryId, threadIds, b.categorizer.model);
    },
    "categorize.count": ({ categoryId, scope }) => countScope(db(), categoryId, scope, b.now()),
    "categorize.preview": ({ categoryId, scope, limit }) => {
      const ids = resolveScope(db(), categoryId, scope, b.now(), COUNT_CAP + 1);
      return { count: Math.min(ids.length, COUNT_CAP), capped: ids.length > COUNT_CAP, sample: getSummaries(db(), ids.slice(0, limit)) };
    },
    "categorize.apply": async ({ categoryId, scope }, ctx) => {
      requireCategory(categoryId);
      // the set is fixed here, once: filing changes the scope's own "not yet in the category" predicate
      const ids = resolveScope(db(), categoryId, scope, b.now());
      const batchId = createBatch(db(), categoryId, "snackbar", scope, b.now());
      const addedBy = ctx.origin === "mcp" ? "agent" : "bulk";
      let added = 0;
      await b.runSliced(ids, 100, (chunk) => {
        const r = db().tx(() => {
          const r = addToCategory(db(), { categoryId, threadIds: chunk, addedBy, now: b.now(), batchId });
          finishBatch(db(), batchId, r.added.length);
          return r;
        });
        b.categorizer.apply(r.deltas);
        added += r.added.length;
        b.notifyChanged(r.added);
      });
      return { batchId: added ? batchId : null, added };
    },
    "categorize.predict": ({ threadId }) => {
      const model = b.categorizer.model;
      return model ? predictThread(db(), threadId, model, readAutoCategorize(db()), b.now()) : [];
    },
    "categorize.suggestions": ({ categoryId, limit }) => {
      const pending = pendingSuggestions(db(), { categoryId, limit });
      const summaries = new Map(getSummaries(db(), [...new Set(pending.map((s) => s.threadId))]).map((t) => [t.id, t]));
      return {
        items: pending.flatMap((s) => {
          const t = summaries.get(s.threadId);
          return t ? [{ ...t, prediction: { categoryId: s.categoryId, p: s.p, decision: "suggest" as const, reasons: s.reasons } }] : [];
        }),
      };
    },
    "categorize.feedback": async ({ threadId, categoryId, verdict }) => {
      requireCategory(categoryId);
      if (verdict === "accept") {
        await fileThreads(categoryId, [threadId], "suggestion", "suggestion");
        return { ok: true as const };
      }
      b.categorizer.apply(rejectSuggestion(db(), threadId, categoryId, b.now()));
      b.notifyChanged([threadId]);
      return { ok: true as const };
    },
    "categorize.stats": () => categoryStats(db()),
    "categorize.undo": async ({ batchId }) => {
      if (isMoveBatch(db(), batchId)) {
        // memberships and decisions come back in one transaction; examples follow in slices
        await b.finishMove(batchId);
        const r = undoMoveCommit(db(), batchId, b.now());
        b.categorizer.apply(r.deltas);
        b.notifyChanged([...new Set([...r.removed, ...r.restored])]);
        await b.finishMove(batchId);
        return { removed: r.removed.length, restored: r.restored.length };
      }
      let removed = 0;
      await sliced(batchThreads(db(), batchId), (chunk) => {
        const r = undoBatchPart(db(), batchId, chunk, b.now());
        b.categorizer.apply(r.deltas);
        removed += r.removed.length;
        b.notifyChanged(r.removed);
      });
      finishUndo(db(), batchId, b.now());
      return { removed };
    },

    "counts.get": () => getCounts(db()),

    "filters.list": () => listFilters(db()),
    "filters.save": (p) => saveFilter(db(), p, b.now()),
    "filters.delete": ({ id }) => {
      deleteFilter(db(), id);
      return { ok: true as const };
    },
    "filters.preview": ({ rule, limit }) => {
      const matches = findRuleMatches(db(), rule, b.now());
      const top = db()
        .all<{ id: number }>(
          "SELECT id FROM threads WHERE id IN (SELECT value FROM json_each(?)) ORDER BY last_date DESC, id DESC LIMIT ?",
          JSON.stringify(matches.threadIds),
          limit,
        )
        .map((r) => r.id);
      return { count: matches.threadIds.length, sample: getSummaries(db(), top) };
    },
    "filters.apply": async ({ id }) => {
      const filter = getFilter(db(), id);
      if (!filter) throw new RpcError("NOT_FOUND", `Filter ${id} not found`);
      // match in id windows, yielding between them: no single long synchronous scan
      const bounds = db().get<{ lo: number | null; hi: number | null }>("SELECT min(id) AS lo, max(id) AS hi FROM messages")!;
      const matched: number[] = [];
      for (let from = bounds.lo ?? 1; bounds.hi !== null && from <= bounds.hi; from += 4000) {
        matched.push(...findRuleMatches(db(), filter.rule, b.now(), undefined, { from, to: from + 3999 }).messageIds);
        await b.platform.yield();
      }
      const matches = { messageIds: matched };
      const touched = new Set<number>();
      let applied = 0;
      // time-sliced so a huge bulk apply doesn't freeze list/search
      const capturedRule = JSON.stringify(filter.rule);
      await b.runSliced(matches.messageIds, 20, (chunk) => {
        db().tx(() => {
          // edited (or deleted) while we were applying it: stop, don't recreate stale claims
          const current = db().get<{ rule_json: string }>("SELECT rule_json FROM filters WHERE id = ?", id);
          if (!current || current.rule_json !== capturedRule) throw new RpcError("CANCELLED", "The filter changed while it was being applied");
          const ids = claimFilterApplications(db(), id, chunk, b.now());
          for (const t of b.runFilterActions(filter.rule.actions, ids)) touched.add(t);
          applied += ids.length;
        });
      });
      b.notifyChanged(touched);
      return { matchedMessages: applied, affectedThreads: touched.size };
    },
    "filters.generate": ({ prompt }, ctx) => b.aiService.generateFilter(prompt, ctx.clientId),

    "learning.proposals": () =>
      proposeLearnedFilters(loadUserActions(db(), b.now() - 60 * 86_400_000), {
        now: b.now(),
        excludedKeys: new Set([...dismissedKeys(db()), ...learnedFilterKeys(db())]),
      }),
    "learning.accept": ({ key }) => {
      const proposal = proposeLearnedFilters(loadUserActions(db(), b.now() - 60 * 86_400_000), { now: b.now() }).find(
        (p) => p.key === key,
      );
      if (!proposal) throw new RpcError("NOT_FOUND", "That suggestion is no longer available");
      const verb = { archive: "Archivar", trash: "Borrar", spam: "Spam" }[proposal.action];
      return saveFilter(db(), { name: `${verb}: ${proposal.value}`, enabled: true, source: "learned", rule: proposal.rule, learnedKey: key }, b.now());
    },
    "learning.dismiss": ({ key }) => {
      dismissSuggestion(db(), key, b.now());
      return { ok: true as const };
    },

    "compose.send": (p, ctx) => {
      const account = getAccount(db(), p.accountId);
      if (!account) throw new RpcError("NOT_FOUND", "Account not found");
      const cfg = getAccountConfig<{ senderName?: string }>(db(), p.accountId)!;
      const from: Address = { name: cfg.config.senderName || account.displayName, email: account.email };
      let inReplyTo: string | null = null;
      let references: string[] = [];
      let providerThreadId: string | null = null;
      let replyThreadId: number | null = null;
      if (p.inReplyToMessageId) {
        const original = db().get<{ rfc_message_id: string | null; references_json: string; thread_id: number; account_id: number }>(
          "SELECT rfc_message_id, references_json, thread_id, account_id FROM messages WHERE id = ?",
          p.inReplyToMessageId,
        );
        if (!original) throw new RpcError("NOT_FOUND", "Original message not found");
        inReplyTo = original.rfc_message_id;
        references = [...(JSON.parse(original.references_json) as string[]), ...(original.rfc_message_id ? [original.rfc_message_id] : [])];
        replyThreadId = original.thread_id;
        if (original.account_id === p.accountId) {
          providerThreadId = db().get<{ provider_thread_id: string | null }>("SELECT provider_thread_id FROM threads WHERE id = ?", original.thread_id)!
            .provider_thread_id;
        }
      }
      const messageId = b.newMessageId(account.email);
      const payload: SendPayload = {
        from,
        to: p.to,
        cc: p.cc,
        bcc: p.bcc,
        subject: p.subject,
        text: p.bodyText,
        messageId,
        inReplyTo,
        references,
        providerThreadId,
      };
      // Optimistic local copy + durable send op, atomically: a crash can't lose or duplicate the send.
      const { opId, threadId, deltas } = db().tx(() => {
        const localKey = `local:${messageId}`;
        const ingest = ingestMessages(
          db(),
          [
            {
              accountId: p.accountId,
              providerMsgId: localKey,
              providerThreadId,
              rfcMessageId: messageId,
              inReplyTo,
              references,
              from,
              to: p.to,
              cc: p.cc,
              bcc: p.bcc,
              subject: p.subject,
              date: b.now(),
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
          b.now(),
        );
        const localId = ingest.inserted[0]!;
        const opId = enqueueOp(db(), { accountId: p.accountId, kind: "send", target: { messageIds: [localId] }, payload }, b.now())!;
        if (p.draftId) deleteDraft(db(), p.draftId);
        if (replyThreadId && ctx.origin === "renderer") recordUserActions(db(), [replyThreadId], "reply", b.now());
        const threadId = db().get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE id = ?", localId)!.thread_id;
        return { opId, threadId, deltas: ingest.deltas };
      });
      b.categorizer.apply(deltas);
      b.notifyChanged([threadId]);
      b.kickWorker();
      return { opId, threadId };
    },

    "drafts.save": (p) => toDraft(saveDraft(db(), p, b.now())),
    "drafts.list": () => listDrafts(db()).map(toDraft),
    "drafts.delete": ({ id }) => {
      deleteDraft(db(), id);
      return { ok: true as const };
    },

    "accounts.addImap": async (p) => {
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
      const { account, claimed } = db().tx(() => {
        const account = createAccount(
          db(),
          { kind: "imap", email: p.email, displayName: p.displayName || p.email, color: nextAccountColor(), providerConfig: config },
          b.now(),
        );
        putSecret(db(), `account:${account.id}:password`, blob);
        return { account, claimed: claim && claimOwner(db(), imapClaim(account, config, p.displayName || p.email), b.now()) };
      });
      b.emitAccounts();
      if (claimed) b.emitOwner();
      b.startAccount(account);
      return account;
    },

    "accounts.connectGmail": async () => {
      const settings = readSettings(db());
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
      const existing = listAccounts(db()).find((a) => a.email === result.email.toLowerCase());
      if (existing) throw new RpcError("BAD_REQUEST", `${result.email} is already connected.`);
      const config: GmailAccountConfig = { senderName: result.name || result.email };
      const blob = await b.options.cipher.encrypt(result.refreshToken);
      const { account, claimed } = db().tx(() => {
        const account = createAccount(
          db(),
          { kind: "gmail", email: result.email, displayName: result.email.split("@")[0]!, color: nextAccountColor(), providerConfig: config },
          b.now(),
        );
        putSecret(db(), `account:${account.id}:refreshToken`, blob);
        return { account, claimed: b.canClaimOwner() && claimOwner(db(), gmailClaim(account, { ...result, name: result.name || result.email }), b.now()) };
      });
      b.emitAccounts();
      if (claimed) b.emitOwner();
      b.startAccount(account);
      return account;
    },

    "accounts.update": ({ id, ...patch }) => {
      const account = updateAccount(db(), id, patch);
      if (!account) throw new RpcError("NOT_FOUND", "Account not found");
      b.emitAccounts();
      return account;
    },

    "accounts.remove": async ({ id }) => {
      const wasOwner = getOwner(db())?.accountId === id;
      await b.dropAccount(id);
      // the owner row survives: its account_id is cleared (ON DELETE SET NULL)
      removeAccount(db(), id);
      db().run("DELETE FROM secrets WHERE name LIKE ?", `account:${id}:%`);
      b.emitAccounts();
      if (wasOwner) b.emitOwner();
      b.notifyChanged([]);
      return { ok: true as const };
    },

    "settings.update": async (patch) => {
      const endpoint = patch.ai?.baseURL ?? readSettings(db()).ai.profiles.compatible?.baseURL;
      const endpointIsLocal = endpoint ? await b.net.isLoopbackEndpoint(endpoint) : false;
      try {
        const wasLocal = readSettings(db()).localMode;
        const next = updateSettings(db(), patch, { endpointIsLocal });
        if (next.localMode !== wasLocal) b.publishPolicy();
        return next;
      } catch (error) {
        if (error instanceof SettingsError) throw new RpcError("BAD_REQUEST", error.message);
        throw error;
      }
    },
    "settings.setSecret": async ({ name, value }) => {
      if (value) await b.setSecret(name, value);
      else db().run("DELETE FROM secrets WHERE name = ?", name);
      return { ok: true as const };
    },

    "ai.providers": () => b.aiService.providers(),
    "ai.listModels": ({ provider, baseURL, preset }) => b.aiService.listModels({ provider, baseURL, preset }),
    "ai.test": ({ provider, model, baseURL, preset }) => b.aiService.test({ provider, model, baseURL, preset }),
    "ai.setKey": ({ provider, preset, value }) => b.aiService.setKey(provider, preset, value),

    "identity.get": () => getOwner(db()),
    "identity.changeOwner": ({ accountId, password }) => changeOwnerTo(b, accountId, password),

    "ops.list": () => listRecentOps(db()).map((op) => b.opInfo(op)),
    "ops.resolveUnknown": ({ opId, resolution }) => {
      const op = getOp(db(), opId);
      if (!op || op.state !== "unknown") throw new RpcError("NOT_FOUND", "No unresolved operation with that id");
      if (resolution === "markSent") completeOp(db(), opId, b.now());
      else if (resolution === "retry") {
        db().run("UPDATE ops SET state = 'queued', next_attempt_at = 0, last_error = NULL WHERE id = ?", opId);
        b.kickWorker();
      } else {
        db().tx(() => {
          db().run("UPDATE ops SET state = 'failed', last_error = 'Discarded by user' WHERE id = ?", opId);
          const target = JSON.parse(op.target_json) as { messageIds?: number[] };
          if (op.kind === "send" && target.messageIds?.length) {
            const local = db().get<{ id: number }>("SELECT id FROM messages WHERE id = ? AND provider_msg_id LIKE 'local:%'", target.messageIds[0]!);
            // deleteMessages recomputes (or deletes) the thread so no empty Sent entry remains
            if (local) b.notifyChanged(deleteMessages(db(), [local.id]));
          }
        });
      }
      return { ok: true as const };
    },

    "sync.now": async ({ accountId }) => {
      const ids = accountId ? [accountId] : listAccounts(db()).map((a) => a.id);
      for (const id of ids) void b.syncAccount(id);
      return { ok: true as const };
    },
  };
}
