import { initialUpdateState, reduceUpdate, type UpdateEvent, type UpdateState } from "@terno/core/updates";
import { setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import { afterEach, describe, expect, it } from "vitest";
import { checkResult, errorText, pillModel, unsupportedText } from "./updates";

afterEach(() => setLocale("en", en));

const info = (version: string) => ({ version, notes: "", size: 1, releaseDate: null });
const s = (...events: UpdateEvent[]): UpdateState => events.reduce(reduceUpdate, initialUpdateState({ current: "0.1.0", mode: "auto", channel: "stable", localMode: false }));
const available = (v = "0.2.0"): UpdateEvent => ({ type: "available", at: 1, update: info(v) });
const ready: UpdateEvent[] = [available(), { type: "download-start" }, { type: "downloaded" }, { type: "ready" }];
const off = { later: false, webUpdate: false };

describe("updates: the sidebar pill", () => {
  it("hidden while there's nothing to say: idle, checking, up to date, a failed check, unsupported", () => {
    for (const state of [null, s(), s({ type: "check-start" }), s({ type: "not-available", at: 1 }), s({ type: "check-failed", at: 1, kind: "offline" }), s({ type: "unsupported", reason: "dmg" })]) {
      expect(pillModel(state, off)).toEqual({ kind: "hidden" });
    }
  });

  it("available → downloading (percent) → verifying → ready (accent, quiet after Later, waiting while a send runs)", () => {
    expect(pillModel(s(available()), off)).toEqual({ kind: "available", version: "0.2.0" });
    expect(pillModel(s(available(), { type: "download-start" }, { type: "download-progress", percent: 42 }), off)).toEqual({ kind: "downloading", version: "0.2.0", percent: 42 });
    expect(pillModel(s(available(), { type: "download-start" }, { type: "downloaded" }), off)).toEqual({ kind: "verifying", version: "0.2.0" });
    expect(pillModel(s(...ready), off)).toEqual({ kind: "ready", version: "0.2.0", deferred: false, quiet: false });
    expect(pillModel(s(...ready), { ...off, later: true })).toMatchObject({ kind: "ready", quiet: true });
    expect(pillModel(s(...ready, { type: "install-start" }, { type: "install-deferred", reason: "sending" }), off)).toMatchObject({ kind: "ready", deferred: true });
  });

  it("a ready update outranks a newer one downloading beside it", () => {
    expect(pillModel(s(...ready, available("0.2.1"), { type: "download-start" }), off)).toMatchObject({ kind: "ready", version: "0.2.0" });
  });

  it("a failed download, a refused bundle or an update that didn't install says so; the web's new build wins over all", () => {
    expect(pillModel(s(available(), { type: "download-start" }, { type: "download-failed", kind: "integrity" }), off)).toEqual({ kind: "error", stage: "download" });
    expect(pillModel(s({ type: "not-applied", version: "0.2.0" }), off)).toEqual({ kind: "error", stage: "install" });
    expect(pillModel(null, { later: false, webUpdate: true })).toEqual({ kind: "web" });
  });
});

describe("updates: what a manual check says", () => {
  it.each([
    [null, "error", "Couldn’t check for updates"],
    [s({ type: "not-available", at: 1 }), "success", "Terno is up to date"],
    [s(available()), "success", "Terno 0.2.0 is available"],
    [s(...ready), "success", "Terno 0.2.0 is ready"],
    [s({ type: "check-failed", at: 1, kind: "offline" }), "error", "Couldn’t check for updates"],
    [s({ type: "unsupported", reason: "translocated" }), "neutral", "This copy of Terno can’t update itself"],
  ] as const)("%#: %s", (state, tone, message) => {
    expect(checkResult(state)).toMatchObject({ tone, message });
  });

  it("explains why, in plain words", () => {
    expect(checkResult(s({ type: "unsupported", reason: "dmg" })).description).toBe("Move Terno to Applications to get updates.");
    expect(checkResult(s({ type: "check-failed", at: 1, kind: "offline" })).description).toMatch(/couldn’t reach GitHub/);
    expect(checkResult(s({ type: "not-available", at: 1 })).description).toBe("You have the latest version (0.1.0).");
  });

  it("says it in Spanish too, every reason and error included", () => {
    setLocale("es", es);
    expect(checkResult(s(available()))).toMatchObject({ message: "Terno 0.2.0 está disponible", description: "Descárgala desde el botón de actualización de la barra lateral." });
    expect(checkResult(s({ type: "not-available", at: 1 })).description).toBe("Tienes la última versión (0.1.0).");
    expect(unsupportedText("translocated")).toBe("Mueve Terno a Aplicaciones para recibir actualizaciones.");
    expect(errorText("not-applied")).toBe("La actualización no se instaló. Terno sigue en la versión anterior.");
    expect(errorText("bogus" as never)).toBe("Algo salió mal. Inténtalo de nuevo en un momento.");
  });
});
