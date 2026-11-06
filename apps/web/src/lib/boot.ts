import { installSendWarnings } from "./send-warning";
import { reconcileAccounts, rememberFocus, restoredFocus } from "~/lib/account-folders";
import { setSyncProgress } from "~/state/sync-progress";
import { localized } from "~/lib/i18n";
import { t } from "@terno/i18n";
import type { DesignId } from "@terno/core";
import { acquireDraftHold, trackDraftComposition, draftsSaved, flushAllDrafts, loadDrafts } from "~/lib/drafts";
import { installQueryRecovery } from "~/rpc/reconnect";
import { client, connectBackend } from "~/rpc/connection";
import { removeFromCategory } from "~/lib/categorize";
import { getApp, navigate, setAccounts, setApp, setCategories, setFolders } from "~/state/app";
import { refreshList, reloadList, useList } from "~/state/list";
import { bootPage, installPage, listCovered, readerShown } from "~/lib/page";
import { invalidateThreads, loadThread, useThreads } from "~/state/threads";
import { snack } from "~/lib/snack";
import { applyAppearance, installAppearanceListeners, reconcileSettings, updateAppearance } from "~/lib/appearance";
import { exposeForTests, regressions } from "~/lib/render-probe";
import { captureUi } from "~/lib/diag";
import { startDiag } from "~/state/diag";
import { setMailboxBridgeForTests } from "~/lib/mailbox";
import { setBridgeForTests, startUpdates } from "~/lib/updates";
import { supportedFilters } from "~/lib/unread-filter";
import { accountsChanged, announceParkedSend } from "~/lib/sign-in";
import { withPendingEdits } from "~/lib/accounts";
import { acceptNextFavorites, applyFavoriteFolders, applyFolderRenames } from "~/lib/folders";
import { installNativeReload } from "~/lib/native-reload";
import { openFromNotice, startAttention } from "~/lib/notify";
import { applyFollowups, loadFollowups } from "~/lib/followups";
import { applyReminders, loadReminders } from "~/lib/reminders";
import { snippetsSaved } from "~/lib/snippets";
import { applyForwards, loadForwards, shareLocale } from "~/lib/forwards";
import { summaryReady } from "~/lib/summaries";
import { loadDraftingEnabled } from "~/lib/ai-draft-state";
import { applyScheduled, loadScheduled } from "~/lib/scheduled";

