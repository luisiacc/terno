/**
 * Plan 17 on the PACKAGED app: a profile written by the previous version
 * (schema v13: no thread facts, no correspondents) opens, migrates to v14 in
 * the desktop backend, and its backfill runs in the utility process until
 * every thread's facts are known; Lumen's greeting then says how many
 * conversations wait for your reply, and the People chip filters. The v13
 * file is today's seeded profile with v14's additions taken out, exactly
 * what v13 created.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../../..");
const SOURCE_APP = join(here, "../release/mac-arm64/Terno.app");

let workdir: string;
let app: ElectronApplication;
let page: Page;
let dbPath: string;

test.describe.configure({ mode: "serial" });

/** v14 out: its indexes, the correspondents table, the new columns, the backfill's progress; user_version 13. */
function toV13(file: string): void {
  const db = new DatabaseSync(file);
  try {
    for (const ix of ["threads_people", "threads_people_id", "threads_waiting", "threads_waiting_id", "threads_waiting_inbox", "threads_facts_pending", "ops_failed_sends", "correspondents_own"]) db.exec(`DROP INDEX IF EXISTS ${ix}`);
    db.exec("DROP TABLE correspondents");
    db.exec("ALTER TABLE threads DROP COLUMN person");
    db.exec("ALTER TABLE threads DROP COLUMN waiting_since");
    db.exec("ALTER TABLE messages DROP COLUMN is_bulk");
    // and v15's (plan 34), which the seed of today writes
    db.exec("ALTER TABLE messages DROP COLUMN reply_to_json");
    db.exec("DELETE FROM settings WHERE key IN ('facts_backfill', 'facts_senders')");
    // nothing of v14 left for the migration to trip on
    const left = db.prepare("SELECT name FROM sqlite_master WHERE sql LIKE '%person%' OR sql LIKE '%waiting_since%' OR sql LIKE '%is_bulk%' OR name LIKE 'ops_failed_sends'").all();
    if (left.length) throw new Error(`v14 left behind: ${JSON.stringify(left)}`);
    db.exec("PRAGMA user_version = 13");
  } finally {
    db.close();
  }
}

const read = <T>(sql: string): T => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(sql).get() as T;
  } finally {
    db.close();
  }
};

test.beforeAll(async () => {
  test.skip(!existsSync(SOURCE_APP), "run `pnpm dist:mac` first");
  workdir = mkdtempSync(join("/tmp", "terno-people-smoke-"));
  const profile = join(workdir, "profile");
  execFileSync("pnpm", ["--filter", "@terno/backend-dev", "exec", "tsx", "src/seed.ts", "--out", profile, "--accounts", "2", "--threads", "1500"], { cwd: repo, stdio: "ignore" });
  dbPath = join(profile, "terno.db");
  // the search snapshot of the v14 file would be a newer version's: an upgrade starts without one
  rmSync(`${dbPath}.search`, { force: true });
  toV13(dbPath);
  expect(read<{ user_version: number }>("PRAGMA user_version").user_version).toBe(13);
  const appPath = join(workdir, "Terno.app");
  execFileSync("ditto", [SOURCE_APP, appPath]);
  const env = { ...process.env, TERNO_DEMO: "1", TERNO_TEST_LANGUAGES: "en-US", TERNO_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.TERNO_DEV_URL;
  app = await electron.launch({ executablePath: join(appPath, "Contents/MacOS/Terno"), env });
  page = await app.firstWindow();
  await page.locator("[data-testid=thread-row]").first().waitFor({ timeout: 60_000 });
});

test.afterAll(async () => {
  await app?.close();
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

test("a v13 profile migrates in the desktop backend; the backfill fills every thread's facts; the greeting counts and People filters", async () => {
  expect(read<{ user_version: number }>("PRAGMA user_version").user_version).toBe(15); // through v15 (plan 34: Reply-To)
  await expect.poll(() => read<{ c: number }>("SELECT count(*) AS c FROM threads WHERE person IS NULL").c, { timeout: 60_000 }).toBe(0);
  expect(read<{ v: string }>("SELECT value_json AS v FROM settings WHERE key = 'facts_backfill'").v).toBe('{"phase":"done"}');
  expect(read<{ c: number }>("SELECT count(*) AS c FROM correspondents WHERE own = 1").c).toBeGreaterThan(0);
  expect(read<{ c: number }>("SELECT count(*) AS c FROM threads WHERE person = 1").c).toBeGreaterThan(0);
  // the packaged app opens in Lumen: the greeting's count appears once the facts are known
  await expect(page.getByTestId("waiting-count")).toHaveText(/^\d+ waiting for your reply$/, { timeout: 30_000 });
  await page.getByTestId("quick-filter-people").click();
  await expect(page.getByTestId("thread-list")).toHaveAttribute("data-results-for", /"people"/);
  await expect(page.locator("[data-testid=thread-row]").first()).toBeVisible();
});
