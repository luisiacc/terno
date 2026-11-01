import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openDatabase, sqliteDriver } from "./index";
import { MIGRATIONS } from "./migrations";
import { rebuildFolders } from "./folders";
import { getCounts } from "./queries";
import { Db } from "./sqlite";

const opened: Db[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) if (db.isOpen) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** what the Archive and Spam lists hold unread, counted from the threads themselves */
function reference(db: Db): Record<string, number> {
  const out: Record<string, number> = {};
  const rows = db.all<{ account_id: number; archive: number; spam: number }>(
    "SELECT account_id, sum(in_inbox = 0 AND in_trash = 0 AND in_spam = 0) AS archive, sum(in_spam = 1 AND in_trash = 0) AS spam FROM threads WHERE unread_count > 0 GROUP BY account_id",
  );
  for (const r of rows) for (const v of ["archive", "spam"] as const) if (r[v]) out[`${r.account_id}:${v}`] = r[v];
  return out;
}
const check = (db: Db) => expect(getCounts(db, 0).viewUnread).toEqual(reference(db));

let seed = 7;
const rand = (n: number) => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) >>> 8) % n;
const state = () => [rand(3), rand(2), rand(4) === 0 ? 1 : 0, rand(5) === 0 ? 1 : 0] as const; // unread, inbox, trash, spam

function fill(db: Db, n: number) {
  db.tx(() => {
    for (const a of [1, 2, 3]) db.run("INSERT INTO accounts(id,kind,email,display_name,created_at) VALUES(?,'imap',?,'Synthetic',0)", a, `synthetic${a}@example.test`);
    for (let id = 1; id <= n; id++) {
      const [unread, inbox, trash, spam] = state();
      db.run("INSERT INTO threads(id,account_id,provider_thread_id,last_date,unread_count,in_inbox,in_trash,in_spam) VALUES(?,?,?,?,?,?,?,?)", id, 1 + (id % 3), `t${id}`, id, unread, inbox, trash, spam);
    }
  });
}

it("keeps each account's Archive and Spam unread exact through writes, deletes and a removed account", () => {
  const db = openDatabase(":memory:"); opened.push(db);
  fill(db, 400);
  check(db);
  for (let i = 0; i < 700; i++) {
    const id = 1 + rand(400);
    const [unread, inbox, trash, spam] = state();
    // each column alone (a trigger that misses one goes stale), all at once, and a write that changes none
    const writes = [
      () => db.run("UPDATE threads SET unread_count = ? WHERE id = ?", unread, id),
      () => db.run("UPDATE threads SET in_inbox = ? WHERE id = ?", inbox, id),
      () => db.run("UPDATE threads SET in_trash = ? WHERE id = ?", trash, id),
      () => db.run("UPDATE threads SET in_spam = ? WHERE id = ?", spam, id),
      () => db.run("UPDATE threads SET account_id = ? WHERE id = ?", 1 + rand(3), id),
      () => db.run("UPDATE threads SET unread_count = ?, in_inbox = ?, in_trash = ?, in_spam = ? WHERE id = ?", unread, inbox, trash, spam, id),
      () => db.run("UPDATE threads SET snippet = 'unrelated' WHERE id = ?", id),
    ];
    writes[i % writes.length]!();
  }
  check(db);
  db.run("DELETE FROM threads WHERE id % 7 = 0");
  check(db);
  db.run("DELETE FROM accounts WHERE id = 2");
  check(db);
  expect(db.get("SELECT 1 FROM view_unread WHERE account_id = 2 OR n <= 0")).toBeUndefined();
  db.run("UPDATE threads SET unread_count = 0");
  expect(getCounts(db, 0).viewUnread).toEqual({});
  expect(db.get("SELECT count(*) AS c FROM view_unread")).toEqual({ c: 0 });
});

it("an upgrade from v40 tallies the mail already there a slice at a time, exact through writes meanwhile, and shows none until done", () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-view-unread-")); dirs.push(dir);
  const path = join(dir, "synthetic.db");
  const old = new Db(sqliteDriver(), path); opened.push(old);
  for (const m of MIGRATIONS.filter((m) => m.version <= 40)) old.exec(m.sql);
  old.exec("PRAGMA user_version=40");
  fill(old, 300);
  expect(Object.keys(reference(old)).length).toBeGreaterThan(3);
  old.close();
  const db = openDatabase(path); opened.push(db);
  // the open did no tally of its own
  expect(db.get("SELECT count(*) AS c FROM view_unread")).toEqual({ c: 0 });
  expect(getCounts(db, 0).viewUnread).toEqual({});
  let slices = 0;
  let touched: number[] = [];
  for (let more = true; more; slices++) {
    // writes on both sides of the cursor between slices
    for (let i = 0; i < 6; i++) {
      const [unread, inbox, trash, spam] = state();
      db.run("UPDATE threads SET unread_count = ?, in_inbox = ?, in_trash = ?, in_spam = ? WHERE id = ?", unread, inbox, trash, spam, 1 + rand(300));
    }
    if (slices === 2) db.run("DELETE FROM threads WHERE id IN (5, 250)");
    if (slices === 3) db.run("INSERT INTO threads(id,account_id,provider_thread_id,last_date,unread_count,in_inbox,in_trash,in_spam) VALUES(1000,1,'late',1,2,0,0,0)");
    ({ more, touched } = rebuildFolders(db, 40));
    if (more) expect(getCounts(db, 0).viewUnread).toEqual({});
  }
  expect(slices).toBeGreaterThan(5);
  expect(touched.length).toBe(1); // its last slice refreshes the counts
  check(db);
});
