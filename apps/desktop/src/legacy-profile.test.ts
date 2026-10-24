import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LegacyProfileInUseError, legacyProfilePath, migrateLegacyDbFiles, migrateLegacyProfile } from "./legacy-profile";

const dirs: string[] = [];
const root = () => {
  const d = mkdtempSync(join(tmpdir(), "terno-legacy-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function legacyProfile(dir: string, files: Record<string, string> = { "unica.db": "db", "unica.db-wal": "wal", "unica.db-shm": "shm", "unica.db.search": "snap", "agent.token": "t" }) {
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
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

  it("renames Unica → Terno and unica.db with its WAL, shm and snapshot → terno.db", () => {
    const r = root();
    legacyProfile(join(r, "Unica"));
    const result = migrateLegacyProfile(join(r, "Terno"));
    expect(result.movedFrom).toBe(join(r, "Unica"));
    expect(result.conflicts).toEqual([]);
    expect(existsSync(join(r, "Unica"))).toBe(false);
    for (const [name, body] of [["terno.db", "db"], ["terno.db-wal", "wal"], ["terno.db-shm", "shm"], ["terno.db.search", "snap"], ["agent.token", "t"]]) {
      expect(readFileSync(join(r, "Terno", name!), "utf8")).toBe(body);
    }
    expect(existsSync(join(r, "Terno", "unica.db"))).toBe(false);
    // the next start finds nothing to do
    expect(migrateLegacyProfile(join(r, "Terno"))).toEqual({ movedFrom: null, renamed: [], conflicts: [] });
  });

  it("never touches a legacy profile when the new one exists", () => {
    const r = root();
    legacyProfile(join(r, "Unica-dev-demo"));
    legacyProfile(join(r, "Terno-dev-demo"), { "terno.db": "new" });
    const result = migrateLegacyProfile(join(r, "Terno-dev-demo"));
    expect(result).toEqual({ movedFrom: null, renamed: [], conflicts: [join(r, "Unica-dev-demo")] });
    expect(readFileSync(join(r, "Unica-dev-demo", "unica.db"), "utf8")).toBe("db");
    expect(readFileSync(join(r, "Terno-dev-demo", "terno.db"), "utf8")).toBe("new");
  });

  it("renames the database inside an explicit path, and leaves both when terno.db exists", () => {
    const r = root();
    legacyProfile(r, { "unica.db": "db", "unica.db-wal": "wal" });
    expect(migrateLegacyDbFiles(r).renamed).toEqual(["unica.db-wal → terno.db-wal", "unica.db → terno.db"]);
    writeFileSync(join(r, "unica.db"), "stale");
    expect(migrateLegacyDbFiles(r)).toEqual({ renamed: [], conflicts: [join(r, "unica.db")] });
    expect(readFileSync(join(r, "terno.db"), "utf8")).toBe("db");
  });

  it("finishes an interrupted rename without putting a WAL beside the wrong database", () => {
    const r = root();
    // stopped after the WAL moved, before the database did
    legacyProfile(r, { "unica.db": "db", "unica.db-shm": "shm", "terno.db-wal": "wal" });
    expect(migrateLegacyDbFiles(r).renamed).toEqual(["unica.db-shm → terno.db-shm", "unica.db → terno.db"]);
    expect(readFileSync(join(r, "terno.db-wal"), "utf8")).toBe("wal");
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
