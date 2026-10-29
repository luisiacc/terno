import { expect, it } from "vitest";
import { ingest, msg, withAccounts } from "@terno/store/conformance";
import { openDatabase } from "./index";
import { SqlMailStore } from "./sql-store";
import { SCHEMA_VERSION } from "./migrations";

it("reaffirmation avoids materializing parked history", async () => {
  const db = openDatabase(":memory:"), store = new SqlMailStore(db);
  try {
    const [account] = await withAccounts(store, 1);
    await ingest(store, [msg({ accountId: account!, providerMsgId: "parked" })]);
    await store.sync.beginObservation(account!, { authoritativeFlags: true });
    const message = (await store.debug.snapshot()).messages[0]!;
    let saved = [] as Awaited<ReturnType<typeof store.threads.act>>["before"];
    for (let n = 0; n < 12; n++) {
      saved = (await store.threads.act({ threadIds: [message.threadId], action: "markRead", signal: null, now: n * 4 + 1 })).before;
      const [op] = await store.ops.claimReady(n * 4 + 2, 10);
      await store.ops.markUnknown(op!.id, "uncertain", n * 4 + 3);
      const epoch = await store.sync.beginObservation(account!, { authoritativeFlags: true });
      await store.sync.updateFlags(account!, [{ messageId: message.id, expectedProviderMsgId: "parked", flags: { isRead: false } }], epoch!);
    }
    const all = db.all.bind(db), get = db.get.bind(db), counts: number[] = [], plans: string[] = [];
    db.get = ((sql: string, ...args: Parameters<typeof db.get> extends [string, ...infer P] ? P : never) => {
      if (sql.startsWith("SELECT 1 FROM flag_op_effects WHERE message_id=? AND field=?")) plans.push(...all<{ detail: string }>("EXPLAIN QUERY PLAN " + sql, ...args).map((row) => row.detail));
      return get(sql, ...args);
    }) as typeof db.get;
    db.all = ((sql: string, ...args: Parameters<typeof db.all> extends [string, ...infer P] ? P : never) => {
      const rows = all(sql, ...args);
      if (sql === "SELECT * FROM flag_op_effects WHERE message_id=?") counts.push(rows.length);
      return rows;
    }) as typeof db.all;
    await store.threads.act({ threadIds: [message.threadId], action: "markUnread", signal: null, now: 99 });
    await store.threads.restore({ messages: saved, now: 100 });
    expect(Math.max(0, ...counts)).toBeLessThanOrEqual(1);
    expect(plans.length).toBeGreaterThan(0);
    expect(plans.every((plan) => plan.includes("flag_effect_parked_current") && plan.includes("<expr>=?"))).toBe(true);
  } finally { await store.close(); }
});

it("upgrades a real schema 21 mailbox with parked effects", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { writeLegacyCopy } = await import("./test/legacy");
  const dir = mkdtempSync(join(tmpdir(), "terno-parked-upgrade-"));
  let source = new SqlMailStore(openDatabase(join(dir, "source.db")));
  try {
    const [account] = await withAccounts(source, 1);
    await ingest(source, [msg({ accountId: account!, providerMsgId: "upgrade" })]);
    await source.sync.beginObservation(account!, { authoritativeFlags: true });
    const message = (await source.debug.snapshot()).messages[0]!;
    await source.threads.act({ threadIds: [message.threadId], action: "markRead", signal: null, now: 1 });
    const [op] = await source.ops.claimReady(2, 10);
    await source.ops.markUnknown(op!.id, "uncertain", 3);
    const path = join(dir, "legacy.db");
    writeLegacyCopy(source.db, path, 21);
    await source.close();
    const db = openDatabase(path); source = new SqlMailStore(db);
    expect(db.get<{ user_version: number }>("PRAGMA user_version")!.user_version).toBe(SCHEMA_VERSION);
    expect(db.get<{ count: number }>("SELECT count(*) AS count FROM flag_op_effects")!.count).toBe(1);
    const fresh = await source.sync.beginObservation(account!, { authoritativeFlags: true });
    await source.sync.updateFlags(account!, [{ messageId: message.id, expectedProviderMsgId: "upgrade", flags: { isRead: false } }], fresh!);
    expect((await source.threads.act({ threadIds: [message.threadId], action: "markUnread", signal: null, now: 4 })).flagReconcileAccounts).toEqual([account]);
    await expect(source.ops.resolveUnknown(op!.id, "retry", 5)).rejects.toMatchObject({ code: "STALE" });
  } finally { if (source.isOpen) await source.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("rolls back a failed reaffirmation and retains the parked lookup", async () => {
  const db = openDatabase(":memory:"), store = new SqlMailStore(db);
  try {
    const [account] = await withAccounts(store, 1);
    await ingest(store, [msg({ accountId: account!, providerMsgId: "rollback" })]);
    await store.sync.beginObservation(account!, { authoritativeFlags: true });
    const message = (await store.debug.snapshot()).messages[0]!;
    await store.threads.act({ threadIds: [message.threadId], action: "markRead", signal: null, now: 1 });
    const [op] = await store.ops.claimReady(2, 10);
    await store.ops.markUnknown(op!.id, "uncertain", 3);
    const fresh = await store.sync.beginObservation(account!, { authoritativeFlags: true });
    await store.sync.updateFlags(account!, [{ messageId: message.id, expectedProviderMsgId: "rollback", flags: { isRead: false } }], fresh!);
    db.exec("CREATE TRIGGER fail_reaffirm BEFORE INSERT ON message_flag_intents BEGIN SELECT RAISE(ABORT, 'test rollback'); END");
    await expect(store.threads.act({ threadIds: [message.threadId], action: "markUnread", signal: null, now: 4 })).rejects.toThrow();
    db.exec("DROP TRIGGER fail_reaffirm");
    expect((await store.threads.act({ threadIds: [message.threadId], action: "markUnread", signal: null, now: 5 })).flagReconcileAccounts).toEqual([account]);
    await expect(store.ops.resolveUnknown(op!.id, "retry", 6)).rejects.toMatchObject({ code: "STALE" });
  } finally { await store.close(); }
});
