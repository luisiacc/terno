import { t } from "@terno/i18n";
import { TooltipProvider } from "@terno/ui/components/tooltip";
import { cn } from "@terno/ui/lib/utils";
import { useEffect } from "react";
import { reviewDrafts, useDraftRecovery } from "~/lib/draft-recovery-ui";
import { useAppearance } from "~/lib/appearance";
import { usePage } from "~/lib/page";
import { useSnack } from "~/lib/snack";
import { regressions } from "~/lib/render-probe";
import { onFiled, undoFiled } from "~/lib/categorize";
import { registerUndo } from "~/lib/snack";
import { installKeyboard } from "~/lib/keyboard";
import { useApp } from "~/state/app";
import { CategoryPicker } from "./components/category-picker";
import { showCategorySnackbar } from "./components/category-snackbar";
import { CommandPalette } from "./components/command-palette";
import { DragGhost } from "./components/drag-ghost";
import { NewMessage } from "./components/new-message";
import { PinnedDraft } from "./components/pinned-draft";
import { bottomInset, usePinned } from "~/lib/pinned-draft-state";
import { installComposeFollowsSelection } from "~/lib/compose";
import { installNetworkEvents } from "~/lib/network";
import { Reader } from "./components/reader";
import { RemindDialog } from "./components/remind-dialog";
import { SelectionBar } from "./components/selection-bar";
import { SnackDock } from "./components/snack-dock";
import { Sidebar } from "./components/sidebar";
import { PaneHandle } from "./components/pane-handle";
import { skipToList, ThreadList } from "./components/thread-list";
import { EngineStopped } from "./components/diag/engine-stopped";
import { unsavedDraftWork } from "./lib/drafts";
import { startMailbox, useGateBlocks, useMailbox } from "./lib/mailbox";
import { startUpdates } from "./lib/updates";
import { useRequiredCover } from "./lib/required-cover";
import { PaneBoundary, RecoveryBoundary } from "./components/diag/error-boundary";
import { ReportPreview } from "./components/diag/report-preview";
import { RecoveryWorkspace } from "./components/diag/recovery-workspace";
import { FiltersDialog } from "./components/filters-dialog";
import { SettingsDialog } from "./components/settings-dialog";
import { AddAccountDialog } from "./components/add-account-dialog";
import { ShortcutsDialog } from "./components/shortcuts-dialog";
import { FirstRun } from "./components/first-run";
import { PrintSheet } from "./components/print-sheet";
import MailboxCover from "./components/mailbox-cover";
import { WebGate } from "~/lib/web-parts";



/** Fresh install: no mailboxes, no owner, not a demo, and the first-run steps not finished. */
function needsFirstRun(): boolean {
  return localStorage.getItem("terno:first-run") !== "done";
}

// plan 95 (desktop): what covers the window while the mailbox can't be used, or an update is required

function Covers() {
  const blocks = useGateBlocks();
  const required = useRequiredCover();
  const gate = useMailbox((s) => s.gate.kind);
  // the gate and the update state, before the mail engine connects: a mailbox that can't open never gets that far,
  // and its Update Terno needs the updater's state (Codex review R4)
  useEffect(() => {
    startMailbox();
    startUpdates();
  }, []);
  // a mailbox that can't be used never hides a draft that isn't saved: its review comes first (Codex review R7)
  useEffect(() => {
    if (blocks && gate !== "upgrading" && unsavedDraftWork()) reviewDrafts("error");
  }, [blocks, gate]);
  if (!blocks && !required) return null;
  return (
    <MailboxCover required={required} />
  );
}

function Fatal({ message }: { message: string }) {
  return (
    <div className="flex h-screen items-center justify-center bg-background p-10 text-center">
      <div>
        <p className="font-semibold">{t("app.fatal.title")}</p>
        <p className="mt-1 text-sm text-muted-foreground">{message}</p>
      </div>
    </div>
  );
}

/**
 * List's page (plan 24): the conversation or a new message, over the list,
 * which stays mounted underneath (inert, unpainted) so Back finds it exactly
 * as it was. Keyed by nothing: moving between conversations never remounts it
 * (and never animates); only coming from the list fades it in.
 */
function PageLayer({ page }: { page: "thread" | "compose" }) {
  const selectedId = useApp((s) => s.selectedId);
  // a new message keeps its foot (the format bar) clear of the dock
  const snackInset = useSnack((s) => (page === "compose" ? s.inset : 0));
  // plan 115: and of the pinned draft over it
  const pinnedInset = usePinned((s) => (page === "compose" ? s.inset : 0));
  const inset = bottomInset(snackInset, pinnedInset);
  return (
    <div data-testid="list-page" data-page={page} className="absolute inset-0 z-[5] flex flex-col bg-background animate-in fade-in-0 slide-in-from-right-1 duration-base" style={inset ? { paddingBottom: inset } : undefined}>
      <PaneBoundary area="reader" resetKey={selectedId} readerThreadId={page === "thread" ? selectedId : null}>
        {page === "compose" ? <NewMessage /> : <Reader />}
      </PaneBoundary>
    </div>
  );
}

