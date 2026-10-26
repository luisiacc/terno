import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateDataset } from "@terno/mock-data";
import { movePending, movePhase, restoreMoveSlice, trainMoveSlice, undoMoveBegin, undoMoveSlice } from "./categorize";
import { getThread } from "./queries";
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
  const dir = mkdtempSync(join(tmpdir(), "terno-mig3-"));
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

/**
 * A database at `version` holding a mock mailbox of one account (id 1): written by today's ingest, copied
 * row by row into that version's schema, as an install of it would hold the same mail.
 */
function legacyMail(version: number, o: { threads: number; seed: number }): { db: Db; path: string } {
  const dir = mkdtempSync(join(tmpdir(), `terno-mig${version}-`));
  dirs.push(dir);
  const source = openDatabase(join(dir, "source.db"));
  source.run("INSERT INTO accounts (id, kind, email, display_name, provider_config, created_at) VALUES (1, 'imap', 'yo@x.mx', '', '{}', 0)");
  ingestMessages(source, generateDataset({ threads: o.threads, accounts: 1, seed: o.seed, now: Date.UTC(2026, 9, 22) }).messages.map((m) => ({ ...m, accountId: 1 })));
  const path = join(dir, `v${version}.db`);
  writeLegacyCopy(source, path, version);
  source.close();
  const db = new Db(nodeSqliteDriver, path);
  dbs.push(db);
  return { db, path };
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
    const dir = mkdtempSync(join(tmpdir(), "terno-mig3-"));
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
    const dir = mkdtempSync(join(tmpdir(), "terno-mig4-"));
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

describe("migration v8: exclusive moves", () => {
  it("keys journaled move rows by their category, taken from the old move's single source, and that move still trains and undoes", () => {
    const { db } = legacyMail(7, { threads: 20, seed: 3 });
    const [t1, t2] = db.all<{ id: number }>("SELECT id FROM threads ORDER BY id LIMIT 2").map((r) => r.id) as [number, number];
    db.run("INSERT INTO categories (id, name, color, position) VALUES (1, 'Origen', 'rose', 0), (2, 'Destino', 'cyan', 1)");
    // a v7 move from 1 to 2 that committed its memberships before the upgrade, its training not done yet
    db.run("INSERT INTO cat_batches (id, category_id, source, scope_json, created_at, added) VALUES (5, 2, 'dnd', ?, 0, 2)", JSON.stringify({ kind: "move", from: 1, addedBy: "user", phase: "training" }));
    db.run("INSERT INTO cat_move_threads (batch_id, thread_id, added, moved) VALUES (5, ?, 1, 1), (5, ?, 1, 1)", t1, t2);
    db.run("INSERT INTO cat_move_rows (batch_id, thread_id, added_by, added_at, prev_batch_id) VALUES (5, ?, 'user', 10, NULL), (5, ?, 'bulk', 11, 3)", t1, t2);
    db.run("INSERT INTO thread_categories (thread_id, category_id, added_by, added_at, batch_id) VALUES (?, 2, 'user', 20, 5), (?, 2, 'user', 20, 5)", t1, t2);
    expect(migrate(db)).toEqual({ from: 7, to: SCHEMA_VERSION });
    expect(db.all("SELECT thread_id, category_id, added_by, added_at, prev_batch_id FROM cat_move_rows ORDER BY thread_id")).toEqual([
      { thread_id: t1, category_id: 1, added_by: "user", added_at: 10, prev_batch_id: null },
      { thread_id: t2, category_id: 1, added_by: "bulk", added_at: 11, prev_batch_id: 3 },
    ]);
    trainMoveSlice(db, 5, [t1, t2], 30);
    expect(movePhase(db, 5)).toBe("done");
    // the removal examples land in the old move's source
    expect(db.all("SELECT DISTINCT category_id FROM cls_examples WHERE label = -1")).toEqual([{ category_id: 1 }]);
    undoMoveBegin(db, 5, 40);
    undoMoveSlice(db, 5, movePending(db, 5), 40);
    expect(db.all("SELECT thread_id, category_id, added_by, batch_id FROM thread_categories ORDER BY thread_id")).toEqual([
      { thread_id: t1, category_id: 1, added_by: "user", batch_id: null },
      { thread_id: t2, category_id: 1, added_by: "bulk", batch_id: 3 },
    ]);
  });
});

describe("migration v8: an undo of a v7 move left half-restored", () => {
  /** A v7 database whose ⌥-move (from 1 to 2) was undone and crashed while restoring examples. */
  function v7Restoring() {
    const { db, path } = legacyMail(7, { threads: 20, seed: 3 });
    const [moved, stale] = db.all<{ id: number }>("SELECT id FROM threads ORDER BY id LIMIT 2").map((r) => r.id) as [number, number];
    db.run("INSERT INTO categories (id, name, color, position) VALUES (1, 'Origen', 'rose', 0), (2, 'Destino', 'cyan', 1)");
    const example = (t: number, cat: number, label: number, source: string) =>
      db.run("INSERT INTO cls_examples (thread_id, category_id, label, weight, source, at, sender, content, batch_id, features) VALUES (?, ?, ?, 1, ?, 1, 's', 1, NULL, x'01')", t, cat, label, source);
    db.run("INSERT INTO cat_batches (id, category_id, source, scope_json, created_at, added, undone_at) VALUES (5, 2, 'dnd', ?, 0, 2, 9)", JSON.stringify({ kind: "move", from: 1, addedBy: "user", phase: "restoring" }));
    // `moved` was in the source; `stale` wasn't (a stale drag): v7 still journaled both categories' examples for both
    db.run("INSERT INTO cat_move_threads (batch_id, thread_id, added, moved, done) VALUES (5, ?, 1, 1, 0), (5, ?, 1, 0, 0)", moved, stale);
    db.run("INSERT INTO cat_move_rows (batch_id, thread_id, added_by, added_at, prev_batch_id) VALUES (5, ?, 'user', 10, NULL)", moved);
    const journal = (t: number, cat: number, label: number, source: string) =>
      db.run("INSERT INTO cat_move_examples (batch_id, thread_id, category_id, label, weight, source, at, sender, content, example_batch_id, features) VALUES (5, ?, ?, ?, 1, ?, 1, 's', 1, NULL, x'01')", t, cat, label, source);
    journal(moved, 1, 1, "user");
    journal(stale, 1, 1, "user");
    // what the undo's membership commit left: memberships back, the move's examples still in place
    db.run("INSERT INTO thread_categories (thread_id, category_id, added_by, added_at, batch_id) VALUES (?, 1, 'user', 10, NULL), (?, 1, 'user', 10, NULL)", moved, stale);
    example(moved, 1, -1, "removal");
    example(moved, 2, 1, "user");
    example(stale, 1, 1, "user"); // the stale thread's own source example, never replaced
    example(stale, 2, 1, "user");
    return { db, path, moved, stale };
  }

  it("finishes restoring after the upgrade: the legacy source counts as touched, no key conflict", () => {
    const { db, moved, stale } = v7Restoring();
    migrate(db);
    expect(() => restoreMoveSlice(db, 5, movePending(db, 5))).not.toThrow();
    expect(movePhase(db, 5)).toBe("undone");
    expect(db.all("SELECT thread_id, category_id, label, source FROM cls_examples ORDER BY thread_id, category_id")).toEqual(
      [
        { thread_id: moved, category_id: 1, label: 1, source: "user" },
        { thread_id: stale, category_id: 1, label: 1, source: "user" },
      ].sort((a, b) => a.thread_id - b.thread_id),
    );
  });
});

describe("migration v9: drafts v2", () => {
  it("keeps every v8 draft as format 1 (its text untouched, no separate quote) and gives replies their conversation", () => {
    const { db } = legacyMail(8, { threads: 3, seed: 9 });
    const m =db.get<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages ORDER BY id LIMIT 1")!;
    const quoted = "Sí.\n\nEl 22 oct, Ana escribió:\n> hola";
    db.run("INSERT INTO drafts (id, account_id, to_json, cc_json, subject, body_text, in_reply_to_message_id, updated_at) VALUES (1, 1, '[]', '[]', 'Re: x', ?, ?, 5)", quoted, m.id);
    db.run("INSERT INTO drafts (id, account_id, to_json, cc_json, subject, body_text, in_reply_to_message_id, updated_at) VALUES (2, 1, '[]', '[]', 'Nuevo', 'texto', NULL, 6)");
    expect(migrate(db)).toEqual({ from: 8, to: SCHEMA_VERSION });
    expect(db.all("SELECT id, format, mode, thread_id, body_text, quoted_text, include_quote, revision, ui_state, bcc_json FROM drafts ORDER BY id")).toEqual([
      { id: 1, format: 1, mode: "reply", thread_id: m.thread_id, body_text: quoted, quoted_text: "", include_quote: 0, revision: 1, ui_state: "open", bcc_json: "[]" },
      { id: 2, format: 1, mode: "new", thread_id: null, body_text: "texto", quoted_text: "", include_quote: 0, revision: 1, ui_state: "open", bcc_json: "[]" },
    ]);
  });
});

describe("migration v10: the next op's sequence number", () => {
  it("is read from an index, not by scanning every op", () => {
    const dir = mkdtempSync(join(tmpdir(), "terno-mig10-"));
    dirs.push(dir);
    const db = new Db(nodeSqliteDriver, join(dir, "v10.db"));
    dbs.push(db);
    migrate(db);
    const plan = db.all<{ detail: string }>("EXPLAIN QUERY PLAN SELECT coalesce(max(seq), 0) + 1 FROM ops").map((r) => r.detail).join(" | ");
    expect(plan).toMatch(/ops_seq/);
    expect(plan).not.toMatch(/ops_account/);
  });
});

describe("migration v11: the unread filter's index", () => {
  it("every filtered page walks threads_unread in order, without a temporary sort, after statistics too", async () => {
    const { listSql, scopeIdsSql } = await import("./queries");
    const dir = mkdtempSync(join(tmpdir(), "terno-mig11-"));
    dirs.push(dir);
    const db = new Db(nodeSqliteDriver, join(dir, "v11.db"));
    dbs.push(db);
    migrate(db);
    expect(db.get<{ sql: string }>("SELECT sql FROM sqlite_schema WHERE name = 'threads_unread'")!.sql).toMatch(/WHERE unread_count > 0/);
    db.exec("ANALYZE");
    for (const view of ["inbox", "starred", "sent", "archive", "spam", "trash", "all"] as const) {
      for (const scope of [{}, { accountId: 1 }, { categoryId: 1 }, { accountId: 1, categoryId: 1 }]) {
        const q = listSql({ view, ...scope, unreadOnly: true, limit: 100, cursor: { lastDate: 1, id: 1 } });
        const plan = db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${q.sql}`, ...q.params).map((r) => r.detail).join(" | ");
        expect(plan, `${view} ${JSON.stringify(scope)}`).toMatch(/USING INDEX threads_unread\b/);
        expect(plan, `${view} ${JSON.stringify(scope)}`).not.toMatch(/TEMP B-TREE/);
        // "select all N" pages of the filtered view walk the unread threads by id (a category, its memberships)
        const s = scopeIdsSql({ view, ...scope, unreadOnly: true, after: 0, limit: 500 });
        const scopePlan = db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${s.sql}`, ...s.params).map((r) => r.detail).join(" | ");
        expect(scopePlan, `scope ${view} ${JSON.stringify(scope)}`).toMatch("categoryId" in scope ? /thread_categories_c/ : /threads_unread_id/);
        expect(scopePlan, `scope ${view} ${JSON.stringify(scope)}`).not.toMatch(/TEMP B-TREE/);
      }
    }
  });
});

