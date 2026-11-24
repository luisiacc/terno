import { describe, expect, it } from "vitest";
import { sqliteDriver } from "./index";
import { ingestMessages } from "./ingest";
import { enqueueOp } from "./repos";
import { msg, testDb, withAccounts } from "./test/helpers";

describe("ops state machine", () => {
  it("a queued flag op undone before sync is superseded, never cancelled out: the newest goes (plan 229)", () => {
    const db = testDb();
    const [a] = withAccounts(db);
    expect(enqueueOp(db, { accountId: a!, kind: "markRead", target: { messageIds: [5, 6] } })).toBeTruthy();
    const unread = enqueueOp(db, { accountId: a!, kind: "markUnread", target: { messageIds: [5, 6] } });
    expect(unread).toBeTruthy();
    expect(db.all<{ id: string; kind: string }>("SELECT id, kind FROM ops")).toEqual([{ id: unread, kind: "markUnread" }]);
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

  it("starts the WAL over during bulk work: slices that settle between commits never grow it past its limit", async () => {
    const { startCheckpointWorker } = await import("./checkpoint");
    const { statSync } = await import("node:fs");
    const db = testDb();
    db.exec("CREATE TABLE bulk (id INTEGER PRIMARY KEY, a INTEGER, b TEXT); CREATE INDEX bulk_a ON bulk(a); CREATE INDEX bulk_b ON bulk(b)");
    const random = () => Math.floor(Math.random() * 1e9);
    db.tx(() => {
      for (let i = 1; i <= 50_000; i++) db.run("INSERT INTO bulk (id, a, b) VALUES (?, ?, ?)", i, random(), random().toString(36));
    });
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    // the production interval: a passive checkpoint a second, which on its own never catches up with back-to-back slices
    const worker = startCheckpointWorker(db)!;
    let written = 0;
    let largest = 0;
    // small commits scattered over three indexes, a yield and a settle between them, until ~4× the limit went through the WAL
    while (written < 256 * 2 ** 20) {
      db.tx(() => {
        for (let i = 0; i < 20; i++) db.run("UPDATE bulk SET a = ?, b = ? WHERE id = ?", random(), random().toString(36), 1 + Math.floor(Math.random() * 50_000));
      });
      written += 60 * 4120; // a lower bound: each update dirties a leaf of the table and of both indexes
      await new Promise((r) => setImmediate(r));
      await worker.settle();
      largest = Math.max(largest, statSync(`${db.path}-wal`).size);
    }
    await worker.stop();
    // without settle() it ends at whatever went through it (hundreds of MB), and the restart truncates on this thread
    expect(largest).toBeLessThanOrEqual(80 * 2 ** 20);
  });
});

// plan 253: checkpoints wait for a backup's first write after a clone, within a bound
describe.runIf(sqliteDriver().features.checkpointWorker)("a held checkpoint worker", () => {
  const MiB = 2 ** 20;
  /** bytes of the main file: it grows only when a checkpoint copies the WAL into it */
  const fileBytes = async (db: { path: string }) => (await import("node:fs")).statSync(db.path).size;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const fill = (db: ReturnType<typeof testDb>, a: number, n = 4) => {
    for (let i = 0; i < n; i++) ingestMessages(db, Array.from({ length: 200 }, () => msg({ accountId: a, bodyText: "x".repeat(2000) })));
  };

  it.each(["resolves", "rejects", "never settles (the bound)"] as const)("checkpoints nothing while held, and starts once the hold %s", async (how) => {
    const { startCheckpointWorker } = await import("./checkpoint");
    const db = testDb();
    const [a] = withAccounts(db);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    let resolve!: () => void, reject!: (e: Error) => void;
    const until = new Promise<void>((y, n) => ((resolve = y), (reject = n)));
    const worker = startCheckpointWorker(db, 20, { until, maxMs: how === "never settles (the bound)" ? 400 : 60_000 })!;
    try {
      const before = await fileBytes(db);
      fill(db, a!);
      await wait(200);
      expect(await fileBytes(db)).toBe(before);
      if (how === "resolves") resolve();
      if (how === "rejects") reject(new Error("settle failed"));
      await wait(how === "never settles (the bound)" ? 600 : 200);
      expect(await fileBytes(db)).toBeGreaterThan(before + MiB);
    } finally {
      await worker.stop();
    }
  });

  it("a bulk writer doesn't wait below the hard limit; past it, it waits for the hold, and stop() lets it go", async () => {
    const { startCheckpointWorker } = await import("./checkpoint");
    const db = testDb();
    db.exec("CREATE TABLE bulk (b BLOB)");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    let resolve!: () => void;
    const until = new Promise<void>((y) => (resolve = y));
    const worker = startCheckpointWorker(db, 20, { until, maxMs: 60_000 })!;
    try {
      // past the budget (16 MiB) and below the hard limit (64 MiB): no wait
      db.tx(() => {
        for (let i = 0; i < 24; i++) db.run("INSERT INTO bulk VALUES (randomblob(1048576))");
      });
      let settled = false;
      await Promise.race([worker.settle().then(() => (settled = true)), wait(100)]);
      expect(settled).toBe(true);
      // past the hard limit: waits for the hold, then a checkpoint
      db.tx(() => {
        for (let i = 0; i < 48; i++) db.run("INSERT INTO bulk VALUES (randomblob(1048576))");
      });
      settled = false;
      const waiting = worker.settle().then(() => (settled = true));
      await wait(150);
      expect(settled).toBe(false);
      resolve();
      await waiting;
      expect(settled).toBe(true);
      // held again (a second worker, the first gone) and stopped: the writer was waiting, and isn't left waiting
      await worker.stop();
      const other = startCheckpointWorker(db, 20, { until: new Promise(() => {}), maxMs: 60_000 })!;
      db.tx(() => {
        for (let i = 0; i < 72; i++) db.run("INSERT INTO bulk VALUES (randomblob(1048576))");
      });
      let freed = false;
      const left = other.settle().then(() => (freed = true));
      await wait(100);
      expect(freed).toBe(false);
      await other.stop();
      await left;
      expect(freed).toBe(true);
    } finally {
      await worker.stop();
    }
  });

  it("deferCheckpoints: the open (and its migration) never checkpoints on its thread; without it, SQLite's default", async () => {
    const { openDatabaseWith } = await import("./portable");
    const { nodeSqliteDriver } = await import("./node-driver");
    const { mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "terno-defer-"));
    const deferred = openDatabaseWith(nodeSqliteDriver, join(dir, "a.db"), { deferCheckpoints: true });
    const plain = openDatabaseWith(nodeSqliteDriver, join(dir, "b.db"));
    // set before the migration's first statement (Codex code review #11), read from what the connection was asked
    const asked: string[] = [];
    const recording = { ...nodeSqliteDriver, open: (path: string, o: { readonly: boolean }) => {
      const conn = nodeSqliteDriver.open(path, o);
      const exec = conn.exec.bind(conn);
      conn.exec = (sql: string) => { asked.push(sql); exec(sql); };
      return conn;
    } };
    openDatabaseWith(recording, join(dir, "c.db"), { deferCheckpoints: true }).close();
    const deferAt = asked.findIndex((sql) => /wal_autocheckpoint = 0/.test(sql));
    const firstCreate = asked.findIndex((sql) => /CREATE TABLE/i.test(sql));
    expect(deferAt).toBeGreaterThan(-1);
    expect(deferAt).toBeLessThan(firstCreate);
    try {
      expect(deferred.get("PRAGMA wal_autocheckpoint")).toEqual({ wal_autocheckpoint: 0 });
      expect(plain.get("PRAGMA wal_autocheckpoint")).toEqual({ wal_autocheckpoint: 1000 });
    } finally {
      deferred.close();
      plain.close();
    }
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
    const db = new Db(nodeSqliteDriver, join(mkdtempSync(join(tmpdir(), "terno-mig-")), "v1.db"));
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
    const a = createAccount(db, { kind: "imap", email: "a@x.dev", displayName: "A", color: "brown" }, 1);
    const b = createAccount(db, { kind: "imap", email: "b@x.dev", displayName: "B", color: "brown" }, 2);
    removeAccount(db, b.id);
    const c = createAccount(db, { kind: "imap", email: "c@x.dev", displayName: "C", color: "brown" }, 3);
    expect(c.id).toBeGreaterThan(b.id);
    expect(accountStamp(db, b.id)).toBeNull();
    expect(accountStamp(db, a.id)).toEqual({ id: a.id, email: "a@x.dev", createdAt: 1 });
  });
});
