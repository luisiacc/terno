import { describe, expect, it } from "vitest";
import { applyThreadAction } from "./actions";
import { ingestMessages } from "./ingest";
import {
  addThreadsToCategory,
  claimReadyOps,
  completeOp,
  createCategory,
  dismissSuggestion,
  enqueueOp,
  failOp,
  getOp,
  markOpUnknown,
  messagesWithPendingOps,
  MAX_OP_ATTEMPTS,
  recoverOps,
  suggestSimilarForCategory,
  claimFilterApplications,
  saveFilter,
} from "./repos";
import { msg, testDb, threadOf, withAccounts } from "./test/helpers";

describe("thread actions", () => {
  it("archive captures only the messages that were in the inbox at action time", () => {
    const db = testDb();
    const [a] = withAccounts(db);
    ingestMessages(db, [
      msg({ accountId: a!, providerMsgId: "in1", rfcMessageId: "r@x", inInbox: true }),
      msg({ accountId: a!, providerMsgId: "sent", inReplyTo: "r@x", inInbox: false, isSent: true }),
    ]);
    const t = threadOf(db, "in1");
    const result = applyThreadAction(db, [t], "archive");
    const inboxMsg = db.get<{ id: number }>("SELECT id FROM messages WHERE provider_msg_id = 'in1'")!.id;
    expect(result.targets).toEqual([{ accountId: a, messageIds: [inboxMsg] }]);
    // a second archive is a no-op: nothing to send to the provider
    expect(applyThreadAction(db, [t], "archive").targets).toEqual([]);
  });

  it("markUnread and star act on the latest message only; unstar clears all", () => {
    const db = testDb();
    const [a] = withAccounts(db);
    ingestMessages(db, [
      msg({ accountId: a!, providerMsgId: "old", rfcMessageId: "o@x", date: 1000, isRead: true, isStarred: true }),
      msg({ accountId: a!, providerMsgId: "new", inReplyTo: "o@x", date: 2000, isRead: true }),
    ]);
    const t = threadOf(db, "old");
    const id = (p: string) => db.get<{ id: number }>("SELECT id FROM messages WHERE provider_msg_id = ?", p)!.id;
    expect(applyThreadAction(db, [t], "markUnread").targets[0]!.messageIds).toEqual([id("new")]);
    expect(applyThreadAction(db, [t], "star").targets[0]!.messageIds).toEqual([id("new")]);
    expect(applyThreadAction(db, [t], "unstar").targets[0]!.messageIds.sort()).toEqual([id("old"), id("new")].sort());
  });

  it("moveToInbox restores received mail but leaves my sent replies out of the inbox", () => {
    const db = testDb();
    const [a] = withAccounts(db);
    ingestMessages(db, [
      msg({ accountId: a!, providerMsgId: "recv", rfcMessageId: "q@x", inInbox: false, isTrash: true }),
      msg({ accountId: a!, providerMsgId: "mine", inReplyTo: "q@x", inInbox: false, isSent: true, isTrash: true }),
    ]);
    const t = threadOf(db, "recv");
    applyThreadAction(db, [t], "moveToInbox");
    const rows = db.all<{ provider_msg_id: string; in_inbox: number; is_trash: number }>(
      "SELECT provider_msg_id, in_inbox, is_trash FROM messages ORDER BY provider_msg_id",
    );
    expect(rows).toEqual([
      { provider_msg_id: "mine", in_inbox: 0, is_trash: 1 },
      { provider_msg_id: "recv", in_inbox: 1, is_trash: 0 },
    ]);
    expect(db.get("SELECT in_inbox, in_trash FROM threads WHERE id = ?", t)).toEqual({ in_inbox: 1, in_trash: 0 });
  });
});

