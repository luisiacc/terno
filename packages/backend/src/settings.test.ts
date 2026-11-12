/** Appearance settings: defaults, round-trips, validation and fallbacks for themes that no longer exist. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient, type RpcError } from "@terno/core/rpc";
import { getSetting, setSetting, sqlDb } from "@terno/db";
import { demoRegistry } from "@terno/mail";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { followFavoriteFolders, readSettings } from "./settings";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "terno-settings-"));
  const backend = new Backend({ dbPath: join(dir, "u.db"), version: "t", cipher: plaintextCipher, providers: demoRegistry, autoSync: false });
  await backend.store.ready;
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "renderer", origin: "renderer" });
  cleanups.push(async () => {
    await backend.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  return { backend, client: new RpcClient(c) };
}

const errorOf = (p: Promise<unknown>) => p.then(() => null, (e: RpcError) => e);
const nord = { id: "mi-nord", name: "Mi Nord", mode: "dark" as const, extends: "nord" as const, tokens: { primary: "#88c0d0" } };

describe("appearance settings", () => {
  it("new installs get the defaults: Lumen in the GitHub palettes, following the system (plan 98)", async () => {
    const { client } = await setup();
    const s = (await client.call("app.bootstrap", {})).settings;
    expect(s).toMatchObject({ theme: "system", design: "lumen", lightTheme: "github-light", darkTheme: "github-dark", previousLightTheme: null, previousDarkTheme: null, motionMs: 75, htmlMailAppearance: "auto", customThemes: [] });
  });

  it("a legacy blob keeps its mode and gets the new fields' defaults", async () => {
    const { backend, client } = await setup();
    setSetting(sqlDb(backend.store), "app", { theme: "dark", density: "compact" });
    const s = (await client.call("app.bootstrap", {})).settings;
    expect(s).toMatchObject({ theme: "dark", density: "compact", design: "lumen", lightTheme: "design", darkTheme: "design", previousLightTheme: null, motionMs: 75, htmlMailAppearance: "auto", customThemes: [] });
    // plan 24: an install from before the layout setting is Split
    expect(s.layout).toBe("split");
    // plan 187: and one line of preview, as before
    expect(s.previewLines).toBe(1);
  });

  it("the preview's lines take none, one or two, and nothing else (plan 187)", async () => {
    const { client } = await setup();
    for (const n of [0, 2, 1] as const) expect((await client.call("settings.update", { previewLines: n })).previewLines).toBe(n);
    for (const bad of [3, -1, 1.5, "1"]) expect(await errorOf(client.call("settings.update", { previewLines: bad as never }))).toMatchObject({ code: "BAD_REQUEST" });
    expect((await client.call("app.bootstrap", {})).settings.previewLines).toBe(1);
  });

  it("every new field round-trips", async () => {
    const { backend, client } = await setup();
    const next = await client.call("settings.update", { lightTheme: "solarized-light", darkTheme: "custom:mi-nord", customThemes: [nord], motionMs: 0, htmlMailAppearance: "paper", theme: "light" });
    expect(next).toMatchObject({ lightTheme: "solarized-light", darkTheme: "custom:mi-nord", customThemes: [nord], motionMs: 0, htmlMailAppearance: "paper", theme: "light" });
    expect((await client.call("app.bootstrap", {})).settings).toMatchObject({ darkTheme: "custom:mi-nord", motionMs: 0 });
    for (const ms of [50, 100, 75] as const) expect((await client.call("settings.update", { motionMs: ms })).motionMs).toBe(ms);
    // persisted, not only echoed
    expect(getSetting<{ lightTheme?: string }>(sqlDb(backend.store), "app", {}).lightTheme).toBe("solarized-light");
  });

  it("rejects motion off the scale, unknown themes and themes of the other mode", async () => {
    const { client } = await setup();
    expect(await errorOf(client.call("settings.update", { motionMs: 60 as never }))).toMatchObject({ code: "BAD_REQUEST" });
    expect(await errorOf(client.call("settings.update", { lightTheme: "no-such-theme" }))).toMatchObject({ code: "BAD_REQUEST" });
    expect(await errorOf(client.call("settings.update", { lightTheme: "dracula" }))).toMatchObject({ code: "BAD_REQUEST" });
    expect(await errorOf(client.call("settings.update", { darkTheme: "custom:missing" }))).toMatchObject({ code: "BAD_REQUEST" });
    // a light-mode slot can't take a dark custom theme
    expect(await errorOf(client.call("settings.update", { customThemes: [nord], lightTheme: "custom:mi-nord" }))).toMatchObject({ code: "BAD_REQUEST" });
    expect(await errorOf(client.call("settings.update", { customThemes: [{ ...nord, tokens: { primary: "red;}body{display:none" } }] }))).toMatchObject({ code: "BAD_REQUEST" });
    expect((await client.call("app.bootstrap", {})).settings).toMatchObject({ lightTheme: "github-light", darkTheme: "github-dark", customThemes: [] });
  });

  it("deleting a custom theme in use falls back to Style colors", async () => {
    const { backend, client } = await setup();
    await client.call("settings.update", { customThemes: [nord], darkTheme: "custom:mi-nord" });
    const after = await client.call("settings.update", { customThemes: [] });
    expect(after.darkTheme).toBe("design");
    // and a stored id that names nothing (edited by hand, or a removed built-in) too
    setSetting(sqlDb(backend.store), "app", { appearanceVersion: 2, lightTheme: "retired-theme", darkTheme: "github-light" });
    expect((await client.call("app.bootstrap", {})).settings).toMatchObject({ lightTheme: "design", darkTheme: "design" });
  });

  it("reads themes saved under their Única ids as the Terno ones", async () => {
    const { backend, client } = await setup();
    setSetting(sqlDb(backend.store), "app", { appearanceVersion: 2, lightTheme: "unica-light", darkTheme: "custom:mi-nord", customThemes: [{ ...nord, extends: "unica-dark" }] });
    const settings = (await client.call("app.bootstrap", {})).settings;
    expect(settings).toMatchObject({ lightTheme: "terno-light", darkTheme: "custom:mi-nord" });
    expect(settings.customThemes[0]).toMatchObject({ id: "mi-nord", extends: "terno-dark" });
  });

  it("reads a theme saved with indigo's tokens with them under brown's, the user's colors kept (plan 194)", async () => {
    const { backend, client } = await setup();
    setSetting(sqlDb(backend.store), "app", { appearanceVersion: 2, darkTheme: "custom:mi-nord", customThemes: [{ ...nord, tokens: { "cat-indigo": "#3355ff" } }] });
    const settings = (await client.call("app.bootstrap", {})).settings;
    expect(settings.darkTheme).toBe("custom:mi-nord");
    expect(settings.customThemes[0]!.tokens).toEqual({ "cat-brown": "#3355ff" });
  });
});

describe("remote images (plan 37)", () => {
  it("a profile in local mode that stored always reads as ask; the next write persists it, and a later always sticks", async () => {
    const { backend, client } = await setup();
    setSetting(sqlDb(backend.store), "app", { localMode: true, remoteImages: "always" });
    expect((await client.call("app.bootstrap", {})).settings.remoteImages).toBe("ask");
    await client.call("settings.update", { motionMs: 50 });
    expect(getSetting<Record<string, unknown>>(sqlDb(backend.store), "app", {})).toMatchObject({ remoteImages: "ask", remoteImagesVersion: 1 });
    // turned on in local mode now: the user's choice, in force
    expect(await client.call("settings.update", { remoteImages: "always" })).toMatchObject({ localMode: true, remoteImages: "always" });
    expect((await client.call("app.bootstrap", {})).settings.remoteImages).toBe("always");
  });

  it("a profile without local mode stored keeps the default (on): always reads as ask", async () => {
    const { backend, client } = await setup();
    setSetting(sqlDb(backend.store), "app", { remoteImages: "always" });
    expect((await client.call("app.bootstrap", {})).settings.remoteImages).toBe("ask");
  });

  it("a connected profile keeps always, also after turning local mode on", async () => {
    const { backend, client } = await setup();
    setSetting(sqlDb(backend.store), "app", { localMode: false, remoteImages: "always" });
    expect((await client.call("app.bootstrap", {})).settings.remoteImages).toBe("always");
    expect(await client.call("settings.update", { localMode: true })).toMatchObject({ localMode: true, remoteImages: "always" });
  });

  it("the marker never reaches the renderer", async () => {
    const { client } = await setup();
    await client.call("settings.update", { motionMs: 50 });
    expect((await client.call("app.bootstrap", {})).settings).not.toHaveProperty("remoteImagesVersion");
  });
});

describe("error reports (plan 78)", () => {
  it("a profile in local mode that stored always reads as ask (it sent nothing before); a later always sticks", async () => {
    const { backend, client } = await setup();
    setSetting(sqlDb(backend.store), "app", { localMode: true, errorReports: "always" });
    expect((await client.call("app.bootstrap", {})).settings.errorReports).toBe("ask");
    await client.call("settings.update", { motionMs: 50 });
    expect(getSetting<Record<string, unknown>>(sqlDb(backend.store), "app", {})).toMatchObject({ errorReports: "ask", errorReportsVersion: 1 });
    expect(await client.call("settings.update", { errorReports: "always" })).toMatchObject({ localMode: true, errorReports: "always" });
    expect((await client.call("app.bootstrap", {})).settings.errorReports).toBe("always");
    expect((await client.call("app.bootstrap", {})).settings).not.toHaveProperty("errorReportsVersion");
  });

  it("a connected profile keeps always; never stays never", async () => {
    const { backend, client } = await setup();
    setSetting(sqlDb(backend.store), "app", { localMode: false, errorReports: "always" });
    expect((await client.call("app.bootstrap", {})).settings.errorReports).toBe("always");
    setSetting(sqlDb(backend.store), "app", { localMode: true, errorReports: "never" });
    expect((await client.call("app.bootstrap", {})).settings.errorReports).toBe("never");
  });
});

describe("designs (plan 15)", () => {
  it("an install from before designs moves to Lumen in its own colors; its palettes are remembered as previous, not applied", async () => {
    const { backend, client } = await setup();
    setSetting(sqlDb(backend.store), "app", { theme: "dark", lightTheme: "github-light", darkTheme: "custom:mi-nord", customThemes: [nord], density: "compact" });
    const s = (await client.call("app.bootstrap", {})).settings;
    expect(s).toMatchObject({ theme: "dark", density: "compact", design: "lumen", lightTheme: "design", darkTheme: "design", previousLightTheme: "github-light", previousDarkTheme: "custom:mi-nord" });
    // an unrelated change persists the move: choosing a design later never brings the old palette back
    await client.call("settings.update", { motionMs: 50 });
    const stored = getSetting<Record<string, unknown>>(sqlDb(backend.store), "app", {});
    expect(stored).toMatchObject({ appearanceVersion: 3, previousLightTheme: "github-light", motionMs: 50, lightTheme: "design", darkTheme: "design" });
    expect(await client.call("settings.update", { design: "macos" })).toMatchObject({ design: "macos", lightTheme: "design", previousLightTheme: "github-light" });
  });

  it("the old defaults and Única ids are remembered under their current names; one that no longer exists is forgotten", async () => {
    const { backend, client } = await setup();
    setSetting(sqlDb(backend.store), "app", { lightTheme: "unica-light", darkTheme: "retired-theme" });
    expect((await client.call("app.bootstrap", {})).settings).toMatchObject({ lightTheme: "design", previousLightTheme: "terno-light", previousDarkTheme: null });
  });

  it("a design and Style colors round-trip; an unknown design is refused, a stored one reads as Lumen", async () => {
    const { backend, client } = await setup();
    expect(await client.call("settings.update", { design: "atelier", lightTheme: "solarized-light" })).toMatchObject({ design: "atelier", lightTheme: "solarized-light" });
    expect(await client.call("settings.update", { lightTheme: "design", darkTheme: "design" })).toMatchObject({ lightTheme: "design", darkTheme: "design" });
    expect(await errorOf(client.call("settings.update", { design: "brutalist" as never }))).toMatchObject({ code: "BAD_REQUEST" });
    setSetting(sqlDb(backend.store), "app", { appearanceVersion: 2, design: "brutalist" });
    expect((await client.call("app.bootstrap", {})).settings.design).toBe("lumen");
  });

  it("plan 98: a profile from before the GitHub defaults keeps what it shows; one that chose keeps its choice", async () => {
    const { backend, client } = await setup();
    // v2, never chose a palette: it showed Lumen's own colors, and still does, also after an unrelated write
    setSetting(sqlDb(backend.store), "app", { appearanceVersion: 2, theme: "dark" });
    expect((await client.call("app.bootstrap", {})).settings).toMatchObject({ lightTheme: "design", darkTheme: "design" });
    expect((await client.call("app.bootstrap", {})).settings).toMatchObject({ lightTheme: "design", darkTheme: "design" });
    await client.call("settings.update", { motionMs: 50 });
    expect(getSetting<Record<string, unknown>>(sqlDb(backend.store), "app", {})).toMatchObject({ appearanceVersion: 3, lightTheme: "design", darkTheme: "design" });
    expect((await client.call("app.bootstrap", {})).settings).toMatchObject({ lightTheme: "design", darkTheme: "design" });
    // v2 with its own palettes: kept (and not remembered as "previous": that was v1's move)
    setSetting(sqlDb(backend.store), "app", { appearanceVersion: 2, lightTheme: "solarized-light", darkTheme: "nord" });
    expect((await client.call("app.bootstrap", {})).settings).toMatchObject({ lightTheme: "solarized-light", darkTheme: "nord", previousLightTheme: null });
    // a fresh profile's first unrelated write keeps the new defaults
    setSetting(sqlDb(backend.store), "app", {});
    await client.call("settings.update", { motionMs: 50 });
    expect(getSetting<Record<string, unknown>>(sqlDb(backend.store), "app", {})).toMatchObject({ appearanceVersion: 3 });
    expect(getSetting<Record<string, unknown>>(sqlDb(backend.store), "app", {}).lightTheme).toBeUndefined();
    expect((await client.call("app.bootstrap", {})).settings).toMatchObject({ lightTheme: "github-light", darkTheme: "github-dark" });
  });

  it("plan 138: a style's kept palettes persist and read like the slots: legacy names, and anything that no longer fits is its own colors", async () => {
    const { backend, client } = await setup();
    expect((await client.call("app.bootstrap", {})).settings.designPalettes).toEqual({});
    const kept = { lumen: { light: "github-light", dark: "dracula" }, graphite: { light: "design", dark: "custom:mi-nord" } };
    expect(await client.call("settings.update", { customThemes: [nord], designPalettes: kept })).toMatchObject({ designPalettes: kept });
    expect((await client.call("app.bootstrap", {})).settings.designPalettes).toEqual(kept);
    // a memory, not a slot: a custom palette deleted since is no reason to refuse anything
    expect((await client.call("settings.update", { customThemes: [] })).designPalettes.graphite).toEqual({ light: "design", dark: "design" });
    setSetting(sqlDb(backend.store), "app", { appearanceVersion: 3, designPalettes: { lumen: { light: "unica-light", dark: "github-light" }, retired: { light: "design", dark: "design" } } });
    expect((await client.call("app.bootstrap", {})).settings.designPalettes).toEqual({ lumen: { light: "terno-light", dark: "design" } });
    expect(await errorOf(client.call("settings.update", { designPalettes: { brutalist: { light: "design", dark: "design" } } as never }))).toMatchObject({ code: "BAD_REQUEST" });
  });

  it("a remembered palette of the wrong mode is forgotten", async () => {
    const { client } = await setup();
    expect(await client.call("settings.update", { previousLightTheme: "dracula", previousDarkTheme: "nord" })).toMatchObject({ previousLightTheme: null, previousDarkTheme: "nord" });
  });
});

describe("language", () => {
  it("new installs follow the system; a choice round-trips; anything else is refused or reads as system", async () => {
    const { backend, client } = await setup();
    expect((await client.call("app.bootstrap", {})).settings.language).toBe("system");
    expect((await client.call("settings.update", { language: "es" })).language).toBe("es");
    expect((await client.call("app.bootstrap", {})).settings.language).toBe("es");
    expect(await errorOf(client.call("settings.update", { language: "fr" as never }))).toMatchObject({ code: "BAD_REQUEST" });
    // a stored language Terno no longer ships (or garbage) reads as system
    setSetting(sqlDb(backend.store), "app", { language: "klingon" });
    expect((await client.call("app.bootstrap", {})).settings.language).toBe("system");
  });

  it("tells the host (main's menus) when it changes, and only then", async () => {
    const dir = mkdtempSync(join(tmpdir(), "terno-settings-"));
    const seen: string[] = [];
    const backend = new Backend({ dbPath: join(dir, "u.db"), version: "t", cipher: plaintextCipher, providers: demoRegistry, autoSync: false, onPolicy: (p) => seen.push(p.language) });
    const [c, s] = createMemoryTransportPair();
    backend.connect(s, { clientId: "renderer", origin: "renderer" });
    cleanups.push(async () => {
      await backend.stop();
      rmSync(dir, { recursive: true, force: true });
    });
    const client = new RpcClient(c);
    await client.call("settings.update", { theme: "dark" });
    await client.call("settings.update", { language: "es" });
    await client.call("settings.update", { language: "es" });
    await client.call("settings.update", { language: "system" });
    expect(seen).toEqual(["es", "system"]);
  });
});

describe("favorite folders (plan 107)", () => {
  it("a rename onto a stale favorite keeps one: every resulting favorite once (Codex code review round 16 #2)", async () => {
    const { backend } = await setup();
    // Work and Job favorited; Job deleted in another app before Terno read the list again; then Work → Job here
    setSetting(sqlDb(backend.store), "app", { favoriteFolders: [{ accountId: 7, folder: "Work", view: null }, { accountId: 7, folder: "Job", view: null }, { accountId: 8, folder: "Job", view: null }] });
    const next = await followFavoriteFolders(backend.store, 7, { renamed: [{ from: "Work", to: "Job" }] });
    expect(next).toEqual([{ accountId: 7, folder: "Job", view: null }, { accountId: 8, folder: "Job", view: null }]);
    expect(getSetting<{ favoriteFolders?: unknown }>(sqlDb(backend.store), "app", {}).favoriteFolders).toEqual(next);
    // the stale one first: the same
    setSetting(sqlDb(backend.store), "app", { favoriteFolders: [{ accountId: 7, folder: "Job", view: null }, { accountId: 7, folder: "Work", view: null }] });
    expect(await followFavoriteFolders(backend.store, 7, { renamed: [{ from: "Work", to: "Job" }] })).toEqual([{ accountId: 7, folder: "Job", view: null }]);
  });
});

describe("reading the settings", () => {
  it("what the AI section shows is read together: a slow read holds up nothing beside it", async () => {
    const { backend } = await setup();
    const get = backend.store.settings.get.bind(backend.store.settings);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    // the origins wait for the hints: read one after the other, this would never answer
    vi.spyOn(backend.store.settings, "get").mockImplementation(async (key: string, fallback: unknown) => {
      if (key === "ai:keyOrigins") await held;
      if (key === "ai:keyHints") release();
      return get(key, fallback) as never;
    });
    await expect(readSettings(backend.store)).resolves.toMatchObject({ ai: { hasKey: false, keyHint: null } });
  });
});
