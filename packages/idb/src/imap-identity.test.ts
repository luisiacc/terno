import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, expect, it, vi } from "vitest";
import { ingest, msg, withAccounts } from "@terno/store/conformance";
import { databaseName } from "./schema";
import { IdbMailStore } from "./store";

const stores: IdbMailStore[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const store of stores.splice(0)) if (store.isOpen) await store.close(); });
const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setImmediate(resolve)) };
async function open(factory = new IDBFactory(), name: string = crypto.randomUUID()) {
  const store = await IdbMailStore.open({ factory, name, instantSearch: false, platform }); stores.push(store); return store;
}
const location = { mailbox: "INBOX", uidvalidity: 7, uid: 1, flags: [] };
const request = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const done = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });

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
  const names = [...db.objectStoreNames].filter((name) => name !== "imap_identity_holds");
  const tx = db.transaction(names, "readonly"), complete = done(tx);
  const images = await Promise.all(names.map(async (name) => ({ name, keys: await request(tx.objectStore(name).getAllKeys()), values: await request(tx.objectStore(name).getAll()) })));
  await complete; db.close();
  const legacyName = crypto.randomUUID();
  const opening = factory.open(databaseName(legacyName), 17);
  opening.onupgradeneeded = () => { for (const name of names) opening.result.createObjectStore(name); };
  const legacy = await request(opening);
  const write = legacy.transaction(names, "readwrite"), written = done(write);
  for (const image of images) image.keys.forEach((key, i) => write.objectStore(image.name).put(image.values[i], key));
  await written; legacy.close();
  const upgraded = await open(factory, legacyName);
  const locations = upgraded.providerStore(account!).locations;
  expect(await locations.unresolved(ids)).toEqual(ids);
  let issued = false;
  await expect(locations.dispatch([ids[0]!], await locations.of([ids[0]!]), async () => { issued = true; })).rejects.toThrow("IMAP identity unavailable");
  expect(issued).toBe(false);
  await upgraded.sync.remove(ids);
  expect((await upgraded.debug.snapshot()).messages.map((m) => m.id)).toEqual(ids);
});
