/**
 * Upgrading from Única, on the PACKAGED app with throwaway keychain items
 * (TERNO_TEST_APP_NAME / TERNO_TEST_LEGACY_APP_NAME stand in for "Terno" and
 * "Única", so the real items are never touched). A legacy profile
 * ("Unica-smoke": unica.db, secrets sealed under the old name's item,
 * localStorage on app://unica) is renamed, its secrets are sealed again under
 * the new item and its localStorage moves to app://terno. Without the old item,
 * nothing is lost and Settings asks for the key again.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE_APP = join(here, "../release/mac-arm64/Terno.app");
const tag = Date.now().toString(36);
const LEGACY = `Terno Smoke Legacy ${tag}`;
const NEW = `Terno Smoke ${tag}`;
const MISSING = `Terno Smoke Missing ${tag}`;
const SECRETS = { "account:1:password": "throwaway-imap-pässword", "ai:openai:apiKey": "sk-throwaway-0000-4242" } as const;

let workdir: string;
let appPath: string;
const running: ElectronApplication[] = [];

function launch(profile: string, env: Record<string, string>) {
  const e: Record<string, string | undefined> = { ...process.env, TERNO_DEMO: "1", TERNO_USER_DATA: profile, ...env };
  delete e.ELECTRON_RUN_AS_NODE;
  return electron.launch({ executablePath: join(appPath, "Contents/MacOS/Terno"), env: e as Record<string, string> }).then((a) => (running.push(a), a));
}

const sqlite = (file: string) => new DatabaseSync(file);
const threadCount = (file: string) => {
  const db = sqlite(file);
  try {
    return (db.prepare("SELECT count(*) AS n FROM threads").get() as { n: number }).n;
  } finally {
    db.close();
  }
};

/**
 * What Única left behind: a profile named Unica-<x> with unica.db, the secrets
 * sealed under LEGACY's keychain item by this same executable, and localStorage
 * on the old renderer origin. Returns the profile path Terno will use.
 */
async function legacyProfile(name: string): Promise<{ profile: string; threads: number; sealed: Record<string, number[]> }> {
  const profile = join(workdir, `Terno-${name}`);
  const app = await launch(profile, { TERNO_TEST_APP_NAME: LEGACY });
  const page = await app.firstWindow();
  await page.locator("[data-testid=thread-row]").first().waitFor({ timeout: 60_000 });
  const sealed = await app.evaluate(({ safeStorage }, secrets) => Object.fromEntries(Object.entries(secrets).map(([k, v]) => [k, [...safeStorage.encryptString(v)]])), SECRETS);
  await page.goto("app://unica/__storage-migration");
  await page.evaluate(() => {
    localStorage.setItem("unica:first-run", "done");
    localStorage.setItem("unica:appearance", JSON.stringify({ mode: "dark", light: "unica-light", dark: "unica-dark", motion: 50 }));
  });
  await app.close();
  const dbFile = join(profile, "terno.db");
  const db = sqlite(dbFile);
  for (const [key, blob] of Object.entries(sealed)) db.prepare("INSERT OR REPLACE INTO secrets (name, blob) VALUES (?, ?)").run(key, Uint8Array.from(blob));
  // Única knew nothing of the keychain state; its AI was OpenAI with that key, out of local mode
  db.prepare("DELETE FROM settings WHERE key = 'secrets.keychain'").run();
  const app0 = JSON.parse((db.prepare("SELECT value_json FROM settings WHERE key = 'app'").get() as { value_json: string } | undefined)?.value_json ?? "{}");
  db.prepare("INSERT OR REPLACE INTO settings (key, value_json) VALUES ('app', ?)").run(JSON.stringify({ ...app0, localMode: false, ai: { provider: "openai", profiles: { openai: { model: "gpt-x" } } } }));
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  const threads = threadCount(dbFile);
  for (const suffix of ["-wal", "-shm", ".search", ""]) if (existsSync(dbFile + suffix)) renameSync(dbFile + suffix, join(profile, `unica.db${suffix}`));
  rmSync(join(profile, "legacy-storage-moved"), { force: true });
  renameSync(profile, join(workdir, `Unica-${name}`));
  return { profile, threads, sealed };
}

