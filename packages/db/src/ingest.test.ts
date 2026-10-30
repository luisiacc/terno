import { describe, expect, it, vi } from "vitest";
import { ingestMessages, setMessageBody } from "./ingest";
import { searchThreads } from "./search";
import { ftsIntegrity, msg, testDb, threadOf, withAccounts } from "./test/helpers";

describe("full-text index maintenance", () => {
  it("keeps JS and SQL body semantics aligned for compatibility characters", async () => {
    const { findRuleMatches } = await import("./rules");
    const db = testDb();
    const [a] = withAccounts(db);
    ingestMessages(db, [msg({ accountId: a!, bodyText: "Revisa la ﬁnance del mes" })]);
    const rule = (value: string) => ({ match: "all" as const, conditions: [{ field: "body" as const, op: "contains" as const, value }], actions: [{ type: "star" as const }] });
    expect(findRuleMatches(db, rule("finance"), 0).messageIds).toHaveLength(0);
    expect(findRuleMatches(db, rule("ﬁnance"), 0).messageIds).toHaveLength(1);
    ingestMessages(db, [msg({ accountId: a!, bodyText: "Νέα άδεια για το έργο" })]);
    expect(findRuleMatches(db, rule("αδεια"), 0).messageIds).toHaveLength(0); // unicode61 keeps Greek tonos
    expect(findRuleMatches(db, rule("άδεια"), 0).messageIds).toHaveLength(1);
  });

  it("reports bodies completed through an upsert", () => {
    const db = testDb();
    const [a] = withAccounts(db);
    ingestMessages(db, [msg({ accountId: a!, providerMsgId: "late", bodyText: null, bodyState: "none" })]);
    const r = ingestMessages(db, [msg({ accountId: a!, providerMsgId: "late", bodyText: "ahora sí", bodyState: "full" })]);
    expect(r.bodyCompleted).toHaveLength(1);
  });

  it("reindexes when a body arrives or changes and forgets old words", () => {
    const db = testDb();
    const [a] = withAccounts(db);
    const r = ingestMessages(db, [msg({ accountId: a!, bodyText: null, bodyState: "none", subject: "Hola" })]);
    const find = (q: string) => searchThreads(db, { query: q, limit: 10 }).items.length;
    expect(find("presupuesto")).toBe(0);
    setMessageBody(db, r.inserted[0]!, "Adjunto el presupuesto final", null, "full");
    expect(find("presupuesto")).toBe(1);
    setMessageBody(db, r.inserted[0]!, "Cambio de planes", null, "full");
    expect(find("presupuesto")).toBe(0);
    expect(find("planes")).toBe(1);
    ftsIntegrity(db);
  });
});

describe("sent message reconciliation", () => {
  it("merges when the server copy arrives with a thread id another local thread already owns", () => {
    const db = testDb();
    const [a] = withAccounts(db);
    ingestMessages(db, [msg({ accountId: a!, providerMsgId: "local:x", rfcMessageId: "<sent@me>", isSent: true })]);
    ingestMessages(db, [msg({ accountId: a!, providerMsgId: "g-other", providerThreadId: "T1" })]);
    ingestMessages(db, [msg({ accountId: a!, providerMsgId: "g-sent", rfcMessageId: "sent@me", providerThreadId: "T1", isSent: true })]);
    expect(threadOf(db, "g-sent")).toBe(threadOf(db, "g-other"));
    expect(db.get<{ c: number }>("SELECT count(*) c FROM threads")!.c).toBe(1);
  });
});


