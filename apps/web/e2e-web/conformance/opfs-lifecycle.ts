import type { SAHPoolUtil } from "@sqlite.org/sqlite-wasm";
import { Db, MIGRATIONS, openDatabaseWith, SCHEMA_VERSION, type SqliteDriver } from "@terno/db/wasm";
import { describe, expect, it } from "./shim";

/** Sync access handles exclude each other across every worker of the origin: what another tab would run into. */
async function poolFilesFree(directory: string): Promise<boolean> {
  let dir = await navigator.storage.getDirectory();
  for (const part of [directory, ".opaque"]) dir = await dir.getDirectoryHandle(part);
  const iterable = dir as unknown as { values(): AsyncIterable<FileSystemHandle> };
  for await (const entry of iterable.values()) {
    try {
      (await (entry as FileSystemFileHandle).createSyncAccessHandle()).close();
    } catch {
      return false;
    }
  }
  return true;
}

const version = (db: Db) => db.get<{ user_version: number }>("PRAGMA user_version")!.user_version;
const count = (db: Db, table: string) => db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)!.n;

/** An older mailbox on the pool: its migrations alone, then one row each to carry over. */
function mailboxAt(driver: SqliteDriver, path: string, at: number): void {
  const db = new Db(driver, path);
  for (const m of MIGRATIONS.filter((m) => m.version <= at)) db.exec(m.sql);
  db.exec(`PRAGMA user_version = ${at}`);
  db.run("INSERT INTO accounts (id, kind, email, display_name, provider_config, created_at) VALUES (1, 'imap', 'synthetic@example.test', 'Synthetic', '{}', 0)");
  db.close();
}

export function defineOpfsLifecycle(driver: SqliteDriver, pool: SAHPoolUtil, directory: string): void {
  describe("OPFS lifecycle", () => {
    it("a new file migrates from nothing, and what was written is there after a reopen", () => {
      const db = openDatabaseWith(driver, "/lifecycle-new.db");
      expect(version(db)).toBe(SCHEMA_VERSION);
      expect(db.get<{ journal_mode: string }>("PRAGMA journal_mode")!.journal_mode).toBe("truncate");
      db.run("INSERT INTO settings (key, value_json) VALUES ('lifecycle', '1')");
      db.close();
      const again = openDatabaseWith(driver, "/lifecycle-new.db");
      expect(again.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = 'lifecycle'")!.value_json).toBe("1");
      again.close();
    });

    it("a mailbox from the previous version migrates and keeps its rows", () => {
      mailboxAt(driver, "/lifecycle-old.db", SCHEMA_VERSION - 1);
      const db = openDatabaseWith(driver, "/lifecycle-old.db");
      expect(version(db)).toBe(SCHEMA_VERSION);
      expect(count(db, "accounts")).toBe(1);
      db.close();
    });

    it("a step that fails leaves the file at its version, and a later open can still read it", () => {
      // the newest step that creates a table, with that table already there
      const creating = [...MIGRATIONS].reverse().find((m) => /CREATE TABLE/i.test(m.sql))!;
      mailboxAt(driver, "/lifecycle-conflict.db", creating.version - 1);
      const raw = new Db(driver, "/lifecycle-conflict.db");
      raw.exec(creating.sql);
      raw.close();
      expect(() => openDatabaseWith(driver, "/lifecycle-conflict.db")).toThrow();
      const after = new Db(driver, "/lifecycle-conflict.db");
      expect(version(after)).toBe(creating.version - 1);
      expect(count(after, "accounts")).toBe(1);
      after.close();
    });

    it("a failed multi-table write rolls back through the journal, past pages already in the file", () => {
      const db = openDatabaseWith(driver, "/lifecycle-atomic.db");
      db.run("INSERT INTO accounts (id, kind, email, display_name, provider_config, created_at) VALUES (1, 'imap', 'synthetic@example.test', 'Synthetic', '{}', 0)");
      // a small cache spills dirty pages into the file before the commit, so only the journal can put them back
      db.exec("PRAGMA cache_size = 8");
      const pages = () => db.get<{ page_count: number }>("PRAGMA page_count")!.page_count;
      const before = pages();
      expect(() =>
        db.tx(() => {
          for (let i = 0; i < 200; i++) {
            db.run("INSERT INTO settings (key, value_json) VALUES (?, ?)", `spill-${i}`, JSON.stringify("x".repeat(4096)));
            db.run("INSERT INTO accounts (id, kind, email, display_name, provider_config, created_at) VALUES (?, 'imap', ?, 'Synthetic', '{}', 0)", i + 2, `s${i}@example.test`);
          }
          // it did reach the file: the rollback below has real work to do
          expect(pages()).toBeGreaterThan(before + 100);
          throw new Error("refused");
        }),
      ).toThrow("refused");
      db.close();
      const after = openDatabaseWith(driver, "/lifecycle-atomic.db");
      expect(count(after, "accounts")).toBe(1);
      expect(after.get<{ n: number }>("SELECT count(*) AS n FROM settings WHERE key LIKE 'spill-%'")!.n).toBe(0);
      expect(after.get<{ integrity_check: string }>("PRAGMA integrity_check")!.integrity_check).toBe("ok");
      after.close();
    });

    it("taking over: the handles can't be released while the mailbox is open; released, another tab could have them; taken back, the mail is there", async () => {
      const db = openDatabaseWith(driver, "/lifecycle-takeover.db");
      db.run("INSERT INTO settings (key, value_json) VALUES ('takeover', '1')");
      expect(() => pool.pauseVfs()).toThrow();
      expect(await poolFilesFree(directory)).toBe(false);
      db.close();
      pool.pauseVfs();
      expect(pool.isPaused()).toBe(true);
      expect(await poolFilesFree(directory)).toBe(true);
      await pool.unpauseVfs();
      expect(await poolFilesFree(directory)).toBe(false);
      const again = openDatabaseWith(driver, "/lifecycle-takeover.db");
      expect(again.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = 'takeover'")!.value_json).toBe("1");
      again.close();
    });
  });
}
