import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import { generateDataset } from "@terno/mock-data";
import { IdbMailStore } from "../store";
import { databaseName } from "../schema";

it("50k cached refresh allocates bounded traversal iterators per real cursor request", async () => {
  const now = Date.UTC(2026, 9, 22, 15, 30);
  const store = await IdbMailStore.open({ name: crypto.randomUUID(), factory: indexedDB, instantSearch: false,
    platform: { uuid: () => crypto.randomUUID(), yield: async () => {} } });
  let db: IDBDatabase | undefined;
  try {
    const seeded = await store.dev.seed(generateDataset({ threads: 28_400, accounts: 8, seed: 42, now, bodyScale: 2 }), { now });
    db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open(databaseName(store.name));
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const index = db.transaction("messages").objectStore("messages").index("cached_provider");
    const tree = (index as unknown as { _rawIndex: { records: { records: {
      _findRecords(...args: unknown[]): IterableIterator<unknown>;
    } } } })._rawIndex.records.records;
    const original = tree._findRecords;
    let iterators = 0, pages = 0;
    const ids = new Set<number>();
    const accounts = await store.accounts.list();
    // Each call creates an actual generator object; delegate without consuming or replacing it.
    const spy = vi.spyOn(tree, "_findRecords").mockImplementation(function (...args) {
      iterators++;
      return original.apply(tree, args);
    });
    try {
      for (const account of accounts) {
        let after: string | undefined;
        while (true) {
          const page = await store.providerStore(account.id).syncedMessagePage(after);
          pages++;
          expect(page.items.length).toBeLessThanOrEqual(50);
          for (const item of page.items) { expect(ids.has(item.id)).toBe(false); ids.add(item.id); }
          if (!page.next) break;
          after = page.next;
        }
      }
    } finally { spy.mockRestore(); }
    expect(ids.size).toBe(seeded.messageCount);
    expect(ids.size).toBeGreaterThanOrEqual(50_000);
    console.log({ messages: ids.size, pages, iterators });
    expect(iterators).toBeLessThanOrEqual(4 * (ids.size + pages));
  } finally { db?.close(); await store.close(); }
}, 60_000);
