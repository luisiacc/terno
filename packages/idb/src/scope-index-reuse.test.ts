import "fake-indexeddb/auto";
import { ingest, msg, withAccounts } from "@terno/store/conformance";
import type { ListFilter } from "@terno/core";
import { afterEach, expect, it, vi } from "vitest";
import { IdbMailStore } from "./store";
import type { Ctx } from "./mail";

const opened: IdbMailStore[] = [];
const open = async (name: string = crypto.randomUUID()) => {
  const store = await IdbMailStore.open({ name, factory: indexedDB, instantSearch: false, platform: { uuid: () => crypto.randomUUID(), yield: async () => {} } });
  await store.whenLoaded();
  opened.push(store);
  return store;
};
afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of opened) if (store.isOpen) await store.close();
  opened.length = 0;
});
const context = (store: IdbMailStore) => (store as unknown as { c: Ctx }).c;
const columns: Partial<Record<ListFilter, string>> = { unread: "unread_count", people: "person", attachments: "has_attachments", starred: "is_starred" };

it.each(["unread", "people", "attachments", "starred"] as const)("%s first scope refreshes a ready order's pending memberships without a table scan", async (filter) => {
  const store = await open();
  const c = context(store);
  const threads = c.db.table("threads");
  const column = columns[filter]!;
  for (let id = 1; id <= 192; id++) threads.load({ id, last_date: id, [column]: id <= 96 ? 1 : 0, in_trash: 0, in_spam: 0 });
  const order = c.filterOrders[filter];
  const initial = [...order.current(threads)];
  expect(initial).toEqual(Array.from({ length: 96 }, (_, i) => 96 - i));
  c.db.tx(() => {
    for (const id of [1, 2, 3, 4]) threads.update(threads.get(id)!, { [column]: 0 });
    for (const id of [97, 98, 99, 100]) threads.update(threads.get(id)!, { [column]: 1 });
    threads.update(threads.get(5)!, { last_date: 1000 });
  });
  expect(order.ready).toBe(true);
  const { ScopeIndex } = await import("./mail");
  const fresh = new ScopeIndex(c.db);
  const current = vi.spyOn(order, "current");
  const scan = vi.spyOn(threads, "all");
  const gets = vi.spyOn(threads, "get");
  expect(fresh.matching(c, filter)).toEqual(Array.from({ length: 96 }, (_, i) => i + 5));
  expect(current).toHaveBeenCalledExactlyOnceWith(threads);
  expect(scan).not.toHaveBeenCalled();
  expect(gets.mock.calls.length).toBeGreaterThan(0);
  expect(gets.mock.calls.length).toBeLessThanOrEqual(64);
});

it.each(["unread", "people", "attachments", "starred"] as const)("%s scope reuses a refreshed list index after dense, empty and sparse crossings", async (filter) => {
  const store = await open();
  const [account, other] = await withAccounts(store);
  const c = context(store);
  const threads = c.db.table("threads");
  for (let i = 192; i > 0; i--) threads.load({ id: i, account_id: i % 2 ? account : other, last_date: Math.floor(i / 2), unread_count: 0, person: 0, has_attachments: 0, is_starred: 0, in_inbox: 1, in_trash: 0, in_spam: 0, message_count: 1 });
  const column = columns[filter]!;
  const p = { view: "all" as const, filter, limit: 1000 };
  await store.threads.scopeIds(p);
  for (const mode of ["dense", "empty", "sparse"] as const) {
    c.db.tx(() => {
      for (const row of threads.all()) threads.update(row, { [column]: mode === "dense" || (mode === "sparse" && row.id === 191) ? 1 : 0 });
    });
    const page = await store.threads.list(p);
    const expected = mode === "dense" ? Array.from({ length: 192 }, (_, i) => i + 1) : mode === "sparse" ? [191] : [];
    expect(page.items.map(t => t.id).sort((a, b) => a - b)).toEqual(expected);
    const scan = vi.spyOn(threads, "all");
    expect(await store.threads.scopeCount(p)).toBe(expected.length);
    expect(await store.threads.scopeIds({ ...p, after: 190, limit: 1 })).toEqual(expected.filter(id => id > 190).slice(0, 1));
    expect(await store.threads.scopeIds({ ...p, accountId: account })).toEqual(expected.filter(id => id % 2));
    expect(scan).not.toHaveBeenCalled();
    scan.mockRestore();
  }
  // A small pending change must be applied even though the date index reports ready.
  c.db.tx(() => threads.update(threads.get(189)!, { [column]: 1, last_date: 999 }));
  expect(await store.threads.scopeIds(p)).toEqual([189, 191]);
  expect(() => c.db.tx(() => {
    threads.update(threads.get(191)!, { [column]: 0 });
    throw new Error("rollback");
  })).toThrow("rollback");
  expect(await store.threads.scopeIds(p)).toEqual([189, 191]);
});

