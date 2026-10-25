import { t } from "@terno/i18n";
import { AtSign, Bot, Database, ListFilter, Palette, SlidersHorizontal, Sparkles, Tag } from "lucide-react";
import type { SettingsTab } from "~/state/app";

const LABEL_KEYS = {
  general: "settings.tab.general",
  appearance: "settings.tab.appearance",
  accounts: "settings.tab.accounts",
  categories: "settings.tab.categories",
  filters: "settings.tab.filters",
  ai: "settings.tab.ai",
  agents: "settings.tab.agents",
  data: "settings.tab.data",
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
export const SETTINGS_TABS: readonly { readonly value: SettingsTab; readonly label: string; readonly icon: typeof AtSign }[] = [
  tab("general", SlidersHorizontal),
  tab("appearance", Palette),
  tab("accounts", AtSign),
  tab("categories", Tag),
  tab("filters", ListFilter),
  tab("ai", Sparkles),
  tab("agents", Bot),
  tab("data", Database),
];