describe("migration v12: the quick filters' indexes", () => {
  it("every page filtered by attachments or starred walks its own index in order, without a temporary sort", async () => {
    const { listSql, scopeIdsSql } = await import("./queries");
    const dir = mkdtempSync(join(tmpdir(), "terno-mig12-"));
    dirs.push(dir);
    const db = new Db(nodeSqliteDriver, join(dir, "v12.db"));
    dbs.push(db);
    migrate(db);
    db.exec("ANALYZE");
    for (const [filter, byDate, byId] of [["attachments", "threads_attach", "threads_attach_id"], ["starred", "threads_starred_f", "threads_starred_f_id"]] as const) {
      for (const view of ["inbox", "starred", "sent", "archive", "spam", "trash", "all"] as const) {
        for (const scope of [{}, { accountId: 1 }, { categoryId: 1 }, { accountId: 1, categoryId: 1 }]) {
          const q = listSql({ view, ...scope, filter, limit: 100, cursor: { lastDate: 1, id: 1 } });
          const plan = db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${q.sql}`, ...q.params).map((r) => r.detail).join(" | ");
          expect(plan, `${filter} ${view} ${JSON.stringify(scope)}`).toMatch(new RegExp(`USING (COVERING )?INDEX ${byDate}\\b`));
          expect(plan, `${filter} ${view} ${JSON.stringify(scope)}`).not.toMatch(/TEMP B-TREE/);
          const s = scopeIdsSql({ view, ...scope, filter, after: 0, limit: 500 });
          const scopePlan = db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${s.sql}`, ...s.params).map((r) => r.detail).join(" | ");
          expect(scopePlan, `scope ${filter} ${view} ${JSON.stringify(scope)}`).toMatch("categoryId" in scope ? /thread_categories_c/ : new RegExp(byId));
          expect(scopePlan, `scope ${filter} ${view} ${JSON.stringify(scope)}`).not.toMatch(/TEMP B-TREE/);
        }
      }
    }
  });
});

