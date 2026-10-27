import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, expect, it, vi } from "vitest";
import { ingest, msg, threadOf, withAccounts } from "@terno/store/conformance";
import { IdbMailStore } from "./store";
import { databaseName } from "./schema";

const stores: IdbMailStore[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const store of stores.splice(0)) if (store.isOpen) await store.close(); });
const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setImmediate(resolve)) };
async function open(factory = new IDBFactory(), name: string = crypto.randomUUID(), yieldTo = platform.yield) {
  const store = await IdbMailStore.open({ factory, name, instantSearch: false, platform: { ...platform, yield: yieldTo } });
  stores.push(store); return store;
}
const request = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const committed = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); tx.onerror = () => reject(tx.error); });

it("real IDB abort rolls back activation, effective intent, clock and snapshot index through reopen", async () => {
  const factory = new IDBFactory();
  let store = await open(factory);
  const [a] = await withAccounts(store, 1);
  await ingest(store, [msg({ accountId: a!, providerMsgId: "rollback" })]);
  const transaction = IDBDatabase.prototype.transaction;
  let abort = true;
  vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function(this: IDBDatabase, ...args) {
    const tx = transaction.call(this, ...args);
    if (abort && args[1] === "readwrite") { abort = false; queueMicrotask(() => tx.abort()); }
    return tx;
  });
  await expect(store.sync.beginObservation(a!, { authoritativeFlags: true })).rejects.toThrow();
  expect(await store.sync.beginObservation(a!, { authoritativeFlags: false })).toBeNull();
  const first = (await store.sync.beginObservation(a!, { authoritativeFlags: true }))!;
  const threadId = await threadOf(store, "rollback");
  abort = true;
  await expect(store.threads.act({ threadIds: [threadId], action: "markRead", signal: null, now: 1 })).rejects.toThrow();
  expect((await store.debug.snapshot()).messages[0]!.isRead).toBe(false);
  expect((await store.debug.snapshot()).ops).toEqual([]);
  expect((await store.sync.beginObservation(a!, { authoritativeFlags: true }))!.epoch).toBe(first.epoch + 1);
  expect((await store.providerStore(a!).pendingFlagSnapshots({ limit: 50 })).items).toEqual([]);
  await store.threads.act({ threadIds: [threadId], action: "markRead", signal: null, now: 2 });
  const [op] = await store.ops.claimReady(3, 20);
  abort = true;
  await expect(store.ops.complete(op!.id, undefined, 4)).rejects.toThrow();
  expect((await store.ops.get(op!.id))?.state).toBe("running");
  const name = store.name;
  await store.close(); store = await open(factory, name);
  await store.ops.complete(op!.id, undefined, 5);
  const id = (await store.debug.snapshot()).messages[0]!.id;
  expect((await store.providerStore(a!).pendingFlagSnapshots({ limit: 50 })).items).toEqual([{ id, providerMsgId: "rollback" }]);
  const fresh = (await store.sync.beginObservation(a!, { authoritativeFlags: true }))!;
  await store.sync.updateFlags(a!, [{ messageId: id, expectedProviderMsgId: "rollback", flags: { isRead: false } }], fresh);
  expect((await store.debug.snapshot()).messages[0]!.isRead).toBe(false);
});

it("bounded INIT preserves an interleaved newer action and physical keyset pages through restart", async () => {
  const factory = new IDBFactory();
  let hold = false, enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  let store = await open(factory, undefined, async () => { if (hold) { hold = false; enter(); await released; } else await platform.yield(); });
  const [a] = await withAccounts(store, 1);
  await ingest(store, Array.from({ length: 129 }, (_, i) => msg({ accountId: a!, providerMsgId: `legacy-${i}` })));
  const snapshot = await store.debug.snapshot();
  const last = snapshot.messages[128]!;
  const legacy = await store.threads.act({ threadIds: snapshot.threads.map((thread) => thread.id), action: "markRead", signal: null, now: 1 });
  hold = true;
  const initialize = store.sync.beginObservation(a!, { authoritativeFlags: true });
  try {
    await entered;
    const newer = await store.threads.act({ threadIds: [last.threadId], action: "markUnread", signal: null, now: 2 });
    const beforeAck = (await store.sync.beginObservation(a!, { authoritativeFlags: true }))!;
    const claimed = await store.ops.claimReady(3, 20);
    expect(claimed.map((op) => op.id)).toEqual([legacy.opIds[0], newer.opIds[0]]);
    await store.ops.complete(legacy.opIds[0]!, undefined, 4);
    await store.ops.complete(newer.opIds[0]!, undefined, 5);
    await store.sync.updateFlags(a!, [{ messageId: last.id, expectedProviderMsgId: last.providerMsgId!, flags: { isRead: true } }], beforeAck);
    expect((await store.debug.snapshot()).messages.find((message) => message.id === last.id)!.isRead).toBe(false);
  } finally { release(); await initialize; }
  const name = store.name;
  await store.close(); store = await open(factory, name);
  const visited: number[] = [];
  let afterMessageId = 0, throughMessageId: number | undefined;
  for (;;) {
    const page = await store.providerStore(a!).pendingFlagSnapshots({ limit: 17, afterMessageId, throughMessageId });
    throughMessageId ??= page.throughMessageId;
    expect(page.throughMessageId).toBe(throughMessageId);
    expect(page.items.length).toBeLessThanOrEqual(17);
    visited.push(...page.items.map((row) => row.id));
    if (!page.hasMore) break;
    afterMessageId = page.items[page.items.length - 1]!.id;
  }
  expect(visited).toEqual(snapshot.messages.map((message) => message.id).sort((x,y) => x-y));
});

it("upgrades a genuine physical7 mailbox and creates required physical flag indexes without activation", async () => {
  const factory = new IDBFactory(), source = await open(factory);
  const [a] = await withAccounts(source, 1);
  await ingest(source, [msg({ accountId: a!, providerMsgId: "physical7" })]);
  const action = await source.threads.act({ threadIds: [await threadOf(source, "physical7")], action: "archive", signal: null, now: 1 });
  const sourceDb = await request(factory.open(databaseName(source.name), 8));
  const names = [...sourceDb.objectStoreNames].filter((name) => !["flag_clocks", "message_flag_intents", "flag_op_effects"].includes(name));
  const read = sourceDb.transaction(names, "readonly");
  const copied = await Promise.all(names.map(async (name) => ({ name, keys: await request(read.objectStore(name).getAllKeys()), values: await request(read.objectStore(name).getAll()) })));
  const oldName = crypto.randomUUID(), create = factory.open(databaseName(oldName), 7);
  create.onupgradeneeded = () => { for (const name of names) create.result.createObjectStore(name); };
  const old = await request(create), write = old.transaction(names, "readwrite"), done = committed(write);
  for (const table of copied) for (let i=0;i<table.keys.length;i++) write.objectStore(table.name).put(table.name === "meta" && table.keys[i] === "logicalSchema" ? 20 : table.values[i], table.keys[i]);
  await done; old.close(); sourceDb.close();
  const upgraded = await open(factory, oldName);
  expect(await upgraded.sync.beginObservation(a!, { authoritativeFlags: false })).toBeNull();
  await upgraded.sync.beginObservation(a!, { authoritativeFlags: true });
  expect((await upgraded.ops.claimReady(2, 20)).map((op) => op.id)).toEqual(action.opIds);
  await upgraded.ops.complete(action.opIds[0]!, undefined, 3);
  expect((await upgraded.providerStore(a!).pendingFlagSnapshots({ limit: 50 })).items.map((row) => row.providerMsgId)).toEqual(["physical7"]);
});
