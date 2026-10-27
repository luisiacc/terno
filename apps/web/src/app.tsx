import { t } from "@terno/i18n";
import { TooltipProvider } from "@terno/ui/components/tooltip";
import { cn } from "@terno/ui/lib/utils";
import { lazy, Suspense, useEffect } from "react";
import { useDraftRecovery } from "~/lib/draft-recovery-ui";
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
import { installComposeFollowsSelection } from "~/lib/compose";
import { installNetworkEvents } from "~/lib/network";
import { Reader } from "./components/reader";
import { SelectionBar } from "./components/selection-bar";
import { SnackDock } from "./components/snack-dock";
import { Sidebar } from "./components/sidebar";
import { PaneHandle } from "./components/pane-handle";
import { ThreadList } from "./components/thread-list";
import { EngineStopped } from "./components/diag/engine-stopped";
import { PaneBoundary, RecoveryBoundary } from "./components/diag/error-boundary";
import { ReportPreview } from "./components/diag/report-preview";

const RecoveryWorkspace = lazy(() => import("./components/diag/recovery-workspace").then((m) => ({ default: m.RecoveryWorkspace })));

// rarely used, heavier surfaces stay out of the startup bundle
const FiltersDialog = lazy(() => import("./components/filters-dialog").then((m) => ({ default: m.FiltersDialog })));
const SettingsDialog = lazy(() => import("./components/settings-dialog").then((m) => ({ default: m.SettingsDialog })));
const AddAccountDialog = lazy(() => import("./components/add-account-dialog").then((m) => ({ default: m.AddAccountDialog })));
const ShortcutsDialog = lazy(() => import("./components/shortcuts-dialog").then((m) => ({ default: m.ShortcutsDialog })));
const FirstRun = lazy(() => import("./components/first-run").then((m) => ({ default: m.FirstRun })));
// printing loads its sheet and the document builder when it opens
const PrintSheet = lazy(() => import("./components/print-sheet").then((m) => ({ default: m.PrintSheet })));
// web build only (a compile-time constant): which tab owns the mailbox, open errors, updates
const WebGate = import.meta.env.VITE_TARGET === "web" ? lazy(() => import("./web/gate").then((m) => ({ default: m.WebGate }))) : null;

/** Fresh install: no mailboxes, no owner, not a demo, and the first-run steps not finished. */
function needsFirstRun(): boolean {
  return localStorage.getItem("terno:first-run") !== "done";
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
  const inset = useSnack((s) => (page === "compose" ? s.inset : 0));
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
        if (source !== "snackbar") showCategorySnackbar(filed, undo);
      }),
    [],
  );

  const recovering = useDraftRecovery((s) => s.open);
  if (recovering) return <RecoveryBoundary><Suspense><RecoveryWorkspace /></Suspense></RecoveryBoundary>;

  const gate = WebGate && (
    <Suspense>
      <WebGate />
    </Suspense>
  );
  if (fatal)
    return (
      gate ?? (
        <>
          <Fatal message={fatal} />
          <EngineStopped />
        </>
      )
    );
  return (
    <TooltipProvider delay={500}>
      {gate}
      {/* plan 24: Split is three panes; List is the sidebar and one content pane (the list, or a page over it). The tree keeps its
          shape across a switch, so the list (and its scroll) survives it. */}
      <div className={cn("grid h-screen overflow-hidden", list ? "app-panes-list" : "app-panes")} data-ready={ready || undefined}>
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
          <SnackDock />
          {/* plan 21: the panes' edges, over the hairlines; List has no list|reader edge (its width is Split's, kept for it) */}
          <PaneHandle pane="sidebar" />
          {!list && <PaneHandle pane="list" />}
        </section>
        {!list && (
          <main className="relative min-h-0">
            {/* the reader pane: a bulk selection, else a new message being written, else the conversation; one that fails to render is that pane only */}
            <PaneBoundary area="reader" resetKey={selectedId} readerThreadId={!many && !composing ? selectedId : null}>
              {many ? <SelectionBar /> : composing ? <NewMessage /> : <Reader />}
            </PaneBoundary>
          </main>
        )}
      </div>
      <CommandPalette />
      <CategoryPicker />
      <Suspense>
        {dialog === "filters" && <FiltersDialog />}
        {dialog === "settings" && <SettingsDialog />}
        {dialog === "addAccount" && <AddAccountDialog />}
        {dialog === "shortcuts" && <ShortcutsDialog />}
        {dialog === "print" && <PrintSheet />}
        {fresh && dialog === null && needsFirstRun() && <FirstRun />}
      </Suspense>
      {/* inside the settings sheet it opens over the sheet (a nested dialog) */}
      {dialog !== "settings" && <ReportPreview />}
      <EngineStopped />
      <DragGhost />
    </TooltipProvider>
  );
}