describe("migration v13: rich drafts", () => {
  it("every v12 draft stays exactly as it was, plain (no HTML), and saves keep working", async () => {
    const { saveDraft } = await import("./repos");
    const dir = mkdtempSync(join(tmpdir(), "terno-mig13-"));
    dirs.push(dir);
    const db = new Db(nodeSqliteDriver, join(dir, "v12.db"));
    dbs.push(db);
    for (const m of MIGRATIONS.filter((m) => m.version <= 12)) db.exec(m.sql);
    db.exec("PRAGMA user_version = 12");
    db.run("INSERT INTO accounts (id, kind, email, display_name, provider_config, created_at) VALUES (1, 'imap', 'yo@x.mx', '', '{}', 0)");
    const text = "Hola,\n\n> citado\n\ttab  y\u00a0nbsp\n";
    db.run("INSERT INTO drafts (id, account_id, format, mode, to_json, cc_json, subject, body_text, quoted_text, include_quote, updated_at) VALUES (1, 1, 2, 'new', '[]', '[]', 'Plano', ?, 'cita', 1, 5)", text);
    const before = db.get<Record<string, unknown>>("SELECT * FROM drafts WHERE id = 1")!;
    expect(migrate(db)).toEqual({ from: 12, to: SCHEMA_VERSION });
    expect(db.get<Record<string, unknown>>("SELECT * FROM drafts WHERE id = 1")).toEqual({ ...before, body_html: "" });
    const saved = saveDraft(db, { id: 1, baseRevision: 1, accountId: 1, to: [], cc: [], subject: "Plano", bodyText: "Hola", bodyHtml: "<div><b>Hola</b></div>" }, 6)!;
    expect(saved).toMatchObject({ body_text: "Hola", body_html: "<div><b>Hola</b></div>", revision: 2 });
  });
});

