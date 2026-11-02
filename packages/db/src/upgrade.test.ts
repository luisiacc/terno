import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS, SCHEMA_VERSION } from "./migrations";
import { nodeSqliteDriver } from "./node-driver";
import { BackupError, classifyOpenError, NoRoomError, SchemaNewerError } from "./open-errors";
import { openDatabaseWith } from "./portable";
import { Db } from "./sqlite";
import { oldMailbox } from "./test/old-mailbox";
import { BACKUP_RETENTION_MS, expireBackups, listBackups, prepareUpgrade, type UpgradeOptions } from "./upgrade";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      chmodSync(d, 0o700);
    } catch {
      /* gone */
    }
    rmSync(d, { recursive: true, force: true });
  }
});

const PREV = SCHEMA_VERSION - 1;
const GiB = 2 ** 30;

function workdir() {
  const dir = mkdtempSync(join(tmpdir(), "terno-upgrade-"));
  dirs.push(dir);
  return { dir, db: join(dir, "terno.db"), backups: join(dir, "backups") };
}

const contents = (path: string) => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      version: (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      drafts: (db.prepare("SELECT subject FROM drafts ORDER BY id").all() as { subject: string }[]).map((r) => r.subject),
    };
  } finally {
    db.close();
  }
};

/** plan 95's tests take the full-copy path (the backup API); plan 112's clone path has its own below */
const opts = (w: { backups: string }, o: Partial<UpgradeOptions> = {}): UpgradeOptions => ({ backupsDir: w.backups, appVersion: "0.2.0", freeBytes: () => 100 * GiB, volume: () => false, ...o });

