import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateDataset } from "@terno/mock-data";
import { movePending, movePhase, restoreMoveSlice, trainMoveSlice, undoMoveBegin, undoMoveSlice } from "./categorize";
import { getThread } from "./queries";
import { ingestMessages } from "./ingest";
import { rebuildFolders } from "./folders";
import { MIGRATIONS, migrate, SCHEMA_VERSION } from "./migrations";
import { openDatabase } from "./index";
import { nodeSqliteDriver } from "./node-driver";
import { writeLegacyCopy } from "./test/legacy";
import { Db } from "./sqlite";

const dirs: string[] = [];
const dbs: Db[] = [];
/**
 * plan 210 (iteration 4): the columns each of its shape-only migrations adds, null on every row migrated from before it.
 * A migration's test starts from the version just before it, and expects its own columns and every later one's.
 */
const ADDED: Record<number, { dated?: Record<string, null>; followups?: Record<string, null>; drafts?: Record<string, null> }> = {
  65: { dated: { settled_by: null, settled_at: null }, followups: { settled_by: null, settled_at: null } },
  66: { followups: { holds: null } },
  67: { dated: { before_day: null, confirms: null, wall: null }, followups: { before_day: null } },
  68: { dated: { changed_at: null, changed_from: null, proposal: null }, followups: { changed_at: null, changed_from: null, proposal: null } },
  70: { dated: { handed_to: null }, followups: { handed_to: null }, drafts: { handoff_json: null } },
  // (iteration 5)
  71: { dated: { part_of_day: null }, followups: { part_of_day: null } },
};
/** the columns `table` gains migrating from `from` to today's schema, from iteration 4's migrations */
const addedSince = (from: number, table: "dated" | "followups" | "drafts"): Record<string, null> =>
  Object.assign({}, ...Object.entries(ADDED).filter(([v]) => Number(v) > from).map(([, t]) => t[table] ?? {}));
const DATED_IT4 = addedSince(64, "dated");
const FOLLOWUPS_IT4 = addedSince(64, "followups");
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
    expect(db.get<Record<string, unknown>>("SELECT * FROM drafts WHERE id = 1")).toEqual({ ...before, body_html: "", attachments_json: "[]", generation: "", show_source_context: 0, reply_context_json: null, handoff_json: null });
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
    expect(after).toEqual(before.map((t) => ({ ...t, person: null, waiting_since: null, tab: 0 })));
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

