import { setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import { afterEach, describe, expect, it } from "vitest";
import { SETTINGS_TABS, settingsTabLabel, settingsTabs } from "./tabs";

describe("settings tabs", () => {
  afterEach(() => setLocale("en", en));

  it("name themselves in the language current when they are read", () => {
    expect(SETTINGS_TABS.map((tab) => tab.label)).toEqual(["General", "Accounts", "Appearance", "What matters", "Categories", "Rules", "Snippets", "AI", "Agents", "Storage", "About"]);
    setLocale("es", es);
    // the same objects (module state) follow the switch: nothing froze at import
    expect(SETTINGS_TABS.map(({ label }) => label)).toEqual(["General", "Cuentas", "Apariencia", "Lo importante", "Categorías", "Reglas", "Plantillas", "IA", "Agentes", "Almacenamiento", "Acerca de"]);
    expect(settingsTabLabel("ai")).toBe("IA");
  });

  it("plan 247: What matters only where it can exist (after Appearance, plan 294), Dev mode last on a local build", () => {
    const values = (o: Parameters<typeof settingsTabs>[0]) => settingsTabs(o).map((tab) => tab.value);
    expect(values({ whatMatters: true, dev: false }).slice(0, 4)).toEqual(["general", "accounts", "appearance", "whatMatters"]);
    expect(values({ whatMatters: false, dev: false })).not.toContain("whatMatters");
    expect(values({ whatMatters: false, dev: false })).toHaveLength(SETTINGS_TABS.length - 1);
    expect(values({ whatMatters: true, dev: true }).at(-1)).toBe("dev");
    expect(values({ whatMatters: false, dev: true }).at(-1)).toBe("dev");
  });
});
