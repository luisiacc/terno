import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { openDatabase, sqliteDriver } from "./index";
import { MIGRATIONS, migrate } from "./migrations";
import { getCounts } from "./queries";
import { Db } from "./sqlite";

const opened: Db[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) if (db.isOpen) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const original = `SELECT tc.category_id, count(*) AS total, sum(t.unread_count > 0) AS unread
 FROM thread_categories tc JOIN threads t ON t.id=tc.thread_id
 WHERE t.in_trash=0 AND t.in_spam=0 GROUP BY tc.category_id`;
interface Count { category_id: number; total: number; unread: number }
interface Op { opcode: string; p1: number; p2: number; p3: number }
function tableWork(db: Db, sql: string) {
  const root = db.get<{ rootpage: number }>("SELECT rootpage FROM sqlite_schema WHERE name='threads'")!.rootpage;
  const ops = db.all<Op>(`EXPLAIN ${sql}`);
  const tables = new Set(ops.filter(o => o.opcode === "OpenRead" && o.p2 === root).map(o => o.p1));
  return ops.filter(o => (tables.has(o.p1) && ["Column", "SeekRowid"].includes(o.opcode)) || (o.opcode === "DeferredSeek" && tables.has(o.p3)));
}
function fill(db: Db, n = 120) {
  db.tx(() => {
    db.run("INSERT INTO accounts(id,kind,email,display_name,created_at) VALUES(1,'gmail','synthetic@example.test','Synthetic',0)");
    for (let c = 1; c <= 4; c++) db.run("INSERT INTO categories(id,name,color,position,show_in_inbox) VALUES(?,?,'blue',?,?)", c, `Synthetic ${c}`, c, c === 2 ? 0 : 1);
    for (let id = 1; id <= n; id++) {
      db.run("INSERT INTO threads(id,account_id,provider_thread_id,subject,snippet,last_date,unread_count,in_inbox,in_trash,in_spam,person) VALUES(?,1,?,'Synthetic','',?, ?,1,?,?,0)", id, `t${id}`, id, id % 3, [0, 0, 0, 1, 2, -1][id % 6]!, [0, 0, 0, 0, 0, 1, 2, -1][id % 8]!);
      db.run("INSERT INTO thread_categories(thread_id,category_id) VALUES(?,1),(?,2)", id, id);
      if (id % 2) db.run("INSERT INTO thread_categories(thread_id,category_id) VALUES(?,3)", id);
    }
    db.run("INSERT INTO thread_categories(thread_id,category_id) SELECT id,4 FROM threads WHERE in_trash<>0 OR in_spam<>0");
  });
}
function check(db: Db) {
  const reference = db.all<Count>(original);
  const counts = getCounts(db, 1000);
  expect(counts.categoryTotal).toEqual(Object.fromEntries(reference.map(r => [r.category_id, r.total])));
  expect(counts.categoryUnread).toEqual(Object.fromEntries(reference.map(r => [r.category_id, r.unread])));
  return counts;
}

