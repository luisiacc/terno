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
  const request = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  let store = await IdbMailStore.open({ name, factory, instantSearch: false, platform });
  let raw: IDBDatabase | undefined;
  try {
    const [account] = await withAccounts(store, 1);
    await ingest(store, [msg({ accountId: account!, providerMsgId: "upgrade" })]);
    await store.sync.beginObservation(account!, { authoritativeFlags: true });
    const message = (await store.debug.snapshot()).messages[0]!;
    await store.threads.act({ threadIds: [message.threadId], action: "markRead", signal: null, now: 1 });
    const [op] = await store.ops.claimReady(2, 10);
    await store.ops.markUnknown(op!.id, "uncertain", 3);
    await store.close();
    raw = await request(factory.open(databaseName(name)));
    const tx = raw.transaction([...raw.objectStoreNames], "readonly");
    const finished = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
    void finished.catch(() => {});
    const image = await Promise.all([...raw.objectStoreNames].map(async (name) => {
      const table = tx.objectStore(name);
      const indexes = [...table.indexNames].map((name) => {
        const index = table.index(name);
        return { name, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
      });
      const [keys, values] = await Promise.all([request(table.getAllKeys()), request(table.getAll())]);
      return { name, keyPath: table.keyPath, autoIncrement: table.autoIncrement, indexes, keys, values };
    }));
    await finished;
    raw.close(); raw = undefined;
    const legacyName = crypto.randomUUID(), create = factory.open(databaseName(legacyName), 8);
    create.onupgradeneeded = () => {
      for (const saved of image) {
        const table = create.result.createObjectStore(saved.name, { keyPath: saved.keyPath, autoIncrement: saved.autoIncrement });
        for (const index of saved.indexes) table.createIndex(index.name, index.keyPath, { unique: index.unique, multiEntry: index.multiEntry });
        saved.values.forEach((value, i) => table.put(saved.name === "meta" && saved.keys[i] === "logicalSchema" ? 21 : value, saved.keys[i]!));
      }
    };
    raw = await request(create);
    expect(raw.version).toBe(8);
    expect(await request(raw.transaction("meta").objectStore("meta").get("logicalSchema"))).toBe(21);
    raw.close(); raw = undefined;
    store = await IdbMailStore.open({ name: legacyName, factory, instantSearch: false, platform });
    raw = await request(factory.open(databaseName(legacyName)));
    expect(raw.version).toBe(10);
    raw.close(); raw = undefined;
    const fresh = await store.sync.beginObservation(account!, { authoritativeFlags: true });
    await store.sync.updateFlags(account!, [{ messageId: message.id, expectedProviderMsgId: "upgrade", flags: { isRead: false } }], fresh!);
    expect((await store.threads.act({ threadIds: [message.threadId], action: "markUnread", signal: null, now: 4 })).flagReconcileAccounts).toEqual([account]);
    await expect(store.ops.resolveUnknown(op!.id, "retry", 5)).rejects.toMatchObject({ code: "STALE" });
  } finally { raw?.close(); if (store.isOpen) await store.close(); }
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