export async function boot(): Promise<void> {
  startDiag();
  trackDraftComposition();
  installNativeReload();
  // Registered before readiness: an update cannot miss a document still starting.
  // plan 93: snippets an editor hasn't saved yet go too
  window.ternoDesktop?.onFlushDrafts?.(async () => (await Promise.all([draftsSaved(4000), snippetsSaved(4000)])).every(Boolean), acquireDraftHold);
  try {
    await connectBackend();
    const b = await client.call("app.bootstrap", {});
    applyAppearance(reconcileSettings(b.settings));
    acceptNextFavorites();
    setApp({ ready: true, accounts: b.accounts, categories: b.categories, folders: b.folders ?? [], counts: b.counts, settings: b.settings, owner: b.owner, demo: b.demo, version: b.version, host: b.host, supportedFilters: supportedFilters(b.filters), ...restoredFocus(b.accounts) });
    // plan 108: focus on an account is remembered however it changes (the menu, the back arrow, leaving for another)
    rememberFocus();
    // a remembered open account that's no longer there (plan 67)
    reconcileAccounts(b.accounts);
    installAppearanceListeners();
    // every stored draft comes back: replies onto their conversations, new ones to the drafts strip
    void loadDrafts().catch((error) => console.warn("[drafts] could not load", error));
    // best effort when the page goes away (the autosave pause may not have ended)
    window.addEventListener("pagehide", () => {
      void flushAllDrafts();
      void snippetsSaved();
    });
    // desktop: main pushes the update state (nothing is checked here)
    startUpdates();
    exposeForTests({
      regressions,
      acquireDraftHold,
      updateAppearance,
      getApp,
      // plan 108: a notification's click, as main or the page would make it
      openFromNotice,
      loadedIds: () => useList.getState().items.map((t) => t.id),
      // the reader specs wait on what the cache holds (a refetch that changes nothing on screen)
      threadDetail: (id: number) => useThreads.getState().details.get(id),
      updatesBridge: setBridgeForTests,
      mailboxBridge: setMailboxBridgeForTests,
      // the perf gate times the switch itself (no save, no font wait)
      setDesign: (design: DesignId) => {
        const settings = { ...getApp().settings!, design };
        setApp({ settings });
        applyAppearance(settings);
      },
    });

    void loadDraftingEnabled();

    let refreshQueued = false;
    client.on("changed", ({ threadIds }) => {
      invalidateThreads(threadIds);
      const selected = getApp().selectedId;
      // the conversation on screen refetches now; in List's list page the cursor is only a row (plan 24, R12)
      // (its row follows the refetched detail: loadThread)
      if (selected !== null && threadIds.includes(selected) && readerShown()) void loadThread(selected, true);
      // coalesce bursts (imports) into one refresh per frame
      if (refreshQueued) return;
      refreshQueued = true;
      requestAnimationFrame(() => {
        refreshQueued = false;
        // a page covering the list: one refresh when it shows again (plan 24, R4)
        refreshList(listCovered());
      });
    });
    installQueryRecovery({ covered: listCovered, readerShown });
    client.on("accounts", (accounts) => {
      // plan 106: a rename or color still on its way stays shown
      setAccounts(withPendingEdits(accounts));
      reconcileAccounts(accounts);
      // plan 25: an account that works again ends what was said about its sign-in
      accountsChanged(accounts);
    });
    client.on("categories", (categories) => setCategories(categories));
    // plan 103: live sync progress, for the sync card alone
    client.on("syncProgress", ({ accountId, progress }) => setSyncProgress(accountId, progress));
    // plan 107: a rename's mapping first, so the list you're in follows it before the new catalog lands
    client.on("foldersRenamed", (renamed) => applyFolderRenames(renamed));
    client.on("folders", (folders) => setFolders(folders));
    // the backend's favorites whenever it changed them (a partial delete, another window)
    client.on("favoriteFolders", applyFavoriteFolders);
    // plan 87: the reminders (bells, the sidebar's count, the Inbox's top); a failure leaves the Inbox as it is
    client.on("reminders", applyReminders);
    // plan 142: follow-ups: the Inbox's top, its row and each conversation's lines
    client.on("followups", applyFollowups);
    const followups = loadFollowups().catch((error) => console.warn("[followups] could not load", error));
    // before the first list, so the Inbox opens with its due ones on top (one local call)
    const reminders = loadReminders().catch((error) => console.warn("[reminders] could not load", error));
    // plan 94: scheduled sends (the strip, the reader's line; drafts scheduled elsewhere leave the composers)
    client.on("scheduled", applyScheduled);
    void loadScheduled().catch((error) => console.warn("[scheduled] could not load", error));
    // plan 116: forwards (the notice with Cancel, the reader's line, the cap's question)
    client.on("forwards", applyForwards);
    client.on("aiSummary", summaryReady);
    void loadForwards().catch((error) => console.warn("[forwards] could not load", error));
    shareLocale();
    client.on("owner", (owner) => setApp({ owner }));
    // drafts added elsewhere (an import, in this window or another): merged in as they are
    client.on("drafts", () => void loadDrafts());
    client.on("categorized", ({ categoryId, threadIds }) => {
      const name = getApp().categories.find((c) => c.id === categoryId)?.name;
      if (!name) return;
      snack(t("category.auto", { count: threadIds.length, category: name }), {
        id: `auto-${categoryId}`,
        duration: 8000,
        background: true,
        // undoing the engine is a correction: it learns from it
        action: { label: t("common.undo"), name: t("category.autoUndo", { category: name }), onClick: () => void removeFromCategory(categoryId, threadIds, "user") },
        secondary: { label: t("common.view"), name: t("category.view", { category: name }), onClick: () => navigate({ categoryId }) },
      });
    });
    installSendWarnings();
    client.on("op", (op) => {
      // plan 25: a send waiting for its account's sign-in says so (once per account, until it signs in)
      if (op.kind === "send" && op.awaitingAuth) {
        const account = getApp().accounts.find((a) => a.id === op.accountId);
        if (account) announceParkedSend(account);
      }
      if (op.state === "unknown") snack.warning(t("actions.send.unknown", { summary: localized(op.summary, op.summaryI18n) }), { description: t("actions.send.unknownHint"), duration: 10_000, background: true });
      if (op.state === "failed") snack.error(t("actions.send.failed", { summary: localized(op.summary, op.summaryI18n) }), { description: localized(op.lastError, op.lastErrorI18n) ?? undefined, background: true });
    });
    // plan 24: history and pages; a reload on a conversation (List) reopens it before the list's first answer can pick row 0
    installPage();
    const reopened = bootPage();
    await Promise.all([reminders, followups]);
    await reloadList({ keepSelection: reopened !== null });
    // plan 41: the badge and notifications; a click main held for this window opens now, after the first list
    startAttention();
  } catch (error) {
    captureUi(error, { code: "boot.failed" });
    setApp({ fatal: error instanceof Error ? error.message : String(error) });
  }
}
