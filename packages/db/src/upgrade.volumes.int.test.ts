/**
 * Plan 255 on a real full disk (macOS, hdiutil): with no backup, a migration
 * that can't write rolls back in its transaction, is said as no room (the
 * estimate beside what's free), and runs once the space is back. The
 * packaged app can't take this case: Electron can't start its own profile on
 * a disk that full.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { SCHEMA_VERSION } from "./migrations";
import { nodeSqliteDriver } from "./node-driver";
import { classifyOpenError } from "./open-errors";
import { openDatabaseWith } from "./portable";
import { oldMailbox } from "./test/old-mailbox";
import { diskFree, mailboxBytes, mailboxSchema, migrateHeadroom } from "./upgrade";

const work = mkdtempSync(join(tmpdir(), "terno-volumes-"));
const mounts: string[] = [];
afterAll(() => {
  for (const m of mounts) spawnSync("hdiutil", ["detach", "-force", m]);
  rmSync(work, { recursive: true, force: true });
});


it.skipIf(process.platform !== "darwin")("a full disk: the migration rolls back step by step, is said as no room, and runs once space is freed", { timeout: 180_000 }, () => {
  const image = join(work, "full.dmg");
  const made = spawnSync("hdiutil", ["create", "-size", "64m", "-fs", "HFS+", "-volname", "TernoFull", "-o", image], { encoding: "utf8" });
  expect(made.status, made.stderr).toBe(0);
  const mount = join(work, "full");
  mkdirSync(mount);
  execFileSync("hdiutil", ["attach", "-nobrowse", "-mountpoint", mount, image]);
  mounts.push(mount);
  const db = join(mount, "terno.db");
  // a mailbox from well before: the steps from v40 on have pages to write
  oldMailbox(db, 40, 400);
  const filler = join(mount, "filler.bin");
  // room for the schema's read (its -shm), not for the migration's pages
  const fill = (leave: number) => {
    const fd = openSync(filler, "a");
    for (const size of [1 << 20, 1 << 14, 1 << 12]) {
      const block = Buffer.alloc(size, 0xab);
      try {
        while (diskFree(mount) - size >= leave) writeSync(fd, block);
      } catch {
        /* full */
      }
    }
    closeSync(fd);
  };
  fill(96 << 10);
  expect(mailboxSchema(db)).toBe(40);
  let error: unknown = null;
  try {
    openDatabaseWith(nodeSqliteDriver, db).close();
  } catch (e) {
    error = e;
  }
  expect(error).not.toBeNull();
  expect(classifyOpenError(error, () => ({ needBytes: migrateHeadroom(mailboxBytes(db)), freeBytes: diskFree(mount) }))).toMatchObject({ kind: "no-room" });
  // the step that couldn't finish rolled back: the file is at a step it reached, never between two (each its own transaction)
  const reached = mailboxSchema(db)!;
  expect(reached).toBeGreaterThanOrEqual(40);
  expect(reached).toBeLessThan(SCHEMA_VERSION);

  rmSync(filler);
  expect(mailboxSchema(db)).toBe(reached);
  openDatabaseWith(nodeSqliteDriver, db).close();
  expect(mailboxSchema(db)).toBe(SCHEMA_VERSION);
});