it("cold and reopened scopes preserve hidden Inbox, account, category and ascending pagination predicates", async () => {
  let store = await open();
  const [account, other] = await withAccounts(store);
  await ingest(store, Array.from({ length: 96 }, (_, i) => msg({ accountId: i % 2 ? account! : other!, providerMsgId: `scope-${i}`, providerThreadId: `scope-thread-${i}`, isStarred: true, date: 100 })));
  const all = await store.threads.scopeIds({ view: "all", filter: "starred", limit: 1000 });
  expect(all).toHaveLength(96); // scope first: no ready date index
  const category = await store.categories.create("Hidden", "indigo");
  await store.categories.add({ threadIds: all.slice(0, 70), categoryId: category.id, addedBy: "user", now: 1 });
  await store.categories.update(category.id, { showInInbox: false });
  for (let phase = 0; phase < 2; phase++) {
    const p = { view: "inbox" as const, filter: "starred" as const, limit: 1000 };
    await store.threads.list(p);
    expect(await store.threads.scopeIds(p)).toEqual(all.slice(70));
    expect(await store.threads.scopeIds({ ...p, categoryId: category.id })).toEqual(all.slice(0, 70));
    const own = (await store.threads.list({ ...p, view: "all", accountId: account })).items.map(t => t.id).sort((a, b) => a - b);
    expect(await store.threads.scopeIds({ ...p, view: "all", accountId: account })).toEqual(own);
    const expected = all.slice(70).reverse();
    const checkPages = async () => {
      const first = await store.threads.list({ ...p, limit: 5 });
      expect(first.items.map(t => t.id)).toEqual(expected.slice(0, 5));
      expect(first.nextCursor).not.toBeNull();
      const next = await store.threads.list({ ...p, cursor: first.nextCursor!, limit: 5 });
      expect(next.items.map(t => t.id)).toEqual(expected.slice(5, 10));
      return { first, next };
    };
    const pages = await checkPages();
    const { ScopeIndex } = await import("./mail");
    expect(new ScopeIndex(context(store).db).matching(context(store), "starred")).toEqual(all);
    expect(await checkPages()).toEqual(pages);
    await store.categories.update(category.id, { showInInbox: true });
    expect(await store.threads.scopeIds(p)).toEqual(all);
    await store.categories.update(category.id, { showInInbox: false });
    const name = store.name;
    await store.close();
    if (!phase) store = await open(name);
  }
});

it("scope construction uses a ready global order at 50k, and leaves an unready date order alone", async () => {
  const store = await open();
  const c = context(store);
  const threads = c.db.table("threads");
  for (let id = 1; id <= 50_000; id++) threads.load({ id, last_date: (id * 7919) % 50_000, is_starred: 1, in_trash: 0, in_spam: 0 });
  c.filterOrders.starred.current(threads);
  const scan = vi.spyOn(threads, "all");
  const gets = vi.spyOn(threads, "get");
  const ids = c.scopes.matching(c, "starred");
  expect(ids).toEqual(Array.from({ length: 50_000 }, (_, i) => i + 1));
  expect(scan).not.toHaveBeenCalled();
  expect(gets.mock.calls.length).toBeLessThanOrEqual(64);
  scan.mockRestore();
  gets.mockRestore();
  // A new ascending index with a built but unready date order uses the original fallback.
  const { ScopeIndex } = await import("./mail");
  const fresh = new ScopeIndex(c.db);
  c.db.tx(() => {
    for (let id = 1; id <= 65; id++) threads.update(threads.get(id)!, { last_date: 99999 + id });
  });
  expect(c.filterOrders.starred.ready).toBe(false);
  const current = vi.spyOn(c.filterOrders.starred, "current");
  expect(fresh.matching(c, "starred")).toEqual(ids);
  expect(current).not.toHaveBeenCalled();
  current.mockRestore();
  // Exactly 64 crossings retain the incremental scope path.
  c.db.tx(() => {
    for (let id = 1; id <= 64; id++) threads.update(threads.get(id)!, { is_starred: 0 });
  });
  const incremental = vi.spyOn(threads, "all");
  expect(fresh.matching(c, "starred")).toEqual(ids.slice(64));
  expect(incremental).not.toHaveBeenCalled();
});

it("a failed durable bulk change preserves both warm indexes immediately and after reopen", async () => {
  let store = await open();
  const [account] = await withAccounts(store, 1);
  await ingest(store, Array.from({ length: 96 }, (_, i) => msg({ accountId: account!, providerMsgId: `failure-${i}`, providerThreadId: `failure-thread-${i}`, isStarred: true, date: i })));
  const p = { view: "all" as const, filter: "starred" as const, limit: 1000 };
  const before = await store.threads.list(p);
  const ids = await store.threads.scopeIds(p);
  const put = IDBObjectStore.prototype.put;
  const fail = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
    if (this.name === "threads") throw new Error("synthetic enqueue failure");
    return put.call(this, ...args);
  });
  await expect(store.threads.act({ threadIds: ids, action: "unstar", signal: null, now: 1 })).rejects.toThrow("synthetic enqueue failure");
  fail.mockRestore();
  expect(await store.threads.list(p)).toEqual(before);
  expect(await store.threads.scopeIds(p)).toEqual(ids);
  const name = store.name;
  await store.close();
  store = await open(name);
  expect(await store.threads.list(p)).toEqual(before);
  expect(await store.threads.scopeIds(p)).toEqual(ids);
});
