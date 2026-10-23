import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS, migrate, SCHEMA_VERSION } from "./migrations";
import { Db } from "./sqlite";

const dirs: string[] = [];
const dbs: Db[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A database exactly as v2 of the app left it. */
function v2(): Db {
  const dir = mkdtempSync(join(tmpdir(), "unica-mig3-"));
  dirs.push(dir);
  const db = new Db(join(dir, "v2.db"));
  dbs.push(db);
  for (const m of MIGRATIONS.filter((m) => m.version <= 2)) db.exec(m.sql);
  db.exec("PRAGMA user_version = 2");
  return db;
}

function account(db: Db, a: { id: number; kind: "imap" | "gmail"; email: string; createdAt: number; demo?: boolean; name?: string }) {
  db.run(
    "INSERT INTO accounts (id, kind, email, display_name, provider_config, created_at) VALUES (?,?,?,?,?,?)",
    a.id,
    a.kind,
    a.email,
    a.name ?? "",
    JSON.stringify(a.demo ? { demo: true } : { senderName: "x" }),
    a.createdAt,
  );
}

const owner = (db: Db) => db.get<Record<string, unknown>>("SELECT * FROM owner");
const appSettings = (db: Db) => {
  const r = db.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = 'app'");
  return r ? (JSON.parse(r.value_json) as Record<string, unknown>) : null;
};

describe("migration v3: owner identity, AI secret, local mode", () => {
  it("adopts the earliest non-demo account as a migrated owner (ties broken by id)", () => {
    const db = v2();
    account(db, { id: 1, kind: "imap", email: "demo@demo.dev", createdAt: 10, demo: true });
    account(db, { id: 3, kind: "gmail", email: "work@acme.com", createdAt: 50, name: "Work" });
    account(db, { id: 2, kind: "imap", email: "me@fastmail.com", createdAt: 50, name: "Me" });
    account(db, { id: 4, kind: "gmail", email: "late@gmail.com", createdAt: 90 });
    expect(migrate(db)).toEqual({ from: 2, to: SCHEMA_VERSION });
    const o = owner(db)!;
    expect(o).toMatchObject({
      id: 1,
      email: "me@fastmail.com",
      display_name: "Me",
      provider: "imap",
      verified_by: "imap_login",
      evidence_json: '{"migrated":true}',
      verified_at: 50,
      account_id: 2,
      created_at: 50,
    });
    expect(o.user_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("maps a Gmail owner to google_oauth", () => {
    const db = v2();
    account(db, { id: 7, kind: "gmail", email: "luis@gmail.com", createdAt: 5 });
    migrate(db);
    expect(owner(db)).toMatchObject({ provider: "gmail", verified_by: "google_oauth", account_id: 7 });
  });

  it("leaves no owner for demo-only and empty databases", () => {
    const demo = v2();
    account(demo, { id: 1, kind: "imap", email: "a@demo.dev", createdAt: 1, demo: true });
    account(demo, { id: 2, kind: "gmail", email: "b@demo.dev", createdAt: 2, demo: true });
    migrate(demo);
    expect(owner(demo)).toBeUndefined();
    const empty = v2();
    migrate(empty);
    expect(owner(empty)).toBeUndefined();
  });

  it("renames the Anthropic key secret without touching its (encrypted) blob or other secrets", () => {
    const db = v2();
    const blob = new Uint8Array([1, 2, 3, 250]);
    db.run("INSERT INTO secrets (name, blob) VALUES ('anthropicApiKey', ?)", blob);
    db.run("INSERT INTO secrets (name, blob) VALUES ('gmailClientSecret', ?)", new Uint8Array([9]));
    db.run("INSERT INTO secrets (name, blob) VALUES ('account:1:password', ?)", new Uint8Array([8]));
    migrate(db);
    const names = db.all<{ name: string }>("SELECT name FROM secrets ORDER BY name").map((r) => r.name);
    expect(names).toEqual(["account:1:password", "ai:anthropic:apiKey", "gmailClientSecret"]);
    expect([...db.get<{ blob: Uint8Array }>("SELECT blob FROM secrets WHERE name = 'ai:anthropic:apiKey'")!.blob]).toEqual([...blob]);
  });

  it("keeps existing installs out of local mode, merging into stored settings", () => {
    const withSettings = v2();
    withSettings.run("INSERT INTO settings (key, value_json) VALUES ('app', ?)", JSON.stringify({ theme: "dark", aiProvider: "anthropic" }));
    migrate(withSettings);
    expect(appSettings(withSettings)).toEqual({ theme: "dark", aiProvider: "anthropic", localMode: false });

    const withAccountsOnly = v2();
    account(withAccountsOnly, { id: 1, kind: "imap", email: "a@b.c", createdAt: 1 });
    migrate(withAccountsOnly);
    expect(appSettings(withAccountsOnly)).toEqual({ localMode: false });
  });

  it("writes nothing for a fresh install, so local mode stays the default", () => {
    const dir = mkdtempSync(join(tmpdir(), "unica-mig3-"));
    dirs.push(dir);
    const db = new Db(join(dir, "fresh.db"));
    dbs.push(db);
    migrate(db);
    expect(appSettings(db)).toBeNull();
    expect(owner(db)).toBeUndefined();
  });

  it("owner survives mailbox removal with account_id cleared (ON DELETE SET NULL)", () => {
    const db = v2();
    account(db, { id: 1, kind: "imap", email: "me@x.dev", createdAt: 1 });
    migrate(db);
    db.run("DELETE FROM accounts WHERE id = 1");
    expect(owner(db)).toMatchObject({ email: "me@x.dev", account_id: null });
  });

  it("enforces a single owner row", () => {
    const db = v2();
    account(db, { id: 1, kind: "imap", email: "me@x.dev", createdAt: 1 });
    migrate(db);
    expect(() =>
      db.run("INSERT INTO owner (id, user_id, email, provider, verified_by, created_at, updated_at) VALUES (2, 'u', 'e', 'imap', 'imap_login', 0, 0)"),
    ).toThrow(/CHECK/);
  });
});
