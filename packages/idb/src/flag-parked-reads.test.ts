import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import { ingest, msg, withAccounts } from "@terno/store/conformance";
import { Table } from "./mem";
import { IdbMailStore } from "./store";

const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setImmediate(resolve)) };
for (const instantSearch of [false, true]) it(`reaffirmation avoids loading parked history (instantSearch=${instantSearch})`, async () => {
  const store = await IdbMailStore.open({ name: crypto.randomUUID(), factory: indexedDB, instantSearch, platform });
  try {
    const [account] = await withAccounts(store, 1);
    await ingest(store, [msg({ accountId: account!, providerMsgId: "parked" })]);
    await store.sync.beginObservation(account!, { authoritativeFlags: true });
    const snap = await store.debug.snapshot(), message = snap.messages[0]!;
    let saved = [] as Awaited<ReturnType<typeof store.threads.act>>["before"];
    for (let n = 0; n < 12; n++) {
      saved = (await store.threads.act({ threadIds: [message.threadId], action: "markRead", signal: null, now: n * 4 + 1 })).before;
      const [op] = await store.ops.claimReady(n * 4 + 2, 10);
      await store.ops.markUnknown(op!.id, "uncertain", n * 4 + 3);
      const epoch = await store.sync.beginObservation(account!, { authoritativeFlags: true });
      await store.sync.updateFlags(account!, [{ messageId: message.id, expectedProviderMsgId: "parked", flags: { isRead: false } }], epoch!);
    }
    const by = Table.prototype.by, count = Table.prototype.count, counts: number[] = [], seeks: string[] = [];
    const spy = vi.spyOn(Table.prototype, "by").mockImplementation(function(this: Table, index, ...keys) {
      const rows = by.call(this, index, ...keys);
      if (this.spec.name === "flag_op_effects" && index === "fk_message_id") counts.push(rows.length);
      return rows;
    });
    const countSpy = vi.spyOn(Table.prototype, "count").mockImplementation(function(this: Table, index, ...keys) {
      if (this.spec.name === "flag_op_effects") seeks.push(index);
      return count.call(this, index, ...keys);
    });
    try {
      await store.threads.act({ threadIds: [message.threadId], action: "markUnread", signal: null, now: 99 });
      await store.threads.restore({ messages: saved, now: 100 });
      expect(Math.max(0, ...counts)).toBeLessThanOrEqual(1);
      expect(seeks.length).toBeGreaterThan(0);
      expect(seeks.length).toBeLessThanOrEqual(6);
      expect(seeks.every((name) => name === "parked_version" || name === "parked_zero")).toBe(true);
    } finally { spy.mockRestore(); countSpy.mockRestore(); }
  } finally { await store.close(); }
});

it("rebuilds the memory index when opening physical 8 logical 21 metadata", async () => {
  const { IDBFactory } = await import("fake-indexeddb");
  const { databaseName } = await import("./schema");
  const factory = new IDBFactory(), name = crypto.randomUUID();
  let store = await IdbMailStore.open({ name, factory, instantSearch: false, platform });
  try {
    const [account] = await withAccounts(store, 1);
    await ingest(store, [msg({ accountId: account!, providerMsgId: "upgrade" })]);
    await store.sync.beginObservation(account!, { authoritativeFlags: true });
    const message = (await store.debug.snapshot()).messages[0]!;
    await store.threads.act({ threadIds: [message.threadId], action: "markRead", signal: null, now: 1 });
    const [op] = await store.ops.claimReady(2, 10);
    await store.ops.markUnknown(op!.id, "uncertain", 3);
    await store.close();
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = factory.open(databaseName(name), 8); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    await new Promise<void>((resolve, reject) => { const tx = db.transaction("meta", "readwrite"); tx.objectStore("meta").put(21, "logicalSchema"); tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
    db.close();
    store = await IdbMailStore.open({ name, factory, instantSearch: false, platform });
    const fresh = await store.sync.beginObservation(account!, { authoritativeFlags: true });
    await store.sync.updateFlags(account!, [{ messageId: message.id, expectedProviderMsgId: "upgrade", flags: { isRead: false } }], fresh!);
    expect((await store.threads.act({ threadIds: [message.threadId], action: "markUnread", signal: null, now: 4 })).flagReconcileAccounts).toEqual([account]);
    await expect(store.ops.resolveUnknown(op!.id, "retry", 5)).rejects.toMatchObject({ code: "STALE" });
  } finally { if (store.isOpen) await store.close(); }
});

it("restores the parked lookup after a real IndexedDB transaction abort", async () => {
  const store = await IdbMailStore.open({ name: crypto.randomUUID(), factory: indexedDB, instantSearch: false, platform });
  try {
    const [account] = await withAccounts(store, 1);
    await ingest(store, [msg({ accountId: account!, providerMsgId: "abort" })]);
    await store.sync.beginObservation(account!, { authoritativeFlags: true });
    const message = (await store.debug.snapshot()).messages[0]!;
    await store.threads.act({ threadIds: [message.threadId], action: "markRead", signal: null, now: 1 });
    const [op] = await store.ops.claimReady(2, 10);
    await store.ops.markUnknown(op!.id, "uncertain", 3);
    const fresh = await store.sync.beginObservation(account!, { authoritativeFlags: true });
    await store.sync.updateFlags(account!, [{ messageId: message.id, expectedProviderMsgId: "abort", flags: { isRead: false } }], fresh!);
    const transaction = IDBDatabase.prototype.transaction;
    let abort = true;
    const spy = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function(this: IDBDatabase, ...args) {
      const tx = transaction.call(this, ...args);
      if (abort && args[1] === "readwrite") { abort = false; queueMicrotask(() => tx.abort()); }
      return tx;
    });
    try { await expect(store.threads.act({ threadIds: [message.threadId], action: "markUnread", signal: null, now: 4 })).rejects.toThrow(); }
    finally { spy.mockRestore(); }
    expect((await store.threads.act({ threadIds: [message.threadId], action: "markUnread", signal: null, now: 5 })).flagReconcileAccounts).toEqual([account]);
    await expect(store.ops.resolveUnknown(op!.id, "retry", 6)).rejects.toMatchObject({ code: "STALE" });
  } finally { await store.close(); }
});
