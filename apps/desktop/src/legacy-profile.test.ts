import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { LegacyProfileConflictError, LegacyProfileInUseError, legacyProfilePath, migrateLegacyDbFiles, migrateLegacyProfile } from "./legacy-profile";

const dirs: string[] = [];
const root = () => {
  const d = mkdtempSync(join(tmpdir(), "terno-legacy-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * A WAL-mode database as an app leaves it when it stops without closing:
 * the rows are committed but still only in the WAL (copied while open).
 */
function sqliteFiles(dir: string, name: string, rows: string[]) {
  const scratch = mkdtempSync(join(tmpdir(), "terno-legacy-src-"));
  dirs.push(scratch);
  const db = new DatabaseSync(join(scratch, "x.db"));
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE mail (v TEXT)");
  for (const v of rows) db.prepare("INSERT INTO mail (v) VALUES (?)").run(v);
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(scratch, "x.db"), join(dir, name));
  copyFileSync(join(scratch, "x.db-wal"), join(dir, `${name}-wal`));
  db.close();
}

const rowsIn = (file: string) => {
  const db = new DatabaseSync(file);
  try {
    return (db.prepare("SELECT v FROM mail ORDER BY rowid").all() as { v: string }[]).map((r) => r.v);
  } finally {
    db.close();
  }
};
const snapshot = (dir: string) => Object.fromEntries(readdirSync(dir).map((f) => [f, readFileSync(join(dir, f)).toString("base64")]));

function legacyProfile(dir: string, rows = ["hola", "adiós"]) {
  sqliteFiles(dir, "unica.db", rows);
  writeFileSync(join(dir, "unica.db.search"), "snap");
  writeFileSync(join(dir, "agent.token"), "t");
}

describe("legacy profile migration", () => {
  it("loads in plain Node (scripts/dev.mjs imports it with type stripping only)", () => {
    const file = join(import.meta.dirname, "legacy-profile.ts");
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(file)}); console.log(typeof m.migrateLegacyProfile, m.DB_FILE)`], { encoding: "utf8" });
    expect(out.trim()).toBe("function terno.db");
  });

  it("only Terno… paths have a legacy sibling", () => {
    expect(legacyProfilePath("/a/Application Support/Terno")).toBe("/a/Application Support/Unica");
    expect(legacyProfilePath("/a/Terno-dev-seeded")).toBe("/a/Unica-dev-seeded");
    expect(legacyProfilePath("/tmp/my-profile")).toBeNull();
  });

  it("renames Unica → Terno and unica.db → terno.db with everything its WAL held, and the snapshot beside it", () => {
    const r = root();
    legacyProfile(join(r, "Unica"));
    const result = migrateLegacyProfile(join(r, "Terno"));
    expect(result.movedFrom).toBe(join(r, "Unica"));
    expect(result.conflicts).toEqual([]);
    expect(existsSync(join(r, "Unica"))).toBe(false);
    expect(readdirSync(join(r, "Terno")).filter((f) => f.startsWith("unica"))).toEqual([]);
    expect(rowsIn(join(r, "Terno", "terno.db"))).toEqual(["hola", "adiós"]);
    expect(readFileSync(join(r, "Terno", "terno.db.search"), "utf8")).toBe("snap");
    expect(readFileSync(join(r, "Terno", "agent.token"), "utf8")).toBe("t");
    // the next start finds nothing to do
    expect(migrateLegacyProfile(join(r, "Terno"))).toEqual({ movedFrom: null, renamed: [], conflicts: [] });
  });

  it("never touches a legacy profile when the new one exists", () => {
    const r = root();
    legacyProfile(join(r, "Unica-dev-demo"));
    sqliteFiles(join(r, "Terno-dev-demo"), "terno.db", ["nuevo"]);
    const before = snapshot(join(r, "Unica-dev-demo"));
    const result = migrateLegacyProfile(join(r, "Terno-dev-demo"));
    expect(result).toEqual({ movedFrom: null, renamed: [], conflicts: [join(r, "Unica-dev-demo")] });
    expect(snapshot(join(r, "Unica-dev-demo"))).toEqual(before);
    expect(rowsIn(join(r, "Terno-dev-demo", "terno.db"))).toEqual(["nuevo"]);
  });

  it("renames the database inside an explicit path, and leaves both when terno.db exists", () => {
    const r = root();
    sqliteFiles(r, "unica.db", ["a"]);
    expect(migrateLegacyDbFiles(r).renamed).toEqual(["unica.db → terno.db"]);
    expect(rowsIn(join(r, "terno.db"))).toEqual(["a"]);
    writeFileSync(join(r, "unica.db"), "stale");
    expect(migrateLegacyDbFiles(r)).toEqual({ renamed: [], conflicts: [join(r, "unica.db")] });
    expect(rowsIn(join(r, "terno.db"))).toEqual(["a"]);
  });

  it("interrupted after moving the WAL, then Única opened again: nothing is renamed or opened, and the stale WAL never meets the database", () => {
    const r = root();
    // an earlier run moved the WAL of that time, then stopped
    sqliteFiles(join(r, "old"), "unica.db", ["antes"]);
    copyFileSync(join(r, "old", "unica.db-wal"), join(r, "terno.db-wal"));
    // Única ran again since: its database and a new WAL with mail committed meanwhile
    sqliteFiles(r, "unica.db", ["antes", "después"]);
    rmSync(join(r, "old"), { recursive: true });
    const before = snapshot(r);
    expect(() => migrateLegacyDbFiles(r)).toThrow(LegacyProfileConflictError);
    expect(snapshot(r)).toEqual(before);
    expect(existsSync(join(r, "terno.db"))).toBe(false);
  });

  it("a Terno sidecar left without its database counts as a conflict even when Única closed cleanly since", () => {
    const r = root();
    sqliteFiles(join(r, "old"), "unica.db", ["antes"]);
    copyFileSync(join(r, "old", "unica.db-wal"), join(r, "terno.db-wal"));
    rmSync(join(r, "old"), { recursive: true });
    // Única's database, closed cleanly (no WAL of its own)
    const db = new DatabaseSync(join(r, "unica.db"));
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE mail (v TEXT); INSERT INTO mail VALUES ('después')");
    db.close();
    const before = snapshot(r);
    let error: unknown;
    try {
      migrateLegacyDbFiles(r);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(LegacyProfileConflictError);
    expect((error as LegacyProfileConflictError).files).toEqual([join(r, "terno.db-wal")]);
    expect(snapshot(r)).toEqual(before);
  });

  it("aborts a profile rename the same way: the conflict is found before anything moves", () => {
    const r = root();
    legacyProfile(join(r, "Unica"));
    writeFileSync(join(r, "Unica", "terno.db-wal"), "stale");
    const before = snapshot(join(r, "Unica"));
    expect(() => migrateLegacyProfile(join(r, "Terno"))).toThrow(LegacyProfileConflictError);
    expect(existsSync(join(r, "Terno"))).toBe(false);
    expect(snapshot(join(r, "Unica"))).toEqual(before);
  });

  it("refuses while Única still has the legacy profile open", () => {
    const r = root();
    legacyProfile(join(r, "Unica"));
    symlinkSync("my-mac-424242", join(r, "Unica", "SingletonLock"));
    expect(() => migrateLegacyProfile(join(r, "Terno"), { isAlive: (pid) => pid === 424242 })).toThrow(LegacyProfileInUseError);
    expect(existsSync(join(r, "Unica", "unica.db"))).toBe(true);
    // a stale lock (the process is gone) doesn't hold it back
    expect(migrateLegacyProfile(join(r, "Terno"), { isAlive: () => false }).movedFrom).toBe(join(r, "Unica"));
  });
});
