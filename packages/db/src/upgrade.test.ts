/**
 * Plan 255: before an open, the schema is read and nothing else; there is no
 * backup. A commit a crash left only in the WAL is part of what's read and
 * of what's migrated.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS, SCHEMA_VERSION } from "./migrations";
import { nodeSqliteDriver } from "./node-driver";
import { SchemaNewerError } from "./open-errors";
import { openDatabaseWith } from "./portable";
import { oldMailbox } from "./test/old-mailbox";
import { mailboxSchema, removeOldBackups } from "./upgrade";

const PREV = SCHEMA_VERSION - 1;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const workdir = () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-upgrade-"));
  dirs.push(dir);
  return { dir, db: join(dir, "terno.db") };
};

/** A Terno that crashed: these statements' commits live only in the -wal, beside a -shm. */
function crashAfter(path: string, sql: string): void {
  const r = spawnSync(process.execPath, ["-e", `const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(${JSON.stringify(path)}); db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0"); db.exec(${JSON.stringify(sql)}); process.exit(0);`]);
  expect(r.status).toBe(0);
  expect(existsSync(`${path}-wal`)).toBe(true);
}

describe("before an open (plan 255)", () => {
  it("no mailbox yet: null; one from a newer Terno: SchemaNewerError, the file untouched", () => {
    const w = workdir();
    expect(mailboxSchema(w.db)).toBeNull();
    oldMailbox(w.db, PREV, 1);
    const raw = new DatabaseSync(w.db);
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    raw.close();
    expect(() => mailboxSchema(w.db)).toThrow(SchemaNewerError);
  });

  it("a crash-left WAL: the schema read is SQLite's own, and the commit only in the WAL survives the migration (Codex plan review #12)", () => {
    const w = workdir();
    oldMailbox(w.db, PREV - 1, 1);
    // the step to PREV (its real SQL, as migrate runs it: a rebuild of a referenced table with foreign keys off, plan 259)
    // and a draft, both only in the WAL: the main file's header still says PREV - 1
    const step = MIGRATIONS.find((m) => m.version === PREV)!;
    crashAfter(w.db, `${step.rebuildsReferenced ? "PRAGMA foreign_keys = OFF; " : ""}${step.sql}; PRAGMA user_version = ${PREV}; INSERT INTO drafts (id, generation, account_id, format, mode, to_json, cc_json, subject, body_text, body_html, updated_at) VALUES (99, 'g', 1, 2, 'new', '[]', '[]', 'only in the WAL', '', '', 5)`);
    expect(mailboxSchema(w.db)).toBe(PREV);
    const db = openDatabaseWith(nodeSqliteDriver, w.db);
    try {
      expect(db.get<{ user_version: number }>("PRAGMA user_version")!.user_version).toBe(SCHEMA_VERSION);
      expect(db.all<{ subject: string }>("SELECT subject FROM drafts ORDER BY id").map((r) => r.subject)).toEqual(["draft 1", "only in the WAL"]);
      // the schema is whole: the step in the WAL and the one after it both there (Codex code review #9)
      const fresh = openDatabaseWith(nodeSqliteDriver, ":memory:");
      const shape = (d: typeof db) => d.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r.name);
      try {
        expect(shape(db)).toEqual(shape(fresh));
      } finally {
        fresh.close();
      }
    } finally {
      db.close();
    }
  });

  it("an earlier build's backups folder goes, whatever it holds; none is fine", async () => {
    const w = workdir();
    await removeOldBackups(w.db);
    const gen = join(w.dir, "backups", "1000-v1-v2");
    mkdirSync(gen, { recursive: true });
    writeFileSync(join(gen, "terno.db"), Buffer.alloc(4096));
    writeFileSync(join(w.dir, "backups", ".partial-x"), "");
    await removeOldBackups(w.db);
    expect(existsSync(join(w.dir, "backups"))).toBe(false);
  });
});
