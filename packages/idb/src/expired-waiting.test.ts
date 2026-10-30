import "fake-indexeddb/auto";
import { waitingCutoff } from "@terno/core";
import type { ListParams } from "@terno/store";
import { ingest, msg, withAccounts } from "@terno/store/conformance";
import { afterEach, expect, it, vi } from "vitest";
import type { Ctx } from "./mail";
import { IdbMailStore } from "./store";

const now = Date.UTC(2026, 9, 22);
const cutoff = waitingCutoff(now);
const opened: IdbMailStore[] = [];
const open = async (name: string = crypto.randomUUID()) => {
  const store = await IdbMailStore.open({ name, factory: indexedDB, platform: { uuid: () => crypto.randomUUID(), yield: async () => {} }, instantSearch: false });
  opened.push(store);
  return store;
};
afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of opened.splice(0)) if (store.isOpen) await store.close();
});
const context = (store: IdbMailStore) => (store as unknown as { c: Ctx }).c;
async function fixture() {
  const store = await open();
  const [accountId, other] = await withAccounts(store);
  for (const id of [accountId!, other!]) await store.folders.replace(id, [{ key: "Label_a", path: ["A"], selectable: true }]);
  await ingest(store, Array.from({ length: 64 }, (_, i) => msg({ accountId: accountId!, date: cutoff - 1 - Math.floor(i / 2), gmailLabels: ["Label_a"], isRead: true })), now);
  const c = context(store);
  const ids = (await store.threads.list({ view: "all", accountId, folder: "Label_a", limit: 100, now })).items.map((t) => t.id);
  return { store, c, ids, p: { view: "all", accountId, folder: "Label_a", filter: "waiting", now, limit: 10 } satisfies ListParams };
}

it.each([false, true])("expired Waiting uses dated keys without thread, membership or IDB reads (cursor=%s)", async (cursor) => {
  const { store, c, ids, p } = await fixture();
  const gets = vi.spyOn(c.db.table("threads"), "get");
  const keys = vi.spyOn(c.db.table("thread_folders"), "keysBy");
  const by = vi.spyOn(c.db.table("thread_folders"), "by");
  const transactions = vi.spyOn(IDBDatabase.prototype, "transaction");
  const page = await store.threads.list({ ...p, ...(cursor ? { cursor: { lastDate: cutoff - 10, id: ids[20]! } } : {}) });
  expect(page).toEqual({ items: [], nextCursor: null });
  expect({ threadGets: gets.mock.calls.length, membershipKeys: keys.mock.calls.length, membershipRows: by.mock.calls.length, transactions: transactions.mock.calls.length }).toEqual({ threadGets: 0, membershipKeys: 0, membershipRows: 0, transactions: 0 });
});

it("kept expired rows still obey membership, account, view and cursor; changes invalidate dated keys", async () => {
  const { store, c, ids, p } = await fixture();
  const id = ids[0]!;
  expect((await store.threads.list({ ...p, keepIds: [id, id] })).items.map((t) => t.id)).toEqual([id]);
  expect((await store.threads.list({ ...p, keepIds: [id], cursor: { lastDate: cutoff - 2, id } })).items).toEqual([]);
  expect((await store.threads.list({ ...p, accountId: (await store.accounts.list())[1]!.id, keepIds: [id] })).items).toEqual([]);
  expect((await store.threads.list({ ...p, folder: "Label_missing", keepIds: [id] })).items).toEqual([]);
  await store.threads.act({ threadIds: [id], action: "star", signal: null, now });
  expect((await store.threads.list({ ...p, view: "starred", keepIds: [id] })).items.map((t) => t.id)).toEqual([id]);
  expect((await store.threads.list({ ...p, filter: "unread", keepIds: [] })).items).toEqual([]);
  const threads = c.db.table("threads");
  const memberships = c.db.table("thread_folders");
  c.db.tx(() => {
    threads.update(threads.get(id)!, { last_date: cutoff, waiting_since: cutoff });
    memberships.update(memberships.get(id, "Label_a")!, { last_date: cutoff });
  });
  expect((await store.threads.list(p)).items.map((t) => t.id)).toEqual([id]);
  expect((await store.threads.list({ ...p, now: now + 1 })).items).toEqual([]);
  await store.threads.act({ threadIds: [id], action: "trash", signal: null, now });
  expect((await store.threads.list({ ...p, keepIds: [id] })).items).toEqual([]);
  await store.close();
  await expect(store.threads.list(p)).rejects.toThrow("closed");
  const reopened = await open(store.name);
  expect((await reopened.threads.list({ ...p, keepIds: [id] })).items).toEqual([]);
});