describe("new attachment capture", () => {
  it("inserts the final empty state without replacement writes", () => {
    const db = testDb();
    const [accountId] = withAccounts(db);
    db.exec(`CREATE TABLE capture_inserts (captured INTEGER, has_parts INTEGER);
      CREATE TABLE observed_dirty (id INTEGER);
      CREATE TRIGGER observe_dirty AFTER INSERT ON search_dirty WHEN new.kind=0 BEGIN
        INSERT INTO observed_dirty VALUES (new.id);
      END;
      CREATE TRIGGER observe_capture AFTER INSERT ON messages BEGIN
        INSERT INTO capture_inserts VALUES (new.attachments_captured, new.has_attachments);
      END;`);
    const writes = vi.spyOn(db, "run");
    const result = ingestMessages(db, [msg({ accountId: accountId!, attachments: [], hasAttachments: true })]);
    expect(db.all("SELECT * FROM capture_inserts")).toEqual([{ captured: 1, has_parts: 0 }]);
    expect(db.get("SELECT attachments_captured, has_attachments FROM messages WHERE id=?", result.inserted[0]!)).toEqual({ attachments_captured: 1, has_attachments: 0 });
    expect(writes.mock.calls.filter(([sql]) => /DELETE FROM (attachments|attachment_links)|UPDATE messages SET attachments_captured/.test(sql))).toEqual([]);
    expect(db.get("SELECT 1 AS dirty FROM observed_dirty WHERE id=?", result.inserted[0]!)).toEqual({ dirty: 1 });
    expect(db.get("SELECT has_attachments FROM threads WHERE id=?", [...result.touchedThreads][0]!)).toEqual({ has_attachments: 0 });
    ftsIntegrity(db);
  });

  it("creates new asset pins without clearing nonexistent metadata and still unpins on replacement", async () => {
    const { SqlMailStore } = await import("./sql-store");
    const db = testDb();
    const store = new SqlMailStore(db, { instantSearch: false });
    const [accountId] = withAccounts(db);
    const ref = await store.attachments.create({ accountId: accountId!, filename: "empty", mime: "text/plain", size: 0, now: 0 });
    await store.attachments.seal(accountId!, ref.assetId);
    const incoming = msg({ accountId: accountId!, attachments: [ref], hasAttachments: true });
    const writes = vi.spyOn(db, "run");
    const result = ingestMessages(db, [incoming]);
    expect(writes.mock.calls.filter(([sql]) => /DELETE FROM (attachments|attachment_links)|UPDATE messages SET attachments_captured/.test(sql))).toEqual([]);
    expect(db.all("SELECT asset_id FROM attachment_links WHERE message_id=?", result.inserted[0]!)).toEqual([{ asset_id: ref.assetId }]);
    ingestMessages(db, [{ ...incoming, attachments: [] }]);
    expect(db.all("SELECT * FROM attachments WHERE message_id=?", result.inserted[0]!)).toEqual([]);
    expect(db.all("SELECT * FROM attachment_links WHERE message_id=?", result.inserted[0]!)).toEqual([]);
    await store.attachments.discard(accountId!, ref.assetId);
    ftsIntegrity(db);
  });

  it("retains unknown and unavailable captures and clears existing metadata", () => {
    const db = testDb();
    const [accountId] = withAccounts(db);
    const initial = msg({ accountId: accountId!, attachments: [{ filename: "test.txt", mime: "text/plain", size: 10 }], hasAttachments: true });
    const result = ingestMessages(db, [initial, msg({ accountId: accountId!, hasAttachments: true }), msg({ accountId: accountId!, attachments: [], captureUnavailable: "size", hasAttachments: true })]);
    expect(result.inserted.map(id => db.get("SELECT attachments_captured, has_attachments FROM messages WHERE id=?", id))).toEqual([
      { attachments_captured: 2, has_attachments: 1 }, { attachments_captured: 0, has_attachments: 1 }, { attachments_captured: 2, has_attachments: 1 },
    ]);
    ingestMessages(db, [{ ...initial, attachments: [] }]);
    expect(db.all("SELECT * FROM attachments WHERE message_id=?", result.inserted[0]!)).toEqual([]);
    expect(db.get("SELECT attachments_captured, has_attachments FROM messages WHERE id=?", result.inserted[0]!)).toEqual({ attachments_captured: 1, has_attachments: 0 });
    ftsIntegrity(db);
  });
});