describe("ops state machine", () => {
  it("claims in sequence order, retries with exponential backoff, then fails terminally", () => {
    const db = testDb();
    const [a] = withAccounts(db);
    const first = enqueueOp(db, { accountId: a!, kind: "archive", target: { messageIds: [1] } }, 0)!;
    const second = enqueueOp(db, { accountId: a!, kind: "trash", target: { messageIds: [2] } }, 0)!;
    expect(claimReadyOps(db, 0).map((o) => o.id)).toEqual([first, second]);
    completeOp(db, second, 0);

    let now = 0;
    const delays: number[] = [];
    for (let attempt = 1; attempt <= MAX_OP_ATTEMPTS; attempt++) {
      const state = failOp(db, first, "ECONNRESET", true, now);
      const op = getOp(db, first)!;
      if (attempt < MAX_OP_ATTEMPTS) {
        expect(state).toBe("queued");
        delays.push(op.next_attempt_at - now);
        expect(claimReadyOps(db, op.next_attempt_at - 1)).toEqual([]); // not before backoff elapses
        now = op.next_attempt_at;
        expect(claimReadyOps(db, now).map((o) => o.id)).toEqual([first]);
      } else {
        expect(state).toBe("failed");
      }
    }
    expect(delays.slice(0, 4)).toEqual([1000, 2000, 4000, 8000]);
    expect(Math.max(...delays)).toBeLessThanOrEqual(300_000);
  });

  it("non-retryable failures fail immediately", () => {
    const db = testDb();
    const [a] = withAccounts(db);
    const id = enqueueOp(db, { accountId: a!, kind: "archive", target: { messageIds: [1] } })!;
    claimReadyOps(db);
    expect(failOp(db, id, "Mailbox does not exist", false)).toBe("failed");
  });

  it("cancels a queued flag op exactly undone before sync (read → unread)", () => {
    const db = testDb();
    const [a] = withAccounts(db);
    expect(enqueueOp(db, { accountId: a!, kind: "markRead", target: { messageIds: [5, 6] } })).toBeTruthy();
    expect(enqueueOp(db, { accountId: a!, kind: "markUnread", target: { messageIds: [5, 6] } })).toBeNull();
    expect(db.get<{ c: number }>("SELECT count(*) c FROM ops")!.c).toBe(0);
    // a different target set is not cancelled
    enqueueOp(db, { accountId: a!, kind: "markRead", target: { messageIds: [5] } });
    expect(enqueueOp(db, { accountId: a!, kind: "markUnread", target: { messageIds: [5, 6] } })).toBeTruthy();
  });

  it("does not cancel an op that is already running", () => {
    const db = testDb();
    const [a] = withAccounts(db);
    enqueueOp(db, { accountId: a!, kind: "star", target: { messageIds: [1] } });
    claimReadyOps(db);
    expect(enqueueOp(db, { accountId: a!, kind: "unstar", target: { messageIds: [1] } })).toBeTruthy();
  });

  it("crash recovery: running sends become unknown (never resent), other running ops requeue", () => {
    const db = testDb();
    const [a] = withAccounts(db);
    const send = enqueueOp(db, { accountId: a!, kind: "send", target: {}, payload: { subject: "hi" } })!;
    const archive = enqueueOp(db, { accountId: a!, kind: "archive", target: { messageIds: [1] } })!;
    claimReadyOps(db);
    expect(recoverOps(db)).toEqual({ requeued: 1, unknown: 1 });
    expect(getOp(db, send)!.state).toBe("unknown");
    expect(getOp(db, archive)!.state).toBe("queued");
    expect(claimReadyOps(db).map((o) => o.id)).toEqual([archive]);
  });

  it("unknown ops are never claimed again", () => {
    const db = testDb();
    const [a] = withAccounts(db);
    const id = enqueueOp(db, { accountId: a!, kind: "send", target: {} })!;
    claimReadyOps(db);
    markOpUnknown(db, id, "socket closed after DATA");
    expect(claimReadyOps(db, Date.now() + 10 ** 9)).toEqual([]);
  });

  it("reports messages with unsettled ops so sync doesn't clobber optimistic state", () => {
    const db = testDb();
    const [a, b] = withAccounts(db);
    const done = enqueueOp(db, { accountId: a!, kind: "archive", target: { messageIds: [1, 2] } })!;
    enqueueOp(db, { accountId: a!, kind: "markRead", target: { messageIds: [3] } });
    enqueueOp(db, { accountId: b!, kind: "markRead", target: { messageIds: [4] } });
    claimReadyOps(db);
    completeOp(db, done);
    expect([...messagesWithPendingOps(db, a!)]).toEqual([3]);
  });
});