it("executes exact category counts without wide thread column reads or row seeks", () => {
  const db = openDatabase(":memory:"); opened.push(db); fill(db);
  const spy = vi.spyOn(db, "all");
  const counts = check(db);
  expect(counts.categoryTotal[1]).toBeGreaterThan(0);
  expect(counts.categoryTotal[2]).toBe(counts.categoryTotal[1]); // hidden categories still count
  expect(counts.categoryTotal[4]).toBeUndefined();
  expect(counts.inboxUnread).toBe(0); // every member belongs to hidden category 2
  const sql = spy.mock.calls.map(([sql]) => sql).filter(sql => sql.includes("sum(t.unread_count > 0)") && !sql.startsWith("EXPLAIN")).at(-1)!;
  expect(tableWork(db, original).length).toBeGreaterThan(0);
  expect(tableWork(db, sql)).toEqual([]);
  const root = db.get<{ rootpage: number }>("SELECT rootpage FROM sqlite_schema WHERE name='threads_category_counts'")!.rootpage;
  const assertSeeks = () => {
    const ops = db.all<Op>(`EXPLAIN ${sql}`);
    const cursors = new Set(ops.filter(o => o.opcode === "OpenRead" && o.p2 === root).map(o => o.p1));
    expect(cursors.size).toBe(1);
    expect(ops.some(o => cursors.has(o.p1) && o.opcode === "SeekGE")).toBe(true);
    expect(ops.filter(o => (cursors.has(o.p1) && ["Rewind", "Last"].includes(o.opcode)) || o.opcode === "SorterOpen")).toEqual([]);
  };
  assertSeeks();
  // Many unrelated clean rows must not turn counts into a global thread walk.
  db.exec(`INSERT INTO threads(account_id,provider_thread_id,subject,snippet,last_date,unread_count,in_inbox,person)
    WITH RECURSIVE n(id) AS (VALUES(1) UNION ALL SELECT id+1 FROM n WHERE id<2000)
    SELECT 1,'unfiled:'||id,'Synthetic','',id,0,0,0 FROM n`);
  db.exec("ANALYZE"); check(db); assertSeeks();
  expect(db.all<Count>(sql)).toEqual(db.all<Count>(original));
  db.run("UPDATE threads SET unread_count=0 WHERE id%3=1"); check(db);
  db.run("UPDATE threads SET in_trash=0,in_spam=0 WHERE id%5=0"); check(db);
  const before = check(db);
  expect(() => db.tx(() => {
    db.run("UPDATE threads SET unread_count=9,in_trash=0,in_spam=0"); check(db);
    db.run("DELETE FROM thread_categories WHERE category_id=2"); check(db);
    throw new Error("rollback");
  })).toThrow("rollback");
  expect(check(db)).toEqual(before);
  db.run("UPDATE threads SET unread_count=0");
  expect(check(db).categoryUnread[1]).toBe(0);
});

it("upgrades v31 with hidden categories intact and reopens the durable index", () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-count-upgrade-")); dirs.push(dir);
  const path = join(dir, "synthetic.db");
  const old = new Db(sqliteDriver(), path); opened.push(old);
  for (const migration of MIGRATIONS.filter(m => m.version <= 31)) old.exec(migration.sql);
  old.exec("PRAGMA user_version=31"); fill(old);
  const before = old.all<Count>(original); old.close();
  const upgraded = openDatabase(path); opened.push(upgraded);
  expect(upgraded.get("SELECT name FROM sqlite_schema WHERE name='threads_category_counts'")).toBeDefined();
  expect(upgraded.get("SELECT show_in_inbox FROM categories WHERE id=2")).toEqual({ show_in_inbox: 0 });
  expect(upgraded.all<Count>(original)).toEqual(before); check(upgraded);
  expect(migrate(upgraded)).toEqual({ from: 32, to: 32 }); upgraded.close();
  const reopened = openDatabase(path); opened.push(reopened); check(reopened);
  expect(reopened.get("SELECT name FROM sqlite_schema WHERE name='threads_category_counts'")).toBeDefined();
});

it("bounds index entries and pages and keeps unrelated summary writes out of it", () => {
  const db = openDatabase(":memory:"); opened.push(db); fill(db, 5000);
  const n = db.get<{ n: number }>("SELECT count(*) n FROM threads WHERE in_trash=0 AND in_spam=0")!.n;
  const index = db.get<{ n: number; bytes: number }>("SELECT sum(ncell) n,sum(pgsize) bytes FROM dbstat WHERE name='threads_category_counts'")!;
  expect(index.n).toBe(n);
  expect(index.bytes).toBeLessThanOrEqual(n * 40 + 8192);
  const root = db.get<{ rootpage: number }>("SELECT rootpage FROM sqlite_schema WHERE name='threads_category_counts'")!.rootpage;
  const writes = (column: string) => {
    const ops = db.all<Op>(`EXPLAIN UPDATE threads SET ${column} WHERE id=1`);
    const cursors = new Set(ops.filter(o => o.opcode === "OpenWrite" && o.p2 === root).map(o => o.p1));
    return ops.filter(o => cursors.has(o.p1) && ["IdxInsert", "IdxDelete"].includes(o.opcode));
  };
  expect(writes("snippet='updated'")).toEqual([]);
  expect(writes("unread_count=4").map(o => o.opcode).sort()).toEqual(["IdxDelete", "IdxInsert"]);
});
