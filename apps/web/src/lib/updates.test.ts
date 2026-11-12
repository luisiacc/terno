import { initialUpdateState, reduceUpdate, type UpdateEvent, type UpdateState } from "@terno/core/updates";
import { setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import { afterEach, describe, expect, it } from "vitest";
import { aboutStatus, checkResult, errorText, pillModel, unsupportedText } from "./updates";

afterEach(() => setLocale("en", en));

const info = (version: string) => ({ version, notes: "", size: 1, releaseDate: null });
const s = (...events: UpdateEvent[]): UpdateState => events.reduce(reduceUpdate, initialUpdateState({ current: "0.1.0", mode: "auto", channel: "stable" }));
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

describe("updates: Settings → About's row (plan 190)", () => {
  const at = (...events: UpdateEvent[]) => aboutStatus(s(...events));

  it("always has something to say: not checked, checking, up to date with when, an offer, the download, the check of it", () => {
    expect(at()).toEqual({ kind: "idle", checkedAt: null });
    expect(at({ type: "check-start" })).toEqual({ kind: "checking" });
    expect(at({ type: "not-available", at: 5 })).toEqual({ kind: "up-to-date", checkedAt: 5 });
    expect(at(available())).toEqual({ kind: "available", update: info("0.2.0") });
    expect(at(available(), { type: "download-start" }, { type: "download-progress", percent: 42 })).toEqual({ kind: "downloading", version: "0.2.0", percent: 42 });
    expect(at(available(), { type: "download-start" }, { type: "downloaded" })).toEqual({ kind: "verifying", version: "0.2.0" });
    // a cancelled check settles on idle with the time it last answered
    expect(at({ type: "not-available", at: 5 }, { type: "check-start" }, { type: "cancelled" })).toEqual({ kind: "idle", checkedAt: 5 });
  });

  it("names the download by its own version, not a newer offer that arrived meanwhile", () => {
    const downloading = [available("0.2.0"), { type: "download-start" }, available("0.3.0")] as UpdateEvent[];
    expect(at(...downloading)).toMatchObject({ kind: "downloading", version: "0.2.0" });
    expect(at(...downloading, { type: "downloaded" })).toMatchObject({ kind: "verifying", version: "0.2.0" });
  });

  it("a ready update wins, and says when it's restarting, waiting for a send, or why the last restart was refused", () => {
    expect(at(...ready)).toEqual({ kind: "ready", update: info("0.2.0"), deferred: false, installing: false, refused: null });
    // a later failed check or newer offer doesn't hide it
    expect(at(...ready, { type: "check-failed", at: 2, kind: "offline" })).toMatchObject({ kind: "ready", refused: null });
    expect(at(...ready, available("0.3.0"))).toMatchObject({ kind: "ready", update: { version: "0.2.0" } });
    expect(at(...ready, { type: "install-start" })).toMatchObject({ kind: "ready", installing: true });
    expect(at(...ready, { type: "install-start" }, { type: "install-deferred", reason: "sending" })).toMatchObject({ kind: "ready", deferred: true });
    expect(at(...ready, { type: "install-start" }, { type: "install-failed", kind: "unsaved" })).toMatchObject({ kind: "ready", installing: false, refused: "unsaved" });
  });

  it("a failed download or verification settles on the offer with the error beside it: Try Again downloads; a failed check or install looks again", () => {
    expect(at(available(), { type: "download-start" }, { type: "download-failed", kind: "offline" })).toEqual({ kind: "error", stage: "download", error: "offline", retry: "download" });
    expect(at(available(), { type: "download-start" }, { type: "downloaded" }, { type: "verify-failed", kind: "integrity" })).toEqual({ kind: "error", stage: "verify", error: "integrity", retry: "download" });
    expect(at({ type: "check-failed", at: 1, kind: "server" })).toEqual({ kind: "error", stage: "check", error: "server", retry: "check" });
    expect(at({ type: "not-applied", version: "0.2.0" })).toEqual({ kind: "error", stage: "install", error: "not-applied", retry: "check" });
  });

  it("a check that never reached main isn't shown as the stale answer before it", () => {
    expect(aboutStatus(s({ type: "not-available", at: 5 }), { checkFailed: true })).toEqual({ kind: "error", stage: "check", error: "unknown", retry: "check" });
    // a staged update is still true
    expect(aboutStatus(s(...ready), { checkFailed: true })).toMatchObject({ kind: "ready" });
  });

  it("an unsupported copy says why; a required update on one points to the download page instead of the updater", () => {
    expect(at({ type: "unsupported", reason: "dmg" })).toEqual({ kind: "unsupported", reason: "dmg" });
    expect(at({ type: "policy", minimum: "0.5.0" })).toEqual({ kind: "required", version: "0.5.0", working: false, unsupported: null });
    expect(at({ type: "policy", minimum: "0.5.0" }, { type: "unsupported", reason: "translocated" })).toEqual({ kind: "required", version: "0.5.0", working: false, unsupported: "translocated" });
    expect(at({ type: "policy", minimum: "0.5.0" }, { type: "update-now", on: true })).toMatchObject({ kind: "required", working: true });
  });
});
