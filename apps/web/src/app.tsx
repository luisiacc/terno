import { Toaster } from "@unica/ui/components/sonner";
import { TooltipProvider } from "@unica/ui/components/tooltip";
import { lazy, Suspense, useEffect } from "react";
import { installKeyboard } from "~/lib/keyboard";
import { useApp } from "~/state/app";
import { CategoryPicker } from "./components/category-picker";
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
  useEffect(() => installKeyboard(), []);

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
      </Suspense>
      <Toaster position="bottom-left" theme={theme} />
    </TooltipProvider>
  );
}
