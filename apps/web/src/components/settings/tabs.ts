import { t } from "@terno/i18n";
import { AtSign, Bot, Database, HardDrive, ListFilter, Palette, SlidersHorizontal, Sparkles, Tag, Terminal, NotepadText } from "@terno/ui/icons";
import type { SettingsTab } from "~/state/app";

const LABEL_KEYS = {
  general: "settings.tab.general",
  appearance: "settings.tab.appearance",
  accounts: "settings.tab.accounts",
  categories: "settings.tab.categories",
  filters: "settings.tab.filters",
  snippets: "settings.tab.snippets",
  ai: "settings.tab.ai",
  agents: "settings.tab.agents",
  data: "settings.tab.data",
  storage: "settings.tab.storage",
  dev: "settings.tab.dev",
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
  tab("appearance", Palette),
  tab("accounts", AtSign),
  tab("categories", Tag),
  tab("filters", ListFilter),
  tab("snippets", NotepadText),
  tab("ai", Sparkles),
  tab("agents", Bot),
  tab("data", Database),
  tab("storage", HardDrive),
];

/** Plan 146: a local build's own section, last. */
export const DEV_TAB: TabEntry = tab("dev", Terminal);
