import { Toaster } from "@unica/ui/components/sonner";
import { TooltipProvider } from "@unica/ui/components/tooltip";
import { lazy, Suspense, useEffect } from "react";
import { onFiled } from "~/lib/categorize";
import { installKeyboard } from "~/lib/keyboard";
import { useApp } from "~/state/app";
import { CategoryPicker } from "./components/category-picker";
import { CategorySnackbarHost, showCategorySnackbar } from "./components/category-snackbar";
import { CommandPalette } from "./components/command-palette";
import { Composer } from "./components/composer";
import { Reader } from "./components/reader";
import { Sidebar } from "./components/sidebar";
import { ThreadList } from "./components/thread-list";

// rarely used, heavier surfaces stay out of the startup bundle
const FiltersDialog = lazy(() => import("./components/filters-dialog").then((m) => ({ default: m.FiltersDialog })));
const SettingsDialog = lazy(() => import("./components/settings-dialog").then((m) => ({ default: m.SettingsDialog })));
const AddAccountDialog = lazy(() => import("./components/add-account-dialog").then((m) => ({ default: m.AddAccountDialog })));
const ShortcutsDialog = lazy(() => import("./components/shortcuts-dialog").then((m) => ({ default: m.ShortcutsDialog })));
const FirstRun = lazy(() => import("./components/first-run").then((m) => ({ default: m.FirstRun })));

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
  const theme = useApp((s) => s.settings?.theme ?? "system");
  const fresh = useApp((s) => s.ready && s.accounts.length === 0 && !s.owner && !s.demo);
  useEffect(() => installKeyboard(), []);
  // every way of filing threads offers the snackbar, except its own bulk adds
  useEffect(() => onFiled((filed, source) => source !== "snackbar" && showCategorySnackbar(filed)), []);

  if (fatal) return <Fatal message={fatal} />;
  return (
    <TooltipProvider delay={500}>
      <div className="grid h-screen grid-cols-[232px_minmax(340px,400px)_minmax(0,1fr)] overflow-hidden" data-ready={ready || undefined}>
        <Sidebar />
        <div className="min-h-0 border-r border-l border-border">
          <ThreadList />
        </div>
        <main className="relative min-h-0">
          <Reader />
          <Composer />
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
      <Toaster position="bottom-left" theme={theme} />
    </TooltipProvider>
  );
}
