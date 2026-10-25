import { setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import { afterEach, describe, expect, it } from "vitest";
import { parseSyncWindow } from "./settings-values";

describe("sync window", () => {
  afterEach(() => setLocale("en", en));

  it("takes whole days in the contract's range, as typed", () => {
    expect(parseSyncWindow("7")).toEqual({ days: 7 });
    expect(parseSyncWindow(" 365 ")).toEqual({ days: 365 });
    expect(parseSyncWindow("3650")).toEqual({ days: 3650 });
  });

  it("explains anything else instead of clamping it", () => {
    for (const bad of ["", "6", "0", "3651", "-30", "30.5", "1e3", "abc"]) expect(parseSyncWindow(bad)).toHaveProperty("error", "Enter a number of days from 7 to 3,650.");
  });

  it("explains it in the current language", () => {
    setLocale("es", es);
    expect(parseSyncWindow("6")).toHaveProperty("error", "Escribe un número de días entre 7 y 3,650.");
  });
});
