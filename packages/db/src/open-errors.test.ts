import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS, migrate, SCHEMA_VERSION } from "./migrations";
import { nodeSqliteDriver } from "./node-driver";
import { classifyOpenError, MigrationError } from "./open-errors";
import { openDatabaseWith } from "./portable";
import { Db } from "./sqlite";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    chmodSync(d, 0o700);
    rmSync(d, { recursive: true, force: true });
  }
});

const PREV = SCHEMA_VERSION - 1;

function at(version: number): { dir: string; path: string; db: Db } {
  const dir = mkdtempSync(join(tmpdir(), "terno-open-"));
  dirs.push(dir);
  const path = join(dir, "terno.db");
  const db = new Db(nodeSqliteDriver, path);
  for (const m of MIGRATIONS.filter((m) => m.version <= version)) db.exec(m.sql);
  db.exec(`PRAGMA user_version = ${version}`);
  return { dir, path, db };
}

const version = (db: Db) => db.get<{ user_version: number }>("PRAGMA user_version")!.user_version;

describe("why a mailbox couldn't open (plan 95)", () => {
  it("a step that fails names itself, and the file stays at the step before", () => {
    const { db } = at(PREV - 1);
    // a table the next step creates is already there (a hand-edited or half-restored file)
    db.exec("CREATE TABLE scheduled_sends (x)");
    const error = (() => {
      try {
        migrate(db);
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(MigrationError);
    expect(error).toMatchObject({ step: SCHEMA_VERSION });
    expect(version(db)).toBe(PREV);
    expect(classifyOpenError(error)).toEqual({ kind: "failed", reason: "migration", step: SCHEMA_VERSION });
    db.close();
  });

  it("a migration that runs out of room (a real SQLITE_FULL) rolls back, keeps SQLite's error, and is 'no room'", () => {
    const { db } = at(PREV);
    for (let i = 0; i < 50; i++) db.run("INSERT INTO accounts (kind, email, display_name, provider_config, created_at) VALUES ('imap', ?, '', '{}', 0)", `a${i}@example.test`);
    const pages = db.get<{ page_count: number }>("PRAGMA page_count")!.page_count;
    db.exec(`PRAGMA max_page_count = ${pages}`);
    let error: unknown;
    try {
      migrate(db);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(MigrationError);
    // the cause is SQLite's own (not a failed ROLLBACK's "no transaction is active")
    expect(((error as MigrationError).cause as { errcode: number }).errcode & 0xff).toBe(13);
    expect(classifyOpenError(error, () => ({ needBytes: 10, freeBytes: 1 }))).toEqual({ kind: "no-room", stage: "migrate", needBytes: 10, freeBytes: 1, canSkipBackup: false });
    expect(version(db)).toBe(PREV);
    // nothing of the step is left behind
    expect(db.get("SELECT name FROM sqlite_master WHERE name = 'scheduled_sends'")).toBeUndefined();
    db.exec("PRAGMA max_page_count = 1073741823");
    migrate(db);
    expect(version(db)).toBe(SCHEMA_VERSION);
    db.close();
  });

  it("a write that fills the database inside a transaction keeps SQLite's error after the rollback", () => {
    const { db } = at(SCHEMA_VERSION);
    const pages = db.get<{ page_count: number }>("PRAGMA page_count")!.page_count;
    db.exec(`PRAGMA max_page_count = ${pages}`);
    let error: unknown;
    try {
      db.tx(() => {
        for (let i = 0; i < 2000; i++) db.run("INSERT INTO accounts (kind, email, display_name, provider_config, created_at) VALUES ('imap', ?, ?, '{}', 0)", `f${i}@example.test`, "x".repeat(500));
      });
    } catch (e) {
      error = e;
    }
    expect((error as { errcode?: number }).errcode! & 0xff).toBe(13);
    expect(db.inTransaction).toBe(false);
    expect(db.autocommit).toBe(true);
    db.close();
  });

  it("a damaged file is 'corrupt', and the failed open is closed (the file can be replaced and opened again)", () => {
    const { dir, db } = at(PREV);
    db.close();
    const path = join(dir, "garbage.db");
    writeFileSync(path, Buffer.alloc(16384, 0x5a));
    let error: unknown;
    try {
      openDatabaseWith(nodeSqliteDriver, path);
    } catch (e) {
      error = e;
    }
    expect(classifyOpenError(error)).toMatchObject({ kind: "failed", reason: "corrupt" });
    rmSync(path);
    openDatabaseWith(nodeSqliteDriver, path).close();
  });

  it("a mailbox in a folder Terno can't write to is 'unwritable'", () => {
    if (process.getuid?.() === 0) return;
    const { dir, path, db } = at(PREV);
    db.close();
    chmodSync(path, 0o444);
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
    chmodSync(dir, 0o555);
    let error: unknown;
    try {
      openDatabaseWith(nodeSqliteDriver, path);
    } catch (e) {
      error = e;
    }
    expect(classifyOpenError(error)).toMatchObject({ kind: "failed", reason: "unwritable" });
  });

  it("an error it doesn't recognise stays a crash", () => {
    expect(classifyOpenError(new Error("something else"))).toBeNull();
  });
});
