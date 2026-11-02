/**
 * Plan 95 on the PACKAGED app, with throwaway profiles (TERNO_USER_DATA):
 * the real backend, real migrations and a real disk.
 *
 * - an older mailbox is backed up (a clone, plan 112), then migrated; the
 *   window opens as usual, never covered
 * - a mailbox from a newer Terno: the gate says so, and nothing restarts the
 *   backend on a timer (one backend.started in the log)
 * - a step that fails (a table the migration creates is already there): the
 *   gate says so, Try Again tries once more, the file stays at its version
 * - a profile on a nearly full disk image: "no room", then Update Without a
 *   Backup migrates
 * - a damaged mailbox with a backup: Restore, after which a send queued in the
 *   backup is not sent again
 */
import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statfsSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { MIGRATIONS, SCHEMA_VERSION } from "../../../packages/db/src/migrations";
import { nodeSqliteDriver } from "../../../packages/db/src/node-driver";
import { Db } from "../../../packages/db/src/sqlite";
import { closePackaged } from "./packaged-fixture";

const here = dirname(fileURLToPath(import.meta.url));
const APP = join(here, "../release/mac-arm64/Terno.app");
const PREV = SCHEMA_VERSION - 1;

let work: string;
let app: ElectronApplication | undefined;
const mounts: string[] = [];

test.beforeAll(() => {
  if (!existsSync(APP)) throw new Error("release/mac-arm64/Terno.app missing: run `pnpm dist:mac` first");
  work = mkdtempSync(join(tmpdir(), "terno-mailbox-smoke-"));
});

test.afterEach(async () => {
  await closePackaged(app);
  app = undefined;
});

test.afterAll(() => {
  while (mounts.length) spawnSync("hdiutil", ["detach", mounts.pop()!, "-force"]);
  rmSync(work, { recursive: true, force: true });
});

function profile(name: string): string {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function launch(userData: string): Promise<Page> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), TERNO_USER_DATA: userData, TERNO_TEST_LANGUAGES: "en-US" };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: join(APP, "Contents/MacOS/Terno"), env });
  const until = Date.now() + 60_000;
  for (;;) {
    const page = app.windows().find((p) => !p.isClosed() && p.url().startsWith("app://terno/"));
    if (page) return page;
    if (Date.now() > until) throw new Error("the window never opened");
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** An older Terno's mailbox: an account, drafts, a queued send and local mode off. */
function oldMailbox(path: string, o: { version?: number; drafts?: number; bodyKb?: number } = {}): void {
  const db = new Db(nodeSqliteDriver, path);
  const version = o.version ?? PREV;
  for (const m of MIGRATIONS.filter((m) => m.version <= version)) db.exec(m.sql);
  db.exec(`PRAGMA user_version = ${version}`);
  db.run("INSERT INTO accounts (id, kind, email, display_name, provider_config, created_at) VALUES (1, 'imap', 'synthetic@example.test', 'Synthetic', '{}', 0)");
  db.tx(() => {
    for (let i = 1; i <= (o.drafts ?? 3); i++) {
      db.run("INSERT INTO drafts (id, generation, account_id, format, mode, to_json, cc_json, subject, body_text, body_html, updated_at) VALUES (?, 'g', 1, 2, 'new', '[]', '[]', ?, hex(randomblob(?)), '', 5)", i, `draft ${i}`, (o.bodyKb ?? 1) * 512);
    }
  });
  db.run("INSERT INTO ops (id, seq, account_id, kind, target_json, payload_json, state, created_at, updated_at) VALUES ('op-1', 1, 1, 'send', '{}', '{}', 'queued', 1, 1)");
  db.run("INSERT INTO settings (key, value_json) VALUES ('app', ?)", JSON.stringify({ localMode: false }));
  db.close();
}

const facts = (path: string) => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const one = <T>(sql: string) => db.prepare(sql).get() as T;
    return {
      version: one<{ user_version: number }>("PRAGMA user_version").user_version,
      drafts: one<{ n: number }>("SELECT count(*) AS n FROM drafts").n,
    };
  } finally {
    db.close();
  }
};

const logged = (userData: string, code: string) => {
  const dir = join(userData, "logs");
  if (!existsSync(dir)) return 0;
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => readFileSync(join(dir, f), "utf8").split("\n").filter((l) => l.includes(`"${code}"`)).length)
    .reduce((a, b) => a + b, 0);
};

