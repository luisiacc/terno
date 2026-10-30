import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Db } from "../../../packages/db/src/sqlite";
import { nodeSqliteDriver } from "../../../packages/db/src/node-driver";
import { migrate, MIGRATIONS, SCHEMA_VERSION } from "../../../packages/db/src/migrations";
import { profileFacts, toV13 } from "./people-profile";

test("the populated v13 fixture has the complete old schema and really migrates to current", () => {
  const dir = mkdtempSync("/tmp/terno-legacy-fixture-");
  try {
    execFileSync("pnpm", ["--filter", "@terno/backend-dev", "exec", "tsx", "src/seed.ts", "--out", dir, "--accounts", "2", "--threads", "1500"], { stdio: "ignore" });
    const path = join(dir, "terno.db");
    const before = profileFacts(path);
    toV13(path);
    assert.deepEqual(profileFacts(path), before);
    const db = new Db(nodeSqliteDriver, path);
    const old = new Db(nodeSqliteDriver, ":memory:");
    try {
      for (const migration of MIGRATIONS.filter((m) => m.version <= 13)) old.exec(migration.sql);
      const schema = (source: Db) => source.all("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name");
      // Exercise migration first so a mislabeled current DB reports the actual duplicate object.
      const oldSchema = schema(db);
      assert.doesNotThrow(() => migrate(db));
      assert.deepEqual(oldSchema, schema(old));
      assert.equal(db.get<{ user_version: number }>("PRAGMA user_version")!.user_version, SCHEMA_VERSION);
      assert.equal(JSON.parse(db.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = 'app'")!.value_json).design, "lumen");
    } finally { db.close(); old.close(); }
    assert.deepEqual(profileFacts(path), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