describe("category suggestions", () => {
  function setup() {
    const db = testDb();
    const [a] = withAccounts(db);
    ingestMessages(db, [
      msg({ accountId: a!, providerMsgId: "s1", from: { name: "Uber", email: "uber.receipts@uber.com" }, date: 1 }),
      msg({ accountId: a!, providerMsgId: "s2", from: { name: "Uber", email: "uber.receipts@uber.com" }, date: 2 }),
      msg({ accountId: a!, providerMsgId: "s3", from: { name: "Uber", email: "uber.receipts@uber.com" }, date: 3, isSpam: true, inInbox: false }),
      msg({ accountId: a!, providerMsgId: "d1", from: { name: "Uber Eats", email: "eats@uber.com" }, date: 4 }),
      msg({ accountId: a!, providerMsgId: "g1", from: { name: "Friend", email: "friend@gmail.com" }, date: 5 }),
      msg({ accountId: a!, providerMsgId: "g2", from: { name: "Other", email: "other@gmail.com" }, date: 6 }),
    ]);
    const cat = createCategory(db, "Facturas", "amber");
    return { db, cat };
  }

  it("suggests other threads from the same sender, newest first, excluding spam and current members", () => {
    const { db, cat } = setup();
    addThreadsToCategory(db, cat.id, [threadOf(db, "s1")], "user");
    const s = suggestSimilarForCategory(db, cat.id, threadOf(db, "s1"))!;
    expect(s.reason).toBe("sender");
    expect(s.threads.map((t) => t.id)).toEqual([threadOf(db, "s2")]);
    expect(s.total).toBe(1);
  });

  it("falls back to the domain once the sender is dismissed, but never for consumer domains", () => {
    const { db, cat } = setup();
    const s1 = threadOf(db, "s1");
    addThreadsToCategory(db, cat.id, [s1], "user");
    dismissSuggestion(db, suggestSimilarForCategory(db, cat.id, s1)!.key);
    const s = suggestSimilarForCategory(db, cat.id, s1)!;
    expect(s.reason).toBe("domain");
    expect(s.threads.map((t) => t.id).sort()).toEqual([threadOf(db, "s2"), threadOf(db, "d1")].sort());

    const g1 = threadOf(db, "g1");
    addThreadsToCategory(db, cat.id, [g1], "user");
    expect(suggestSimilarForCategory(db, cat.id, g1)).toBeNull(); // gmail.com is not a meaningful group
  });
});

describe("filter applications", () => {
  it("applies a filter to a message at most once (e.g. re-evaluation when bodies arrive)", () => {
    const db = testDb();
    const [a] = withAccounts(db);
    const r = ingestMessages(db, [msg({ accountId: a! }), msg({ accountId: a! })]);
    const f = saveFilter(db, {
      name: "x",
      enabled: true,
      source: "manual",
      rule: { match: "all", conditions: [{ field: "subject", op: "contains", value: "s" }], actions: [{ type: "archive" }] },
    });
    expect(claimFilterApplications(db, f.id, [r.inserted[0]!])).toEqual([r.inserted[0]]);
    expect(claimFilterApplications(db, f.id, r.inserted)).toEqual([r.inserted[1]]);
    expect(db.get<{ hits: number }>("SELECT hits FROM filters WHERE id = ?", f.id)!.hits).toBe(2);
  });
});
