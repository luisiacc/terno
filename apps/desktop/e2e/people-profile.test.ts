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

test("People smoke derives its expected schema from the packaged migration witness", async () => {
  const { readFileSync } = await import("node:fs");
  const smoke = readFileSync(new URL("./people.smoke.ts", import.meta.url), "utf8");
  assert.match(smoke, /packagedSchemaVersion\(\)/);
  assert.doesNotMatch(smoke, /PACKAGED_SCHEMA_VERSION\s*=\s*\d/);
});


test("source and built schema witnesses reject omitted or no-op v31/v32 even with a current version", async () => {
  const { packagedSchemaVersion, assertUpgradeSchema } = await import("./people-profile");
  assert.equal(packagedSchemaVersion(), SCHEMA_VERSION);
  for (const version of [31, 32]) {
    assert.throws(() => packagedSchemaVersion(MIGRATIONS.filter((migration) => migration.version !== version)));
    assert.throws(() => packagedSchemaVersion(MIGRATIONS.map((migration) => migration.version === version ? { ...migration, sql: "SELECT 1;" } : migration)));
    const db = new Db(nodeSqliteDriver, ":memory:");
    try {
      for (const migration of MIGRATIONS) if (migration.version !== version) db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      assert.throws(() => assertUpgradeSchema(db));
    } finally { db.close(); }
  }
});

const decoyMigrations = MIGRATIONS.map((migration) => migration.version === 32 ? {
  ...migration,
  sql: "CREATE TABLE decoy (id INTEGER, unread_count INTEGER, in_trash INTEGER, in_spam INTEGER); CREATE INDEX threads_category_counts ON decoy(id, unread_count) WHERE in_trash = 0 AND in_spam = 0;",
} : migration);

test("source schema witness rejects a matching index on a decoy table", async () => {
  const { packagedSchemaVersion } = await import("./people-profile");
  assert.throws(() => packagedSchemaVersion(decoyMigrations));
});

test("packaged schema witness rejects a matching index on a decoy table with current version", async () => {
  const { assertPackagedUpgrade } = await import("./people-profile");
  const dir = mkdtempSync("/tmp/terno-people-decoy-");
  const path = join(dir, "terno.db");
  try {
    const db = new Db(nodeSqliteDriver, path);
    try {
      for (const migration of decoyMigrations) db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    } finally { db.close(); }
    assert.throws(() => assertPackagedUpgrade(path));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
