import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ingest, msg, threadOf, withAccounts } from "@terno/store/conformance";
import { openDatabase } from "./index";
import { SqlMailStore } from "./sql-store";
import { writeLegacyCopy } from "./test/legacy";

const stores: SqlMailStore[] = [], dirs: string[] = [];
afterEach(async () => { for (const store of stores.splice(0)) if (store.isOpen) await store.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const path = () => { const dir = mkdtempSync(join(tmpdir(), "terno-flag-lifecycle-")); dirs.push(dir); return join(dir, "store.db"); };
const open = (file = path(), yieldTo = () => new Promise<void>((resolve) => setImmediate(resolve))) => { const store = new SqlMailStore(openDatabase(file), { platform: { yield: yieldTo } }); stores.push(store); return store; };

it("rolls back activation, flags, queue and observation clock at the real SQL commit boundary", async () => {
  const store = open();
  const [a] = await withAccounts(store, 1);
  await ingest(store, [msg({ accountId: a!, providerMsgId: "rollback" })]);
  let fail = true;
  store.db.onBeforeCommit(() => { if (fail) throw new Error("synthetic flag commit refusal"); });
  await expect(store.sync.beginObservation(a!, { authoritativeFlags: true })).rejects.toThrow("synthetic flag commit refusal");
  fail = false;
  expect(await store.sync.beginObservation(a!, { authoritativeFlags: false })).toBeNull();
  const first = (await store.sync.beginObservation(a!, { authoritativeFlags: true }))!;
  const threadId = await threadOf(store, "rollback");
  fail = true;
  await expect(store.threads.act({ threadIds: [threadId], action: "markRead", signal: null, now: 1 })).rejects.toThrow("synthetic flag commit refusal");
  fail = false;
  expect((await store.debug.snapshot()).messages[0]!.isRead).toBe(false);
  expect((await store.debug.snapshot()).ops).toEqual([]);
  expect((await store.sync.beginObservation(a!, { authoritativeFlags: true }))!.epoch).toBe(first.epoch + 1);
  expect((await store.providerStore(a!).pendingFlagSnapshots({ limit: 50 })).items).toEqual([]);
});

it("removal at an initializer yield rejects before another chunk and cannot recreate its account", async () => {
  let holding = false, removed = false, enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  const illegal = new Error("initializer continued after account removal");
  const store = open(path(), async () => {
    if (holding) { holding = false; enter(); await released; }
    else if (removed) throw illegal;
    else await new Promise<void>((resolve) => setImmediate(resolve));
  });
  const [a] = await withAccounts(store, 1);
  await ingest(store, Array.from({ length: 129 }, (_, i) => msg({ accountId: a!, providerMsgId: `moving-${i}` })));
  const ids = (await store.debug.snapshot()).threads.map((thread) => thread.id);
  await store.threads.act({ threadIds: ids, action: "archive", signal: null, now: 1 });
  holding = true;
  const initialize = store.sync.beginObservation(a!, { authoritativeFlags: true });
  try {
    await entered;
    await store.accounts.remove(a!);
    removed = true;
  } finally { release(); }
  await expect(initialize).rejects.toThrow("Account no longer exists");
  expect((await store.debug.snapshot()).accounts).toEqual([]);
});

it("upgrades genuine logical20 queue data without activating it, then synthesizes current legacy targets", async () => {
  const source = open();
  const [a] = await withAccounts(source, 1);
  await ingest(source, [msg({ accountId: a!, providerMsgId: "legacy20" })]);
  const action = await source.threads.act({ threadIds: [await threadOf(source, "legacy20")], action: "archive", signal: null, now: 1 });
  const file = path();
  writeLegacyCopy(source.db, file, 20);
  const upgraded = open(file);
  expect(await upgraded.sync.beginObservation(a!, { authoritativeFlags: false })).toBeNull();
  await upgraded.sync.beginObservation(a!, { authoritativeFlags: true });
  expect((await upgraded.ops.claimReady(2, 20)).map((op) => op.id)).toEqual(action.opIds);
  await upgraded.ops.complete(action.opIds[0]!, undefined, 3);
  expect((await upgraded.providerStore(a!).pendingFlagSnapshots({ limit: 50 })).items.map((row) => row.providerMsgId)).toEqual(["legacy20"]);
});
