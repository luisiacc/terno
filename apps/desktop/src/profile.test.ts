import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLocale, setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LegacyProfileConflictError, LegacyProfileInUseError } from "./legacy-profile";
import { LOCALE_FILE, writeLanguage } from "./locale";

const electron = vi.hoisted(() => ({
  app: { setName: vi.fn(), getPath: vi.fn(() => "/nowhere"), setPath: vi.fn(), exit: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock("electron", () => electron);

const migration = vi.hoisted(() => ({ error: null as unknown }));
vi.mock("./legacy-profile", async (importOriginal) => {
  const real = await importOriginal<typeof import("./legacy-profile")>();
  return {
    ...real,
    migrateLegacyProfile: () => {
      throw migration.error;
    },
  };
});

const { prepareProfile, refusal } = await import("./profile");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "terno-profile-"));
  process.env.TERNO_USER_DATA = dir;
  vi.clearAllMocks();
});
afterEach(() => {
  delete process.env.TERNO_USER_DATA;
  rmSync(dir, { recursive: true, force: true });
  setLocale("en", en);
});

describe("main: a profile that can't be made ready", () => {
  it("explains each refusal in English by default", () => {
    expect(refusal(new LegacyProfileInUseError("/x/terno.db"))).toEqual({ title: "Única is still open", message: expect.stringContaining("Quit Única and open Terno again") });
    const conflict = refusal(new LegacyProfileConflictError(["/p/terno.db-wal", "/p/terno.db-shm"]));
    expect(conflict.title).toBe("Couldn’t move your mail from Única to Terno");
    expect(conflict.message).toContain("\n\n/p/terno.db-wal\n/p/terno.db-shm\n\n");
    expect(refusal(new Error("disk full")).message).toBe("disk full\n\nNothing was deleted. Quit Única and open Terno again.");
  });

  it("returns false at once, then shows the box in the profile's saved language and exits", async () => {
    writeLanguage(dir, "es");
    migration.error = new LegacyProfileInUseError(join(dir, "terno.db"));
    expect(prepareProfile()).toBe(false);
    expect(electron.dialog.showErrorBox).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(electron.app.exit).toHaveBeenCalledWith(1));
    expect(electron.dialog.showErrorBox).toHaveBeenCalledWith("Única sigue abierta", "Cierra Única y vuelve a abrir Terno: tu correo pasa a Terno en cuanto Única no lo esté usando.");
    expect(getLocale()).toBe("es");
    expect(electron.app.setPath).not.toHaveBeenCalled();
  });

  it("without a saved language (before ready there are no system languages): English", async () => {
    expect(existsSync(join(dir, LOCALE_FILE))).toBe(false);
    migration.error = new Error("unreadable");
    expect(prepareProfile()).toBe(false);
    await vi.waitFor(() => expect(electron.app.exit).toHaveBeenCalledWith(1));
    expect(electron.dialog.showErrorBox).toHaveBeenCalledWith("Couldn’t move your mail from Única to Terno", "unreadable\n\nNothing was deleted. Quit Única and open Terno again.");
  });
});
