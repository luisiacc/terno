import type { ThreadAction } from "@unica/core";
import { describe, expect, it } from "vitest";
import { applyThreadAction } from "./actions";
import { deleteMessages, ingestMessages, setMessageBody } from "./ingest";
import { addThreadsToCategory, createCategory } from "./repos";
import { searchThreads } from "./search";
import { ftsIntegrity, msg, testDb, threadOf, withAccounts } from "./test/helpers";

describe("threading", () => {
  it("joins replies to their parent via In-Reply-To / References", () => {
    const db = testDb();
    const [a] = withAccounts(db);
    ingestMessages(db, [msg({ accountId: a!, providerMsgId: "root", rfcMessageId: "<root@x>" })]);
    ingestMessages(db, [msg({ accountId: a!, providerMsgId: "r1", inReplyTo: "<ROOT@x>", references: ["<root@x>"] })]);
    expect(threadOf(db, "r1")).toBe(threadOf(db, "root"));
  });

  it("threads a parent that arrives after its reply (out-of-order sync)", () => {
    const db = testDb();
    const [a] = withAccounts(db);
    ingestMessages(db, [msg({ accountId: a!, providerMsgId: "child", references: ["parent@x"] })]);
    ingestMessages(db, [msg({ accountId: a!, providerMsgId: "parent", rfcMessageId: "parent@x" })]);
    expect(threadOf(db, "parent")).toBe(threadOf(db, "child"));
    expect(db.get<{ c: number }>("SELECT count(*) c FROM threads")!.c).toBe(1);
  });

  it("merges two threads bridged by a later message and keeps both threads' categories", () => {
    const db = testDb();
    const [a] = withAccounts(db);
    ingestMessages(db, [
      msg({ accountId: a!, providerMsgId: "x", rfcMessageId: "x@x" }),
      msg({ accountId: a!, providerMsgId: "y", rfcMessageId: "y@x" }),
    ]);
    const [tx, ty] = [threadOf(db, "x"), threadOf(db, "y")];
    expect(tx).not.toBe(ty);
    const work = createCategory(db, "Work", "indigo");
    const travel = createCategory(db, "Travel", "cyan");
    addThreadsToCategory(db, work.id, [tx], "user");
    addThreadsToCategory(db, travel.id, [ty], "user");

    const r = ingestMessages(db, [msg({ accountId: a!, providerMsgId: "bridge", references: ["x@x", "y@x"] })]);
    const merged = threadOf(db, "bridge");
    expect(threadOf(db, "x")).toBe(merged);
    expect(threadOf(db, "y")).toBe(merged);
    expect(r.mergedThreads.size).toBe(1);
    const cats = db.all<{ category_id: number }>("SELECT category_id FROM thread_categories WHERE thread_id = ? ORDER BY 1", merged);
    expect(cats.map((c) => c.category_id)).toEqual([work.id, travel.id]);
    expect(db.get<{ message_count: number }>("SELECT message_count FROM threads WHERE id = ?", merged)!.message_count).toBe(3);
  });

  it("never merges on subject alone, nor across accounts", () => {
    const db = testDb();
    const [a, b] = withAccounts(db);
    ingestMessages(db, [
      msg({ accountId: a!, providerMsgId: "s1", subject: "Factura marzo" }),
      msg({ accountId: a!, providerMsgId: "s2", subject: "RE: Factura marzo" }),
      msg({ accountId: a!, providerMsgId: "acct-a", rfcMessageId: "shared@x" }),
      msg({ accountId: b!, providerMsgId: "acct-b", inReplyTo: "shared@x" }),
    ]);
    expect(threadOf(db, "s1")).not.toBe(threadOf(db, "s2"));
    expect(threadOf(db, "acct-a")).not.toBe(threadOf(db, "acct-b"));
  });

  it("uses the provider thread id (Gmail) when present", () => {
    const db = testDb();
    const [a] = withAccounts(db);
    ingestMessages(db, [
      msg({ accountId: a!, providerMsgId: "g1", providerThreadId: "T1" }),
      msg({ accountId: a!, providerMsgId: "g2", providerThreadId: "T1", subject: "unrelated" }),
      msg({ accountId: a!, providerMsgId: "g3", providerThreadId: "T2" }),
    ]);
    expect(threadOf(db, "g1")).toBe(threadOf(db, "g2"));
    expect(threadOf(db, "g3")).not.toBe(threadOf(db, "g1"));
  });

  it("upserts by provider id: flags refresh, no duplicate rows", () => {
    const db = testDb();
    const [a] = withAccounts(db);
    ingestMessages(db, [msg({ accountId: a!, providerMsgId: "u", isRead: false })]);
    const r = ingestMessages(db, [msg({ accountId: a!, providerMsgId: "u", isRead: true })]);
    expect(r.inserted).toEqual([]);
    expect(r.updated).toHaveLength(1);
    expect(db.get<{ c: number; unread: number }>("SELECT count(*) c, sum(is_read = 0) unread FROM messages")).toEqual({ c: 1, unread: 0 });
  });
});

