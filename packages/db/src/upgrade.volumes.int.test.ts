/**
 * Plan 95 on real volumes (macOS): small disk images made with hdiutil,
 * filled for real, and one mounted read-only. No mocks: the errors come from
 * the file system and SQLite exactly as a full or locked disk gives them.
 * Skipped with the reason where hdiutil can't make or attach an image.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync, statfsSync, writeSync, closeSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { MIGRATIONS, SCHEMA_VERSION } from "./migrations";
import { nodeSqliteDriver } from "./node-driver";
import { classifyOpenError, NoRoomError } from "./open-errors";
import { openDatabaseWith } from "./portable";
import { Db } from "./sqlite";
import { mailboxBytes, migrateHeadroom, prepareUpgrade } from "./upgrade";

const PREV = SCHEMA_VERSION - 1;
const work = mkdtempSync(join(tmpdir(), "terno-volumes-"));
const mounted: string[] = [];

function volume(name: string, fs: "HFS+" | "APFS", sizeMb: number, o: { readonly?: boolean; from?: string } = {}): string | null {
  const image = o.from ?? join(work, `${name}.dmg`);
  if (!o.from) {
    const made = spawnSync("hdiutil", ["create", "-size", `${sizeMb}m`, "-fs", fs, "-volname", name, "-o", image], { encoding: "utf8" });
    if (made.status !== 0) return null;
  }
  const mount = join(work, `${name}${o.readonly ? "-ro" : ""}-mnt`);
  mkdirSync(mount, { recursive: true });
  const attached = spawnSync("hdiutil", ["attach", "-nobrowse", ...(o.readonly ? ["-readonly"] : []), "-mountpoint", mount, image], { encoding: "utf8" });
  if (attached.status !== 0) return null;
  mounted.push(mount);
  return mount;
}

function detach(mount: string): void {
  spawnSync("hdiutil", ["detach", mount, "-force"]);
  mounted.splice(mounted.indexOf(mount), 1);
}

afterAll(() => {
  // detach takes each mount off the list
  while (mounted.length) detach(mounted[0]!);
  rmSync(work, { recursive: true, force: true });
});

const free = (dir: string) => {
  const s = statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
};

/**
 * Fills the volume until fewer than `leave` bytes are free (a real file, 1 MB blocks then 4 KB ones). With
 * `leave` 0 it writes until the volume refuses (statfs keeps reporting a margin APFS won't give out).
 */
function fill(dir: string, leave: number): string {
  const file = join(dir, "filler.bin");
  const fd = openSync(file, "w");
  const write = (b: Buffer) => {
    try {
      writeSync(fd, b);
      return true;
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOSPC") throw error;
      return false;
    }
  };
  try {
    for (const big = Buffer.alloc(1 << 20, 0xab); free(dir) > leave + big.length && write(big); );
    for (const small = Buffer.alloc(4096, 0xab); (leave === 0 || free(dir) > leave + small.length) && write(small); );
  } finally {
    closeSync(fd);
  }
  return file;
}

/** An older mailbox, about `mb` megabytes (drafts with incompressible bodies). */
function oldMailbox(path: string, mb: number, version = PREV): void {
  const db = new Db(nodeSqliteDriver, path);
  for (const m of MIGRATIONS.filter((m) => m.version <= version)) db.exec(m.sql);
  db.exec(`PRAGMA user_version = ${version}`);
  db.run("INSERT INTO accounts (id, kind, email, display_name, provider_config, created_at) VALUES (1, 'imap', 'synthetic@example.test', '', '{}', 0)");
  db.tx(() => {
    for (let i = 1; i <= mb * 4; i++) db.run("INSERT INTO drafts (id, generation, account_id, format, mode, to_json, cc_json, subject, body_text, body_html, updated_at) VALUES (?, 'g', 1, 2, 'new', '[]', '[]', ?, hex(randomblob(128000)), '', 5)", i, `draft ${i}`);
  });
  db.close();
}

const drafts = (path: string) => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return { version: (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, n: (db.prepare("SELECT count(*) AS n FROM drafts").get() as { n: number }).n };
  } finally {
    db.close();
  }
};

const probe = process.platform === "darwin" ? volume("probe", "HFS+", 8) : null;
if (probe) detach(probe);
const skip = !probe;

