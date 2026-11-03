import { Dialog, DialogContent, DialogTitle } from "@terno/ui/components/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@terno/ui/components/tabs";
import { useCallback } from "react";
import { snack } from "~/lib/snack";
import { client } from "~/rpc/connection";
import { getApp, setApp, useApp, type SettingsTab } from "~/state/app";
import { AiTab } from "./settings/ai-tab";
import { AppearanceTab } from "./settings/appearance-tab";
import { CategoriesTab } from "./settings/categories-tab";
import { AccountsTab } from "./settings/accounts-tab";
import { AgentsTab } from "./settings/agents-tab";
import { DataTab } from "./settings/data-tab";
import { FiltersTab } from "./settings/filters-tab";
import { SnippetsTab } from "./settings/snippets-tab";
import { closeSnippetEditor, setDeletedSnippet } from "~/lib/snippet-editor-state";
import { GeneralTab } from "./settings/general-tab";
import { StorageTab } from "./settings/storage-tab";
import { SETTINGS_TABS, settingsTabLabel } from "./settings/tabs";
import { t } from "@terno/i18n";
import { reconcileSettings } from "~/lib/appearance";
import { switchFocus } from "~/lib/i18n";
import type { SettingsUpdate } from "./settings/parts";
import { PaneBoundary } from "./diag/error-boundary";
import { ReportPreview } from "./diag/report-preview";
import { useNativeReload } from "~/lib/native-reload";

/** plan 106: opened on an account, its row (expanded by the tab) takes the first focus; else the dialog's own */
function initialFocus(): boolean | HTMLElement {
  const id = getApp().settingsAccount;
  if (id === null) return switchFocus();
  const row = document.querySelector<HTMLElement>(`[data-testid=settings-account][data-account-id="${id}"] [data-testid=account-toggle]`);
  // used once: a later visit to the tab opens nothing by itself
  setApp({ settingsAccount: null });
  return row ?? switchFocus();
}

export function SettingsDialog() {
  const open = useApp((s) => s.dialog === "settings");
  const fatalModal = useNativeReload((s) => s.modalHost !== null);
  const tab = useApp((s) => s.settingsTab);
  const settings = useApp((s) => s.settings);

  const update = useCallback<SettingsUpdate>(async (patch, options) => {
    try {
      setApp({ settings: reconcileSettings(await client.call("settings.update", patch)) });
    } catch (error) {
      // a field that shows its own error asks to hear about it; anything else says so in a snack
      if (options?.quiet) throw error;
      snack.error(error instanceof Error ? error.message : String(error));
    }
  }, []);
  if (!settings) return null;

  return (
    <Dialog
      open={open && !fatalModal}
      onOpenChange={(o) => {
        if (o || fatalModal) return;
        setApp({ dialog: null, settingsAccount: null });
        // plan 93: Settings opens again on the list (the editor's save is flushed as it unmounts)
        closeSnippetEditor();
        setDeletedSnippet(null);
      }}
    >
      <DialogContent className="h-[min(640px,85vh)] max-w-[min(820px,94vw)] grid-rows-1 gap-0 overflow-hidden p-0 sm:max-w-[min(820px,94vw)]" data-testid="settings-dialog" initialFocus={initialFocus}
        // on the section title's line, at the content's inset (pt-5 px-6)
        closeClassName="top-[calc(var(--spacing)*5+(var(--text-lg--line-height)-var(--spacing)*6)/2)]">
        <DialogTitle className="sr-only">{t("common.settings")}</DialogTitle>
        <Tabs value={tab} onValueChange={(v) => setApp({ settingsTab: v as SettingsTab })} orientation="vertical" className="flex h-full min-w-0 flex-row gap-0">
          {/* macOS System Settings: a sidebar of sections with accent glyphs */}
          <nav className="hairline-r hairline-strong flex w-[180px] shrink-0 flex-col bg-sidebar px-2 pt-5 pb-3">
            <h2 className="mb-3 px-2 text-md font-semibold tracking-tight">{t("common.settings")}</h2>
            {/* a 1 px gap: a hovered row's fill never runs into the selected one's */}
            <TabsList activateOnFocus className="h-auto w-full items-stretch gap-px rounded-none bg-transparent p-0 dark:bg-transparent">
              {SETTINGS_TABS.map(({ value, label, icon: Icon }) => (
                <TabsTrigger
                  key={value}
                  value={value}
                  data-testid={`tab-${value}`}
                  className="h-auto justify-start gap-2.5 rounded-md border border-transparent px-2 py-0.5 font-normal text-sidebar-foreground after:hidden not-data-active:hover:bg-sidebar-hover hover:text-sidebar-foreground data-active:bg-sidebar-accent data-active:font-medium data-active:text-sidebar-accent-foreground data-active:shadow-none dark:data-active:border-transparent dark:data-active:bg-sidebar-accent dark:data-active:shadow-none"
                >
                  <Icon className="size-4 text-sidebar-glyph" />
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
          </nav>
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-6 pt-5 pb-4">
            <h2 className="mb-4 text-lg font-semibold tracking-tight">{settingsTabLabel(tab)}</h2>
            {/* a section that fails to render stays a section: the sheet and the other tabs keep working */}
            <PaneBoundary area="settings" resetKey={tab} title={t("settings.sectionError")}>
              <TabsContent value="general">
                <GeneralTab settings={settings} update={update} />
              </TabsContent>

              <TabsContent value="appearance">
                <AppearanceTab settings={settings} update={update} />
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

              <TabsContent value="snippets">
                <SnippetsTab />
              </TabsContent>

              <TabsContent value="ai">
                <AiTab settings={settings} update={update} />
              </TabsContent>

              <TabsContent value="data">
                <DataTab />
              </TabsContent>

              <TabsContent value="storage">
                <StorageTab />
              </TabsContent>

              <TabsContent value="agents">
                <AgentsTab settings={settings} update={update} />
              </TabsContent>
            </PaneBoundary>
          </div>
        </Tabs>
        <ReportPreview />
      </DialogContent>
    </Dialog>
  );
}