describe("derived thread state", () => {
  it("an archived conversation returns to the inbox when a new reply arrives, keeping its categories", () => {
    const db = testDb();
    const [a] = withAccounts(db);
    ingestMessages(db, [msg({ accountId: a!, providerMsgId: "root", rfcMessageId: "r@x" })]);
    const t = threadOf(db, "root");
    const cat = createCategory(db, "Clientes", "emerald");
    addThreadsToCategory(db, cat.id, [t], "user");
    applyThreadAction(db, [t], "archive");
    expect(db.get<{ in_inbox: number }>("SELECT in_inbox FROM threads WHERE id = ?", t)!.in_inbox).toBe(0);

    ingestMessages(db, [msg({ accountId: a!, providerMsgId: "reply", inReplyTo: "r@x", date: 1_900_000_000_000 })]);
    const row = db.get<{ in_inbox: number; message_count: number; last_date: number }>(
      "SELECT in_inbox, message_count, last_date FROM threads WHERE id = ?",
      t,
    )!;
    expect(row).toEqual({ in_inbox: 1, message_count: 2, last_date: 1_900_000_000_000 });
    expect(db.get("SELECT 1 FROM thread_categories WHERE thread_id = ? AND category_id = ?", t, cat.id)).toBeTruthy();
  });

  it("never reuses a message id, even after deleting the newest message", () => {
    const db = testDb();
    const [a] = withAccounts(db);
    const first = ingestMessages(db, [msg({ accountId: a! }), msg({ accountId: a! })]);
    deleteMessages(db, [first.inserted[1]!]);
    const next = ingestMessages(db, [msg({ accountId: a! })]);
    expect(next.inserted[0]).toBeGreaterThan(first.inserted[1]!);
  });

  it("deleting the last message of a thread deletes the thread", () => {
    const db = testDb();
    const [a] = withAccounts(db);
    const r = ingestMessages(db, [msg({ accountId: a!, providerMsgId: "only" })]);
    deleteMessages(db, r.inserted);
    expect(db.get<{ c: number }>("SELECT count(*) c FROM threads")!.c).toBe(0);
    ftsIntegrity(db);
  });

  /**
   * Property test: after any random sequence of ingests, actions and deletes,
   * the stored thread aggregates equal a from-scratch recomputation in JS.
   */
  it("stays consistent with an independent recomputation under random operations", () => {
    const db = testDb();
    const accounts = withAccounts(db, 2);
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
    const actions: ThreadAction[] = ["archive", "trash", "spam", "notSpam", "moveToInbox", "markRead", "markUnread", "star", "unstar"];
    const rfcIds: string[] = [];
    for (let step = 0; step < 400; step++) {
      const r = rand();
      if (r < 0.5 || rfcIds.length === 0) {
        const id = `rnd${step}@x`;
        const parent = rfcIds.length && rand() < 0.6 ? pick(rfcIds) : null;
        ingestMessages(db, [
          msg({
            accountId: pick(accounts),
            rfcMessageId: id,
            inReplyTo: parent,
            date: 1_700_000_000_000 + Math.floor(rand() * 1e9),
            isRead: rand() < 0.5,
            isSent: rand() < 0.2,
            inInbox: rand() < 0.7,
            isSpam: rand() < 0.05,
            isTrash: rand() < 0.05,
            isStarred: rand() < 0.1,
            hasAttachments: rand() < 0.2,
          }),
        ]);
        rfcIds.push(id);
      } else if (r < 0.9) {
        const threads = db.all<{ id: number }>("SELECT id FROM threads").map((t) => t.id);
        if (threads.length) applyThreadAction(db, [pick(threads), pick(threads)], pick(actions));
      } else {
        const ids = db.all<{ id: number }>("SELECT id FROM messages").map((m) => m.id);
        if (ids.length) deleteMessages(db, [pick(ids)]);
      }
    }
    type M = { thread_id: number; date: number; id: number; is_read: number; is_trash: number; is_spam: number; in_inbox: number; is_sent: number; is_starred: number; has_attachments: number };
    const messages = db.all<M>("SELECT thread_id, date, id, is_read, is_trash, is_spam, in_inbox, is_sent, is_starred, has_attachments FROM messages");
    const byThread = new Map<number, M[]>();
    for (const m of messages) byThread.set(m.thread_id, [...(byThread.get(m.thread_id) ?? []), m]);
    const threads = db.all<Record<string, number>>("SELECT * FROM threads");
    expect(threads.length).toBe(byThread.size);
    for (const t of threads) {
      const ms = byThread.get(t.id!)!;
      const live = ms.filter((m) => !m.is_trash);
      const expected = {
        message_count: ms.length,
        unread_count: live.filter((m) => !m.is_read).length,
        in_inbox: Number(ms.some((m) => m.in_inbox && !m.is_trash && !m.is_spam)),
        in_trash: Number(ms.every((m) => m.is_trash)),
        in_spam: Number(live.length > 0 && live.every((m) => m.is_spam)),
        has_sent: Number(ms.some((m) => m.is_sent && !m.is_trash && !m.is_spam)),
        is_starred: Number(ms.some((m) => m.is_starred && !m.is_trash)),
        has_attachments: Number(ms.some((m) => m.has_attachments)),
      };
      expect({
        message_count: t.message_count,
        unread_count: t.unread_count,
        in_inbox: t.in_inbox,
        in_trash: t.in_trash,
        in_spam: t.in_spam,
        has_sent: t.has_sent,
        is_starred: t.is_starred,
        has_attachments: t.has_attachments,
      }).toEqual(expected);
    }
    ftsIntegrity(db);
  });
});

