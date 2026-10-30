import { setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import { afterEach, describe, expect, it } from "vitest";
import { parseSyncWindow, windowChoices, windowLabel } from "./settings-values";

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

describe("plan 79: the window asked for when connecting", () => {
  afterEach(() => setLocale("en", en));

  it("lists the usual choices, and the General setting when it's none of them", () => {
    expect(windowChoices(180)).toEqual([30, 90, 180, 365, 730]);
    expect(windowChoices(45)).toEqual([30, 45, 90, 180, 365, 730]);
  });

  it("names them in days or years, in the current language", () => {
    expect([30, 180, 365, 730, 1095].map(windowLabel)).toEqual(["The last 30 days", "The last 180 days", "The last year", "The last 2 years", "The last 3 years"]);
    setLocale("es", es);
    expect([30, 365, 730].map(windowLabel)).toEqual(["Los últimos 30 días", "El último año", "Los últimos 2 años"]);
  });
});
