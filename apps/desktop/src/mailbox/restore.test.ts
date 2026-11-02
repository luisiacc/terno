import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { BackupInfo } from "@terno/db/backups";
import { BEFORE_RESTORE_RETENTION_MS, readRestoredMarker, reconcileRestore, restoreFromBackup, RestoreError, restorePaths, settleRestored, type RestoreDeps } from "./restore";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A live mailbox (with a WAL holding a commit) and a backup of an older one. */
function world() {
  const dir = mkdtempSync(join(tmpdir(), "terno-restore-"));
  dirs.push(dir);
  const db = join(dir, "terno.db");
  const live = new DatabaseSync(db);
  live.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('live'); PRAGMA user_version = 38");
  // the process holding it died: the WAL stays (as after a crash)
  const gen = join(dir, "backups", "1000-v37-v38");
  mkdirSync(gen, { recursive: true });
  const file = join(gen, "terno.db");
  const copy = new DatabaseSync(file);
  copy.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('backup'); PRAGMA user_version = 37");
  copy.close();
  const backup: BackupInfo = { id: "1000-v37-v38", dir: gen, file, fromSchema: 37, toSchema: 38, appVersion: "0.2.0", size: 8192, createdAt: 1000 };
  return { dir, db, backup, live };
}

const value = (db: string) => {
  const c = new DatabaseSync(db, { readOnly: true });
  try {
    return (c.prepare("SELECT v FROM t").get() as { v: string }).v;
  } finally {
    c.close();
  }
};

const roomy: RestoreDeps = { freeBytes: () => 2 ** 34 };

