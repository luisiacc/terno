import { setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import { afterEach, describe, expect, it } from "vitest";
import { SETTINGS_TABS, settingsTabLabel } from "./tabs";

describe("settings tabs", () => {
  afterEach(() => setLocale("en", en));

  it("name themselves in the language current when they are read", () => {
    expect(SETTINGS_TABS.map((tab) => tab.label)).toEqual(["General", "Appearance", "Accounts", "Categories", "Rules", "Snippets", "AI", "Agents", "Data", "Storage", "About"]);
    setLocale("es", es);
    // the same objects (module state) follow the switch: nothing froze at import
    expect(SETTINGS_TABS.map(({ label }) => label)).toEqual(["General", "Apariencia", "Cuentas", "Categorías", "Reglas", "Plantillas", "IA", "Agentes", "Datos", "Almacenamiento", "Acerca de"]);
    expect(settingsTabLabel("ai")).toBe("IA");
  });
});
