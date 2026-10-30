/**
 * Plan 17 on the PACKAGED app: a profile written by the previous version
 * (schema v13: no thread facts, no correspondents) opens, migrates to v30 in
 * the desktop backend, and its backfill runs in the utility process until
 * every thread's facts are known; Lumen's greeting then says how many
 * conversations wait for your reply, and the People chip filters. The v13
 * file copies today's populated seed into the schema v13 actually created.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

import { blockExternal, cleanupOwned, closePackaged } from "./packaged-fixture";
import { profileFacts, toV13 } from "./people-profile";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../../..");
const SOURCE_APP = join(here, "../release/mac-arm64/Terno.app");

let workdir: string;
let app: ElectronApplication;
let page: Page;
let dbPath: string;
let preserved: ReturnType<typeof profileFacts>;
const PACKAGED_SCHEMA_VERSION = 30; // source HEAD 2ac773241e and current main

test.describe.configure({ mode: "serial" });

const read = <T>(sql: string): T => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(sql).get() as T;
  } finally {
    db.close();
  }
};

test.beforeAll(async () => {
  expect(existsSync(SOURCE_APP), "packaged app fixture must exist").toBe(true);
  workdir = mkdtempSync(join("/tmp", "terno-people-smoke-"));
  const profile = join(workdir, "profile");
  execFileSync("pnpm", ["--filter", "@terno/backend-dev", "exec", "tsx", "src/seed.ts", "--out", profile, "--accounts", "2", "--threads", "1500"], { cwd: repo, stdio: "ignore" });
  dbPath = join(profile, "terno.db");
  // the search snapshot of the current file would be a newer version's: an upgrade starts without one
  rmSync(`${dbPath}.search`, { force: true });
  preserved = profileFacts(dbPath);
  expect(preserved.counts.slice(0, 4).every((n) => n > 0)).toBe(true);
  toV13(dbPath);
  expect(profileFacts(dbPath)).toEqual(preserved);
  expect(read<{ user_version: number }>("PRAGMA user_version").user_version).toBe(13);
  const appPath = join(workdir, "Terno.app");
  execFileSync("ditto", [SOURCE_APP, appPath]);
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), TERNO_DEMO: "1", TERNO_TEST_LANGUAGES: "en-US", TERNO_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.TERNO_DEV_URL;
  delete env.TERNO_SMOKE_SCREENSHOT;
  app = await electron.launch({ executablePath: join(appPath, "Contents/MacOS/Terno"), env });
  await blockExternal(app);
  page = await app.firstWindow();
  await page.locator("[data-testid=thread-row]").first().waitFor({ timeout: 60_000 });
});

test.afterAll(async () => {
  await cleanupOwned([() => closePackaged(app), () => { if (workdir) rmSync(workdir, { recursive: true, force: true }); }]);
});

test("a v13 profile migrates in the desktop backend; the backfill fills every thread's facts; the greeting counts and People filters", async () => {
  expect(read<{ user_version: number }>("PRAGMA user_version").user_version).toBe(PACKAGED_SCHEMA_VERSION);
  expect(profileFacts(dbPath)).toEqual(preserved);
  expect(JSON.parse(read<{ v: string }>("SELECT value_json AS v FROM settings WHERE key = 'app'").v).design).toBe("lumen");
  await expect.poll(() => read<{ c: number }>("SELECT count(*) AS c FROM threads WHERE person IS NULL").c, { timeout: 60_000 }).toBe(0);
  expect(read<{ v: string }>("SELECT value_json AS v FROM settings WHERE key = 'facts_backfill'").v).toBe('{"phase":"done"}');
  expect(read<{ c: number }>("SELECT count(*) AS c FROM correspondents WHERE own = 1").c).toBeGreaterThan(0);
  expect(read<{ c: number }>("SELECT count(*) AS c FROM threads WHERE person = 1").c).toBeGreaterThan(0);
  // the fixture explicitly selects Lumen: the greeting's count appears once the facts are known
  await expect(page.getByTestId("waiting-count")).toHaveText(/^\d+ waiting for your reply$/, { timeout: 30_000 });
  await page.getByTestId("quick-filter-people").click();
  await expect(page.getByTestId("thread-list")).toHaveAttribute("data-results-for", /"people"/);
  await expect(page.locator("[data-testid=thread-row]").first()).toBeVisible();
});