describe("message-level actions (filters)", () => {
  it("star acts on every matched message, not only the latest of the thread", async () => {
    const { applyMessageAction } = await import("./actions");
    const db = testDb();
    const [a] = withAccounts(db);
    const r = ingestMessages(db, [
      msg({ accountId: a!, rfcMessageId: "s1@x", date: 1 }),
      msg({ accountId: a!, inReplyTo: "s1@x", date: 2 }),
    ]);
    applyMessageAction(db, r.inserted, "star");
    expect(db.get("SELECT sum(is_starred) s FROM messages")).toEqual({ s: 2 });
  });
});

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
  it("a conversation we started adopts the provider thread id and later replies join it", async () => {
    const { adoptProviderThread } = await import("./ingest");
    const db = testDb();
    const [a] = withAccounts(db);
    ingestMessages(db, [msg({ accountId: a!, providerMsgId: "local:1", providerThreadId: null, isSent: true })]);
    const local = threadOf(db, "local:1");
    adoptProviderThread(db, local, a!, "T-NEW");
    ingestMessages(db, [msg({ accountId: a!, providerMsgId: "g-reply", providerThreadId: "T-NEW" })]);
    expect(threadOf(db, "g-reply")).toBe(local);
  });

  it("merges when the server copy arrives with a thread id another local thread already owns", () => {
    const db = testDb();
    const [a] = withAccounts(db);
    ingestMessages(db, [msg({ accountId: a!, providerMsgId: "local:x", rfcMessageId: "<sent@me>", isSent: true })]);
    ingestMessages(db, [msg({ accountId: a!, providerMsgId: "g-other", providerThreadId: "T1" })]);
    ingestMessages(db, [msg({ accountId: a!, providerMsgId: "g-sent", rfcMessageId: "sent@me", providerThreadId: "T1", isSent: true })]);
    expect(threadOf(db, "g-sent")).toBe(threadOf(db, "g-other"));
    expect(db.get<{ c: number }>("SELECT count(*) c FROM threads")!.c).toBe(1);
  });

  it("adopts the optimistic local copy when the server copy of a sent message syncs", () => {
    const db = testDb();
    const [a] = withAccounts(db);
    ingestMessages(db, [msg({ accountId: a!, providerMsgId: "local:op1", rfcMessageId: "<abc@me>", isSent: true, inInbox: false })]);
    const r = ingestMessages(db, [msg({ accountId: a!, providerMsgId: "imap-77", rfcMessageId: "abc@me", isSent: true, inInbox: false, isRead: true })]);
    expect(r.inserted).toEqual([]);
    expect(db.all("SELECT provider_msg_id FROM messages")).toEqual([{ provider_msg_id: "imap-77" }]);
  });
});