/** the fields of the backend's "mailbox.backup_made" line (plan 112: how it was made, and how long it took) */
const backupMade = (userData: string): { method?: string; durationMs: number } | null => {
  const dir = join(userData, "logs");
  for (const f of existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith(".jsonl")) : [])
    for (const line of readFileSync(join(dir, f), "utf8").split("\n"))
      if (line.includes('"mailbox.backup_made"')) return (JSON.parse(line) as { fields: { method?: string; durationMs: number } }).fields;
  return null;
};

const gate = (page: Page) => page.getByTestId("mailbox-gate");

test("an older mailbox: backed up, migrated, and the window opens as usual, never covered (plan 112)", async () => {
  const userData = profile("older");
  const db = join(userData, "terno.db");
  // ~200 MB: a full copy takes seconds, past the cover's 400 ms; a clone doesn't
  oldMailbox(db, { drafts: 5, bodyKb: 40_000 });
  const page = await launch(userData);
  // watched until the mailbox is ready: the cover never appeared (a sample; the log below is the proof)
  let covered = false;
  for (const until = Date.now() + 60_000; ; ) {
    if (await gate(page).count()) covered = true;
    if (await page.locator("[data-ready]").count()) break;
    if (Date.now() > until) throw new Error("the mailbox never opened");
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(covered).toBe(false);
  await expect(gate(page)).toHaveCount(0);
  await closePackaged(app);
  app = undefined;
  expect(facts(db)).toEqual({ version: SCHEMA_VERSION, drafts: 5 });
  const generations = readdirSync(join(userData, "backups"));
  expect(generations).toHaveLength(1);
  const manifest = JSON.parse(readFileSync(join(userData, "backups", generations[0]!, "manifest.json"), "utf8")) as { fromSchema: number; toSchema: number };
  expect(manifest).toMatchObject({ fromSchema: PREV, toSchema: SCHEMA_VERSION, method: "clone" });
  expect(facts(join(userData, "backups", generations[0]!, "terno.db"))).toEqual({ version: PREV, drafts: 5 });
  expect(logged(userData, "mailbox.backup_made")).toBe(1);
  // the cover waits 400 ms before it shows: a backup (and its lock) done well inside that never shows it (Codex code review #5)
  const made = backupMade(userData);
  expect(made).toMatchObject({ method: "clone" });
  expect(made!.durationMs).toBeLessThan(400);
});

test("a mailbox from a newer Terno: the gate says so, and the backend isn't restarted on a timer", async () => {
  const userData = profile("newer");
  const db = join(userData, "terno.db");
  oldMailbox(db, { version: SCHEMA_VERSION });
  const raw = new DatabaseSync(db);
  raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
  raw.close();
  const page = await launch(userData);
  await expect(gate(page)).toHaveAttribute("data-kind", "newer", { timeout: 30_000 });
  await expect(gate(page)).toContainText("This mailbox is from a newer version of Terno");
  // its way forward is there on a cold start, though the mail engine never connected (Codex review R4)
  await expect(page.getByTestId("update-now")).toBeVisible();
  await expect(page.getByTestId("update-now")).toHaveText("Update Terno");
  await expect(page.getByTestId("engine-stopped")).toHaveCount(0);
  // the restart policy would have tried again within 0.5 + 1 + 2 + 4 s
  await page.waitForTimeout(9_000);
  await closePackaged(app);
  app = undefined;
  expect(logged(userData, "backend.started")).toBe(1);
  expect(facts(db).version).toBe(SCHEMA_VERSION + 1);
});

test("a step that fails: the gate names it, Try Again tries once more, the file stays at its version", async () => {
  const userData = profile("conflict");
  const db = join(userData, "terno.db");
  // the newest step that creates a table, with that table already there (a hand-edited or half-restored file)
  const creating = [...MIGRATIONS].reverse().find((m) => /CREATE TABLE/i.test(m.sql))!;
  oldMailbox(db, { version: creating.version - 1 });
  const raw = new DatabaseSync(db);
  raw.exec(creating.sql);
  raw.close();
  const page = await launch(userData);
  await expect(gate(page)).toHaveAttribute("data-kind", "migration", { timeout: 30_000 });
  await expect(gate(page)).toContainText("Terno couldn’t update your mailbox");
  await page.getByTestId("mailbox-retry").click();
  await expect(gate(page)).toHaveAttribute("data-kind", "migration", { timeout: 30_000 });
  await page.waitForTimeout(2_000);
  await closePackaged(app);
  app = undefined;
  expect(logged(userData, "backend.started")).toBe(2);
  expect(facts(db).version).toBe(creating.version - 1);
  // its backup was made before the step failed, and kept for the retry
  expect(readdirSync(join(userData, "backups"))).toHaveLength(1);
});

test("a nearly full disk: 'no room' with the numbers, then Update Without a Backup migrates", async () => {
  const image = join(work, "tight.dmg");
  const made = spawnSync("hdiutil", ["create", "-size", "160m", "-fs", "HFS+", "-volname", "TernoTight", "-o", image], { encoding: "utf8" });
  test.skip(made.status !== 0, `hdiutil can't make a disk image here: ${made.stderr}`);
  const mount = join(work, "tight");
  mkdirSync(mount);
  execFileSync("hdiutil", ["attach", "-nobrowse", "-mountpoint", mount, image]);
  mounts.push(mount);
  const userData = join(mount, "profile");
  mkdirSync(userData);
  const db = join(userData, "terno.db");
  // ~24 MB: the backup and the migration need ~100 MB, the migration alone ~76 MB
  oldMailbox(db, { drafts: 48, bodyKb: 500 });
  const free = () => {
    const s = statfsSync(mount);
    return Number(s.bavail) * Number(s.bsize);
  };
  const filler = join(mount, "filler.bin");
  const fd = openSync(filler, "w");
  const block = Buffer.alloc(1 << 20, 0xab);
  while (free() > 85 * 2 ** 20) writeSync(fd, block);
  closeSync(fd);
  const page = await launch(userData);
  await expect(gate(page)).toHaveAttribute("data-kind", "no-room", { timeout: 30_000 });
  await expect(gate(page)).toContainText(/including a backup of it\. \d+[.,]\d MB is free now/);
  await page.getByTestId("mailbox-skip-backup").click();
  await page.locator("[data-ready]").waitFor({ timeout: 60_000 });
  await expect(gate(page)).toHaveCount(0);
  await closePackaged(app);
  app = undefined;
  expect(facts(db)).toEqual({ version: SCHEMA_VERSION, drafts: 48 });
  expect(existsSync(join(userData, "backups")) ? readdirSync(join(userData, "backups")) : []).toEqual([]);
  expect(statSync(filler).size).toBeGreaterThan(0);
});

test("a damaged mailbox with a backup: Restore brings it back, and a queued send isn't sent again", async () => {
  const userData = profile("damaged");
  const db = join(userData, "terno.db");
  // the backup an earlier upgrade made (its manifest names its file and size)
  const gen = join(userData, "backups", `${Date.UTC(2026, 9, 20, 12)}-v${PREV}-v${SCHEMA_VERSION}`);
  mkdirSync(gen, { recursive: true });
  oldMailbox(join(gen, "terno.db"), { drafts: 4 });
  const c = new DatabaseSync(join(gen, "terno.db"));
  c.exec("PRAGMA journal_mode = DELETE");
  c.close();
  writeFileSync(join(gen, "manifest.json"), JSON.stringify({ file: "terno.db", fromSchema: PREV, toSchema: SCHEMA_VERSION, appVersion: "0.2.0", size: statSync(join(gen, "terno.db")).size, createdAt: Date.UTC(2026, 9, 20, 12) }));
  writeFileSync(db, Buffer.alloc(64 * 1024, 0x5a));
  const page = await launch(userData);
  await expect(gate(page)).toHaveAttribute("data-kind", "corrupt", { timeout: 30_000 });
  await expect(gate(page)).toContainText("Terno has a copy from October 20, 2026");
  await page.getByTestId("mailbox-restore").click();
  await page.getByTestId("mailbox-restore-confirm-confirm").click();
  await page.locator("[data-ready]").waitFor({ timeout: 60_000 });
  await expect(gate(page)).toHaveCount(0);
  await expect(page.getByTestId("snack-dock")).toContainText("Mailbox restored from the copy of October 20, 2026");
  await closePackaged(app);
  app = undefined;
  expect(facts(db)).toEqual({ version: SCHEMA_VERSION, drafts: 4 });
  const check = new DatabaseSync(db, { readOnly: true });
  try {
    expect(check.prepare("SELECT state FROM ops WHERE id = 'op-1'").get()).toEqual({ state: "failed" });
  } finally {
    check.close();
  }
  // the damaged file is kept aside, and the marker was handled
  expect(existsSync(`${db}.before-restore`)).toBe(true);
  expect(existsSync(`${db}.restored.json`)).toBe(false);
  expect(existsSync(`${db}.restore.json`)).toBe(false);
});