export function App() {
  const ready = useApp((s) => s.ready);
  const fatal = useApp((s) => s.fatal);
  const dialog = useApp((s) => s.dialog);
  const fresh = useApp((s) => s.ready && s.accounts.length === 0 && !s.owner && !s.demo);
  const many = useApp((s) => s.scope !== null || s.checked.size >= 2);
  const composing = useApp((s) => s.compose !== null);
  const selectedId = useApp((s) => s.selectedId);
  const list = useAppearance((s) => s.layout) === "list";
  // keyed by draft: another pinned draft never inherits the last one's form state (revealed rows, recipient undo)
  const pinned = usePinned((s) => s.key);
  // Split: a new message keeps its foot (the format bar) clear of the pinned draft, and of the dock (plan 158: it's over this pane)
  const composeInset = bottomInset(useSnack((s) => (!list && composing ? s.inset : 0)), usePinned((s) => (!list && composing ? s.inset : 0)));
  const page = usePage();
  const covered = page !== "list";
  useEffect(() => installKeyboard(), []);
  useEffect(() => installComposeFollowsSelection(), []);
  useEffect(() => installNetworkEvents(), []);
  // every way of filing threads offers the snackbar, except its own bulk adds
  useEffect(
    () =>
      onFiled((filed, source) => {
        // z / ⌘Z, the snackbar's Deshacer and its z: one undo, run once (z still takes it back after the snackbar is gone)
        const undo = registerUndo(() => undoFiled(filed));
        if (source !== "snackbar") showCategorySnackbar(filed, undo, source);
      }),
    [],
  );

  const recovering = useDraftRecovery((s) => s.open);
  if (recovering) return <RecoveryBoundary><RecoveryWorkspace /></RecoveryBoundary>;

  const gate = WebGate && <WebGate />;
  if (fatal)
    return (
      gate ?? (
        <>
          <Fatal message={fatal} />
          <EngineStopped />
          <Covers />
        </>
      )
    );
  return (
    <TooltipProvider delay={500}>
      {gate}
      {/* plan 24: Split is three panes; List is the sidebar and one content pane (the list, or a page over it). The tree keeps its
          shape across a switch, so the list (and its scroll) survives it. */}
      <div className={cn("relative grid h-screen overflow-hidden", list ? "app-panes-list" : "app-panes")} data-ready={ready || undefined}>
        {/* plan 158: the first Tab stop, seen only then: past the sidebar, straight to the mail (while the list is what shows) */}
        {!covered && <button type="button" data-testid="skip-to-list" onClick={skipToList} className="absolute top-2 left-2 z-50 rounded-md bg-popover px-3 py-1.5 text-sm text-popover-foreground opacity-0 shadow-menu outline-none pointer-events-none focus-reveal:pointer-events-auto focus-reveal:opacity-100 focus-visible:ring-2 focus-visible:ring-ring">
          {t("list.skipTo")}
        </button>}
        <Sidebar />
        <section id="app-list" role={list ? "main" : undefined} aria-label={list ? undefined : t("list.label")} className={cn("hairline-l relative min-h-0", !list && "hairline-r hairline-strong")}>
          {/* under a page the list stays laid out (scroll, measured rows, mounted rows) but isn't painted or reachable */}
          <div
            // test builds only: the perf gate's injected regression (a list remounted by every page change) must fail it
            key={import.meta.env.VITE_RENDER_PROBE && regressions.remountList ? page : undefined}
            data-list-section
            className="h-full min-h-0 data-covered:invisible"
            inert={covered}
            data-covered={covered || undefined}
          >
            <ThreadList />
          </div>
          {list && page !== "list" && <PageLayer page={page} />}
          {/* plan 115: the pinned draft, over the list or its page, kept while other mail is read */}
          {list && pinned && <PinnedDraft key={pinned} overList={page === "list"} />}
          {/* plan 158: toasts sit over the pane that isn't being worked in: List's one pane keeps room under its rows for it */}
          {list && <SnackDock over={page === "list" ? "list" : "reader"} />}
        </section>
        {!list && (
          <main className="relative min-h-0" style={composeInset ? { paddingBottom: composeInset } : undefined}>
            {/* the reader pane: a bulk selection, else a new message being written, else the conversation; one that fails to render is that pane only */}
            <PaneBoundary area="reader" resetKey={selectedId} readerThreadId={!many && !composing ? selectedId : null}>
              {many ? <SelectionBar /> : composing ? <NewMessage /> : <Reader />}
            </PaneBoundary>
            {pinned && <PinnedDraft key={pinned} overList={false} />}
            {/* Split: over the reader's foot, never over the rows being triaged (the reader's end scrolls clear of it) */}
            <SnackDock over="reader" />
          </main>
        )}
        {/* plan 21: the panes' edges, over the hairlines; List has no list|reader edge (its width is Split's, kept for it).
            Plan 158: last in the page, so Tab goes sidebar, list, reader and only then to them; in a landmark of their own, as
            all content is (a box-less one: they're still placed on the grid) */}
        <div role="region" aria-label={t("panes.sizes")} className="contents">
          <PaneHandle pane="sidebar" />
          {!list && <PaneHandle pane="list" />}
        </div>
      </div>
      <CommandPalette />
      <CategoryPicker />
      {dialog === "filters" && <FiltersDialog />}
      {dialog === "settings" && <SettingsDialog />}
      {dialog === "addAccount" && <AddAccountDialog />}
      {dialog === "shortcuts" && <ShortcutsDialog />}
      {dialog === "print" && <PrintSheet />}
      {dialog === "remind" && <RemindDialog />}
      {fresh && dialog === null && needsFirstRun() && <FirstRun />}
      {/* inside the settings sheet it opens over the sheet (a nested dialog) */}
      {dialog !== "settings" && <ReportPreview />}
      <EngineStopped />
      <Covers />
      <DragGhost />
    </TooltipProvider>
  );
}
