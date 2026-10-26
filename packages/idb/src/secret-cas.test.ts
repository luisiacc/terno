import "fake-indexeddb/auto";
import { IDBDatabase } from "fake-indexeddb";
import { afterEach, expect, it, vi } from "vitest";
import { IdbMailStore } from "./store";

const opened: IdbMailStore[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const s of opened.splice(0)) await s.close(); });
const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setTimeout(resolve, 0)) };
const open = async (name: string = crypto.randomUUID()) => { const s = await IdbMailStore.open({ name, factory: indexedDB, platform, instantSearch: false }); opened.push(s); return s; };

it("secret CAS rolls memory and disk back on abort, persists on reopen, and ownership assertions issue no write", async () => {
  let store = await open();
  await store.secrets.put("synthetic", Uint8Array.of(1));
  const transaction = IDBDatabase.prototype.transaction;
  const txs = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args) {
    const tx = transaction.call(this, ...args);
    if (args[1] === "readwrite") queueMicrotask(() => tx.abort());
    return tx;
  });
  await expect(store.secrets.replace("synthetic", Uint8Array.of(1), Uint8Array.of(2))).rejects.toThrow();
  expect(await store.secrets.get("synthetic")).toEqual(Uint8Array.of(1));
  txs.mockRestore();
  await store.close();
  store = await open(store.name);
  expect(await store.secrets.get("synthetic")).toEqual(Uint8Array.of(1));
  expect(await store.secrets.replace("synthetic", Uint8Array.of(1), Uint8Array.of(2))).toBe(true);
  await store.close();
  store = await open(store.name);
  const writes = vi.spyOn(IDBDatabase.prototype, "transaction");
  expect(await store.secrets.replace("synthetic", Uint8Array.of(2), Uint8Array.of(2))).toBe(true);
  expect(await store.secrets.replace("synthetic", Uint8Array.of(1), Uint8Array.of(1))).toBe(false);
  expect(writes.mock.calls.filter((args) => args[1] === "readwrite")).toEqual([]);
});
