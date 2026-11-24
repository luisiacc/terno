/**
 * Plan 95 on the PACKAGED app, with throwaway profiles (TERNO_USER_DATA):
 * the real backend, real migrations and a real disk. There is no backup
 * before a migration (plan 255).
 *
 * - an older mailbox is migrated; the window opens as usual, never covered,
 *   and an earlier build's backups/ goes
 * - a mailbox from a newer Terno: the gate says so, and nothing restarts the
 *   backend on a timer (one backend.started in the log)
 * - a step that fails (a table the migration creates is already there): the
 *   gate says so, Try Again tries once more, the file stays at its version
 * - a full disk is packages/db's upgrade.volumes.int.test.ts: Electron
 *   can't start its own profile on a disk that full
 * - a damaged mailbox: the gate says so, and the file is left as it is
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { MIGRATIONS, SCHEMA_VERSION } from "../../../packages/db/src/migrations";
import { nodeSqliteDriver } from "../../../packages/db/src/node-driver";
import { Db } from "../../../packages/db/src/sqlite";
import { BODY_READY_APPLICATION_ID } from "../../../packages/db/src/body-upgrade";
import { closePackaged } from "./packaged-fixture";

const here = dirname(fileURLToPath(import.meta.url));
const APP = join(here, "../release/mac-arm64/Terno.app");
const PREV = SCHEMA_VERSION - 1;

let work: string;
let app: ElectronApplication | undefined;

test.beforeAll(() => {
  if (!existsSync(APP)) throw new Error("release/mac-arm64/Terno.app missing: run `pnpm dist:mac` first");
  work = mkdtempSync(join(tmpdir(), "terno-mailbox-smoke-"));
});

test.afterEach(async () => {
  await closePackaged(app);
  app = undefined;
});

test.afterAll(() => {
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
  // its bodies converted, as every recent Terno leaves it: the backend's own open migrates it (plan 253)
  db.exec(`PRAGMA application_id = ${BODY_READY_APPLICATION_ID}`);
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

const gate = (page: Page) => page.getByTestId("mailbox-gate");

// @alone: test:startup, by itself: it times the window against the cover's 400 ms
test("an older mailbox: migrated with no backup, an earlier build's backups removed, and the window opens as usual, never covered (plan 255)", { tag: "@alone" }, async () => {
  const userData = profile("older");
  const db = join(userData, "terno.db");
  // ~200 MB: a backup of it would have taken seconds (a copy) or held its first write (a clone)
  oldMailbox(db, { drafts: 5, bodyKb: 40_000 });
  const old = join(userData, "backups", "1000-v1-v2");
  mkdirSync(old, { recursive: true });
  writeFileSync(join(old, "terno.db"), Buffer.alloc(1 << 20));
  const page = await launch(userData);
  // watched until the mailbox is ready: the cover never appeared
  let covered = false;
  for (const until = Date.now() + 60_000; ; ) {
    if (await gate(page).count()) covered = true;
    if (await page.locator("[data-ready]").count()) break;
    if (Date.now() > until) throw new Error("the mailbox never opened");
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(covered).toBe(false);
  await expect(gate(page)).toHaveCount(0);
  await expect.poll(() => existsSync(join(userData, "backups")), { timeout: 10_000 }).toBe(false);
  await closePackaged(app);
  app = undefined;
  expect(facts(db)).toEqual({ version: SCHEMA_VERSION, drafts: 5 });
  expect(existsSync(join(userData, "backups"))).toBe(false);
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
  // the restart policy's first try would come at 0.5 s, and one more start is what fails below
  await page.waitForTimeout(2_000);
  await closePackaged(app);
  app = undefined;
  expect(logged(userData, "backend.started")).toBe(1);
  expect(facts(db).version).toBe(SCHEMA_VERSION + 1);
});

test("a step that fails: the gate names it, Try Again tries once more, the file stays at its version", async () => {
  const userData = profile("conflict");
  const db = join(userData, "terno.db");
  // the newest step that creates a table, with that table already there (a hand-edited or half-restored file)
  const creating = [...MIGRATIONS].reverse().find((m) => /CREATE TABLE/i.test(m.sql) && !/RENAME TO/i.test(m.sql))!; // a rebuild (create, copy, rename) replays cleanly: not a step whose replay fails
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
  // plan 255: the step rolled back in its transaction; no backup was made
  expect(existsSync(join(userData, "backups"))).toBe(false);
});

test("a damaged mailbox: the gate says so with Try Again and Export Diagnostics, and the file is left as it is", async () => {
  const userData = profile("damaged");
  const db = join(userData, "terno.db");
  writeFileSync(db, Buffer.alloc(64 * 1024, 0x5a));
  const page = await launch(userData);
  await expect(gate(page)).toHaveAttribute("data-kind", "corrupt", { timeout: 30_000 });
  await expect(gate(page)).toContainText("Terno can’t read it.");
  await expect(gate(page).getByRole("button")).toHaveText(["Try Again", "Export diagnostics…"]);
  await closePackaged(app);
  app = undefined;
  expect(readFileSync(db)).toEqual(Buffer.alloc(64 * 1024, 0x5a));
});
