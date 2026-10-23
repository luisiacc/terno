import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateDataset } from "@unica/mock-data";
import { ingestMessages } from "./ingest";
import { MIGRATIONS, migrate, SCHEMA_VERSION } from "./migrations";
import { openDatabase } from "./index";
import { nodeSqliteDriver } from "./node-driver";
import { writeLegacyCopy } from "./test/legacy";
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
  const db = new Db(nodeSqliteDriver, join(dir, "v2.db"));
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
    const db = new Db(nodeSqliteDriver, join(dir, "fresh.db"));
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

describe("migration v4: smart categorization", () => {
  /** A v3 database with real mail and categories, as the previous release left it. */
  function seededV3(): { db: Db; threads: number[] } {
    const dir = mkdtempSync(join(tmpdir(), "unica-mig4-"));
    dirs.push(dir);
    // mail threaded by today's code, written into the v3 schema the way that release stored it
    const source = openDatabase(join(dir, "source.db"));
    const data = generateDataset({ threads: 600, accounts: 3, seed: 11 });
    const accountIds = data.accounts.map((a, i) => {
      source.run("INSERT INTO accounts (id, kind, email, created_at) VALUES (?,?,?,?)", i + 1, a.kind, a.email, 1);
      return i + 1;
    });
    ingestMessages(source, data.messages.map((m) => ({ ...m, accountId: accountIds[m.accountIndex]! })), 1);
    writeLegacyCopy(source, join(dir, "v3.db"), 3);
    source.close();
    const db = new Db(nodeSqliteDriver, join(dir, "v3.db"));
    dbs.push(db);
    db.run("INSERT INTO categories (id, name, color, position) VALUES (1, 'Facturas', 'amber', 0), (2, 'Lecturas', 'violet', 1)");
    const threads = db.all<{ id: number }>("SELECT id FROM threads ORDER BY id").map((r) => r.id);
    const origins = ["user", "filter", "agent", "suggestion"];
    threads.slice(0, 200).forEach((t, i) => db.run("INSERT INTO thread_categories VALUES (?, ?, ?, ?)", t, 1 + (i % 2), origins[i % 4]!, 1000 + i));
    return { db, threads };
  }

  const plan = (db: Db, sql: string, ...params: (number | string)[]) => db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...params).map((r) => r.detail).join(" | ");

  it("keeps every category row, with its origin and date, and the FTS index consistent", () => {
    const { db } = seededV3();
    const before = db.all("SELECT thread_id, category_id, added_by, added_at FROM thread_categories ORDER BY thread_id, category_id");
    const ftsBefore = db.get<{ c: number }>("SELECT count(*) AS c FROM messages_fts WHERE messages_fts MATCH 'factura'")!.c;
    expect(migrate(db)).toEqual({ from: 3, to: SCHEMA_VERSION });
    expect(db.all("SELECT thread_id, category_id, added_by, added_at FROM thread_categories ORDER BY thread_id, category_id")).toEqual(before);
    expect(db.get<{ c: number }>("SELECT count(*) AS c FROM thread_categories WHERE batch_id IS NOT NULL")!.c).toBe(0);
    // external-content FTS: triggers survive and the index still matches its content
    db.exec("INSERT INTO messages_fts(messages_fts, rank) VALUES('integrity-check', 1)");
    expect(db.get<{ c: number }>("SELECT count(*) AS c FROM messages_fts WHERE messages_fts MATCH 'factura'")!.c).toBe(ftsBefore);
    const triggers = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%fts%' ORDER BY name").map((r) => r.name);
    expect(triggers).toEqual(["message_bodies_fts_ad", "message_bodies_fts_ai", "message_bodies_fts_au", "messages_fts_ad", "messages_fts_ai", "messages_fts_au"]);
    db.run("UPDATE messages SET subject = 'zzqqmigrated' WHERE id = (SELECT min(id) FROM messages)");
    db.run("DELETE FROM messages WHERE id = (SELECT max(id) FROM messages)");
    db.exec("INSERT INTO messages_fts(messages_fts, rank) VALUES('integrity-check', 1)");
    expect(db.get<{ c: number }>("SELECT count(*) AS c FROM messages_fts WHERE messages_fts MATCH 'zzqqmigrated'")!.c).toBe(1);
  });

  it("recreates the category indexes, so category views stay index walks", () => {
    const { db } = seededV3();
    migrate(db);
    const indexes = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'thread_categories' ORDER BY name").map((r) => r.name);
    expect(indexes).toEqual(expect.arrayContaining(["thread_categories_batch", "thread_categories_c"]));
    expect(plan(db, "SELECT thread_id FROM thread_categories WHERE category_id = ?", 1)).toMatch(/thread_categories_c/);
    expect(plan(db, "SELECT thread_id FROM thread_categories WHERE batch_id = ?", 1)).toMatch(/thread_categories_batch/);
  });

  it("allows auto and bulk adds, still rejects unknown origins, and cascades", () => {
    const { db, threads } = seededV3();
    migrate(db);
    db.run("INSERT INTO thread_categories (thread_id, category_id, added_by, added_at, batch_id) VALUES (?, 1, 'auto', 1, NULL)", threads[300]!);
    db.run("INSERT INTO thread_categories (thread_id, category_id, added_by, added_at, batch_id) VALUES (?, 1, 'bulk', 1, 7)", threads[301]!);
    expect(() => db.run("INSERT INTO thread_categories (thread_id, category_id, added_by) VALUES (?, 1, 'robot')", threads[302]!)).toThrow(/CHECK/);
    expect(db.get<{ auto_apply: number }>("SELECT auto_apply FROM categories WHERE id = 1")!.auto_apply).toBe(1);
    db.run("INSERT INTO cls_examples (thread_id, category_id, label, weight, source, at, features) VALUES (?, 1, -1, 3, 'removal', 1, x'01')", threads[300]!);
    db.run("INSERT INTO cls_decisions (thread_id, category_id, kind, p, explain_json, at) VALUES (?, 1, 'auto', 0.99, '[]', 1)", threads[300]!);
    db.run("DELETE FROM messages WHERE thread_id = ?", threads[300]!);
    db.run("DELETE FROM threads WHERE id = ?", threads[300]!);
    for (const t of ["thread_categories", "cls_examples", "cls_decisions"]) {
      expect(db.get<{ c: number }>(`SELECT count(*) AS c FROM ${t} WHERE thread_id = ?`, threads[300]!)!.c, t).toBe(0);
    }
    db.run("DELETE FROM categories WHERE id = 1");
    expect(db.get<{ c: number }>("SELECT count(*) AS c FROM thread_categories WHERE category_id = 1")!.c).toBe(0);
    expect(db.get<{ fk: number }>("SELECT count(*) AS fk FROM pragma_foreign_key_check")!.fk).toBe(0);
  });

  it("rolls back as one transaction", () => {
    const { db } = seededV3();
    // a stray table with the temporary name makes the migration fail halfway
    db.exec("CREATE TABLE thread_categories_new (x)");
    expect(() => migrate(db)).toThrow();
    expect(db.get<{ user_version: number }>("PRAGMA user_version")!.user_version).toBe(3);
    expect(db.get<{ c: number }>("SELECT count(*) AS c FROM thread_categories")!.c).toBe(200);
    expect(db.get("SELECT name FROM sqlite_master WHERE name = 'cls_examples'")).toBeUndefined();
  });
});
