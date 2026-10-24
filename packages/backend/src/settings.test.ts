/** Appearance settings: defaults, round-trips, validation and fallbacks for themes that no longer exist. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient, type RpcError } from "@terno/core/rpc";
import { getSetting, setSetting, sqlDb } from "@terno/db";
import { demoRegistry } from "@terno/mail";
import { afterEach, describe, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "unica-settings-"));
  const backend = new Backend({ dbPath: join(dir, "u.db"), version: "t", cipher: plaintextCipher, providers: demoRegistry, autoSync: false });
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
  it("new installs get the defaults", async () => {
    const { client } = setup();
    const s = (await client.call("app.bootstrap", {})).settings;
    expect(s).toMatchObject({ theme: "system", lightTheme: "unica-light", darkTheme: "unica-dark", motionMs: 75, htmlMailAppearance: "auto", customThemes: [] });
  });

  it("a legacy blob keeps its mode and gets the new fields' defaults", async () => {
    const { backend, client } = setup();
    setSetting(sqlDb(backend.store), "app", { theme: "dark", density: "compact" });
    const s = (await client.call("app.bootstrap", {})).settings;
    expect(s).toMatchObject({ theme: "dark", density: "compact", lightTheme: "unica-light", darkTheme: "unica-dark", motionMs: 75, htmlMailAppearance: "auto", customThemes: [] });
  });

  it("every new field round-trips", async () => {
    const { backend, client } = setup();
    const next = await client.call("settings.update", { lightTheme: "solarized-light", darkTheme: "custom:mi-nord", customThemes: [nord], motionMs: 0, htmlMailAppearance: "paper", theme: "light" });
    expect(next).toMatchObject({ lightTheme: "solarized-light", darkTheme: "custom:mi-nord", customThemes: [nord], motionMs: 0, htmlMailAppearance: "paper", theme: "light" });
    expect((await client.call("app.bootstrap", {})).settings).toMatchObject({ darkTheme: "custom:mi-nord", motionMs: 0 });
    for (const ms of [50, 100, 75] as const) expect((await client.call("settings.update", { motionMs: ms })).motionMs).toBe(ms);
    // persisted, not only echoed
    expect(getSetting<{ lightTheme?: string }>(sqlDb(backend.store), "app", {}).lightTheme).toBe("solarized-light");
  });

  it("rejects motion off the scale, unknown themes and themes of the other mode", async () => {
    const { client } = setup();
    expect(await errorOf(client.call("settings.update", { motionMs: 60 as never }))).toMatchObject({ code: "BAD_REQUEST" });
    expect(await errorOf(client.call("settings.update", { lightTheme: "no-such-theme" }))).toMatchObject({ code: "BAD_REQUEST" });
    expect(await errorOf(client.call("settings.update", { lightTheme: "dracula" }))).toMatchObject({ code: "BAD_REQUEST" });
    expect(await errorOf(client.call("settings.update", { darkTheme: "custom:missing" }))).toMatchObject({ code: "BAD_REQUEST" });
    // a light-mode slot can't take a dark custom theme
    expect(await errorOf(client.call("settings.update", { customThemes: [nord], lightTheme: "custom:mi-nord" }))).toMatchObject({ code: "BAD_REQUEST" });
    expect(await errorOf(client.call("settings.update", { customThemes: [{ ...nord, tokens: { primary: "red;}body{display:none" } }] }))).toMatchObject({ code: "BAD_REQUEST" });
    expect((await client.call("app.bootstrap", {})).settings).toMatchObject({ lightTheme: "unica-light", darkTheme: "unica-dark", customThemes: [] });
  });

  it("deleting a custom theme in use falls back to the mode's default", async () => {
    const { backend, client } = setup();
    await client.call("settings.update", { customThemes: [nord], darkTheme: "custom:mi-nord" });
    const after = await client.call("settings.update", { customThemes: [] });
    expect(after.darkTheme).toBe("unica-dark");
    // and a stored id that names nothing (edited by hand, or a removed built-in) too
    setSetting(sqlDb(backend.store), "app", { lightTheme: "retired-theme", darkTheme: "github-light" });
    expect((await client.call("app.bootstrap", {})).settings).toMatchObject({ lightTheme: "unica-light", darkTheme: "unica-dark" });
  });
});