describe.skipIf(skip)("plan 95 on real volumes", () => {
  it("HFS+ (no clones): the room check refuses a backup that doesn't fit, and says whether the migration alone would", async () => {
    const v = volume("tight", "HFS+", 120)!;
    const db = join(v, "terno.db");
    oldMailbox(db, 20);
    const before = drafts(db);
    fill(v, 90 * 2 ** 20);
    const error = await prepareUpgrade(db, { backupsDir: join(v, "backups"), appVersion: "0.2.0" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NoRoomError);
    expect(error).toMatchObject({ stage: "backup", canSkipBackup: true });
    expect(drafts(db)).toEqual(before);
    detach(v);
  });

  it("a disk that fills during the backup (the estimate said yes): no partial copy left, the mailbox untouched, 'no room'", async () => {
    const v = volume("fills", "HFS+", 80)!;
    const db = join(v, "terno.db");
    oldMailbox(db, 30);
    const before = drafts(db);
    fill(v, 10 * 2 ** 20);
    const error = await prepareUpgrade(db, { backupsDir: join(v, "backups"), appVersion: "0.2.0", freeBytes: () => 2 ** 40 }).catch((e: unknown) => e);
    expect(classifyOpenError(error)).toMatchObject({ kind: "no-room", stage: "backup" });
    expect(readdirSync(join(v, "backups"))).toEqual([]);
    expect(drafts(db)).toEqual(before);
    detach(v);
  });

  it("a migration on a full disk rolls back to the version it had (SQLite says CANTOPEN or IOERR, not FULL); freed, the same file opens and migrates", async () => {
    const v = volume("full", "APFS", 60)!;
    const db = join(v, "terno.db");
    // a mailbox two steps back, with a migration that writes (v37's rows) to run on a disk with no room
    oldMailbox(db, 8, PREV - 1);
    const filler = fill(v, 0);
    let error: unknown;
    try {
      openDatabaseWith(nodeSqliteDriver, db).close();
    } catch (e) {
      error = e;
    }
    // what the backend gives the classifier: the migration's headroom and the volume's free space
    expect(classifyOpenError(error, () => ({ needBytes: migrateHeadroom(mailboxBytes(db)), freeBytes: free(v) }))).toMatchObject({ kind: "no-room", stage: "migrate" });
    // (even reading needs room for SQLite's -shm: looked at once there is some, before the retry migrates)
    rmSync(filler);
    expect(drafts(db)).toEqual({ version: PREV - 1, n: 32 });
    openDatabaseWith(nodeSqliteDriver, db).close();
    expect(drafts(db)).toEqual({ version: SCHEMA_VERSION, n: 32 });
    detach(v);
  });

  it("a mailbox on a read-only volume: 'unwritable', with nothing written", async () => {
    const image = join(work, "locked.dmg");
    execFileSync("hdiutil", ["create", "-size", "20m", "-fs", "HFS+", "-volname", "locked", "-o", image]);
    const rw = volume("locked", "HFS+", 20, { from: image })!;
    oldMailbox(join(rw, "terno.db"), 1);
    detach(rw);
    const ro = volume("locked", "HFS+", 20, { from: image, readonly: true })!;
    const db = join(ro, "terno.db");
    const error = await prepareUpgrade(db, { backupsDir: join(ro, "backups"), appVersion: "0.2.0" }).then(
      () => {
        try {
          openDatabaseWith(nodeSqliteDriver, db).close();
          return null;
        } catch (e) {
          return e;
        }
      },
      (e: unknown) => e,
    );
    expect(classifyOpenError(error)).toMatchObject({ kind: "failed", reason: "unwritable" });
    expect(existsSync(join(ro, "backups"))).toBe(false);
    detach(ro);
  });

  it("APFS: a backup made, then the original migrated; the copy still opens at the old version", async () => {
    const v = volume("apfs", "APFS", 80)!;
    const db = join(v, "terno.db");
    oldMailbox(db, 4);
    const plan = await prepareUpgrade(db, { backupsDir: join(v, "backups"), appVersion: "0.2.0" });
    openDatabaseWith(nodeSqliteDriver, db).close();
    const copy = join(work, "copy.db");
    copyFileSync(plan.backup!.file, copy);
    expect(drafts(copy)).toEqual({ version: PREV, n: 16 });
    expect(drafts(db)).toEqual({ version: SCHEMA_VERSION, n: 16 });
    detach(v);
  });
});
