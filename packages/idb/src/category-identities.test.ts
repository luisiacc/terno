import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, expect, it, vi } from "vitest";
import { createMemDb, databaseName } from "./schema";
import { createCategory } from "./mail";
import { IdbMailStore } from "./store";

const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setImmediate(resolve)) };
const stores = new Set<IdbMailStore>();
afterEach(async () => { vi.restoreAllMocks(); for (const s of stores) await s.close(); stores.clear(); });
async function setup() {
  const factory = new IDBFactory(), name = crypto.randomUUID();
  const open = async () => { const store = await IdbMailStore.open({ name, factory, platform, instantSearch: false }); stores.add(store); return store; };
  return { factory, name, open, close: async (store: IdbMailStore) => { await store.close(); stores.delete(store); } };
}
const rule = (categoryId: number) => ({ match: "all" as const, conditions: [{ field: "subject" as const, op: "contains" as const, value: "Synthetic" }], actions: [{ type: "addCategory" as const, categoryId }] });
const request = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

it("preserves default and explicit Inbox visibility while allocating stable IDs", async () => {
  const t = await setup(); let s = await t.open();
  const shown = await s.categories.create("Shown", "amber");
  const hidden = await s.categories.create("Hidden", "amber", { showInInbox: false });
  expect(shown.showInInbox).toBe(true); expect(hidden.showInInbox).toBe(false);
  await t.close(s); s = await t.open(); expect(await s.categories.list()).toEqual([shown, hidden]);
});

it("never reuses highest or all deleted category IDs across repeated reopen", async () => {
  const t = await setup(); let s = await t.open(); let previous = 0;
  for (let round = 0; round < 3; round++) {
    const a = await s.categories.create("A", "amber"), b = await s.categories.create("B", "amber");
    expect(a.id).toBeGreaterThan(previous); expect(b.id).toBeGreaterThan(a.id);
    await s.categories.delete(b.id); await t.close(s); s = await t.open();
    const c = await s.categories.create("B", "amber"); expect(c.id).toBeGreaterThan(b.id);
    for (const category of await s.categories.list()) await s.categories.delete(category.id);
    previous = c.id; await t.close(s); s = await t.open();
  }
});

it("reserves nonexistent saved action IDs and edited rules even when later erased", async () => {
  const t = await setup(); let s = await t.open();
  const f = await s.filters.save({ name: "stale", enabled: true, source: "manual", rule: rule(50) }, 0);
  expect((await s.categories.create("New", "amber")).id).toBeGreaterThan(50);
  await s.filters.save({ ...f, rule: rule(90) }, 1); await s.filters.delete(f.id);
  await t.close(s); s = await t.open(); expect((await s.categories.create("Next", "amber")).id).toBeGreaterThan(90);
});

it("rolls back allocation after an actual persistence abort, and retains a committed lost-response ID", async () => {
  const t = await setup(); let s = await t.open();
  const a = await s.categories.create("Before", "amber");
  const transaction = IDBDatabase.prototype.transaction;
  let targeted = false, aborted = false;
  const spy = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args) {
    const tx = transaction.call(this, ...args);
    if (!targeted && tx.mode === "readwrite" && tx.objectStoreNames.contains("categories")) {
      targeted = true; tx.addEventListener("abort", () => { aborted = true; }); queueMicrotask(() => tx.abort());
    }
    return tx;
  });
  await expect(s.categories.create("Never published", "amber")).rejects.toBeDefined(); spy.mockRestore();
  expect(targeted).toBe(true); expect(aborted).toBe(true);
  expect(await s.categories.list()).toEqual([a]);
  await t.close(s); s = await t.open();
  const committed = await s.categories.create("Committed", "amber"); expect(committed.id).toBe(a.id + 1);
  const lost = new Error("lost response");
  await expect(Promise.resolve(committed).then(() => { throw lost; })).rejects.toBe(lost);
  await t.close(s); s = await t.open(); expect(await s.categories.list()).toEqual([a, committed]);
  await s.categories.delete(committed.id); await t.close(s); s = await t.open();
  expect((await s.categories.create("After", "amber")).id).toBeGreaterThan(committed.id);
});

