import { setLocale, t } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import { afterEach, describe, expect, it } from "vitest";
import { LISTED, SECTIONS, unlistedBindings } from "./shortcut-sections";

afterEach(() => setLocale("en", en));

describe("shortcuts dialog", () => {
  it("lists every bound command (or leaves it out on purpose)", () => {
    expect(unlistedBindings()).toEqual([]);
    for (const c of ["list.selectAll", "list.extendNext", "list.extendPrev", "thread.markRead", "thread.toggleRead", "thread.move", "action.undo", "list.menu"] as const) expect(LISTED.has(c)).toBe(true);
  });

  it("names its sections and rows from the catalog, in both languages", () => {
    const keys = SECTIONS.flatMap((s) => [s.title, ...s.rows.map(([, label]) => label)]);
    for (const key of keys) {
      expect(en).toHaveProperty([key]);
      expect(es).toHaveProperty([key]);
    }
    expect(SECTIONS.map((s) => t(s.title))).toEqual(["Navigate", "Select", "Actions", "Compose"]);
    expect(t(SECTIONS[0]!.rows[0]![1])).toBe("Next conversation");
    setLocale("es", es);
    expect(SECTIONS.map((s) => t(s.title))).toEqual(["Moverse", "Seleccionar", "Acciones", "Escribir"]);
    expect(t(SECTIONS[0]!.rows[0]![1])).toBe("Siguiente conversación");
  });
});