describe("migration v23: durable draft source context", () => {
  it("defaults existing drafts without changing their content or identity and constrains new values", () => {
    const dir = mkdtempSync(join(tmpdir(), "terno-mig23-"));
    dirs.push(dir);
    const db = new Db(nodeSqliteDriver, join(dir, "v22.db"));
    dbs.push(db);
    for (const m of MIGRATIONS.filter((m) => m.version <= 22)) db.exec(m.sql);
    db.exec("PRAGMA user_version = 22");
    db.run("INSERT INTO accounts (id, kind, email, display_name, provider_config, created_at) VALUES (1, 'imap', 'synthetic@example.test', '', '{}', 0)");
    db.run("INSERT INTO drafts (id, generation, account_id, format, mode, to_json, cc_json, subject, body_text, body_html, updated_at) VALUES (1, 'generation', 1, 2, 'reply', '[]', '[]', 'subject', 'exact text', '<b>exact</b>', 5)");
    const before = db.get<Record<string, unknown>>("SELECT * FROM drafts WHERE id = 1")!;
    expect(migrate(db)).toEqual({ from: 22, to: SCHEMA_VERSION });
    expect(db.get("SELECT * FROM drafts WHERE id = 1")).toEqual({ ...before, show_source_context: 0, reply_context_json: null, handoff_json: null });
    expect(() => db.run("UPDATE drafts SET show_source_context = 2 WHERE id = 1")).toThrow();
    db.run("UPDATE drafts SET show_source_context = 1 WHERE id = 1");
    expect(db.get("SELECT generation, body_text, body_html, show_source_context FROM drafts WHERE id = 1")).toEqual({ generation: "generation", body_text: "exact text", body_html: "<b>exact</b>", show_source_context: 1 });
    expect(migrate(db)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    expect(() => migrate(db)).toThrow(/newer than this app/);
  });
});

describe("migration v24: an account's own folders (plan 68)", () => {
  it("adds the folder tables, and a Gmail mailbox from before is in its labels after the upgrade's slices (not trash, not spam, user labels only)", () => {
    const dir = mkdtempSync(join(tmpdir(), "terno-mig24-"));
    dirs.push(dir);
    const db = new Db(nodeSqliteDriver, join(dir, "v23.db"));
    dbs.push(db);
    for (const m of MIGRATIONS.filter((m) => m.version <= 23)) db.exec(m.sql);
    db.exec("PRAGMA user_version = 23");
    db.run("INSERT INTO accounts (id, kind, email, display_name, provider_config, created_at) VALUES (1, 'gmail', 'synthetic@example.test', '', '{}', 0)");
    db.run("INSERT INTO threads (id, account_id, last_date, unread_count) VALUES (1, 1, 50, 1), (2, 1, 40, 0), (3, 1, 30, 0)");
    const add = (id: number, thread: number, labels: string | null, trash = 0) =>
      db.run("INSERT INTO messages (id, account_id, thread_id, provider_msg_id, date, gmail_labels, is_trash) VALUES (?, 1, ?, ?, 0, ?, ?)", id, thread, `g${id}`, labels, trash);
    add(1, 1, JSON.stringify(["INBOX", "Label_1", "CATEGORY_UPDATES"]));
    add(2, 2, JSON.stringify(["Label_2"]), 1);
    add(3, 3, "not json");
    expect(migrate(db)).toEqual({ from: 23, to: SCHEMA_VERSION });
    // Codex R13, R14: nothing written in the migration; a message a slice (limit 5) until done, durable between slices
    expect(db.all("SELECT * FROM thread_folders")).toEqual([]);
    expect(rebuildFolders(db, 5)).toEqual({ more: true, touched: [1] });
    expect(db.all("SELECT after_message_id FROM folder_backfill")).toEqual([{ after_message_id: 1 }]);
    for (let r = rebuildFolders(db, 5); r.more; r = rebuildFolders(db, 5));
    expect(db.all("SELECT * FROM folder_backfill")).toEqual([]);
    expect(rebuildFolders(db, 5)).toEqual({ more: false, touched: [] });
    expect(db.all("SELECT thread_id, account_id, folder, last_date, unread FROM thread_folders ORDER BY thread_id")).toEqual([{ thread_id: 1, account_id: 1, folder: "Label_1", last_date: 50, unread: 1 }]);
    expect(db.all("SELECT * FROM folders")).toEqual([]);
  });

  it("Codex R13: a mailbox without Gmail labels has no backfill to run", () => {
    const db = new Db(nodeSqliteDriver, ":memory:");
    dbs.push(db);
    for (const m of MIGRATIONS.filter((m) => m.version <= 23)) db.exec(m.sql);
    db.exec("PRAGMA user_version = 23");
    migrate(db);
    expect(db.all("SELECT * FROM folder_backfill")).toEqual([]);
  });
});

it("upgrades v27 pending and accepted recipient receipts conservatively", () => {
  const db = new Db(nodeSqliteDriver, ":memory:"); dbs.push(db);
  for (const migration of MIGRATIONS.filter((entry) => entry.version <= 27)) db.exec(migration.sql);
  db.exec("PRAGMA user_version = 27"); account(db, { id: 1, kind: "imap", email: "synthetic@example.test", createdAt: 1 });
  for (const [id, state] of [["pending", "pending"], ["accepted", "accepted"]] as const) {
    db.run("INSERT INTO ops(id,seq,account_id,kind,target_json,payload_json,created_at,updated_at) VALUES(?,?,1,'send','{}','{}',1,1)", id, id === "pending" ? 1 : 2);
    db.run("INSERT INTO recipient_receipts(opId,accountId,createdAt,charge,count,parts,state,retired,childOpId,deleteAfter) VALUES(?,1,1,1024,1,1,?,0,NULL,0)", id, state);
  }
  expect(migrate(db)).toEqual({ from: 27, to: SCHEMA_VERSION });
  expect(db.all("SELECT opId,hasRejected FROM recipient_receipts ORDER BY opId")).toEqual([{ opId: "accepted", hasRejected: 1 }, { opId: "pending", hasRejected: 0 }]);
});

describe("migration v35: automatic filters (plan 90)", () => {
  it("marks only SimilarFilters' filters (manual with a learned key) as Terno's; a new one is the user's unless said", () => {
    const db = v2();
    // every step up to v34, then the filters an older app made
    for (const m of MIGRATIONS.filter((m) => m.version > 2 && m.version <= 34)) db.exec(m.sql);
    db.exec("PRAGMA user_version = 34");
    const rule = JSON.stringify({ match: "all", conditions: [{ field: "from", op: "equals", value: "a@b.com" }], actions: [{ type: "spam" }] });
    const insert = (name: string, source: string, key: string | null) => db.run("INSERT INTO filters (name, enabled, source, rule_json, learned_key, created_at) VALUES (?, 1, ?, ?, ?, 0)", name, source, rule, key);
    insert("spam sweep", "manual", "sender:a@b.com:spam");
    insert("mine", "manual", null);
    insert("learned", "learned", "sender:a@b.com:archive");
    expect(migrate(db)).toEqual({ from: 34, to: SCHEMA_VERSION });
    expect(db.all<{ name: string; auto: number }>("SELECT name, auto FROM filters ORDER BY id")).toEqual([
      { name: "spam sweep", auto: 1 },
      { name: "mine", auto: 0 },
      { name: "learned", auto: 0 },
    ]);
    expect(() => db.run("UPDATE filters SET auto = 2")).toThrow();
  });
});

describe("migration v37: Gmail tabs (plan 86)", () => {
  it("adds the columns without rewriting a row, and marks the backfill only for a mailbox with a Gmail account", () => {
    const { db } = legacyMail(36, { threads: 10, seed: 6 });
    const before = db.all<Record<string, unknown>>("SELECT * FROM threads ORDER BY id");
    expect(migrate(db)).toEqual({ from: 36, to: SCHEMA_VERSION });
    expect(db.all<Record<string, unknown>>("SELECT * FROM threads ORDER BY id")).toEqual(before.map((t) => ({ ...t, tab: 0 })));
    expect(db.get<{ c: number }>("SELECT count(*) AS c FROM messages WHERE category IS NOT NULL")!.c).toBe(0);
    expect(db.get("SELECT 1 FROM settings WHERE key = 'tabs_backfill'")).toBeUndefined();
    const gmail = legacyMail(36, { threads: 2, seed: 7 }).db;
    gmail.run("UPDATE accounts SET kind = 'gmail'");
    migrate(gmail);
    expect(JSON.parse(gmail.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = 'tabs_backfill'")!.value_json)).toEqual({ phase: "messages", after: 0 });
  });
});

describe("migration v57: an ask (plan 204, after the third panel round)", () => {
  it("admits `ask`, keeping every row with its id and revision, the indexes, and the ids' high mark (a pruned id isn't reused)", () => {
    const { db } = legacyMail(56, { threads: 3, seed: 8 });
    const thread = db.get<{ id: number }>("SELECT id FROM threads ORDER BY id LIMIT 1")!.id;
    const insert = (id: number | null, kind: string, revision = 0, state = "open") =>
      db.run(
        `INSERT INTO dated_items (id, thread_id, message_id, item, kind, text, quote, sender_key, due_day, due_at, timed, dated, act_at, deferred_until, arrived_at, state, closed_reason, closed_at, from_scan, revision, model, provider, prompt_version, created_at)
         VALUES (?, ?, ?, 0, ?, 'Pay', 'due', 'a@b.mx', '2026-11-20', 5, 0, 1, 4, NULL, 3, ?, NULL, NULL, 0, ?, 'm', 'p', 4, 2)`,
        id, thread, id ?? 100, kind, state, revision,
      );
    insert(1, "pay", 2);
    insert(2, "respond", 0, "done");
    insert(3, "event", 1);
    db.run("DELETE FROM dated_items WHERE id = 3");
    expect(() => insert(4, "ask")).toThrow(/CHECK/);
    const before = db.all<Record<string, unknown>>("SELECT * FROM dated_items ORDER BY id");
    expect(migrate(db)).toEqual({ from: 56, to: SCHEMA_VERSION });
    // v61's columns at their defaults (plan 210, iteration 2)
    expect(db.all<Record<string, unknown>>("SELECT * FROM dated_items ORDER BY id")).toEqual(before.map((r) => ({ ...r, early: 0, same_as: null, detail_of: null, lapses: 0, ...DATED_IT4 })));
    expect(db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'dated_items' AND sql IS NOT NULL ORDER BY name").map((r) => r.name)).toEqual(["dated_closed", "dated_open", "dated_same", "dated_sender", "dated_thread"]);
    expect(db.get("SELECT name FROM sqlite_master WHERE name = 'dated_items_v57'")).toBeUndefined();
    // an ask now; the next id is past the pruned one, as before the upgrade
    insert(null, "ask");
    expect(db.get<{ id: number; kind: string }>("SELECT id, kind FROM dated_items WHERE message_id = 100")).toEqual({ id: 4, kind: "ask" });
    expect(() => insert(null, "chore")).toThrow(/CHECK/);
  });
});

describe("migration v58: a promise's Later (plan 204, the fifth panel round)", () => {
  it("adds a nullable deferral to follow-ups, every row kept as it was (no backfill)", () => {
    const { db } = legacyMail(57, { threads: 2, seed: 9 });
    const thread = db.get<{ id: number }>("SELECT id FROM threads ORDER BY id LIMIT 1")!.id;
    db.run(
      `INSERT INTO followups (thread_id, message_id, item, kind, text, sent_at, due_at, dated, state, revision, created_at)
       VALUES (?, 1, 0, 'promise', 'send the deck', 1, 5, 1, 'open', 3, 2)`,
      thread,
    );
    const before = db.all<Record<string, unknown>>("SELECT * FROM followups ORDER BY id");
    expect(before).toHaveLength(1);
    expect(migrate(db)).toEqual({ from: 57, to: SCHEMA_VERSION });
    expect(db.all<Record<string, unknown>>("SELECT * FROM followups ORDER BY id")).toEqual(before.map((r) => ({ ...r, deferred_until: null, same_as: null, broken_due_at: null, timed: 0, answers: null, ...FOLLOWUPS_IT4 })));
    expect(db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'followups' AND sql IS NOT NULL ORDER BY name").map((r) => r.name)).toEqual(["followups_active", "followups_answers", "followups_closed", "followups_same", "followups_thread", "followups_top"]);
  });
});

describe("migration v61: What matters' items (plan 210, iteration 2)", () => {
  it("adds duplicates, details, early, a broken promise's day and a promise's time at their defaults, every row kept, and drops v59's per-thread closing indexes (shape only)", () => {
    const { db } = legacyMail(60, { threads: 2, seed: 10 });
    const thread = db.get<{ id: number }>("SELECT id FROM threads ORDER BY id LIMIT 1")!.id;
    db.run(
      `INSERT INTO dated_items (thread_id, message_id, item, kind, text, quote, sender_key, due_day, due_at, timed, dated, act_at, arrived_at, state, revision, created_at)
       VALUES (?, 1, 0, 'respond', 'Send the form', 'send the form', 'a@b.mx', '2026-11-30', 5, 0, 1, 4, 3, 'open', 2, 2)`,
      thread,
    );
    db.run(
      `INSERT INTO followups (thread_id, message_id, item, kind, text, sent_at, due_at, dated, deferred_until, state, revision, created_at)
       VALUES (?, 2, 0, 'promise', 'call Marcus at 4:00 PM', 1, 5, 1, NULL, 'open', 3, 2)`,
      thread,
    );
    const dated = db.all<Record<string, unknown>>("SELECT * FROM dated_items ORDER BY id");
    const followups = db.all<Record<string, unknown>>("SELECT * FROM followups ORDER BY id");
    expect(migrate(db)).toEqual({ from: 60, to: SCHEMA_VERSION });
    expect(db.all<Record<string, unknown>>("SELECT * FROM dated_items ORDER BY id")).toEqual(dated.map((r) => ({ ...r, early: 0, same_as: null, detail_of: null, lapses: 0, ...DATED_IT4 })));
    expect(db.all<Record<string, unknown>>("SELECT * FROM followups ORDER BY id")).toEqual(followups.map((r) => ({ ...r, same_as: null, broken_due_at: null, timed: 0, answers: null, ...FOLLOWUPS_IT4 })));
    // `same_as` by index, only where it's set
    expect(db.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'dated_same'")!.sql).toMatch(/WHERE same_as IS NOT NULL/);
    expect(db.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'followups_same'")!.sql).toMatch(/WHERE same_as IS NOT NULL/);
    expect(db.all<{ detail: string }>("EXPLAIN QUERY PLAN SELECT id FROM dated_items WHERE same_as IN ('dated:1')").map((r) => r.detail).join(" ")).toMatch(/dated_same/);
    // a line per closed item now: no conversation's newest closing is read
    for (const name of ["dated_closed_thread", "followups_closed_thread"]) expect(db.get("SELECT 1 FROM sqlite_master WHERE name = ?", name)).toBeUndefined();
    for (const name of ["dated_closed", "followups_closed"]) expect(db.get("SELECT 1 FROM sqlite_master WHERE name = ?", name)).toBeDefined();
  });
});

describe("migration v62: a promise answers a request (plan 210, iteration 3)", () => {
  it("adds a promise's request and a confirmed send's mark at their defaults, every row kept (no backfill: an old send isn't an answer), and finds a request's promises by index", () => {
    const { db } = legacyMail(61, { threads: 2, seed: 11 });
    const m = db.get<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages ORDER BY id LIMIT 1")!;
    db.run(
      `INSERT INTO followups (thread_id, message_id, item, kind, text, sent_at, due_at, dated, state, revision, created_at)
       VALUES (?, 2, 0, 'promise', 'send the slip', 1, 5, 1, 'open', 3, 2)`,
      m.thread_id,
    );
    db.run("INSERT INTO ai_sent_mail (message_id, thread_id, sent_at, queued_at, source) VALUES (?, ?, 1, 2, 'live')", m.id, m.thread_id);
    const followups = db.all<Record<string, unknown>>("SELECT * FROM followups ORDER BY id");
    const marks = db.all<Record<string, unknown>>("SELECT * FROM ai_sent_mail ORDER BY message_id");
    expect(migrate(db)).toEqual({ from: 61, to: SCHEMA_VERSION });
    expect(db.all<Record<string, unknown>>("SELECT * FROM followups ORDER BY id")).toEqual(followups.map((r) => ({ ...r, answers: null, ...FOLLOWUPS_IT4 })));
    expect(db.all<Record<string, unknown>>("SELECT * FROM ai_sent_mail ORDER BY message_id")).toEqual(marks.map((r) => ({ ...r, confirmed: 0 })));
    expect(db.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'followups_answers'")!.sql).toMatch(/WHERE answers IS NOT NULL/);
    expect(db.all<{ detail: string }>("EXPLAIN QUERY PLAN SELECT id FROM followups WHERE answers = 7").map((r) => r.detail).join(" ")).toMatch(/followups_answers/);
  });
});

describe("migration v63: an item that lapses unless renewed (plan 210, iteration 3)", () => {
  it("adds the fact at its default, off, every row kept as it was (shape only, no backfill)", () => {
    const { db } = legacyMail(61, { threads: 2, seed: 11 });
    const thread = db.get<{ id: number }>("SELECT id FROM threads ORDER BY id LIMIT 1")!.id;
    db.run(
      `INSERT INTO dated_items (thread_id, message_id, item, kind, text, quote, sender_key, due_day, due_at, timed, dated, act_at, arrived_at, state, revision, created_at)
       VALUES (?, 1, 0, 'renew', 'Renew the domain', 'renew before it expires', 'a@b.mx', '2026-12-07', 5, 0, 1, 4, 3, 'open', 2, 2)`,
      thread,
    );
    const before = db.all<Record<string, unknown>>("SELECT * FROM dated_items ORDER BY id");
    expect(migrate(db)).toEqual({ from: 61, to: SCHEMA_VERSION });
    expect(db.all<Record<string, unknown>>("SELECT * FROM dated_items ORDER BY id")).toEqual(before.map((r) => ({ ...r, lapses: 0, ...DATED_IT4 })));
  });
});

describe("migration v64: a confirmed send stays yours for certain (plan 210, iteration 3, Codex code review)", () => {
  it("adds the fact at its default, not confirmed, every message kept as it was (shape only, no backfill)", () => {
    const { db } = legacyMail(63, { threads: 2, seed: 11 });
    const before = db.all<Record<string, unknown>>("SELECT * FROM messages ORDER BY id");
    expect(before.length).toBeGreaterThan(0);
    expect(migrate(db)).toEqual({ from: 63, to: SCHEMA_VERSION });
    expect(db.all<Record<string, unknown>>("SELECT * FROM messages ORDER BY id")).toEqual(before.map((r) => ({ ...r, sent_confirmed: 0 })));
  });
});

describe("migration v68: Change… (plan 210, iteration 4)", () => {
  it("adds the user's schedule, its change and a mail's proposal, all null, every item and promise kept as it was (shape only)", () => {
    const { db } = legacyMail(67, { threads: 2, seed: 12 });
    const thread = db.get<{ id: number }>("SELECT id FROM threads ORDER BY id LIMIT 1")!.id;
    db.run(
      `INSERT INTO dated_items (thread_id, message_id, item, kind, text, quote, sender_key, due_day, due_at, timed, dated, act_at, arrived_at, state, revision, created_at)
       VALUES (?, 1, 0, 'pay', 'Pay the bill', 'due Friday', 'a@b.mx', '2026-12-04', 5, 0, 1, 4, 3, 'open', 2, 2)`,
      thread,
    );
    db.run(
      `INSERT INTO followups (thread_id, message_id, item, kind, text, sent_at, due_at, dated, state, inbox_state, revision, created_at)
       VALUES (?, 1, 0, 'promise', 'send the script', 1, 5, 1, 'open', 'none', 3, 1)`,
      thread,
    );
    const dated = db.all<Record<string, unknown>>("SELECT * FROM dated_items ORDER BY id");
    const followups = db.all<Record<string, unknown>>("SELECT * FROM followups ORDER BY id");
    expect(migrate(db)).toEqual({ from: 67, to: SCHEMA_VERSION });
    expect(db.all<Record<string, unknown>>("SELECT * FROM dated_items ORDER BY id")).toEqual(dated.map((r) => ({ ...r, ...addedSince(67, "dated") })));
    expect(db.all<Record<string, unknown>>("SELECT * FROM followups ORDER BY id")).toEqual(followups.map((r) => ({ ...r, ...addedSince(67, "followups") })));
  });
});

describe("migration v70: Hand to… (plan 210, iteration 4)", () => {
  it("adds a draft's hand-off and an item's recipient at none, every draft, item and promise kept as it was (shape only)", () => {
    const { db } = legacyMail(69, { threads: 2, seed: 12 });
    const thread = db.get<{ id: number }>("SELECT id FROM threads ORDER BY id LIMIT 1")!.id;
    db.run("INSERT INTO drafts (id, generation, account_id, thread_id, mode, to_json, cc_json, bcc_json, subject, body_text, body_html, attachments_json, quoted_text, include_quote, format, revision, updated_at) VALUES (1, 'g', 1, NULL, 'forward', '[]', '[]', '[]', 'Fwd', 'hi', '', '[]', '', 0, 2, 3, 4)");
    db.run(
      `INSERT INTO dated_items (thread_id, message_id, item, kind, text, quote, sender_key, due_day, due_at, timed, dated, act_at, arrived_at, state, revision, created_at)
       VALUES (?, 1, 0, 'respond', 'Sign the form', 'sign it', 'a@b.mx', '2026-12-07', 5, 0, 1, 4, 3, 'open', 2, 2)`,
      thread,
    );
    db.run(`INSERT INTO followups (thread_id, message_id, item, kind, text, sent_at, due_at, dated, state, revision, created_at) VALUES (?, 2, 0, 'promise', 'send the slip', 1, 5, 1, 'open', 3, 2)`, thread);
    const drafts = db.all<Record<string, unknown>>("SELECT * FROM drafts ORDER BY id");
    const dated = db.all<Record<string, unknown>>("SELECT * FROM dated_items ORDER BY id");
    const followups = db.all<Record<string, unknown>>("SELECT * FROM followups ORDER BY id");
    expect(migrate(db)).toEqual({ from: 69, to: SCHEMA_VERSION });
    expect(db.all<Record<string, unknown>>("SELECT * FROM drafts ORDER BY id")).toEqual(drafts.map((r) => ({ ...r, ...addedSince(69, "drafts") })));
    expect(db.all<Record<string, unknown>>("SELECT * FROM dated_items ORDER BY id")).toEqual(dated.map((r) => ({ ...r, ...addedSince(69, "dated") })));
    expect(db.all<Record<string, unknown>>("SELECT * FROM followups ORDER BY id")).toEqual(followups.map((r) => ({ ...r, ...addedSince(69, "followups") })));
  });
});

describe("migration v71: a part of the day (plan 210, iteration 5)", () => {
  it("adds the part at none, every item and promise kept as it was, for the whole day (shape only, no backfill)", () => {
    const { db } = legacyMail(70, { threads: 2, seed: 12 });
    const thread = db.get<{ id: number }>("SELECT id FROM threads ORDER BY id LIMIT 1")!.id;
    db.run(
      `INSERT INTO dated_items (thread_id, message_id, item, kind, text, quote, sender_key, due_day, due_at, timed, dated, act_at, arrived_at, state, revision, created_at)
       VALUES (?, 1, 0, 'respond', 'Send Kai notes', 'by saturday morning', 'a@b.mx', '2026-12-05', 5, 0, 1, 4, 3, 'open', 2, 2)`,
      thread,
    );
    db.run(`INSERT INTO followups (thread_id, message_id, item, kind, text, sent_at, due_at, dated, timed, state, revision, created_at) VALUES (?, 2, 0, 'promise', 'bring the cupcakes by 12:00 PM', 1, 5, 1, 1, 'open', 3, 2)`, thread);
    const dated = db.all<Record<string, unknown>>("SELECT * FROM dated_items ORDER BY id");
    const followups = db.all<Record<string, unknown>>("SELECT * FROM followups ORDER BY id");
    expect(migrate(db)).toEqual({ from: 70, to: SCHEMA_VERSION });
    expect(db.all<Record<string, unknown>>("SELECT * FROM dated_items ORDER BY id")).toEqual(dated.map((r) => ({ ...r, ...addedSince(70, "dated") })));
    expect(db.all<Record<string, unknown>>("SELECT * FROM followups ORDER BY id")).toEqual(followups.map((r) => ({ ...r, ...addedSince(70, "followups") })));
    expect(addedSince(70, "dated")).toEqual({ part_of_day: null });
  });
});

describe("migration v75: Remove on a conversation waiting on you (plan 216)", () => {
  it("rebuilds the table with v74's records as they were, takes a removed one, keeps its indexes and its cascade (shape only)", () => {
    const { db } = legacyMail(74, { threads: 3, seed: 19 });
    const [a, b, c] = db.all<{ id: number }>("SELECT id FROM messages ORDER BY id LIMIT 3").map((r) => r.id) as [number, number, number];
    db.run("INSERT INTO waiting_acts (message_id, state, until, at, rev, who, subject, wrote) VALUES (?, 'later', 9, 1, 2, 'Ana', 'Q3', 1)", a);
    db.run("INSERT INTO waiting_acts (message_id, state, until, at, rev, who, subject, wrote) VALUES (?, 'done', NULL, 3, 1, 'Bea', 'Offsite', 0)", b);
    expect(() => db.run("INSERT INTO waiting_acts (message_id, state, at, rev) VALUES (?, 'removed', 1, 1)", c)).toThrow();
    const before = db.all<Record<string, unknown>>("SELECT * FROM waiting_acts ORDER BY message_id");
    const threads = db.all<Record<string, unknown>>("SELECT * FROM threads ORDER BY id");
    expect(migrate(db)).toEqual({ from: 74, to: SCHEMA_VERSION });
    expect(db.all<Record<string, unknown>>("SELECT * FROM waiting_acts ORDER BY message_id")).toEqual(before);
    expect(db.all<Record<string, unknown>>("SELECT * FROM threads ORDER BY id")).toEqual(threads);
    expect(db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'waiting_acts' AND sql IS NOT NULL ORDER BY name").map((r) => r.name)).toEqual(["waiting_acts_done", "waiting_acts_later", "waiting_acts_removed"]);
    db.run("INSERT INTO waiting_acts (message_id, state, at, rev) VALUES (?, 'removed', 1, 1)", c);
    expect(() => db.run("UPDATE waiting_acts SET state = 'gone' WHERE message_id = ?", c)).toThrow();
    expect(db.get<{ n: number }>("SELECT count(*) AS n FROM waiting_acts INDEXED BY waiting_acts_removed WHERE state = 'removed'")!.n).toBe(1);
    db.run("DELETE FROM messages WHERE id = ?", c);
    expect(db.all<{ message_id: number }>("SELECT message_id FROM waiting_acts ORDER BY message_id").map((r) => r.message_id)).toEqual([a, b]);
  });
});

describe("migration v77: What matters in your words (plan 248)", () => {
  it("adds three empty tables with their indexes, every thread, message, dated item and setting kept as it was; a mark goes with its message and an item with its thread", () => {
    const { db } = legacyMail(76, { threads: 3, seed: 19 });
    const [first, second] = db.all<{ id: number; thread_id: number; date: number }>("SELECT id, thread_id, date FROM messages ORDER BY id LIMIT 2");
    db.run("INSERT INTO settings (key, value_json) VALUES ('theme', '\"dark\"')");
    db.run("INSERT INTO dated_items (thread_id, message_id, item, kind, text, quote, sender_key, due_day, due_at, act_at, arrived_at, state, created_at) VALUES (?, ?, 0, 'pay', 'Pay', 'due', 'a@x.mx', '2026-11-30', 9, 8, 7, 'open', 6)", first!.thread_id, first!.id);
    const kept = () => ["threads", "messages", "dated_items", "settings"].map((t) => db.all<Record<string, unknown>>(`SELECT * FROM ${t} ORDER BY 1`));
    const before = kept();
    expect(migrate(db)).toEqual({ from: 76, to: SCHEMA_VERSION });
    expect(kept()).toEqual(before);
    for (const t of ["preference_verdicts", "wanted_items", "wanted_marks"]) expect(db.all(`SELECT * FROM ${t}`)).toEqual([]);
    expect(db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('preference_verdicts', 'wanted_items', 'wanted_marks') AND sql IS NOT NULL ORDER BY name").map((r) => r.name)).toEqual(["preference_verdicts_at", "wanted_marks_order", "wanted_message", "wanted_open", "wanted_thread"]);
    const item = (thread: number, message: number, state: string) =>
      db.run("INSERT INTO wanted_items (thread_id, message_id, kind, text, quote, sender_key, due_day, due_at, act_at, arrived_at, state, rules, created_at) VALUES (?, ?, 'renew', 'Renew', 'renews', 'a@x.mx', '2026-11-30', 9, 8, 7, ?, '[\"s1\"]', 6)", thread, message, state);
    item(first!.thread_id, first!.id, "open");
    item(second!.thread_id, second!.id, "done");
    // only the states and sources there are; an item needs its thread, a mark its message
    expect(() => item(first!.thread_id, first!.id, "settled")).toThrow();
    expect(() => item(999_999, first!.id, "open")).toThrow();
    db.run("INSERT INTO wanted_marks (message_id, thread_id, arrived_at, queued_at, source) VALUES (?, ?, 1, 2, 'look')", first!.id, first!.thread_id);
    expect(() => db.run("INSERT INTO wanted_marks (message_id, thread_id, arrived_at, queued_at, source) VALUES (?, ?, 1, 2, 'scan')", second!.id, second!.thread_id)).toThrow();
    expect(() => db.run("INSERT INTO wanted_marks (message_id, thread_id, arrived_at, queued_at, source) VALUES (999999, 1, 1, 2, 'live')")).toThrow();
    expect(db.get<{ n: number }>("SELECT count(*) AS n FROM wanted_items INDEXED BY wanted_open WHERE state = 'open'")!.n).toBe(1);
    expect(db.get("SELECT timed, dated, revision, from_look, deferred_until, orphaned_at FROM wanted_items WHERE state = 'open'")).toEqual({ timed: 0, dated: 1, revision: 0, from_look: 0, deferred_until: null, orphaned_at: null });
    db.run("INSERT INTO preference_verdicts (target, basis, at) VALUES ('d:1:0', 'b', 5)");
    expect(db.get("SELECT rules, failed FROM preference_verdicts")).toEqual({ rules: "[]", failed: 0 });
    db.run("DELETE FROM threads WHERE id = ?", first!.thread_id);
    expect(db.all<{ thread_id: number }>("SELECT thread_id FROM wanted_items").map((r) => r.thread_id)).toEqual([second!.thread_id]);
    expect(db.all("SELECT * FROM wanted_marks")).toEqual([]);
  });
});

describe("migration v74: Done and Later on a conversation waiting on you (plan 215)", () => {
  it("adds an empty table with its two partial indexes, every message and thread kept as it was; a record goes with its message", () => {
    const { db } = legacyMail(73, { threads: 3, seed: 17 });
    const threads = db.all<Record<string, unknown>>("SELECT * FROM threads ORDER BY id");
    const messages = db.all<Record<string, unknown>>("SELECT * FROM messages ORDER BY id");
    expect(migrate(db)).toEqual({ from: 73, to: SCHEMA_VERSION });
    expect(db.all<Record<string, unknown>>("SELECT * FROM threads ORDER BY id")).toEqual(threads);
    expect(db.all<Record<string, unknown>>("SELECT * FROM messages ORDER BY id")).toEqual(messages);
    expect(db.all("SELECT * FROM waiting_acts")).toEqual([]);
    expect(db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'waiting_acts' AND sql IS NOT NULL ORDER BY name").map((r) => r.name)).toEqual(expect.arrayContaining(["waiting_acts_done", "waiting_acts_later"]));
    const m = messages[0]!.id as number;
    db.run("INSERT INTO waiting_acts (message_id, state, until, at, rev) VALUES (?, 'later', 9, 1, 1)", m);
    expect(() => db.run("INSERT INTO waiting_acts (message_id, state, at, rev) VALUES (?, 'gone', 1, 1)", messages[1]!.id as number)).toThrow();
    db.run("DELETE FROM messages WHERE id = ?", m);
    expect(db.all("SELECT * FROM waiting_acts")).toEqual([]);
  });
});

describe("migration v73: the second look's claim (plan 210, iteration 5)", () => {
  it("adds the mark's claim at none, every mark kept as it was (shape only)", () => {
    // the version just before it, whichever of iteration 5's others came first
    const before = MIGRATIONS.filter((m) => m.version < 73).at(-1)!.version;
    const { db } = legacyMail(before, { threads: 2, seed: 13 });
    const [first, second] = db.all<{ id: number; thread_id: number; date: number }>("SELECT id, thread_id, date FROM messages ORDER BY id LIMIT 2");
    for (const [m, source] of [[first!, "live"], [second!, "scan"]] as const) db.run("INSERT INTO ai_dated_mail (message_id, thread_id, arrived_at, queued_at, source) VALUES (?, ?, ?, 7, ?)", m.id, m.thread_id, m.date, source);
    const marks = db.all<Record<string, unknown>>("SELECT * FROM ai_dated_mail ORDER BY message_id");
    expect(migrate(db)).toEqual({ from: before, to: SCHEMA_VERSION });
    expect(db.all<Record<string, unknown>>("SELECT * FROM ai_dated_mail ORDER BY message_id")).toEqual(marks.map((r) => ({ ...r, looked_at: null })));
  });
});

describe("migration v65: the mail that settled an item, and its date (plan 210, iteration 4, revision 7)", () => {
  it("adds both columns to both tables, empty, every row kept as it was (shape only, no backfill)", () => {
    const { db } = legacyMail(64, { threads: 2, seed: 11 });
    const thread = db.get<{ id: number }>("SELECT id FROM threads ORDER BY id LIMIT 1")!.id;
    db.run(
      `INSERT INTO dated_items (thread_id, message_id, item, kind, text, quote, sender_key, due_day, due_at, timed, dated, act_at, arrived_at, state, closed_reason, closed_at, revision, created_at)
       VALUES (?, 1, 0, 'pay', 'Pay the bill', 'due Friday', 'a@b.mx', '2026-12-07', 5, 0, 1, 4, 3, 'settled', 'settled', 9, 2, 2)`,
      thread,
    );
    db.run(
      `INSERT INTO followups (thread_id, message_id, item, kind, text, sent_at, due_at, dated, state, inbox_state, closed_reason, closed_at, revision, created_at)
       VALUES (?, 1, 0, 'promise', 'send the deck', 3, 5, 1, 'done', 'none', 'kept', 9, 2, 2)`,
      thread,
    );
    const dated = db.all<Record<string, unknown>>("SELECT * FROM dated_items ORDER BY id");
    const followups = db.all<Record<string, unknown>>("SELECT * FROM followups ORDER BY id");
    expect(migrate(db)).toEqual({ from: 64, to: SCHEMA_VERSION });
    expect(db.all<Record<string, unknown>>("SELECT * FROM dated_items ORDER BY id")).toEqual(dated.map((r) => ({ ...r, ...addedSince(64, "dated") })));
    expect(db.all<Record<string, unknown>>("SELECT * FROM followups ORDER BY id")).toEqual(followups.map((r) => ({ ...r, ...addedSince(64, "followups") })));
  });
});

describe("migration v67: before a day, a confirmation's event, the mail's own clock (plan 210, iteration 4)", () => {
  it("adds nullable columns, every item and promise kept as it was with none (shape only, nothing guessed)", () => {
    const { db } = legacyMail(66, { threads: 2, seed: 12 });
    const m = db.get<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages ORDER BY id LIMIT 1")!;
    db.run("INSERT INTO dated_items (thread_id, message_id, item, kind, text, quote, sender_key, due_day, due_at, timed, dated, act_at, arrived_at, state, from_scan, revision, created_at) VALUES (?, ?, 0, 'respond', 't', 'q', 'k', '2026-11-15', 1, 0, 1, 1, 1, 'open', 0, 0, 1)", m.thread_id, m.id);
    const dated = db.all<Record<string, unknown>>("SELECT * FROM dated_items ORDER BY id");
    const followups = db.all<Record<string, unknown>>("SELECT * FROM followups ORDER BY id");
    expect(migrate(db)).toEqual({ from: 66, to: SCHEMA_VERSION });
    expect(db.all<Record<string, unknown>>("SELECT * FROM dated_items ORDER BY id")).toEqual(dated.map((r) => ({ ...r, ...addedSince(66, "dated") })));
    expect(db.all<Record<string, unknown>>("SELECT * FROM followups ORDER BY id")).toEqual(followups.map((r) => ({ ...r, ...addedSince(66, "followups") })));
  });
});

describe("migration v66: a promise that holds a request (plan 210, iteration 4)", () => {
  it("adds the link at its default, none, every promise kept as it was (shape only, no backfill)", () => {
    const { db } = legacyMail(65, { threads: 2, seed: 11 });
    const thread = db.get<{ id: number }>("SELECT id FROM threads ORDER BY id LIMIT 1")!.id;
    db.run(
      `INSERT INTO followups (thread_id, message_id, item, kind, text, sent_at, due_at, dated, state, revision, created_at, answers)
       VALUES (?, 2, 0, 'promise', 'check your calendar and get back to Dolores', 1, 5, 0, 'open', 3, 2, NULL)`,
      thread,
    );
    const before = db.all<Record<string, unknown>>("SELECT * FROM followups ORDER BY id");
    expect(migrate(db)).toEqual({ from: 65, to: SCHEMA_VERSION });
    expect(db.all<Record<string, unknown>>("SELECT * FROM followups ORDER BY id")).toEqual(before.map((r) => ({ ...r, ...addedSince(65, "followups") })));
  });
});

describe("migration v60: what the dated reader read with nothing asked (plan 210, iteration 2)", () => {
  it("adds an empty table keyed by message and found by thread, every message kept; a row goes with its message", () => {
    const { db } = legacyMail(59, { threads: 2, seed: 10 });
    const before = db.all<Record<string, unknown>>("SELECT id, thread_id FROM messages ORDER BY id");
    expect(migrate(db)).toEqual({ from: 59, to: SCHEMA_VERSION });
    expect(db.get<{ n: number }>("SELECT count(*) AS n FROM dated_nothing_asked")!.n).toBe(0);
    expect(db.all<Record<string, unknown>>("SELECT id, thread_id FROM messages ORDER BY id")).toEqual(before);
    expect(db.all<{ name: string }>("SELECT name FROM pragma_table_info('dated_nothing_asked') ORDER BY cid").map((r) => r.name)).toEqual(["message_id", "thread_id", "arrived_at", "prompt_version"]);
    expect(db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'dated_nothing_asked' AND sql IS NOT NULL").map((r) => r.name)).toEqual(["dated_nothing_asked_thread"]);
    const m = before.at(-1) as { id: number; thread_id: number };
    db.run("INSERT INTO dated_nothing_asked (message_id, thread_id, arrived_at, prompt_version) VALUES (?, ?, 5, 12)", m.id, m.thread_id);
    db.exec("PRAGMA foreign_keys = ON");
    db.run("DELETE FROM messages WHERE id = ?", m.id);
    expect(db.get<{ n: number }>("SELECT count(*) AS n FROM dated_nothing_asked")!.n).toBe(0);
  });
});

describe("migration v69: muted senders and kinds (plan 210, iteration 4)", () => {
  it("adds an empty table keyed by what's muted, every message kept; a target outside sender and kind is refused", () => {
    const { db } = legacyMail(64, { threads: 2, seed: 12 });
    const before = db.all<Record<string, unknown>>("SELECT id, thread_id FROM messages ORDER BY id");
    expect(migrate(db)).toEqual({ from: 64, to: SCHEMA_VERSION });
    expect(db.get<{ n: number }>("SELECT count(*) AS n FROM dated_mutes")!.n).toBe(0);
    expect(db.all<Record<string, unknown>>("SELECT id, thread_id FROM messages ORDER BY id")).toEqual(before);
    expect(db.all<{ name: string }>("SELECT name FROM pragma_table_info('dated_mutes') ORDER BY cid").map((r) => r.name)).toEqual(["target", "key", "name", "created_at"]);
    db.run("INSERT INTO dated_mutes (target, key, created_at) VALUES ('kind', 'delivery', 1)");
    expect(() => db.run("INSERT INTO dated_mutes (target, key, created_at) VALUES ('kind', 'delivery', 2)")).toThrow();
    expect(() => db.run("INSERT INTO dated_mutes (target, key, created_at) VALUES ('thread', '5', 1)")).toThrow();
  });
});

describe("migration v72: a kind muted from one sender (plan 210, iteration 5)", () => {
  it("adds an empty companion table keyed by sender and kind, v69's table and every message kept as they were", () => {
    const { db } = legacyMail(70, { threads: 2, seed: 12 });
    db.run("INSERT INTO dated_mutes (target, key, name, created_at) VALUES ('sender', 'ana@people.test', 'Ana', 1)");
    const before = db.all<Record<string, unknown>>("SELECT id, thread_id FROM messages ORDER BY id");
    const mutes = db.all<Record<string, unknown>>("SELECT * FROM dated_mutes");
    const mutesSql = db.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'dated_mutes'")!.sql;
    expect(migrate(db)).toEqual({ from: 70, to: SCHEMA_VERSION });
    expect(db.get<{ n: number }>("SELECT count(*) AS n FROM dated_mute_pairs")!.n).toBe(0);
    expect(db.all<Record<string, unknown>>("SELECT id, thread_id FROM messages ORDER BY id")).toEqual(before);
    // v69's CHECK and key untouched: a pair is never a target there
    expect(db.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'dated_mutes'")!.sql).toBe(mutesSql);
    expect(db.all<Record<string, unknown>>("SELECT * FROM dated_mutes")).toEqual(mutes);
    expect(() => db.run("INSERT INTO dated_mutes (target, key, created_at) VALUES ('pair', 'delivery|a@b.test', 1)")).toThrow();
    expect(db.all<{ name: string }>("SELECT name FROM pragma_table_info('dated_mute_pairs') ORDER BY cid").map((r) => r.name)).toEqual(["sender_key", "kind", "name", "created_at"]);
    db.run("INSERT INTO dated_mute_pairs (sender_key, kind, created_at) VALUES ('track@parcelo.test', 'delivery', 1)");
    db.run("INSERT INTO dated_mute_pairs (sender_key, kind, created_at) VALUES ('track@parcelo.test', 'pay', 1)");
    expect(() => db.run("INSERT INTO dated_mute_pairs (sender_key, kind, created_at) VALUES ('track@parcelo.test', 'delivery', 2)")).toThrow();
  });
});