it("does not reserve a target when an update names a filter that does not exist", async () => {
  const t = await setup(); const s = await t.open();
  expect(await s.filters.save({ id: 999, name: "Missing", enabled: true, source: "manual", rule: rule(Number.MAX_SAFE_INTEGER) }, 0)).toBeNull();
  expect((await s.categories.create("Usable", "amber")).id).toBe(1);
});

it("refuses exhausted safe-integer IDs without inserting a category", async () => {
  const t = await setup(); const s = await t.open();
  await s.filters.save({ name: "safe bound", enabled: true, source: "manual", rule: rule(Number.MAX_SAFE_INTEGER) }, 0);
  await expect(s.categories.create("Unsafe", "amber")).rejects.toBeDefined(); expect(await s.categories.list()).toEqual([]);
});

it("honors explicit in-memory loaded IDs without narrowing the allocation ceiling", () => {
  const db = createMemDb();
  db.table("categories").load({ id: 150, name: "Loaded", color: "amber", position: 0 });
  const c = { db, uuid: platform.uuid } as Parameters<typeof createCategory>[0];
  const made = db.tx(() => createCategory(c, "Next", "amber")); expect(made.id).toBeGreaterThan(150);
});

it.each(["filter", "pending", "moveSource", "moveRow"] as const)("upgrades a v19 image atomically and reserves legacy %s references above live categories", async (highest) => {
  const ids = { filter: 90, pending: 110, moveSource: 120, moveRow: 130 }; ids[highest] = 200;
  const t = await setup(); let s = await t.open();
  const survivor = await s.categories.create("Survivor", "amber");
  const f = await s.filters.save({ name: "legacy", enabled: true, source: "manual", rule: rule(ids.filter) }, 0);
  await s.settings.set("import:pending", { filters: [{ rule: rule(ids.pending) }] });
  await t.close(s);
  const source = await request(t.factory.open(databaseName(t.name)));
  const names = [...source.objectStoreNames].filter((name) => name !== "category_counter");
  const tx = source.transaction(names);
  const image = await Promise.all(names.map(async (name) => {
    const table = tx.objectStore(name);
    return { name, keys: await request(table.getAllKeys()), values: await request(table.getAll()), indexes: [...table.indexNames].map((key) => ({ name: key, keyPath: table.index(key).keyPath, unique: table.index(key).unique, multiEntry: table.index(key).multiEntry })) };
  }));
  source.close();
  const meta = image.find((table) => table.name === "meta")!;
  meta.values[meta.keys.indexOf("logicalSchema")] = 30;
  image.find((table) => table.name === "cat_batches")!.keys.push(1);
  image.find((table) => table.name === "cat_batches")!.values.push({ id: 1, category_id: survivor.id, source: "dnd", scope_json: JSON.stringify({ kind: "move", from: ids.moveSource }), created_at: 0, added: 0 });
  image.find((table) => table.name === "cat_move_rows")!.keys.push([1, 9, ids.moveRow]);
  image.find((table) => table.name === "cat_move_rows")!.values.push({ batch_id: 1, thread_id: 9, category_id: ids.moveRow, added_by: "user", added_at: 0 });
  const legacyName = `${t.name}-legacy`;
  const make = t.factory.open(databaseName(legacyName), 19);
  make.onupgradeneeded = () => {
    for (const table of image) {
      const out = make.result.createObjectStore(table.name);
      for (const ix of table.indexes) out.createIndex(ix.name, ix.keyPath!, ix);
      table.keys.forEach((key, i) => out.put(table.values[i], key));
    }
  };
  (await request(make)).close();
  const put = IDBObjectStore.prototype.put;
  const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
    if (this.name === "category_counter") throw new Error("interrupted upgrade");
    return put.call(this, ...args);
  });
  const failed = await IdbMailStore.open({ name: legacyName, factory: t.factory, platform, instantSearch: false }).then((opened) => { stores.add(opened); return null; }, (error: unknown) => error);
  expect(failed).not.toBeNull(); spy.mockRestore();
  const unchanged = await request(t.factory.open(databaseName(legacyName), 19));
  expect(unchanged.objectStoreNames.contains("category_counter")).toBe(false); unchanged.close();
  s = await IdbMailStore.open({ name: legacyName, factory: t.factory, platform, instantSearch: false }); stores.add(s);
  expect(await s.categories.list()).toEqual([survivor]); expect(await s.filters.list()).toEqual([f]);
  expect((await s.categories.create("After upgrade", "amber")).id).toBeGreaterThan(200);
});