it("dated cursor seeks preserve ties, Waiting predicates and order across membership removal and rollback", async () => {
  const { store, c, ids, p } = await fixture();
  const threads = c.db.table("threads");
  const memberships = c.db.table("thread_folders");
  const selected = ids.slice(0, 5).sort((a, b) => b - a);
  c.db.tx(() => {
    for (const id of selected) {
      threads.update(threads.get(id)!, { last_date: cutoff, waiting_since: cutoff });
      memberships.update(memberships.get(id, "Label_a")!, { last_date: cutoff });
    }
    threads.update(threads.get(selected[1]!)!, { waiting_since: cutoff - 1 });
    threads.update(threads.get(selected[2]!)!, { waiting_since: null });
  });
  const expected = selected.filter((_, i) => i !== 1 && i !== 2);
  const gets = vi.spyOn(threads, "get");
  const first = await store.threads.list({ ...p, limit: 1 });
  expect(gets.mock.calls.length).toBeGreaterThan(0);
  expect(first.items.map((t) => t.id)).toEqual(expected.slice(0, 1));
  expect((await store.threads.list({ ...p, cursor: first.nextCursor!, limit: 10 })).items.map((t) => t.id)).toEqual(expected.slice(1));
  expect(() => c.db.tx(() => {
    threads.update(threads.get(expected[0]!)!, { last_date: cutoff - 100, waiting_since: cutoff - 100 });
    memberships.update(memberships.get(expected[0]!, "Label_a")!, { last_date: cutoff - 100 });
    throw new Error("rollback");
  })).toThrow("rollback");
  expect((await store.threads.list(p)).items.map((t) => t.id)).toEqual(expected);
  c.db.tx(() => memberships.delete(expected[0]!, "Label_a"));
  expect((await store.threads.list({ ...p, cursor: first.nextCursor! })).items.map((t) => t.id)).toEqual(expected.slice(1));
  expect((await store.threads.list({ ...p, keepIds: [expected[0]!] })).items.map((t) => t.id)).toEqual(expected.slice(1));
});

it.each([undefined, "unread"] as const)("shared dated seek keeps ordinary and %s pages exact after read changes", async (filter) => {
  const { store, ids, p } = await fixture();
  if (filter) await store.threads.act({ threadIds: ids, action: "markUnread", signal: null, now });
  const query = { ...p, filter, limit: 1 };
  const first = await store.threads.list(query);
  expect(first.items.map((t) => t.id)).toEqual(ids.slice(0, 1));
  expect(first.nextCursor).toEqual({ lastDate: cutoff - 1, id: ids[0] });
  const second = await store.threads.list({ ...query, cursor: first.nextCursor! });
  expect(second.items.map((t) => t.id)).toEqual(ids.slice(1, 2));
  if (filter) {
    await store.threads.act({ threadIds: [ids[1]!], action: "markRead", signal: null, now });
    expect((await store.threads.list({ ...query, cursor: first.nextCursor! })).items.map((t) => t.id)).toEqual(ids.slice(2, 3));
  }
});

it("reopening an expired folder rebuilds its order and preserves kept identity", async () => {
  const { store, ids, p } = await fixture();
  await store.close();
  const reopened = await open(store.name);
  expect(await reopened.threads.list(p)).toEqual({ items: [], nextCursor: null });
  expect((await reopened.threads.list({ ...p, keepIds: [ids[0]!] })).items.map((t) => t.id)).toEqual(ids.slice(0, 1));
});
