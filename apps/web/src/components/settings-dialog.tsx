import { Dialog, DialogContent, DialogTitle } from "@terno/ui/components/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@terno/ui/components/tabs";
import { useCallback, useEffect, useRef } from "react";
import { installScrollHairline } from "~/lib/scroll-hairline";
import { snack } from "~/lib/snack";
import { imeKey } from "~/lib/ime-escape";
import { client } from "~/rpc/connection";
import { getApp, setApp, useApp, type SettingsTab } from "~/state/app";
import { AiTab } from "./settings/ai-tab";
import { escapeStyleEditor, leaveStyleEditors } from "./settings/writing-style";
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
import { DEV_TAB, SETTINGS_TABS, settingsTabLabel } from "./settings/tabs";
import { DevTab } from "./settings/dev-tab";
import { t } from "@terno/i18n";
import { reconcileSettings } from "~/lib/appearance";
import { switchFocus } from "~/lib/i18n";
import type { SettingsUpdate } from "./settings/parts";
import { PaneBoundary } from "./diag/error-boundary";
import { ReportPreview } from "./diag/report-preview";
import { useNativeReload } from "~/lib/native-reload";
import { useAiDraftUi } from "~/lib/ai-draft-state";
import { IconButton } from "@terno/ui/components/icon-button";
import { ChevronLeft } from "@terno/ui/icons";

/** plan 106: opened on an account, its row (expanded by the tab) takes the first focus; else the dialog's own */
function initialFocus(): boolean | HTMLElement {
  const id = getApp().settingsAccount;
  if (id === null) return switchFocus();
  const row = document.querySelector<HTMLElement>(`[data-testid=settings-account][data-account-id="${id}"] [data-testid=account-toggle]`);
  // used once: a later visit to the tab opens nothing by itself
  setApp({ settingsAccount: null });
  return row ?? switchFocus();
}

/**
 * A section: its title on a row of its own, level with the sheet's close, and the content scrolling below it, so nothing
 * runs under the close. The padding around the row's edge keeps the first control's focus ring from being clipped.
 */
function SettingsPane({ title, back, children }: { title: string; /** a page inside a section (plan 161): its way back, on the title's line */ back?: { label: string; onClick: () => void; testId: string }; children: React.ReactNode }) {
  const headerRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const [root, sentinel, header] = [scrollerRef.current, sentinelRef.current, headerRef.current];
    return root && sentinel && header ? installScrollHairline(root, sentinel, header) : undefined;
  }, []);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div ref={headerRef} data-testid="settings-header" data-dialog-handle className="scroll-hairline shrink-0 px-6 pt-5 pb-2">
        {back ? (
          <div className="-ml-1.5 flex items-center gap-1">
            <IconButton label={back.label} data-testid={back.testId} onClick={back.onClick}><ChevronLeft /></IconButton>
            <h2 className="text-lg font-semibold tracking-tight" data-testid="settings-title">{title}</h2>
          </div>
        ) : (
          <h2 className="text-lg font-semibold tracking-tight" data-testid="settings-title">{title}</h2>
        )}
      </div>
      {/* plan 161: on the popover in dark, a tint card's edge is a ring */}
      <div ref={scrollerRef} className="relative min-h-0 flex-1 overflow-y-auto px-6 pt-2 pb-4 dark:[--card-ring:var(--card-ring-dialog)]">
        <div ref={sentinelRef} aria-hidden className="absolute top-0 h-px w-px" />
        {children}
      </div>
    </div>
  );
}

