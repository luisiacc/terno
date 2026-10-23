import { describe, expect, it } from "vitest";
import { applyThreadAction } from "./actions";
import { ingestMessages } from "./ingest";
import {
  claimReadyOps,
  completeOp,
  enqueueOp,
  failOp,
  getOp,
  markOpUnknown,
  messagesWithPendingOps,
  MAX_OP_ATTEMPTS,
  recoverOps,
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

  it("a newer op supersedes the overlapping part of an older op waiting in backoff", () => {
    const db = testDb();
    const [a] = withAccounts(db);
    const older = enqueueOp(db, { accountId: a!, kind: "markRead", target: { messageIds: [5, 6] } }, 0)!;
    claimReadyOps(db, 0);
    failOp(db, older, "ETIMEDOUT", true, 0); // queued again, attempts = 1
    enqueueOp(db, { accountId: a!, kind: "markUnread", target: { messageIds: [6] } }, 1);
    // the retry must not touch message 6 any more
    expect(JSON.parse(getOp(db, older)!.target_json)).toEqual({ messageIds: [5] });
    // fully covered older ops disappear
    enqueueOp(db, { accountId: a!, kind: "markUnread", target: { messageIds: [5] } }, 2);
    expect(getOp(db, older)).toBeNull();
  });

  it("only cancels an opposite op that was never attempted", () => {
    const db = testDb();
    const [a] = withAccounts(db);
    const star = enqueueOp(db, { accountId: a!, kind: "star", target: { messageIds: [1] } }, 0)!;
    claimReadyOps(db, 0);
    failOp(db, star, "response lost", true, 0); // the server may already be starred
    expect(enqueueOp(db, { accountId: a!, kind: "unstar", target: { messageIds: [1] } }, 1)).toBeTruthy();
    expect(db.all("SELECT kind FROM ops ORDER BY seq")).toEqual([{ kind: "unstar" }]); // star superseded, unstar kept
  });

  it("a running op that fails gives up messages a newer op already covers", () => {
    const db = testDb();
    const [a] = withAccounts(db);
    const older = enqueueOp(db, { accountId: a!, kind: "markRead", target: { messageIds: [1] } }, 0)!;
    claimReadyOps(db, 0); // in flight
    enqueueOp(db, { accountId: a!, kind: "markUnread", target: { messageIds: [1] } }, 1);
    failOp(db, older, "ETIMEDOUT", true, 2);
    expect(getOp(db, older)).toBeNull(); // its retry would have undone the newer markUnread
  });

  it("location ops are never superseded and run in order per message", () => {
    const db = testDb();
    const [a] = withAccounts(db);
    const notSpam = enqueueOp(db, { accountId: a!, kind: "notSpam", target: { messageIds: [1] } }, 0)!;
    claimReadyOps(db, 0);
    failOp(db, notSpam, "ETIMEDOUT", true, 0); // backoff
    const archive = enqueueOp(db, { accountId: a!, kind: "archive", target: { messageIds: [1, 2] } }, 1)!;
    expect(getOp(db, notSpam)).not.toBeNull(); // Gmail archive wouldn't clear SPAM: keep both
    expect(claimReadyOps(db, 1).map((o) => o.id)).toEqual([]); // archive waits behind notSpam
    const ready = claimReadyOps(db, getOp(db, notSpam)!.next_attempt_at);
    expect(ready.map((o) => o.id)).toEqual([notSpam]);
    completeOp(db, notSpam);
    expect(claimReadyOps(db, 10 ** 13).map((o) => o.id)).toEqual([archive]);
  });

  it("deleting messages removes them from unsettled ops (rowids can be reused)", async () => {
    const { deleteMessages } = await import("./ingest");
    const db = testDb();
    const [a] = withAccounts(db);
    const r = ingestMessages(db, [msg({ accountId: a! }), msg({ accountId: a! })]);
    const op = enqueueOp(db, { accountId: a!, kind: "trash", target: { messageIds: r.inserted } })!;
    deleteMessages(db, [r.inserted[1]!]);
    expect(JSON.parse(getOp(db, op)!.target_json)).toEqual({ messageIds: [r.inserted[0]] });
    deleteMessages(db, [r.inserted[0]!]);
    expect(getOp(db, op)).toBeNull();
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

describe("filter applications", () => {
  it("editing a filter's rule forgets the old applications", () => {
    const db = testDb();
    const [a] = withAccounts(db);
    const r = ingestMessages(db, [msg({ accountId: a! })]);
    const rule = { match: "all" as const, conditions: [{ field: "subject" as const, op: "contains" as const, value: "s" }], actions: [{ type: "archive" as const }] };
    const f = saveFilter(db, { name: "x", enabled: true, source: "manual", rule });
    claimFilterApplications(db, f.id, r.inserted);
    saveFilter(db, { id: f.id, name: "renamed", enabled: true, source: "manual", rule }); // same rule: keep
    expect(claimFilterApplications(db, f.id, r.inserted)).toEqual([]);
    saveFilter(db, { id: f.id, name: "x", enabled: true, source: "manual", rule: { ...rule, actions: [{ type: "star" }] } });
    expect(claimFilterApplications(db, f.id, r.inserted)).toEqual(r.inserted);
  });

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

describe("checkpoint worker", () => {
  it("keeps the WAL bounded without in-thread autocheckpoints, and falls back if it dies", async () => {
    const { startCheckpointWorker } = await import("./checkpoint");
    const { statSync } = await import("node:fs");
    const db = testDb();
    const [a] = withAccounts(db);
    const worker = startCheckpointWorker(db, 20)!;
    expect(db.get("PRAGMA wal_autocheckpoint")).toEqual({ wal_autocheckpoint: 0 });
    for (let i = 0; i < 20; i++) ingestMessages(db, Array.from({ length: 200 }, () => msg({ accountId: a!, bodyText: "x".repeat(2000) })));
    await new Promise((r) => setTimeout(r, 200));
    // a passive checkpoint ran: the main db file has grown well beyond the empty schema
    expect(statSync(db.path).size).toBeGreaterThan(4_000_000);
    await worker.stop();
    expect(statSync(`${db.path}-wal`).size).toBe(0); // TRUNCATE on stop
  });
});

describe("migrations", () => {
  it("upgrades a v1 database and backfills the op target index for unsettled ops", async () => {
    const { MIGRATIONS, migrate } = await import("./migrations");
    const { Db } = await import("./sqlite");
    const { mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const db = new Db(join(mkdtempSync(join(tmpdir(), "unica-mig-")), "v1.db"));
    db.exec(MIGRATIONS[0]!.sql);
    db.exec("PRAGMA user_version = 1");
    db.run("INSERT INTO accounts (id, kind, email, created_at) VALUES (1, 'imap', 'a@b.c', 0)");
    db.run("INSERT INTO ops (id, seq, account_id, kind, target_json, state, created_at, updated_at) VALUES ('q', 1, 1, 'markRead', '{\"messageIds\":[7,8]}', 'queued', 0, 0)");
    db.run("INSERT INTO ops (id, seq, account_id, kind, target_json, state, created_at, updated_at) VALUES ('s', 2, 1, 'archive', '{\"messageIds\":[9]}', 'succeeded', 0, 0)");
    expect(migrate(db)).toMatchObject({ from: 1 });
    expect(db.all("SELECT op_id, message_id, grp FROM op_targets ORDER BY message_id")).toEqual([
      { op_id: "q", message_id: 7, grp: "read" },
      { op_id: "q", message_id: 8, grp: "read" },
    ]);
    db.close();
  });

  it("refuses to open a database from a newer app version", async () => {
    const { migrate } = await import("./migrations");
    const db = testDb();
    db.exec("PRAGMA user_version = 99");
    expect(() => migrate(db)).toThrow(/newer/);
  });
});

describe("account ids", () => {
  it("are never reused, even after removing the newest account (secrets and the owner refer to them)", async () => {
    const { createAccount, removeAccount, accountStamp } = await import("./repos");
    const db = testDb();
    const a = createAccount(db, { kind: "imap", email: "a@x.dev", displayName: "A", color: "indigo" }, 1);
    const b = createAccount(db, { kind: "imap", email: "b@x.dev", displayName: "B", color: "indigo" }, 2);
    removeAccount(db, b.id);
    const c = createAccount(db, { kind: "imap", email: "c@x.dev", displayName: "C", color: "indigo" }, 3);
    expect(c.id).toBeGreaterThan(b.id);
    expect(accountStamp(db, b.id)).toBeNull();
    expect(accountStamp(db, a.id)).toEqual({ id: a.id, email: "a@x.dev", createdAt: 1 });
  });
});
