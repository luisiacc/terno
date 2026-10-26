import { localized } from "~/lib/i18n";
import { t } from "@terno/i18n";
import type { DesignId } from "@terno/core";
import { flushAllDrafts, loadDrafts } from "~/lib/drafts";
import { client, connectBackend } from "~/rpc/connection";
import { removeFromCategory } from "~/lib/categorize";
import { getApp, navigate, setApp, setCategories } from "~/state/app";
import { refreshList, reloadList, useList } from "~/state/list";
import { bootPage, installPage, listCovered, readerShown } from "~/lib/page";
import { invalidateThreads, loadThread, useThreads } from "~/state/threads";
import { snack } from "~/lib/snack";
import { applyAppearance, installAppearanceListeners, reconcileSettings, updateAppearance } from "~/lib/appearance";
import { exposeForTests, regressions } from "~/lib/render-probe";
import { captureUi } from "~/lib/diag";
import { startDiag } from "~/state/diag";
import { setBridgeForTests, startUpdates } from "~/lib/updates";
import { supportedFilters } from "~/lib/unread-filter";

export async function boot(): Promise<void> {
  startDiag();
  try {
    await connectBackend();
    const b = await client.call("app.bootstrap", {});
    applyAppearance(reconcileSettings(b.settings));
    setApp({ ready: true, accounts: b.accounts, categories: b.categories, counts: b.counts, settings: b.settings, owner: b.owner, demo: b.demo, version: b.version, host: b.host, supportedFilters: supportedFilters(b.filters) });
    installAppearanceListeners();
    // every stored draft comes back: replies onto their conversations, new ones to the drafts strip
    void loadDrafts().catch((error) => console.warn("[drafts] could not load", error));
    // best effort when the page goes away (the autosave pause may not have ended)
    window.addEventListener("pagehide", () => void flushAllDrafts());
    // desktop: before any quit or update, main waits (5 s at most) until what is written is saved
    window.ternoDesktop?.onFlushDrafts?.(() => flushAllDrafts(4000));
    // desktop: main pushes the update state (nothing is checked here)
    startUpdates();
    exposeForTests({
      regressions,
      updateAppearance,
      getApp,
      loadedIds: () => useList.getState().items.map((t) => t.id),
      // the reader specs wait on what the cache holds (a refetch that changes nothing on screen)
      threadDetail: (id: number) => useThreads.getState().details.get(id),
      updatesBridge: setBridgeForTests,
      // the perf gate times the switch itself (no save, no font wait)
      setDesign: (design: DesignId) => {
        const settings = { ...getApp().settings!, design };
        setApp({ settings });
        applyAppearance(settings);
      },
    });

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
    client.on("counts", (counts) => setApp({ counts }));
    client.on("accounts", (accounts) => setApp({ accounts }));
    client.on("categories", (categories) => setCategories(categories));
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
    client.on("op", (op) => {
      if (op.kind === "send" && op.state === "succeeded") {
        if (op.lastError) snack.warning(t("actions.send.partial"), { description: localized(op.lastError, op.lastErrorI18n), duration: 12_000, background: true });
        else snack.success(t("actions.send.sent"), { background: true });
      }
      if (op.state === "unknown") snack.warning(t("actions.send.unknown", { summary: localized(op.summary, op.summaryI18n) }), { description: t("actions.send.unknownHint"), duration: 10_000, background: true });
      if (op.state === "failed") snack.error(t("actions.send.failed", { summary: localized(op.summary, op.summaryI18n) }), { description: localized(op.lastError, op.lastErrorI18n) ?? undefined, background: true });
    });
    // plan 24: history and pages; a reload on a conversation (List) reopens it before the list's first answer can pick row 0
    installPage();
    const reopened = bootPage();
    await reloadList({ keepSelection: reopened !== null });
  } catch (error) {
    captureUi(error, { code: "boot.failed" });
    setApp({ fatal: error instanceof Error ? error.message : String(error) });
  }
}
