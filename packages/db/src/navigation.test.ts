import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { msg } from "@terno/store/conformance";
import { nodeSqliteDriver, openDatabase, openDatabaseWith } from "./index";
import { ingestMessages } from "./ingest";
import { getThread } from "./queries";
import { SqlMailStore } from "./sql-store";
import type { Db } from "./sqlite";

const opened: Db[] = [];
afterEach(() => { for (const db of opened.splice(0)) if (db.isOpen) db.close(); });
function fixture(db = openDatabase(":memory:")) {
  opened.push(db);
  db.run("INSERT INTO accounts(id,kind,email,display_name,created_at) VALUES(1,'gmail','me@example.test','Me',0)");
  const { inserted } = ingestMessages(db, [30, 10, 10].map((date, i) => msg({
    accountId: 1, providerMsgId: `m${i}`, providerThreadId: "long", date,
    subject: `Subject ${i}`, bodyText: `雪 body ${i}`, bodyHtml: `<p>${i}</p>`,
    references: ["source@example.test"], replyTo: [{ name: "Reply", email: "reply@example.test" }],
    cc: [{ name: "Copy", email: "copy@example.test" }],
    hasAttachments: true,
    attachments: [{ filename: `雪${i}.txt`, mime: "text/plain", size: i + 1, contentId: `cid${i}` }],
  })), 100);
  const id = db.get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE id=?", inserted[0]!)!.thread_id;
  return { db, id, inserted };
}
function materializations(db: Db) {
  const spy = vi.spyOn(db, "all");
  return () => spy.mock.calls.filter(([sql]) => sql.includes("FROM messages m LEFT JOIN message_bodies")).length;
}

it("reuses the bounded actual reader while returning exact, independently mutable data through the store", async () => {
  const { db, id, inserted } = fixture();
  const reads = materializations(db);
  const store = new SqlMailStore(db);
  const first = (await store.threads.get(id))!;
  const expected = structuredClone(first);
  expect(first.messages.map((m) => m.id)).toEqual([inserted[1], inserted[2], inserted[0]]);
  expect(first.messages.map((m) => m.bodyText)).toEqual(["雪 body 1", "雪 body 2", "雪 body 0"]);
  expect(first.messages[0]).toMatchObject({ accountId: 1, threadId: id, subject: "Subject 1", bodyHtml: "<p>1</p>", attachments: [{ filename: "雪1.txt", contentId: "cid1", size: 2 }] });
  first.thread.categoryIds.push(123);
  const m = first.messages[0]!;
  m.from.name = "changed"; m.replyTo[0]!.email = "changed"; m.to[0]!.name = "changed"; m.cc[0]!.name = "changed";
  m.references.push("changed"); m.attachments[0]!.filename = "changed";
  first.messages.reverse(); first.messages.pop();
  const second = (await store.threads.get(id))!;
  expect(second).toEqual(expected);
  second.messages[0]!.bodyText = "changed again";
  expect(await store.threads.get(id)).toEqual(expected);
  expect(reads()).toBe(1);
  expect(Object.hasOwn(second.messages[0]!.attachments[0]!, "assetId")).toBe(true);
  expect(Object.hasOwn(second.messages[0]!, "bodyUnavailable")).toBe(false);
});

it("invalidates body, header, flags, attachment, summary, membership and deletion edits", () => {
  const { db, id, inserted } = fixture();
  getThread(db, id);
  db.run("UPDATE message_bodies SET body_text='updated' WHERE message_id=?", inserted[1]!);
  db.run("UPDATE messages SET subject='new', is_read=1, date=99 WHERE id=?", inserted[1]!);
  db.run("UPDATE attachments SET filename='new.bin', asset_id='asset' WHERE message_id=?", inserted[1]!);
  db.run("UPDATE threads SET snippet='summary' WHERE id=?", id);
  const after = getThread(db, id)!;
  expect(after.thread.snippet).toBe("summary");
  expect(after.messages.at(-1)).toMatchObject({ id: inserted[1], subject: "new", isRead: true, bodyText: "updated", attachments: [{ filename: "new.bin", assetId: "asset" }] });
  db.run("INSERT INTO categories(id,name,color,position) VALUES(1,'Synthetic','blue',0)");
  db.run("INSERT INTO thread_categories(thread_id,category_id) VALUES(?,1)", id);
  expect(getThread(db, id)!.thread.categoryIds).toEqual([1]);
  db.run("DELETE FROM messages WHERE id=?", inserted[2]!);
  expect(getThread(db, id)!.messages.map((m) => m.id)).toEqual([inserted[0], inserted[1]]);
  db.run("DELETE FROM threads WHERE id=?", id);
  expect(getThread(db, id)).toBeNull();
});

