import { t } from "@terno/i18n";
import { TooltipProvider } from "@terno/ui/components/tooltip";
import { lazy, Suspense, useEffect } from "react";
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
import { Reader } from "./components/reader";
import { SelectionBar } from "./components/selection-bar";
import { SnackDock } from "./components/snack-dock";
import { Sidebar } from "./components/sidebar";
import { PaneHandle } from "./components/pane-handle";
import { ThreadList } from "./components/thread-list";
import { EngineStopped } from "./components/diag/engine-stopped";
import { PaneBoundary } from "./components/diag/error-boundary";
import { ReportPreview } from "./components/diag/report-preview";

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

export function App() {
  const ready = useApp((s) => s.ready);
  const fatal = useApp((s) => s.fatal);
  const dialog = useApp((s) => s.dialog);
  const fresh = useApp((s) => s.ready && s.accounts.length === 0 && !s.owner && !s.demo);
  const many = useApp((s) => s.scope !== null || s.checked.size >= 2);
  const composing = useApp((s) => s.compose !== null);
  const selectedId = useApp((s) => s.selectedId);
  useEffect(() => installKeyboard(), []);
  useEffect(() => installComposeFollowsSelection(), []);
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
      <div className="app-panes grid h-screen overflow-hidden" data-ready={ready || undefined}>
        <Sidebar />
        <div id="app-list" className="hairline-l hairline-r hairline-strong relative min-h-0">
          <ThreadList />
          <SnackDock />
          {/* plan 21: the panes' edges, over the hairlines */}
          <PaneHandle pane="sidebar" />
          <PaneHandle pane="list" />
        </div>
        <main className="relative min-h-0">
          {/* the reader pane: a bulk selection, else a new message being written, else the conversation; one that fails to render is that pane only */}
          <PaneBoundary area="reader" resetKey={selectedId}>
            {many ? <SelectionBar /> : composing ? <NewMessage /> : <Reader />}
          </PaneBoundary>
        </main>
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
