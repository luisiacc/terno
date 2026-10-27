import "fake-indexeddb/auto";
import { expect, it } from "vitest";
import { withAccounts } from "@terno/store/conformance";
import { databaseName, TABLES } from "./schema";
import { IdbMailStore } from "./store";

it("upgrades v6 legacy drafts, accepts their old identity, and fences erased legacy IDs from fresh generations", async () => {
  const name = `draft-upgrade-${crypto.randomUUID()}`;
  const platform = { uuid: () => crypto.randomUUID(), yield: async () => {} };
  const source = await IdbMailStore.open({ name: `${name}-source`, factory: indexedDB, platform, instantSearch: false });
  const [accountId] = await withAccounts(source);

  const input = { accountId: accountId!, to: [], cc: [], subject: "exact", bodyText: "keep" };
  const d = (await source.drafts.save(input, 0))!;
  await source.close();
  const sourceDb = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(databaseName(`${name}-source`));
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
  const read = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  const tx = sourceDb.transaction(["accounts", "drafts"], "readonly");
  const [accounts, row] = await Promise.all([read(tx.objectStore("accounts").getAll() as IDBRequest<Record<string, unknown>[]>), read(tx.objectStore("drafts").get(d.id) as IDBRequest<Record<string, unknown>>)]);
  sourceDb.close(); delete row.generation;
  const old = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(databaseName(name), 6);
    r.onupgradeneeded = () => {
      for (const table of TABLES) if (!table.memoryOnly && table.name !== "draft_counter") r.result.createObjectStore(table.name);
      r.result.createObjectStore("meta");
      for (const account of accounts) r.transaction!.objectStore("accounts").put(account, account.id as number);
      r.transaction!.objectStore("drafts").put(row, d.id);
    };
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
  old.close();
  let store = await IdbMailStore.open({ name, factory: indexedDB, platform, instantSearch: false });
  try {
    expect(await store.drafts.save({ ...input, id: d.id, baseRevision: 1 }, 1)).toMatchObject({ id: d.id, generation: "", revision: 2 });
    const fresh = (await store.drafts.save(input, 2))!;
    expect(await store.drafts.save({ ...input, id: fresh.id, baseRevision: 1, bodyText: "delayed legacy" }, 3)).toBeNull();
    await store.drafts.delete(fresh.id); await store.close();
    store = await IdbMailStore.open({ name, factory: indexedDB, platform, instantSearch: false });
    expect((await store.drafts.save(input, 4))!.id).toBeGreaterThan(fresh.id);
  } finally { await store.close(); }
});