describe("restoring a backup (plan 95)", () => {
  it("puts the backup in place, sets the old mailbox (and its WAL) aside, and leaves the marker for the backend", async () => {
    const w = world();
    await restoreFromBackup(w.db, w.backup, roomy);
    w.live.close();
    expect(value(w.db)).toBe("backup");
    // the live WAL went with the old file, never onto the restored one
    expect(existsSync(`${w.db}-wal`)).toBe(false);
    expect(existsSync(`${restorePaths(w.db).aside}-wal`)).toBe(true);
    expect(readRestoredMarker(w.db)).toEqual({ createdAt: 1000 });
    expect(existsSync(restorePaths(w.db).journal)).toBe(false);
    // and the old mailbox, with its WAL, is whole aside
    expect(value(restorePaths(w.db).aside)).toBe("live");
  });

  it("needs room for the copy, and says so without touching anything", async () => {
    const w = world();
    await expect(restoreFromBackup(w.db, w.backup, { freeBytes: () => 1024 })).rejects.toMatchObject({ name: "RestoreError", kind: "no-room" });
    w.live.close();
    expect(value(w.db)).toBe("live");
  });

  it("plan 112: on the backup's own APFS volume the copy is a clone, which needs only the margin; elsewhere the backup's size too", async () => {
    const w = world();
    const room = { freeBytes: () => 64 * 2 ** 20 + 1024 };
    await expect(restoreFromBackup(w.db, w.backup, { ...room, volume: () => false })).rejects.toMatchObject({ kind: "no-room" });
    let cloned = 0;
    await restoreFromBackup(w.db, w.backup, { ...room, volume: () => true, clone: async (src, dst) => { cloned++; copyFileSync(src, dst); } });
    w.live.close();
    expect(cloned).toBe(1);
    expect(value(w.db)).toBe("backup");
  });

  it("plan 112: a clone that fails is said as no-room or failed, with nothing moved", async () => {
    const w = world();
    const fail = (code: string) => restoreFromBackup(w.db, w.backup, { ...roomy, volume: () => true, clone: () => Promise.reject(Object.assign(new Error(code), { code })) });
    await expect(fail("ENOSPC")).rejects.toMatchObject({ kind: "no-room" });
    await expect(fail("EIO")).rejects.toMatchObject({ kind: "failed" });
    w.live.close();
    expect(value(w.db)).toBe("live");
    expect(existsSync(restorePaths(w.db).restoring)).toBe(false);
  });

  it("a backup that isn't what its manifest says is refused before anything moves", async () => {
    const w = world();
    await expect(restoreFromBackup(w.db, { ...w.backup, fromSchema: 12 }, roomy)).rejects.toThrow(RestoreError);
    w.live.close();
    expect(value(w.db)).toBe("live");
    expect(existsSync(restorePaths(w.db).restoring)).toBe(false);
  });

  for (const step of ["copy", "journal", "aside-wal", "aside", "swap"] as const) {
    it(`a failure at "${step}" leaves the mailbox exactly as it was`, async () => {
      const w = world();
      await expect(restoreFromBackup(w.db, w.backup, { ...roomy, fault: (s) => { if (s === step) throw Object.assign(new Error("EIO"), { code: "EIO" }); } })).rejects.toThrow(RestoreError);
      w.live.close();
      expect(value(w.db)).toBe("live");
      expect(readRestoredMarker(w.db)).toBeNull();
      expect(readdirSync(w.dir).filter((f) => f.includes("restor"))).toEqual([]);
    });
  }

  it("a failure after the swap (writing the marker) is a finished restore, not a failed one", async () => {
    const w = world();
    let first = true;
    await restoreFromBackup(w.db, w.backup, { ...roomy, fault: (s) => { if (s === "marker" && first) { first = false; throw new Error("EIO"); } } });
    w.live.close();
    expect(value(w.db)).toBe("backup");
    expect(readRestoredMarker(w.db)).toEqual({ createdAt: 1000 });
  });

  it("at start, a journal whose copy is in place and old mailbox aside is finished: marker written, journal gone", async () => {
    const w = world();
    const p = restorePaths(w.db);
    // a crash right after the swap: the journal is there, the marker isn't
    writeFileSync(p.journal, JSON.stringify({ createdAt: 1000 }));
    w.live.close();
    for (const f of [`${w.db}-wal`, `${w.db}-shm`]) rmSync(f, { force: true });
    renameSync(w.db, p.aside);
    copyFileSync(w.backup.file, w.db);
    expect(reconcileRestore(w.db)).toBe("completed");
    expect(value(w.db)).toBe("backup");
    expect(readRestoredMarker(w.db)).toEqual({ createdAt: 1000 });
    expect(existsSync(p.journal)).toBe(false);
  });

  it("at start, a journal with the old mailbox aside and no copy in place puts the old mailbox (and its WAL) back", async () => {
    const w = world();
    const p = restorePaths(w.db);
    writeFileSync(p.journal, JSON.stringify({ createdAt: 1000 }));
    // crashed after setting the WAL and the file aside, before the swap; the copy is beside it
    renameSync(`${w.db}-wal`, `${p.aside}-wal`);
    rmSync(`${w.db}-shm`, { force: true });
    renameSync(w.db, p.aside);
    copyFileSync(w.backup.file, p.restoring);
    expect(reconcileRestore(w.db)).toBe("rolled-back");
    expect(value(w.db)).toBe("live");
    w.live.close();
    expect(existsSync(p.restoring)).toBe(false);
    expect(existsSync(p.journal)).toBe(false);
  });

  it("at start, a journal from before anything moved (only the WAL aside) puts the WAL back: the commit in it survives", async () => {
    const w = world();
    const p = restorePaths(w.db);
    writeFileSync(p.journal, "{torn");
    renameSync(`${w.db}-wal`, `${p.aside}-wal`);
    expect(reconcileRestore(w.db)).toBe("rolled-back");
    expect(value(w.db)).toBe("live");
    w.live.close();
  });

  it("an earlier restore's marker the backend hasn't handled survives a later restore that rolls back", async () => {
    const w = world();
    const p = restorePaths(w.db);
    writeFileSync(p.marker, JSON.stringify({ createdAt: 5 }));
    await expect(restoreFromBackup(w.db, w.backup, { ...roomy, fault: (s) => { if (s === "swap") throw new Error("EIO"); } })).rejects.toThrow();
    expect(readRestoredMarker(w.db)).toEqual({ createdAt: 5 });
  });

  it("the mailbox set aside goes 14 days after the restore, at a start", async () => {
    const w = world();
    await restoreFromBackup(w.db, w.backup, roomy);
    w.live.close();
    const p = restorePaths(w.db);
    expect(reconcileRestore(w.db, { now: () => Date.now() + BEFORE_RESTORE_RETENTION_MS - 60_000 })).toBeNull();
    expect(existsSync(p.aside)).toBe(true);
    const old = (Date.now() - BEFORE_RESTORE_RETENTION_MS - 1000) / 1000;
    utimesSync(p.aside, old, old);
    expect(reconcileRestore(w.db)).toBeNull();
    expect(existsSync(p.aside)).toBe(false);
    expect(existsSync(`${p.aside}-wal`)).toBe(false);
  });

  it("the journal is durable, its folder entry too, before anything moves (Codex review R1)", async () => {
    const w = world();
    const events: string[] = [];
    await restoreFromBackup(w.db, w.backup, { ...roomy, synced: (path) => events.push(`sync:${path === w.dir ? "dir" : path.split("/").pop()}`), fault: (s) => void events.push(`step:${s}`) });
    w.live.close();
    const journal = events.indexOf("sync:terno.db.restore.json.tmp");
    expect(journal).toBeGreaterThan(-1);
    expect(events[journal + 1]).toBe("sync:dir");
    expect(events.indexOf("step:aside-wal")).toBeGreaterThan(journal + 1);
    // and the moves are durable before the copy takes the mailbox's place
    expect(events.lastIndexOf("sync:dir", events.indexOf("step:swap"))).toBeGreaterThan(events.indexOf("step:aside"));
  });

  it("the old mailbox is kept 14 days from the restore, not from when it was last written (Codex review R9)", async () => {
    const w = world();
    w.live.close();
    const old = (Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(w.db, old, old);
    await restoreFromBackup(w.db, w.backup, roomy);
    expect(reconcileRestore(w.db)).toBeNull();
    expect(existsSync(restorePaths(w.db).aside)).toBe(true);
  });

  it("settleRestored: quarantined and checkpointed to the file before the marker goes; a checkpoint that can't finish keeps it (Codex review R3)", () => {
    const w = world();
    w.live.close();
    writeFileSync(restorePaths(w.db).marker, JSON.stringify({ createdAt: 7 }));
    const order: string[] = [];
    const db = new DatabaseSync(w.db);
    const facade = {
      get: <T,>(sql: string) => {
        order.push(`${sql}|marker:${existsSync(restorePaths(w.db).marker)}`);
        return db.prepare(sql).get() as T;
      },
    };
    expect(settleRestored(facade, w.db, () => order.push("quarantine"))).toEqual({ createdAt: 7 });
    expect(order).toEqual(["quarantine", "PRAGMA wal_checkpoint(FULL)|marker:true"]);
    expect(existsSync(restorePaths(w.db).marker)).toBe(false);
    writeFileSync(restorePaths(w.db).marker, JSON.stringify({ createdAt: 7 }));
    const busy = { get: <T,>() => ({ busy: 1, log: 3, checkpointed: 1 }) as T };
    expect(() => settleRestored(busy, w.db, () => {})).toThrow();
    expect(readRestoredMarker(w.db)).toEqual({ createdAt: 7 });
    db.close();
  });
});
