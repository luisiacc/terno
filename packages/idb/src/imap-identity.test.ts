import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, expect, it, vi } from "vitest";
import { ingest, msg, withAccounts } from "@terno/store/conformance";
import { databaseName } from "./schema";
import { IdbMailStore } from "./store";
import { identityImage, physicalImage, legacyBodyUpgrade } from "./test/legacy-stores";

const stores: IdbMailStore[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const store of stores.splice(0)) if (store.isOpen) await store.close(); });
const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setImmediate(resolve)) };
async function open(factory = new IDBFactory(), name: string = crypto.randomUUID()) {
  const store = await IdbMailStore.open({ legacyUpgrade: legacyBodyUpgrade(factory), factory, name, instantSearch: false, platform }); stores.push(store); return store;
}
const location = { mailbox: "INBOX", uidvalidity: 7, uid: 1, flags: [] };
const request = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

it("identity: a real IDB abort cannot dispatch or leave a partly prepared hold through reopen", async () => {
  const factory = new IDBFactory();
  let store = await open(factory);
  const [, account] = await withAccounts(store);
  const { inserted: [id] } = await ingest(store, [msg({ accountId: account!, locations: [location] })]);
  const captured = await store.providerStore(account!).locations.of([id!]);
  const transaction = IDBDatabase.prototype.transaction;
  let abort = true, issued = false;
  const spy = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args) {
    const tx = transaction.call(this, ...args);
    if (abort && args[1] === "readwrite") { abort = false; queueMicrotask(() => tx.abort()); }
    return tx;
  });
  await expect(store.providerStore(account!).locations.dispatch([id!], captured, async () => { issued = true; }, [id!])).rejects.toThrow();
  spy.mockRestore();
  expect(issued).toBe(false);
  expect(await store.providerStore(account!).locations.unresolved([id!])).toEqual([]);
  const name = store.name; await store.close(); store = await open(factory, name);
  expect(await store.providerStore(account!).locations.unresolved([id!])).toEqual([]);
  expect(await store.providerStore(account!).locations.of([id!])).toEqual(captured);
});

it("identity: physical17 upgrade holds legacy locators before the first provider read", async () => {
  const factory = new IDBFactory();
  const source = await open(factory);
  const [, account] = await withAccounts(source);
  const { inserted: ids } = await ingest(source, [msg({ accountId: account!, locations: [location] }), msg({ accountId: account!, locations: [] })]);
  const db = await request(factory.open(databaseName(source.name)));
  const images = identityImage(await physicalImage(db), 17); db.close();
  const historicalMessages = images.find((image) => image.name === "messages")!.values;
  expect(historicalMessages).toHaveLength(2);
  for (const row of historicalMessages) expect(row).not.toHaveProperty("category");
  const legacyName = crypto.randomUUID();
  const opening = factory.open(databaseName(legacyName), 17);
  opening.onupgradeneeded = () => {
    for (const image of images) {
      const store = opening.result.createObjectStore(image.name, { keyPath: image.keyPath, autoIncrement: image.autoIncrement });
      for (const index of image.indexes) store.createIndex(index.name, index.keyPath, index);
      image.keys.forEach((key, i) => store.put(image.values[i], key));
    }
  };
  (await request(opening)).close();
  const upgraded = await open(factory, legacyName);
  const locations = upgraded.providerStore(account!).locations;
  expect(await locations.unresolved(ids)).toEqual(ids);
  let issued = false;
  await expect(locations.dispatch([ids[0]!], await locations.of([ids[0]!]), async () => { issued = true; })).rejects.toThrow("IMAP identity unavailable");
  expect(issued).toBe(false);
  await upgraded.sync.remove(ids);
  expect((await upgraded.debug.snapshot()).messages.map((m) => m.id)).toEqual(ids);
  const { inserted: [fresh] } = await ingest(upgraded, [msg({ accountId: account!, providerMsgId: "new-trusted-import", locations: [{ ...location, uid: 99 }] })]);
  expect(await locations.unresolved([fresh!])).toEqual([]);
  await expect(locations.dispatch([fresh!], await locations.of([fresh!]), async () => "new import")).resolves.toBe("new import");
  expect(await locations.unresolved(ids)).toEqual(ids);

});

it("identity review: a concurrent fence survives cleanup of an undispatched IDB admission", async () => {
  const factory = new IDBFactory();
  let store = await open(factory);
  const [, account] = await withAccounts(store);
  const { inserted: ids } = await ingest(store, Array.from({ length: 257 }, (_, i) => msg({ accountId: account!, locations: [{ ...location, uid: i + 1 }] })));
  const locations = store.providerStore(account!).locations;
  const before = await locations.of(ids);
  const transaction = IDBDatabase.prototype.transaction;
  let fenced: Promise<void> | undefined, issued = false, changed = false;
  const spy = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args) {
    const tx = transaction.call(this, ...args);
    if (args[1] === "readwrite" && [...tx.objectStoreNames].includes("imap_identity_holds")) tx.addEventListener("complete", () => {
      if (!changed) { changed = true; fenced = locations.fence([ids[0]!]); }
    });
    return tx;
  });
  try {
    await expect(locations.dispatch(ids, before, async () => { issued = true; }, ids)).rejects.toThrow("IMAP identity unavailable");
    await fenced;
  } finally { spy.mockRestore(); }
  expect(changed).toBe(true);
  expect(issued).toBe(false);
  const name = store.name; await store.close(); store = await open(factory, name);
  const current = store.providerStore(account!).locations;
  expect(await current.unresolved(ids)).toEqual([ids[0]]);
  await expect(current.dispatch(ids.slice(1), before.filter((l) => l.message_id !== ids[0]), async () => "still usable")).resolves.toBe("still usable");
});
