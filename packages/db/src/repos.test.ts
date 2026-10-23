import { describe, expect, it } from "vitest";
import { sqliteDriver } from "./index";
import { ingestMessages } from "./ingest";
import { claimReadyOps, enqueueOp, failOp } from "./repos";
import { msg, testDb, withAccounts } from "./test/helpers";

describe("ops state machine", () => {
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

  it("only cancels an opposite op that was never attempted", () => {
    const db = testDb();
    const [a] = withAccounts(db);
    const star = enqueueOp(db, { accountId: a!, kind: "star", target: { messageIds: [1] } }, 0)!;
    claimReadyOps(db, 0);
    failOp(db, star, "response lost", true, 0); // the server may already be starred
    expect(enqueueOp(db, { accountId: a!, kind: "unstar", target: { messageIds: [1] } }, 1)).toBeTruthy();
    expect(db.all("SELECT kind FROM ops ORDER BY seq")).toEqual([{ kind: "unstar" }]); // star superseded, unstar kept
  });
});

// desktop only: the web engine has no WAL and no second connection
describe.runIf(sqliteDriver().features.checkpointWorker)("checkpoint worker", () => {
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
    const { nodeSqliteDriver } = await import("./node-driver");
    const { mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const db = new Db(nodeSqliteDriver, join(mkdtempSync(join(tmpdir(), "unica-mig-")), "v1.db"));
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