describe("prepareUpgrade (plan 95)", () => {
  it("a fresh install and a current mailbox have nothing to back up (and a current start makes no backups folder)", async () => {
    const w = workdir();
    expect(await prepareUpgrade(w.db, opts(w))).toEqual({ from: null, to: SCHEMA_VERSION, backup: null, made: false });
    const db = openDatabaseWith(nodeSqliteDriver, w.db);
    db.close();
    let backedUp = false;
    expect(await prepareUpgrade(w.db, opts(w, { onBackup: () => (backedUp = true) }))).toMatchObject({ from: SCHEMA_VERSION, backup: null, made: false });
    expect(backedUp).toBe(false);
    expect(existsSync(w.backups)).toBe(false);
  });

  it("backs an older mailbox up as an immutable generation with its manifest, then the migration runs on the original", async () => {
    const w = workdir();
    oldMailbox(w.db, PREV, 3);
    const before = contents(w.db);
    let told = 0;
    const plan = await prepareUpgrade(w.db, opts(w, { now: () => 1_000, onBackup: () => told++ }));
    expect(told).toBe(1);
    expect(plan).toMatchObject({ from: PREV, to: SCHEMA_VERSION, made: true, backup: { id: `1000-v${PREV}-v${SCHEMA_VERSION}`, fromSchema: PREV, toSchema: SCHEMA_VERSION, appVersion: "0.2.0", createdAt: 1000 } });
    expect(readdirSync(w.backups)).toEqual([plan.backup!.id]);
    expect(JSON.parse(readFileSync(join(plan.backup!.dir, "manifest.json"), "utf8"))).toMatchObject({ file: "terno.db", fromSchema: PREV, toSchema: SCHEMA_VERSION });
    expect(contents(plan.backup!.file)).toEqual(before);
    // the mailbox itself was only read
    expect(contents(w.db)).toEqual(before);
    const db = openDatabaseWith(nodeSqliteDriver, w.db);
    expect(db.get<{ user_version: number }>("PRAGMA user_version")!.user_version).toBe(SCHEMA_VERSION);
    db.close();
    // the backup is still the mailbox from before
    expect(contents(plan.backup!.file)).toEqual(before);
  });

  it("copies commits that live only in the WAL, while another connection holds the file", async () => {
    const w = workdir();
    oldMailbox(w.db, PREV, 1);
    const writer = new DatabaseSync(w.db);
    writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
    writer.exec("INSERT INTO drafts (id, generation, account_id, format, mode, to_json, cc_json, subject, body_text, body_html, updated_at) VALUES (99, 'g', 1, 2, 'new', '[]', '[]', 'only in the WAL', '', '', 5)");
    try {
      const plan = await prepareUpgrade(w.db, opts(w));
      expect(contents(plan.backup!.file).drafts).toContain("only in the WAL");
      // a backup is self-contained: no WAL travels with it
      expect(readdirSync(plan.backup!.dir).sort()).toEqual(["manifest.json", "terno.db"]);
    } finally {
      writer.close();
    }
  });

  it("a retry after a migration failed halfway keeps the backup from before the upgrade started", async () => {
    const w = workdir();
    oldMailbox(w.db, PREV - 1, 2);
    const first = await prepareUpgrade(w.db, opts(w, { now: () => 1_000 }));
    expect(first.backup!.fromSchema).toBe(PREV - 1);
    // one step went through, the next failed: the file is in between
    const db = new Db(nodeSqliteDriver, w.db);
    db.exec(MIGRATIONS.find((m) => m.version === PREV)!.sql);
    db.exec(`PRAGMA user_version = ${PREV}`);
    db.close();
    const again = await prepareUpgrade(w.db, opts(w, { now: () => 2_000 }));
    expect(again).toMatchObject({ from: PREV, made: false, backup: { id: first.backup!.id, fromSchema: PREV - 1 } });
    expect(listBackups(w.backups).map((b) => b.id)).toEqual([first.backup!.id]);
  });

  it("refuses a mailbox from a newer Terno, with the words the web worker matches", async () => {
    const w = workdir();
    oldMailbox(w.db, PREV);
    const raw = new DatabaseSync(w.db);
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    raw.close();
    const error = await prepareUpgrade(w.db, opts(w)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SchemaNewerError);
    expect((error as Error).message).toMatch(/newer than this app/);
    expect(classifyOpenError(error)).toEqual({ kind: "newer", schema: SCHEMA_VERSION + 1, supported: SCHEMA_VERSION });
  });

  it("checks the room first: a backup that doesn't fit says how much is needed, and whether the migration alone fits", async () => {
    const w = workdir();
    oldMailbox(w.db, PREV, 50);
    const room = (free: number) => prepareUpgrade(w.db, opts(w, { freeBytes: () => free })).then(() => { throw new Error("expected no room"); }, (e: unknown) => e as NoRoomError);
    const none = await room(1024);
    expect(none).toBeInstanceOf(NoRoomError);
    expect(none).toMatchObject({ stage: "backup", freeBytes: 1024, canSkipBackup: false });
    expect(none.needBytes).toBeGreaterThan(64 * 2 ** 20);
    const migrationFits = await room(none.needBytes - 1);
    expect(migrationFits).toMatchObject({ stage: "backup", canSkipBackup: true });
    expect(existsSync(w.backups) ? readdirSync(w.backups) : []).toEqual([]);
    // the user chose to go on without one
    expect(await prepareUpgrade(w.db, opts(w, { freeBytes: () => 1024, skipBackup: true }))).toMatchObject({ from: PREV, backup: null, made: false });
  });

  for (const [code, kind] of [
    ["ENOSPC", "no-room"],
    ["EACCES", "unwritable"],
    ["EROFS", "unwritable"],
    ["EIO", "failed"],
  ] as const) {
    it(`a copy that fails with ${code} leaves no partial folder, the mailbox as it was, and says ${kind}`, async () => {
      const w = workdir();
      oldMailbox(w.db, PREV, 4);
      const before = contents(w.db);
      const failing: UpgradeOptions["backup"] = async (_db, path) => {
        writeFileSync(path, "half a copy");
        throw Object.assign(new Error(`${code}: write`), { code });
      };
      const error = await prepareUpgrade(w.db, opts(w, { backup: failing })).catch((e: unknown) => e);
      if (kind === "no-room") expect(error).toBeInstanceOf(NoRoomError);
      else expect(error).toMatchObject({ name: "BackupError", kind });
      expect(classifyOpenError(error)).toMatchObject(kind === "no-room" ? { kind: "no-room", stage: "backup" } : { kind: "failed", reason: kind === "unwritable" ? "unwritable" : "backup" });
      expect(readdirSync(w.backups)).toEqual([]);
      expect(contents(w.db)).toEqual(before);
    });
  }

  it("a copy that doesn't verify (another file, or missing pages) and a failed fsync are failures, cleaned up", async () => {
    const w = workdir();
    oldMailbox(w.db, PREV, 4);
    const wrong: UpgradeOptions["backup"] = async (_db, path) => {
      const other = new DatabaseSync(path);
      other.exec("PRAGMA user_version = 3");
      other.close();
      return 1;
    };
    expect(await prepareUpgrade(w.db, opts(w, { backup: wrong })).catch((e: unknown) => e)).toBeInstanceOf(BackupError);
    expect(readdirSync(w.backups)).toEqual([]);
    const error = await prepareUpgrade(w.db, opts(w, { fsync: () => { throw Object.assign(new Error("EIO"), { code: "EIO" }); } })).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "BackupError", kind: "failed" });
    expect(readdirSync(w.backups)).toEqual([]);
    // and once the disk behaves, the backup is made
    expect(await prepareUpgrade(w.db, opts(w))).toMatchObject({ made: true });
  });

  it("a real permission error: a backups folder Terno can't write to", async () => {
    if (process.getuid?.() === 0) return; // root writes anywhere
    const w = workdir();
    oldMailbox(w.db, PREV);
    mkdirSync(w.backups);
    chmodSync(w.backups, 0o500);
    const error = await prepareUpgrade(w.db, opts(w)).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "BackupError", kind: "unwritable" });
    expect(classifyOpenError(error)).toEqual({ kind: "failed", reason: "unwritable", step: null });
  });

  it("removes what a crash left (a partial folder, a generation whose manifest doesn't match its file) and never trusts it", async () => {
    const w = workdir();
    oldMailbox(w.db, PREV);
    mkdirSync(join(w.backups, ".partial-5-v1-v2"), { recursive: true });
    writeFileSync(join(w.backups, ".partial-5-v1-v2", "terno.db"), "x");
    const torn = join(w.backups, `5-v${PREV}-v${SCHEMA_VERSION}`);
    mkdirSync(torn);
    writeFileSync(join(torn, "terno.db"), "short");
    writeFileSync(join(torn, "manifest.json"), JSON.stringify({ file: "terno.db", fromSchema: PREV, toSchema: SCHEMA_VERSION, appVersion: "0.1.0", size: 4096, createdAt: 5 }));
    const plan = await prepareUpgrade(w.db, opts(w, { now: () => 10 }));
    // the torn generation would have been "kept" for this upgrade: it isn't, a real one is made
    expect(plan.made).toBe(true);
    expect(readdirSync(w.backups)).toEqual([plan.backup!.id]);
  });

  it("keeps one generation: a new upgrade's backup replaces the last one only once it is complete", async () => {
    const w = workdir();
    oldMailbox(w.db, PREV - 1);
    const old = join(w.backups, `1-v${PREV - 2}-v${PREV - 1}`);
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, "terno.db"), "copy");
    writeFileSync(join(old, "manifest.json"), JSON.stringify({ file: "terno.db", fromSchema: PREV - 2, toSchema: PREV - 1, appVersion: "0.0.9", size: 4, createdAt: 1 }));
    const failing: UpgradeOptions["backup"] = async () => {
      throw Object.assign(new Error("EIO"), { code: "EIO" });
    };
    await prepareUpgrade(w.db, opts(w, { backup: failing })).catch(() => null);
    expect(readdirSync(w.backups)).toEqual([`1-v${PREV - 2}-v${PREV - 1}`]);
    const plan = await prepareUpgrade(w.db, opts(w, { now: () => 2 }));
    expect(readdirSync(w.backups)).toEqual([plan.backup!.id]);
  });

  it("a backup goes 14 days after it was made, and only once the mailbox opened (checked at start, no timer)", async () => {
    const w = workdir();
    oldMailbox(w.db, PREV);
    const plan = await prepareUpgrade(w.db, opts(w, { now: () => 0 }));
    openDatabaseWith(nodeSqliteDriver, w.db).close();
    // past its time, but the mailbox hasn't opened yet this start: still offered (Codex review R8)
    expect(await prepareUpgrade(w.db, opts(w, { now: () => BACKUP_RETENTION_MS * 2 }))).toMatchObject({ backup: { id: plan.backup!.id } });
    expireBackups(w.backups, BACKUP_RETENTION_MS - 1);
    expect(readdirSync(w.backups)).toEqual([plan.backup!.id]);
    expireBackups(w.backups, BACKUP_RETENTION_MS);
    expect(readdirSync(w.backups)).toEqual([]);
  });

  it("a damaged mailbox file is reported as damaged before anything is copied", async () => {
    const w = workdir();
    writeFileSync(w.db, Buffer.alloc(8192, 7));
    const error = await prepareUpgrade(w.db, opts(w)).catch((e: unknown) => e);
    expect(classifyOpenError(error)).toEqual({ kind: "failed", reason: "corrupt", step: null });
  });
});