it("never retains a transaction or nested rollback image", () => {
  const { db, id } = fixture();
  const original = getThread(db, id);
  expect(() => db.tx(() => {
    db.run("UPDATE message_bodies SET body_text='outer'");
    expect(getThread(db, id)!.messages[0]!.bodyText).toBe("outer");
    expect(() => db.tx(() => {
      db.run("UPDATE message_bodies SET body_text='inner'");
      expect(getThread(db, id)!.messages[0]!.bodyText).toBe("inner");
      throw new Error("inner rollback");
    })).toThrow("inner rollback");
    expect(getThread(db, id)!.messages[0]!.bodyText).toBe("outer");
    throw new Error("outer rollback");
  })).toThrow("outer rollback");
  expect(getThread(db, id)).toEqual(original);
  db.tx(() => { db.run("UPDATE message_bodies SET body_text='committed'"); getThread(db, id); });
  expect(getThread(db, id)!.messages[0]!.bodyText).toBe("committed");
});

it("evicts the previous thread and does not retain oversized bodies or closed handles", () => {
  const { db, id } = fixture();
  const reads = materializations(db);
  getThread(db, id); getThread(db, id);
  expect(reads()).toBe(1);
  expect(getThread(db, -1)).toBeNull();
  getThread(db, id);
  expect(reads()).toBe(2);
  const body = "雪".repeat(3 * 2 ** 20);
  db.run("UPDATE message_bodies SET body_text=?", body);
  expect(getThread(db, id)!.messages.map((m) => m.bodyText)).toEqual([body, body, body]);
  getThread(db, id);
  expect(reads()).toBe(4);
  db.close();
  expect(() => getThread(db, id)).toThrow();
});

it("invalidates changes from an actual second native connection and local DDL", () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-navigation-"));
  try {
    const { db, id } = fixture(openDatabaseWith(nodeSqliteDriver, join(dir, "mail.db")));
    const other = openDatabaseWith(nodeSqliteDriver, db.path); opened.push(other);
    getThread(db, id);
    other.run("UPDATE message_bodies SET body_text='external'");
    expect(getThread(db, id)!.messages[0]!.bodyText).toBe("external");
    const reads = materializations(db);
    getThread(db, id);
    expect(reads()).toBe(0);
    db.exec("CREATE TABLE navigation_probe(id INTEGER)");
    getThread(db, id);
    expect(reads()).toBe(1);
    other.close(); db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("bypasses raw transactions and standalone savepoints across rollback", () => {
  const { db, id } = fixture();
  const original = getThread(db, id);
  for (const [begin, end] of [["BEGIN", "ROLLBACK"], ["SAVEPOINT raw", "ROLLBACK TO raw; RELEASE raw"]]) {
    db.exec(begin!);
    db.run("UPDATE message_bodies SET body_text='raw'");
    expect(getThread(db, id)!.messages[0]!.bodyText).toBe("raw");
    db.exec(end!);
    expect(getThread(db, id)).toEqual(original);
  }
});

it("does not retain an external commit racing reader statements", () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-navigation-race-"));
  try {
    const { db, id } = fixture(openDatabaseWith(nodeSqliteDriver, join(dir, "mail.db")));
    const other = openDatabaseWith(nodeSqliteDriver, db.path); opened.push(other);
    const all = db.all.bind(db);
    const spy = vi.spyOn(db, "all").mockImplementationOnce((...args: Parameters<typeof db.all>) => {
      const rows = all(...args);
      other.run("UPDATE message_bodies SET body_text='racing'");
      return rows;
    });
    getThread(db, id);
    spy.mockRestore();
    expect(getThread(db, id)!.messages[0]!.bodyText).toBe("racing");
    other.close(); db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("returns every message above the cache count bound without retaining it", () => {
  const { db, id } = fixture();
  ingestMessages(db, Array.from({ length: 8190 }, (_, i) => msg({ accountId: 1, providerMsgId: `extra${i}`, providerThreadId: "long", date: 100 + i })), 100);
  const reads = materializations(db);
  const first = getThread(db, id)!;
  expect(first.messages).toHaveLength(8193);
  expect(new Set(first.messages.map((m) => m.id)).size).toBe(8193);
  expect(getThread(db, id)).toEqual(first);
  expect(reads()).toBe(2);
});