export function SettingsDialog() {
  const open = useApp((s) => s.dialog === "settings");
  const fatalModal = useNativeReload((s) => s.modalHost !== null);
  const tab = useApp((s) => s.settingsTab);
  const settings = useApp((s) => s.settings);
  const hasDevMode = useApp((s) => s.devAi !== null);
  const stylePage = useAiDraftUi((s) => s.stylePage) && tab === "ai";

  // back to Drafting, focus on the button that opened Writing style (pass 3), as the palette's pages go back
  const backFromStyle = () => {
    const back = () => {
      useAiDraftUi.setState({ stylePage: false });
      requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-testid=ai-drafting-style-open]")?.focus());
    };
    // a changed editor asks before the page goes (Codex review)
    leaveStyleEditors(back);
  };
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
      <DialogContent
        movable="settings"
        // plan 161, pass 3: Esc steps back a level before it closes: on Writing style, back to Drafting (the style editor's
        // own Esc goes first); a portal's Esc bubbles here through React and is its own
        onKeyDown={(e) => {
          if (e.key !== "Escape" || !stylePage || e.defaultPrevented || imeKey(e.nativeEvent) || !e.currentTarget.contains(e.target as Node)) return;
          // the popup's own Esc (merged after this one) and the document's both stand down
          (e as unknown as { preventBaseUIHandler(): void }).preventBaseUIHandler();
          e.preventDefault();
          e.stopPropagation();
          // an editor open on the page is the level below it, wherever focus is (Codex review): it steps back first
          if (!escapeStyleEditor()) backFromStyle();
        }}
        className="h-[min(640px,85vh)] max-w-[min(820px,94vw)] grid-rows-1 gap-0 overflow-hidden p-0 sm:max-w-[min(820px,94vw)]" data-testid="settings-dialog" initialFocus={initialFocus}
        // on the section title's line, at the content's inset (pt-5 px-6)
        closeClassName="top-[calc(var(--spacing)*5+(var(--text-lg--line-height)-var(--spacing)*6)/2)]">
        <DialogTitle className="sr-only">{t("common.settings")}</DialogTitle>
        <Tabs value={tab} onValueChange={(v) => setApp({ settingsTab: v as SettingsTab })} orientation="vertical" className="flex h-full min-w-0 flex-row gap-0">
          {/* macOS System Settings: a sidebar of sections with accent glyphs */}
          <nav data-dialog-handle className="hairline-r hairline-strong flex w-[180px] shrink-0 flex-col bg-sidebar px-2 pt-5 pb-3">
            <h2 className="mb-3 px-2 text-md font-semibold tracking-tight">{t("common.settings")}</h2>
            {/* a 1 px gap: a hovered row's fill never runs into the selected one's */}
            <TabsList activateOnFocus className="h-auto w-full items-stretch gap-px rounded-none bg-transparent p-0 dark:bg-transparent">
              {(hasDevMode ? [...SETTINGS_TABS, DEV_TAB] : SETTINGS_TABS).map(({ value, label, icon: Icon }) => (
                <TabsTrigger
                  key={value}
                  value={value}
                  data-testid={`tab-${value}`}
                  data-settings-tab={value}
                  className="h-auto justify-start gap-2.5 rounded-md border border-transparent px-2 py-0.5 font-normal text-sidebar-foreground after:hidden not-data-active:hover:bg-sidebar-hover hover:text-sidebar-foreground data-active:bg-sidebar-accent data-active:font-medium data-active:text-sidebar-accent-foreground data-active:shadow-none dark:data-active:border-transparent dark:data-active:bg-sidebar-accent dark:data-active:shadow-none"
                >
                  <Icon className="size-4 text-sidebar-glyph" />
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
          </nav>
          <SettingsPane
            // plan 161: Writing style is a page of its own: it's the title, with the way back to Drafting beside it
            title={stylePage ? t("aiDraft.style.title") : settingsTabLabel(tab)}
            back={stylePage ? { label: t("aiDraft.style.back"), onClick: backFromStyle, testId: "writing-style-back" } : undefined}
          >
            {/* a section that fails to render stays a section: the sheet and the other tabs keep working */}
            <PaneBoundary area="settings" resetKey={tab} title={t("settings.sectionError")}>
              {hasDevMode && (
                <TabsContent value="dev">
                  <DevTab settings={settings} update={update} />
                </TabsContent>
              )}

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
          </SettingsPane>
        </Tabs>
        <ReportPreview />
      </DialogContent>
    </Dialog>
  );
}
