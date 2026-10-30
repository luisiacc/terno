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


describe("bounded reference writes", () => {
  it("batches references while preserving same-batch reverse threading and account boundaries", () => {
    const db = testDb();
    const [a, b] = withAccounts(db);
    const children = Array.from({ length: 96 }, (_, i) => msg({ accountId: a!, providerThreadId: `provider-${i}`, references: [`<ROOT-${i}@test>`, `other-${i}@test`, `<ROOT-${i}@test>`] }));
    const root = msg({ accountId: a!, rfcMessageId: "root-0@test" });
    const foreign = msg({ accountId: b!, rfcMessageId: "root-1@test" });
    const writes = vi.spyOn(db, "run");
    const interleaved = children.flatMap((child, i) => [child, msg({ accountId: a!, rfcMessageId: `unreferenced-${i}@test` })]);
    const result = ingestMessages(db, [...interleaved, root, foreign]);
    const refs = writes.mock.calls.filter(([sql]) => sql.startsWith("INSERT OR IGNORE INTO message_refs"));
    expect(refs.length).toBeLessThanOrEqual(2);
    expect(refs.every(([, payload]) => JSON.parse(payload as string).length <= 128)).toBe(true);
    expect(db.get("SELECT count(*) AS n FROM message_refs")).toEqual({ n: 192 });
    expect(db.all<{ ref: string }>("SELECT ref FROM message_refs WHERE message_id=? ORDER BY ref", result.inserted[0]!).map(r => r.ref)).toEqual(["other-0@test", "root-0@test"]);
    expect(threadOf(db, root.providerMsgId!)).toBe(threadOf(db, children[0]!.providerMsgId!));
    expect(threadOf(db, foreign.providerMsgId!)).not.toBe(threadOf(db, children[1]!.providerMsgId!));
    ftsIntegrity(db);
  });

  it.each(["new sent", "existing"] as const)("publishes pending references before %s fact readers", (mode) => {
    const db = testDb();
    const [a] = withAccounts(db);
    const original = msg({ accountId: a!, providerThreadId: "existing", from: { name: "Me", email: "me0@example.com" }, to: [{ name: "Person", email: "new-person@example.com" }] });
    if (mode === "existing") ingestMessages(db, [original]);
    db.exec(`CREATE TABLE reference_visibility (n INTEGER);
      CREATE TRIGGER observe_teaching AFTER INSERT ON correspondents WHEN new.email='new-person@example.com' AND new.written=1 BEGIN
        INSERT INTO reference_visibility SELECT count(*) FROM message_refs WHERE ref LIKE 'pending-%';
      END;
      CREATE TRIGGER observe_existing AFTER UPDATE OF is_sent ON messages WHEN new.is_sent=1 BEGIN
        INSERT INTO reference_visibility SELECT count(*) FROM message_refs WHERE ref LIKE 'pending-%';
      END;`);
    const child = msg({ accountId: a!, providerThreadId: "child", references: ["pending-child@test"] });
    ingestMessages(db, [child, { ...original, isSent: true, ...(mode === "new sent" ? { references: ["pending-sent@test"] } : {}) }]);
    const observed = db.all<{ n: number }>("SELECT n FROM reference_visibility");
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.every(r => r.n === (mode === "new sent" ? 2 : 1))).toBe(true);
    ftsIntegrity(db);
  });

  it("rolls back messages, pending references and search publication when a reference write fails", () => {
    const db = testDb();
    const [a] = withAccounts(db);
    db.exec(`CREATE TRIGGER refuse_ref BEFORE INSERT ON message_refs WHEN new.ref='refuse@test' BEGIN SELECT RAISE(ABORT, 'synthetic reference failure'); END;`);
    const messages = Array.from({ length: 70 }, (_, i) => msg({ accountId: a!, providerThreadId: `rollback-${i}`, references: [`ref-${i}@test`, i === 69 ? "refuse@test" : `second-${i}@test`] }));
    expect(() => ingestMessages(db, messages)).toThrow("synthetic reference failure");
    for (const table of ["messages", "message_bodies", "message_refs", "threads", "search_dirty", "search_outbox"]) expect(db.get(`SELECT count(*) AS n FROM ${table}`)).toEqual({ n: 0 });
    db.exec("DROP TRIGGER refuse_ref");
    ingestMessages(db, messages);
    expect(db.get("SELECT count(*) AS n FROM message_refs")).toEqual({ n: 140 });
    ftsIntegrity(db);
  });
});


