import { t } from "@terno/i18n";
import { AtSign, Bot, HardDrive, Info, ListFilter, Palette, SlidersHorizontal, Sparkles, Sun, Tag, Terminal, NotepadText } from "@terno/ui/icons";
import type { SettingsTab } from "~/state/app";

const LABEL_KEYS = {
  general: "settings.tab.general",
  whatMatters: "today.title",
  appearance: "settings.tab.appearance",
  accounts: "settings.tab.accounts",
  categories: "settings.tab.categories",
  filters: "settings.tab.filters",
  snippets: "settings.tab.snippets",
  ai: "settings.tab.ai",
  agents: "settings.tab.agents",
  storage: "settings.tab.storage",
  dev: "settings.tab.dev",
  about: "settings.tab.about",
} as const satisfies Record<SettingsTab, string>;

/** A section's name in the current language. */
export function settingsTabLabel(tab: SettingsTab): string {
  return t(LABEL_KEYS[tab]);
}

const tab = (value: SettingsTab, icon: typeof AtSign) => ({
  value,
  icon,
  /** read when rendered, so it follows the language */
  get label() {
    return settingsTabLabel(value);
  },
});

/** The settings sections, in sidebar order; the palette offers each as "Settings → <label>". */
type TabEntry = { readonly value: SettingsTab; readonly label: string; readonly icon: typeof AtSign };

export const SETTINGS_TABS: readonly TabEntry[] = [
  tab("general", SlidersHorizontal),
  // plan 294: Accounts, the first thing set up, before how it all looks
  tab("accounts", AtSign),
  tab("appearance", Palette),
  // plan 247: only where What matters can exist (settingsTabs)
  tab("whatMatters", Sun),
  tab("categories", Tag),
  tab("filters", ListFilter),
  tab("snippets", NotepadText),
  tab("ai", Sparkles),
  tab("agents", Bot),
  tab("storage", HardDrive),
  tab("about", Info),
];

/** Plan 146: a local build's own section, last. */
export const DEV_TAB: TabEntry = tab("dev", Terminal);

/**
 * Plan 247: the sections that exist here, in sidebar order: What matters only where it can exist (AI can run: the same rule
 * as its search entries), Dev mode last on a local build. The sidebar and the palette both read it.
 */
export function settingsTabs({ whatMatters, dev }: { whatMatters: boolean; dev: boolean }): readonly TabEntry[] {
  const tabs = whatMatters ? SETTINGS_TABS : SETTINGS_TABS.filter((e) => e.value !== "whatMatters");
  return dev ? [...tabs, DEV_TAB] : tabs;
}
