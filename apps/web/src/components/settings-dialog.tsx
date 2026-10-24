import { Button } from "@terno/ui/components/button";
import { Dialog, DialogContent, DialogTitle } from "@terno/ui/components/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@terno/ui/components/tabs";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@terno/ui/components/alert-dialog";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { client } from "~/rpc/connection";
import { setApp, useApp, type SettingsTab } from "~/state/app";
import { AiTab } from "./settings/ai-tab";
import { AppearanceTab } from "./settings/appearance-tab";
import { CategoriesTab } from "./settings/categories-tab";
import { AccountsTab } from "./settings/accounts-tab";
import { AgentsTab } from "./settings/agents-tab";
import { DataTab } from "./settings/data-tab";
import { FiltersTab } from "./settings/filters-tab";
import { GeneralTab } from "./settings/general-tab";
import { SETTINGS_TABS } from "./settings/tabs";
import { reconcileSettings } from "~/lib/appearance";
import type { SettingsUpdate } from "./settings/parts";

export function SettingsDialog() {
  const open = useApp((s) => s.dialog === "settings");
  const tab = useApp((s) => s.settingsTab);
  const settings = useApp((s) => s.settings);
  const [confirmLocalOff, setConfirmLocalOff] = useState(false);

  const update = useCallback<SettingsUpdate>(async (patch, options) => {
    try {
      setApp({ settings: reconcileSettings(await client.call("settings.update", patch)) });
    } catch (error) {
      // a field that shows its own error asks to hear about it; anything else says so in a toast
      if (options?.quiet) throw error;
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }, []);
  if (!settings) return null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && setApp({ dialog: null })}>
      <DialogContent className="h-[min(640px,85vh)] max-w-[min(820px,94vw)] gap-0 overflow-hidden p-0 sm:max-w-[min(820px,94vw)]" data-testid="settings-dialog">
        <DialogTitle className="sr-only">Ajustes</DialogTitle>
        <Tabs value={tab} onValueChange={(v) => setApp({ settingsTab: v as SettingsTab })} orientation="vertical" className="flex h-full flex-row gap-0">
          {/* macOS System Settings: a sidebar of sections with accent glyphs */}
          <nav className="hairline-r hairline-strong flex w-[180px] shrink-0 flex-col bg-sidebar px-2 pt-5 pb-3">
            <h2 className="mb-3 px-2 text-md font-semibold tracking-tight">Ajustes</h2>
            <TabsList activateOnFocus className="w-full items-stretch bg-transparent p-0">
              {SETTINGS_TABS.map(({ value, label, icon: Icon }) => (
                <TabsTrigger
                  key={value}
                  value={value}
                  data-testid={`tab-${value}`}
                  className="h-7 justify-start gap-2.5 rounded-md px-2 font-normal text-sidebar-foreground after:hidden data-active:bg-sidebar-accent data-active:font-medium data-active:text-sidebar-accent-foreground data-active:shadow-none dark:data-active:border-transparent dark:data-active:bg-sidebar-accent"
                >
                  <Icon className="size-4 text-sidebar-glyph" />
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
          </nav>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-5 pb-4">
            <h2 className="mb-4 text-lg font-semibold tracking-tight">{SETTINGS_TABS.find((t) => t.value === tab)?.label}</h2>
            <TabsContent value="general">
              <GeneralTab settings={settings} update={update} onLocalOff={() => setConfirmLocalOff(true)} />
            </TabsContent>

            <TabsContent value="appearance">
              <AppearanceTab settings={settings} />
            </TabsContent>

            <TabsContent value="accounts">
              <AccountsTab settings={settings} update={update} />
            </TabsContent>

            <TabsContent value="categories">
              <CategoriesTab settings={settings} update={update} />
            </TabsContent>

            <TabsContent value="filters">
              <FiltersTab />
            </TabsContent>

            <TabsContent value="ai">
              <AiTab settings={settings} update={update} />
            </TabsContent>

            <TabsContent value="data">
              <DataTab />
            </TabsContent>

            <TabsContent value="agents">
              <AgentsTab settings={settings} update={update} />
            </TabsContent>
          </div>
        </Tabs>
        <AlertDialog open={confirmLocalOff} onOpenChange={setConfirmLocalOff}>
          <AlertDialogContent data-testid="local-mode-confirm">
            <AlertDialogHeader>
              <AlertDialogTitle>¿Desactivar el modo local?</AlertDialogTitle>
              <AlertDialogDescription render={<div />}>
                <p>Al desactivarlo, Única podrá:</p>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-left">
                  <li>usar IA en la nube (Claude, OpenAI y compatibles) con tu propia API key;</li>
                  <li>cargar imágenes remotas de un correo cuando lo pidas.</li>
                </ul>
                <p className="mt-2">El correo con tus servidores funciona igual en los dos modos.</p>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Mantener activado</AlertDialogCancel>
              <Button
                variant="destructive"
                data-testid="local-mode-confirm-off"
                onClick={() => {
                  setConfirmLocalOff(false);
                  void update({ localMode: false });
                }}
              >
                Desactivar
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}
