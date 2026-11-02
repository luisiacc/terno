import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createCategory, deleteCategory, openDatabase, saveFilter, sqliteDriver } from "./index";
import { MIGRATIONS, migrate } from "./migrations";
import { Db } from "./sqlite";

const dirs: string[] = [];
const opened = new Set<Db>();
afterEach(() => { vi.restoreAllMocks(); for (const db of opened) db.close(); opened.clear(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function path() { const dir = mkdtempSync(join(tmpdir(), "terno-category-identity-")); dirs.push(dir); return join(dir, "test.db"); }
function open(file: string) { const db = openDatabase(file); opened.add(db); return db; }
function close(db: Db) { db.close(); opened.delete(db); }
const rule = (categoryId: number) => ({ match: "all" as const, conditions: [{ field: "subject" as const, op: "contains" as const, value: "Synthetic" }], actions: [{ type: "addCategory" as const, categoryId }] });

it("preserves default and explicit Inbox visibility while allocating stable IDs", () => {
  const file = path(); const db = open(file);
  const shown = createCategory(db, "Shown", "amber");
  const hidden = createCategory(db, "Hidden", "amber", { showInInbox: false });
  expect(shown.showInInbox).toBe(true); expect(hidden.showInInbox).toBe(false);
  close(db); const reopened = open(file);
  expect(reopened.all("SELECT id,show_in_inbox FROM categories ORDER BY id")).toEqual([{ id: shown.id, show_in_inbox: 1 }, { id: hidden.id, show_in_inbox: 0 }]);
});

it("never reuses highest or all deleted category IDs across repeated reopen", () => {
  const file = path(); let db = open(file); let previous = 0;
  for (let round = 0; round < 3; round++) {
    const a = createCategory(db, "A", "amber"), b = createCategory(db, "B", "amber");
    expect(a.id).toBeGreaterThan(previous); expect(b.id).toBeGreaterThan(a.id);
    deleteCategory(db, b.id); close(db); db = open(file);
    const c = createCategory(db, "B", "amber"); expect(c.id).toBeGreaterThan(b.id);
    db.run("DELETE FROM categories"); previous = c.id; close(db); db = open(file);
  }
});

it("reserves nonexistent saved action IDs, including an edited rule, after deleting the rule", () => {
  const file = path(); let db = open(file);
  const f = saveFilter(db, { name: "stale", enabled: true, source: "manual", rule: rule(50) });
  expect(createCategory(db, "New", "amber").id).toBeGreaterThan(50);
  saveFilter(db, { ...f, rule: rule(90) }); db.run("DELETE FROM filters");
  close(db); db = open(file);
  expect(createCategory(db, "Next", "amber").id).toBeGreaterThan(90);
});

it("reserves explicit fresh recovery IDs and refuses retired IDs or primary-key rewrites", () => {
  const db = open(path());
  db.run("INSERT INTO categories(id,name,color,position) VALUES(100,'Explicit','amber',0)");
  deleteCategory(db, 100);
  expect(() => db.run("INSERT INTO categories(id,name,color,position) VALUES(100,'Wrong lifetime','amber',0)")).toThrow();
  const c = createCategory(db, "Legitimate", "amber"); expect(c.id).toBeGreaterThan(100);
  expect(() => db.run("UPDATE categories SET id = 1000 WHERE id = ?", c.id)).toThrow();
  expect(db.get("SELECT name FROM categories WHERE id = ?", c.id)).toMatchObject({ name: "Legitimate" });
});

it("rolls back unpublished allocation and preserves a committed allocation after lost response", () => {
  const file = path(); let db = open(file); const before = createCategory(db, "Before", "amber");
  expect(() => db.tx(() => { createCategory(db, "Never published", "amber"); throw new Error("rollback"); })).toThrow("rollback");
  const committed = createCategory(db, "Committed", "amber"); expect(committed.id).toBe(before.id + 1);
  expect(() => { throw new Error("lost response"); }).toThrow("lost response");
  close(db); db = open(file); expect(db.get("SELECT name FROM categories WHERE id = ?", committed.id)).toMatchObject({ name: "Committed" });
  deleteCategory(db, committed.id); close(db); db = open(file);
  expect(createCategory(db, "After", "amber").id).toBeGreaterThan(committed.id);
});

it("does not reserve a target when an update names a filter that does not exist", () => {
  const db = open(path());
  expect(saveFilter(db, { id: 999, name: "Missing", enabled: true, source: "manual", rule: rule(Number.MAX_SAFE_INTEGER) })).toBeNull();
  expect(createCategory(db, "Usable", "amber").id).toBe(1);
});

it("refuses exhausted safe-integer IDs without partially inserting a category", () => {
  const db = open(path());
  saveFilter(db, { name: "safe bound", enabled: true, source: "manual", rule: rule(Number.MAX_SAFE_INTEGER) });
  expect(() => createCategory(db, "Unsafe", "amber")).toThrow();
  expect(db.all("SELECT * FROM categories")).toEqual([]);
});

it.each(["filter", "pending", "moveSource", "moveRow"] as const)("migrates retained %s references above live max atomically without changing rules, indexes or FKs", (highest) => {
  const ids = { filter: 90, pending: 110, moveSource: 120, moveRow: 130 }; ids[highest] = 200;
  const file = path(); const db = new Db(sqliteDriver(), file); opened.add(db);
  for (const m of MIGRATIONS.filter((m) => m.version <= 32)) db.exec(m.sql);
  db.exec("PRAGMA user_version = 32");
  db.run("INSERT INTO categories(id,name,color,position) VALUES(1,'Survivor','amber',0)");
  // written as the v32 app did (today's saveFilter knows v35's auto column)
  const f = { id: Number(db.run("INSERT INTO filters(name,enabled,source,rule_json,position,created_at) VALUES('legacy',1,'manual',?,0,0)", JSON.stringify(rule(ids.filter))).lastInsertRowid) };
  db.run("INSERT INTO settings(key,value_json) VALUES('import:pending',?)", JSON.stringify({ filters: [{ rule: rule(ids.pending) }] }));
  db.run("INSERT INTO cat_batches(id,category_id,source,scope_json,created_at,added) VALUES(1,1,'dnd',?,0,0)", JSON.stringify({ kind: "move", from: ids.moveSource }));
  db.run("INSERT INTO cat_move_rows(batch_id,thread_id,category_id,added_by,added_at) VALUES(1,9,?,'user',0)", ids.moveRow);
  const schema = db.all("SELECT type,name,sql FROM sqlite_master WHERE tbl_name='categories' OR type IN ('index','trigger') ORDER BY type,name");
  const filters = db.all("SELECT * FROM filters");
  const exec = db.exec.bind(db);
  vi.spyOn(db, "exec").mockImplementation((sql) => { exec(sql); if (sql.includes("CREATE TABLE category_counter")) throw new Error("interrupted upgrade"); });
  expect(() => migrate(db)).toThrow("interrupted upgrade"); vi.restoreAllMocks();
  expect(db.get("PRAGMA user_version")).toEqual({ user_version: 32 });
  expect(db.get("SELECT name FROM sqlite_master WHERE name='category_counter'")).toBeUndefined();
  expect(db.all("SELECT * FROM filters")).toEqual(filters);
  migrate(db);
  // unchanged but for v35's auto column (plan 90: a manual filter without a learned key is the user's) and v44's forward state (plan 116: none)
  expect(db.all("SELECT * FROM filters")).toEqual(filters.map((x) => ({ ...(x as object), auto: 0, forward_json: null })));
  expect(db.get("SELECT rule_json FROM filters WHERE id=?", f.id)).toEqual({ rule_json: JSON.stringify(rule(ids.filter)) });
  // v44 adds the categories' forward state (plan 116); nothing else about them changes
  const later = (row: Record<string, unknown>) => (row.type === "table" && row.name === "categories" ? { ...row, sql: String(row.sql).replace(/\)$/, ", forward_json TEXT)") } : row);
  for (const row of schema) expect(db.all("SELECT type,name,sql FROM sqlite_master WHERE name=?", row.name as string)).toContainEqual(later(row as Record<string, unknown>));
  expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
  expect(createCategory(db, "After upgrade", "amber").id).toBeGreaterThan(200);
  close(db); const reopened = open(file); reopened.run("DELETE FROM categories");
  expect(createCategory(reopened, "After reopen", "amber").id).toBeGreaterThan(201);
});


it.each(["id", "rowid", "_rowid_", "oid", "ROWID", '"_RoWiD_"', "`oid`", "[ROWID]"])("refuses %s rebinding of a retired filter target without changing the replacement lifetime", (alias) => {
  const file = path(); const db = open(file);
  const old = createCategory(db, "Old lifetime", "amber");
  const filter = saveFilter(db, { name: "Retained", enabled: true, source: "manual", rule: rule(old.id) });
  const originalRule = db.get("SELECT rule_json FROM filters WHERE id=?", filter.id);
  expect(old.id).toBe(1);
  deleteCategory(db, old.id);
  const replacement = createCategory(db, "Replacement lifetime", "amber");
  expect(replacement.id).toBe(2);
  expect(db.get("SELECT id FROM categories WHERE id=1")).toBeUndefined();
  expect(() => db.run(`UPDATE categories SET ${alias}=1 WHERE id=2`)).toThrow("Category identity cannot change");
  expect(db.get("SELECT id,name FROM categories WHERE id=2")).toEqual({ id: 2, name: "Replacement lifetime" });
  expect(db.get("SELECT id FROM categories WHERE id=1")).toBeUndefined();
  expect(db.get("SELECT rule_json FROM filters WHERE id=?", filter.id)).toEqual(originalRule);
  db.run(`UPDATE categories SET ${alias}=${alias},name='Renamed replacement',color='cyan',position=7 WHERE id=2`);
  close(db); const reopened = open(file);
  expect(reopened.get("SELECT id,name,color,position FROM categories WHERE id=2")).toEqual({ id: 2, name: "Renamed replacement", color: "cyan", position: 7 });
  expect(reopened.get("SELECT rule_json FROM filters WHERE id=?", filter.id)).toEqual(originalRule);
  expect(createCategory(reopened, "Next lifetime", "amber").id).toBe(3);
});


it("upgrades the installed alias guard atomically without changing categories or retained filters", () => {
  const file = path(); const db = new Db(sqliteDriver(), file); opened.add(db);
  for (const migration of MIGRATIONS.filter((m) => m.version <= 39)) db.exec(migration.sql);
  db.exec("PRAGMA user_version = 39");
  const old = createCategory(db, "Original lifetime", "amber");
  // written as the v39 app did (today's saveFilter knows v44's forward state)
  const filter = { id: Number(db.run("INSERT INTO filters(name,enabled,source,rule_json,position,created_at) VALUES('Preserved rule',1,'manual',?,0,0)", JSON.stringify(rule(old.id))).lastInsertRowid) };
  deleteCategory(db, old.id);
  const replacement = createCategory(db, "Replacement lifetime", "amber");
  expect(old.id).toBe(1); expect(replacement.id).toBe(2);
  const categories = db.all("SELECT * FROM categories");
  const filters = db.all("SELECT * FROM filters");
  const trigger = db.get("SELECT sql FROM sqlite_master WHERE name='category_immutable_id'");
  const exec = db.exec.bind(db);
  vi.spyOn(db, "exec").mockImplementation((sql) => {
    exec(sql);
    if (sql.includes("CREATE TRIGGER category_immutable_id BEFORE UPDATE ON")) throw new Error("interrupted alias upgrade");
  });
  expect(() => migrate(db)).toThrow("interrupted alias upgrade");
  vi.restoreAllMocks();
  expect(db.get("PRAGMA user_version")).toEqual({ user_version: 39 });
  expect(db.get("SELECT sql FROM sqlite_master WHERE name='category_immutable_id'")).toEqual(trigger);
  expect(db.all("SELECT * FROM categories")).toEqual(categories);
  expect(db.all("SELECT * FROM filters")).toEqual(filters);
  migrate(db);
  expect(() => db.run("UPDATE categories SET rowid=1 WHERE id=2")).toThrow("Category identity cannot change");
  // unchanged but for v44's forward state (plan 116: none)
  expect(db.all("SELECT * FROM categories")).toEqual(categories.map((x) => ({ ...(x as object), forward_json: null })));
  expect(db.all("SELECT * FROM filters")).toEqual(filters.map((x) => ({ ...(x as object), forward_json: null })));
  expect(db.get("SELECT rule_json FROM filters WHERE id=?", filter.id)).toEqual({ rule_json: JSON.stringify(rule(1)) });
  close(db); const reopened = open(file);
  expect(() => reopened.run("UPDATE categories SET oid=1 WHERE id=2")).toThrow("Category identity cannot change");
  reopened.run("UPDATE categories SET name='Renamed' WHERE id=2");
  expect(reopened.get("SELECT id,name FROM categories WHERE id=2")).toEqual({ id: 2, name: "Renamed" });
  expect(reopened.all("PRAGMA foreign_key_check")).toEqual([]);
});
