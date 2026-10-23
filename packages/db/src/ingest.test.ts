import { describe, expect, it } from "vitest";
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
