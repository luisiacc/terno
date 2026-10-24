import { Toaster } from "@unica/ui/components/sonner";
import { TooltipProvider } from "@unica/ui/components/tooltip";
import { lazy, Suspense, useEffect } from "react";
import { useAppearance } from "~/lib/appearance";
import { setLastUndo } from "~/lib/actions";
import { onFiled, undoFiled } from "~/lib/categorize";
import { installKeyboard } from "~/lib/keyboard";
import { useApp } from "~/state/app";
import { CategoryPicker } from "./components/category-picker";
import { CategorySnackbarHost, showCategorySnackbar } from "./components/category-snackbar";
import { CommandPalette } from "./components/command-palette";
import { DragGhost } from "./components/drag-ghost";
import { NewMessage } from "./components/new-message";
import { installComposeFollowsSelection } from "~/lib/compose";
import { Reader } from "./components/reader";
import { SelectionBar } from "./components/selection-bar";
import { Sidebar } from "./components/sidebar";
import { ThreadList } from "./components/thread-list";

// rarely used, heavier surfaces stay out of the startup bundle
const FiltersDialog = lazy(() => import("./components/filters-dialog").then((m) => ({ default: m.FiltersDialog })));
const SettingsDialog = lazy(() => import("./components/settings-dialog").then((m) => ({ default: m.SettingsDialog })));
const AddAccountDialog = lazy(() => import("./components/add-account-dialog").then((m) => ({ default: m.AddAccountDialog })));
const ShortcutsDialog = lazy(() => import("./components/shortcuts-dialog").then((m) => ({ default: m.ShortcutsDialog })));
const FirstRun = lazy(() => import("./components/first-run").then((m) => ({ default: m.FirstRun })));
// web build only (a compile-time constant): which tab owns the mailbox, open errors, updates
const WebGate = import.meta.env.VITE_TARGET === "web" ? lazy(() => import("./web/gate").then((m) => ({ default: m.WebGate }))) : null;

/** Fresh install: no mailboxes, no owner, not a demo, and the first-run steps not finished. */
function needsFirstRun(): boolean {
  return localStorage.getItem("unica:first-run") !== "done";
}

function Fatal({ message }: { message: string }) {
  return (
    <div className="flex h-screen items-center justify-center bg-background p-10 text-center">
      <div>
        <p className="font-semibold">No se pudo conectar con el motor de correo</p>
        <p className="mt-1 text-sm text-muted-foreground">{message}</p>
      </div>
    </div>
  );
}

export function App() {
  const ready = useApp((s) => s.ready);
  const fatal = useApp((s) => s.fatal);
  const dialog = useApp((s) => s.dialog);
  const mode = useAppearance((s) => s.mode);
  const fresh = useApp((s) => s.ready && s.accounts.length === 0 && !s.owner && !s.demo);
  const many = useApp((s) => s.scope !== null || s.checked.size >= 2);
  const composing = useApp((s) => s.compose !== null);
  useEffect(() => installKeyboard(), []);
  useEffect(() => installComposeFollowsSelection(), []);
  // every way of filing threads offers the snackbar, except its own bulk adds
  useEffect(
    () =>
      onFiled((filed, source) => {
        if (source !== "snackbar") showCategorySnackbar(filed);
        // z / ⌘Z after the snackbar is gone still takes the filing back
        setLastUndo(() => void undoFiled(filed).catch(() => {}));
      }),
    [],
  );

  const gate = WebGate && (
    <Suspense>
      <WebGate />
    </Suspense>
  );
  if (fatal) return gate ?? <Fatal message={fatal} />;
  return (
    <TooltipProvider delay={500}>
      {gate}
      <div className="grid h-screen grid-cols-[232px_minmax(340px,400px)_minmax(0,1fr)] overflow-hidden" data-ready={ready || undefined}>
        <Sidebar />
        <div className="hairline-l hairline-r hairline-strong min-h-0">
          <ThreadList />
        </div>
        <main className="relative min-h-0">
          {/* the reader pane: a bulk selection, else a new message being written, else the conversation */}
          {many ? <SelectionBar /> : composing ? <NewMessage /> : <Reader />}
        </main>
      </div>
      <CommandPalette />
      <CategoryPicker />
      <Suspense>
        {dialog === "filters" && <FiltersDialog />}
        {dialog === "settings" && <SettingsDialog />}
        {dialog === "addAccount" && <AddAccountDialog />}
        {dialog === "shortcuts" && <ShortcutsDialog />}
        {fresh && dialog === null && needsFirstRun() && <FirstRun />}
      </Suspense>
      <CategorySnackbarHost />
      <DragGhost />
      <Toaster position="bottom-left" theme={mode} />
    </TooltipProvider>
  );
}