describe("migration v14: people and waiting for your reply (plan 17)", () => {
  const planOf = (db: Db, sql: string, ...params: (number | string | null)[]) => db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...params).map((r) => r.detail).join(" | ");

  it("rewrites no row: the facts are NULL until the backfill, which starts from its first phase; an empty mailbox has nothing to do", () => {
    const { db } = legacyMail(13, { threads: 30, seed: 4 });
    const before = db.all<Record<string, unknown>>("SELECT * FROM threads ORDER BY id");
    expect(migrate(db)).toEqual({ from: 13, to: SCHEMA_VERSION });
    const after = db.all<Record<string, unknown>>("SELECT * FROM threads ORDER BY id");
    expect(after).toEqual(before.map((t) => ({ ...t, person: null, waiting_since: null })));
    expect(db.get<{ c: number }>("SELECT count(*) AS c FROM messages WHERE is_bulk != 0")!.c).toBe(0);
    expect(db.get<{ c: number }>("SELECT count(*) AS c FROM correspondents")!.c).toBe(0);
    expect(JSON.parse(db.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = 'facts_backfill'")!.value_json)).toEqual({ phase: "senders", after: 0 });
    const empty = v2();
    migrate(empty);
    expect(JSON.parse(empty.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = 'facts_backfill'")!.value_json)).toEqual({ phase: "done" });
  });

  it("People and Waiting pages, counts and scopes, the queue, a failed send's lookup and a sender's messages all walk an index (no table scan, no sort of the mailbox)", async () => {
    const { listSql, scopeIdsSql, waitingSql } = await import("./queries");
    const { SENDER_SQL } = await import("./facts");
    const { db } = legacyMail(13, { threads: 200, seed: 5 });
    migrate(db);
    db.exec("ANALYZE");
    for (const filter of ["people", "waiting"] as const) {
      for (const p of [{ view: "inbox" as const }, { view: "all" as const, accountId: 1 }, { view: "trash" as const }]) {
        const page = listSql({ ...p, filter, now: Date.UTC(2026, 9, 22), limit: 100 });
        const plan = planOf(db, page.sql, ...(page.params as number[]));
        expect(plan, `${filter} ${JSON.stringify(p)} page`).toMatch(filter === "people" ? /threads_people\b/ : /threads_waiting\b/);
        expect(plan, `${filter} page`).not.toMatch(/TEMP B-TREE/);
        const scope = scopeIdsSql({ ...p, filter, now: Date.UTC(2026, 9, 22), limit: 500 });
        const scopePlan = planOf(db, scope.sql, ...(scope.params as number[]));
        // people: its id index in key order; waiting: the window's range of its date index (a sort of what waits, Codex R9)
        expect(scopePlan, `${filter} scope`).toMatch(filter === "people" ? /threads_people_id/ : /threads_waiting \(last_date>\?\)/);
        if (filter === "people") expect(scopePlan).not.toMatch(/TEMP B-TREE/);
      }
    }
    const w = waitingSql(Date.UTC(2026, 9, 22));
    expect(planOf(db, `SELECT t.account_id, count(*) FROM threads t INDEXED BY ${w.byDate} WHERE ${w.where} AND t.in_inbox = 1 GROUP BY t.account_id`, ...(w.params as number[]))).toMatch(/threads_waiting \(last_date>\?\)/);
    // the greeting's count: a covering range of the inbox's waiting threads
    expect(planOf(db, "SELECT account_id, count(*) AS c FROM threads INDEXED BY threads_waiting_inbox WHERE in_inbox = 1 AND waiting_since IS NOT NULL AND waiting_since >= ? GROUP BY account_id", 1)).toMatch(/SEARCH threads USING COVERING INDEX threads_waiting_inbox \(waiting_since>\?\)/);
    expect(planOf(db, "SELECT id FROM threads INDEXED BY threads_facts_pending WHERE person IS NULL ORDER BY last_date DESC, id DESC LIMIT 5")).toMatch(/threads_facts_pending/);
    // Codex review 1, #3: a local copy's failed send, without reading every op ever run
    expect(planOf(db, "SELECT 1 FROM ops WHERE kind = 'send' AND state = 'failed' AND json_extract(target_json, '$.messageIds[0]') = ? LIMIT 1", 7)).toMatch(/SEARCH ops USING INDEX ops_failed_sends/);
    // a sender's messages, and their +tagged forms, by ranges of messages_from
    expect(planOf(db, SENDER_SQL.address, "a@x", 0, 10)).toMatch(/messages_from \(from_email=\? AND rowid>\?\)/);
    // the +tagged forms: the cursor's address past its id (both in the seek, Codex review 2 #4), then the next addresses of the range
    expect(planOf(db, SENDER_SQL.address, "a+b@x", 9, 10)).toMatch(/messages_from \(from_email=\? AND rowid>\?\)/);
    expect(planOf(db, SENDER_SQL.range, "a+", "a,", 10)).toMatch(/messages_from \(from_email>\? AND from_email<\?\)/);
    expect(planOf(db, SENDER_SQL.range, "a+", "a,", 10)).not.toMatch(/TEMP B-TREE/);
    // "answered": message_refs probed per account, in one statement
    expect(planOf(db, "SELECT m.id FROM message_refs r JOIN messages m ON m.id = r.message_id WHERE r.account_id IN (SELECT id FROM accounts) AND r.ref = ?", "q@x")).toMatch(/SEARCH r USING PRIMARY KEY \(account_id=\? AND ref=\?\)/);
  });
});

describe("migration v14: what the code actually runs (Codex review 3, #2)", () => {
  it("the greeting's count and a sender job at a late +tagged cursor run statements that seek their indexes", async () => {
    const { waitingCounts } = await import("./queries");
    const { backfillSlice } = await import("./facts");
    const { db } = legacyMail(13, { threads: 200, seed: 6 });
    migrate(db);
    db.exec("ANALYZE");
    db.run("UPDATE settings SET value_json = '{\"phase\":\"done\"}' WHERE key = 'facts_backfill'");
    db.run("UPDATE threads SET person = 0");
    // every statement the calls prepare, with dummy values for EXPLAIN
    const seen: string[] = [];
    const prepare = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      seen.push(sql);
      return prepare(sql);
    };
    const planOfRun = (sql: string) => db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...Array.from(sql.matchAll(/\?/g), () => 0)).map((r) => r.detail).join(" | ");
    waitingCounts(db, Date.UTC(2026, 9, 22));
    const count = seen.find((s) => /count\(\*\)/.test(s) && /waiting_since/.test(s))!;
    expect(planOfRun(count)).toMatch(/SEARCH threads USING COVERING INDEX threads_waiting_inbox \(waiting_since>\?\)/);
    seen.length = 0;
    db.run("INSERT OR REPLACE INTO settings (key, value_json) VALUES ('facts_senders', ?)", JSON.stringify([{ email: "support@shop.com", stage: 1, from: "support+t1@shop.com", id: 5 }]));
    db.tx(() => backfillSlice(db, 10));
    const senders = seen.filter((s) => /FROM messages WHERE .*from_email [=<>]/.test(s));
    expect(senders.length).toBeGreaterThanOrEqual(2);
    // the cursor's own address is sought with its id in the seek (a row value would read that address's earlier mail)
    expect(senders.some((s) => /messages_from \(from_email=\? AND rowid>\?\)/.test(planOfRun(s)))).toBe(true);
    for (const s of senders) {
      const plan = planOfRun(s);
      expect(plan, s).toMatch(/SEARCH messages USING INDEX messages_from \((from_email=\? AND rowid>\?|from_email>\? AND from_email<\?)\)/);
      expect(plan, s).not.toMatch(/TEMP B-TREE/);
    }
  });
});

describe("scope pages walk an index in key order", () => {
  it("every view, account and category scope pages without a temporary sort", async () => {
    const { scopeIdsSql } = await import("./queries");
    const dir = mkdtempSync(join(tmpdir(), "terno-scopeplan-"));
    dirs.push(dir);
    const db = new Db(nodeSqliteDriver, join(dir, "plan.db"));
    dbs.push(db);
    migrate(db);
    db.exec("ANALYZE");
    for (const p of [
      { view: "all" as const },
      { view: "inbox" as const, accountId: 1 },
      { view: "archive" as const, accountId: 1 },
      { view: "all" as const, categoryId: 1 },
      { view: "inbox" as const, categoryId: 1, accountId: 1 },
    ]) {
      const q = scopeIdsSql({ ...p, after: 0, limit: 500 });
      const plan = db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${q.sql}`, ...q.params).map((r) => r.detail).join(" | ");
      expect(plan, JSON.stringify(p)).not.toMatch(/TEMP B-TREE/);
      if (p.accountId !== undefined && p.categoryId === undefined) expect(plan, JSON.stringify(p)).toMatch(/threads_account_id/);
    }
  });
});


it("migration v15 opens legacy messages with empty Reply-To and preserves their bodies", () => {
  const { db } = legacyMail(14, { threads: 3, seed: 27 });
  const before = db.get<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages ORDER BY id LIMIT 1")!;
  expect(migrate(db)).toEqual({ from: 14, to: SCHEMA_VERSION });
  const message = getThread(db, before.thread_id)!.messages.find((m) => m.id === before.id)!;
  expect(message.replyTo).toEqual([]);
  expect(message.bodyText).toBeTruthy();
  expect(migrate(db)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
});