describe("bounded new-message body writes", () => {
  it("batches body rows before their messages with exact content and no orphan rows", () => {
    const db = testDb(); const [a] = withAccounts(db);
    const messages = Array.from({ length: 96 }, (_, i) => msg({ accountId: a!, providerThreadId: `body-${i}`, bodyText: i % 3 ? `uniqueBody${i}` : null, bodyHtml: i % 6 ? `<p>uniqueBody${i}</p>` : null }));
    const writes = vi.spyOn(db, "run");
    const result = ingestMessages(db, messages);
    const bodyWrites = writes.mock.calls.filter(([sql]) => sql.startsWith("INSERT INTO message_bodies"));
    expect(bodyWrites.length).toBeLessThanOrEqual(3);
    expect(bodyWrites.every(([, ...args]) => args.length <= 96)).toBe(true);
    expect(db.all("SELECT message_id AS id,body_text,body_html FROM message_bodies ORDER BY message_id")).toEqual(messages.flatMap((m, i) => m.bodyText === null && m.bodyHtml === null ? [] : [{ id: result.inserted[i]!, body_text: m.bodyText, body_html: m.bodyHtml }]));
    expect(result.inserted).toEqual(Array.from({ length: 96 }, (_, i) => i + 1));
    expect(searchThreads(db, { query: "uniqueBody95", limit: 10 }).items).toHaveLength(1);
    ftsIntegrity(db);
  });

  it("uses sequential body updates for duplicate, existing and local identities", () => {
    const db = testDb(); const [a] = withAccounts(db);
    const local = msg({ accountId: a!, providerMsgId: "LOCAL:body", rfcMessageId: "local-body@test", bodyText: "local first" });
    const original = msg({ accountId: a!, providerMsgId: "duplicate-body", bodyText: "first" });
    const result = ingestMessages(db, [local, { ...local, providerMsgId: "server-body", bodyText: "adopted" }, original, { ...original, bodyText: "latest" }]);
    expect(result.inserted).toHaveLength(2); expect(result.updated).toEqual(result.inserted);
    expect(db.all("SELECT body_text FROM message_bodies ORDER BY message_id")).toEqual([{ body_text: "adopted" }, { body_text: "latest" }]);
    const again = ingestMessages(db, [{ ...original, bodyText: "changed again" }]);
    expect(again.inserted).toEqual([]); expect(again.updated).toEqual([result.inserted[1]!]);
    expect(db.get("SELECT body_text FROM message_bodies WHERE message_id=?", result.inserted[1]!)).toEqual({ body_text: "changed again" });
    ftsIntegrity(db);
  });

  it("keeps oversized batches on the sequential path", () => {
    const db = testDb(); const [a] = withAccounts(db);
    const writes = vi.spyOn(db, "run");
    const result = ingestMessages(db, Array.from({ length: 201 }, () => msg({ accountId: a! })));
    expect(result.inserted).toHaveLength(201);
    expect(writes.mock.calls.filter(([sql]) => sql.startsWith("INSERT INTO message_bodies"))).toHaveLength(201);
    ftsIntegrity(db);
  });

  it("keeps SQL's case-insensitive local identity adoption within a batch", () => {
    const db = testDb(); const [a] = withAccounts(db);
    const local = msg({ accountId: a!, providerMsgId: "LOCAL:case", rfcMessageId: "case@test", bodyText: "optimistic" });
    const result = ingestMessages(db, [local, { ...local, providerMsgId: "remote-case", bodyText: "confirmed" }]);
    expect(result.inserted).toHaveLength(1);
    expect(result.updated).toEqual(result.inserted);
    expect(db.all("SELECT body_text FROM message_bodies")).toEqual([{ body_text: "confirmed" }]);
    ftsIntegrity(db);
  });

  it("rolls back all prepared bodies and reserved IDs when a later chunk fails", () => {
    const db = testDb(); const [a] = withAccounts(db);
    db.exec(`CREATE TRIGGER refuse_body BEFORE INSERT ON message_bodies WHEN new.body_text='refuse body' BEGIN SELECT RAISE(ABORT, 'synthetic body failure'); END;`);
    const messages = Array.from({ length: 70 }, (_, i) => msg({ accountId: a!, bodyText: i === 69 ? "refuse body" : `body ${i}` }));
    expect(() => ingestMessages(db, messages)).toThrow("synthetic body failure");
    for (const table of ["messages", "message_bodies", "message_refs", "threads", "search_dirty", "search_outbox"]) expect(db.get(`SELECT count(*) AS n FROM ${table}`)).toEqual({ n: 0 });
    db.exec("DROP TRIGGER refuse_body");
    expect(ingestMessages(db, messages).inserted).toEqual(Array.from({ length: 70 }, (_, i) => i + 1));
    ftsIntegrity(db);
  });
});