test.beforeAll(() => {
  test.skip(!existsSync(SOURCE_APP), "run `pnpm dist:mac` first");
  workdir = mkdtempSync(join("/tmp", "terno-migration-"));
  appPath = join(workdir, "Terno.app");
  execFileSync("ditto", [SOURCE_APP, appPath]);
});

test.afterAll(async () => {
  for (const a of running) await a.close().catch(() => {});
  // the throwaway keychain items this run created
  for (const name of [LEGACY, NEW, MISSING]) {
    try {
      execFileSync("security", ["delete-generic-password", "-s", `${name} Safe Storage`], { stdio: "ignore" });
    } catch {
      /* not created */
    }
  }
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

test("a legacy profile is renamed, its secrets sealed again under the new keychain item and its localStorage moved", async () => {
  const { profile, threads, sealed } = await legacyProfile("smoke");
  const app = await launch(profile, { TERNO_TEST_APP_NAME: NEW, TERNO_TEST_LEGACY_APP_NAME: LEGACY });
  const page = await app.firstWindow();
  await page.locator("[data-testid=thread-row]").first().waitFor({ timeout: 60_000 });

  expect(existsSync(join(workdir, "Unica-smoke"))).toBe(false);
  expect(existsSync(join(profile, "unica.db"))).toBe(false);
  expect(threadCount(join(profile, "terno.db"))).toBe(threads);

  // every blob was replaced, and the new ones open under the new name's item
  const db = sqlite(join(profile, "terno.db"));
  const rows = db.prepare("SELECT name, blob FROM secrets ORDER BY name").all() as { name: string; blob: Uint8Array }[];
  const state = JSON.parse((db.prepare("SELECT value_json FROM settings WHERE key = 'secrets.keychain'").get() as { value_json: string }).value_json);
  db.close();
  expect(rows.map((r) => r.name)).toEqual(Object.keys(SECRETS));
  for (const r of rows) expect([...r.blob]).not.toEqual(sealed[r.name]);
  expect(state).toEqual({ generation: "terno", pending: {} });
  const opened = await app.evaluate(({ safeStorage }, blobs) => blobs.map((b) => safeStorage.decryptString(Buffer.from(b))), rows.map((r) => [...r.blob]));
  expect(opened).toEqual(Object.values(SECRETS));

  // the renderer's localStorage came along from app://unica, under Terno's key names
  expect(page.url()).toBe("app://terno/");
  expect(await page.evaluate(() => [localStorage.getItem("terno:first-run"), localStorage.getItem("unica:first-run")])).toEqual(["done", null]);
  await app.close();
});

test("without the old keychain item nothing is lost: the blobs stay, the app runs, Settings asks for the key again", async () => {
  const { profile, threads, sealed } = await legacyProfile("fallback");
  const app = await launch(profile, { TERNO_TEST_APP_NAME: NEW, TERNO_TEST_LEGACY_APP_NAME: MISSING });
  const page = await app.firstWindow();
  await page.locator("[data-testid=thread-row]").first().waitFor({ timeout: 60_000 });
  expect(threadCount(join(profile, "terno.db"))).toBe(threads);

  const db = sqlite(join(profile, "terno.db"));
  const rows = db.prepare("SELECT name, blob FROM secrets ORDER BY name").all() as { name: string; blob: Uint8Array }[];
  const state = JSON.parse((db.prepare("SELECT value_json FROM settings WHERE key = 'secrets.keychain'").get() as { value_json: string }).value_json);
  db.close();
  for (const r of rows) expect([...r.blob]).toEqual(sealed[r.name]);
  expect(Object.keys(state.pending).sort()).toEqual(Object.keys(SECRETS));

  await page.keyboard.press("Meta+Comma");
  await page.getByTestId("tab-ai").click();
  await expect(page.getByTestId("ai-key-unreadable")).toContainText("Terno no pudo abrir la API key que guardó Única");
  await app.close();
});
