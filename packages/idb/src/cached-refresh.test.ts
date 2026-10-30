import "fake-indexeddb/auto";
import { ingest, msg, withAccounts } from "@terno/store/conformance";
import { generateDataset } from "@terno/mock-data";
import { IdbMailStore } from "./store";
import { Table } from "./mem";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../db/src/index";
import { SqlMailStore } from "../../db/src/sql-store";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0)) await close(); });
it.each(["SQL", "IDB"])("%s seeks 50k cached keys without an account materialization", async (kind) => {
  const dir = mkdtempSync(join(tmpdir(), "terno-cached-page-"));
  const store = kind === "SQL" ? new SqlMailStore(openDatabase(join(dir, "mail.db"))) : await IdbMailStore.open({ name: crypto.randomUUID(), factory: indexedDB, platform: { uuid: () => crypto.randomUUID(), yield: async () => {} }, instantSearch: false });
  cleanup.push(async () => { await store.close(); rmSync(dir, { recursive: true, force: true }); });
  const now = Date.UTC(2026, 9, 22);
  await store.dev.seed(generateDataset({ threads: 50_000, accounts: 1, seed: 4, now }), { now });
  const account = (await store.accounts.list())[0]!;
  const provider = store.providerStore(account.id);
  const legacy = vi.spyOn(provider, "syncedMessages").mockRejectedValue(new Error("unbounded"));
  const by = Table.prototype.by;
  vi.spyOn(Table.prototype, "by").mockImplementation(function (this: Table, index, ...values) {
    if (this.spec.name === "messages") throw new Error("unbounded messages index materialization");
    return by.call(this, index, ...values);
  });
  let sqlCalls = 0;
  if (store instanceof SqlMailStore) {
    const db = store.db, all = db.all.bind(db);
    vi.spyOn(db, "all").mockImplementation((sql, ...params) => {
      expect(sql).toMatch(/ORDER BY provider_msg_id LIMIT 50$/);
      expect(sql).not.toMatch(/OFFSET|SELECT \*/i);
      sqlCalls++; return all(sql, ...params);
    });
    const plan = db.all<{ detail: string }>("EXPLAIN QUERY PLAN SELECT id, provider_msg_id FROM messages WHERE account_id = ? AND provider_msg_id > ? ORDER BY provider_msg_id LIMIT 50", account.id, "");
    expect(plan.map((r) => r.detail).join(" ")).toContain("messages_provider");
  }
  const scanCounts: number[] = [];
  const open = IDBIndex.prototype.openKeyCursor;
  vi.spyOn(IDBIndex.prototype, "openKeyCursor").mockImplementation(function (this: IDBIndex, ...args) {
    const req = open.call(this, ...args), at = scanCounts.length;
    scanCounts.push(0);
    req.addEventListener("success", () => { if (req.result) scanCounts[at] = scanCounts[at]! + 1; });
    return req;
  });
  let after: string | undefined, count = 0, calls = 0;
  do {
    const page = await provider.syncedMessagePage(after);
    calls++;
    expect(page.items.length).toBeLessThanOrEqual(50);
    for (const row of page.items) { expect(Object.keys(row).sort()).toEqual(["id", "providerMsgId"]); expect(row.providerMsgId > (after ?? "")).toBe(true); }
    count += page.items.length;
    if (!page.next) break;
    expect(page.next > (after ?? "")).toBe(true); after = page.next;
  } while (calls < 4000);
  expect(count).toBeGreaterThanOrEqual(50_000);
  expect(calls).toBe(Math.ceil(count / 50) + 1);
  expect(legacy).not.toHaveBeenCalled();
  expect(scanCounts.every((n) => n <= 50)).toBe(true);
  if (kind === "IDB") expect(scanCounts.length).toBe(calls);
  if (kind === "SQL") expect(sqlCalls).toBe(calls + 1);
}, 120_000);

it("IDB advances local-only pages and survives deletion, insertion and reopen", async () => {
  const name = crypto.randomUUID(), platform = { uuid: () => crypto.randomUUID(), yield: async () => {} };
  let store = await IdbMailStore.open({ name, factory: indexedDB, platform, instantSearch: false });
  cleanup.push(async () => { await store.close(); });
  const [account] = await withAccounts(store, 1);
  await ingest(store, Array.from({ length: 50 }, (_, i) => msg({ accountId: account!, providerMsgId: `local:${String(i).padStart(3, "0")}` })));
  await ingest(store, [msg({ accountId: account!, providerMsgId: "z-first" })]);
  const first = await store.providerStore(account!).syncedMessagePage();
  expect(first).toEqual({ items: [], next: "local:049" });
  const second = await store.providerStore(account!).syncedMessagePage(first.next);
  expect(second.items.map((r) => r.providerMsgId)).toEqual(["z-first"]);
  await store.sync.remove(second.items.map((r) => r.id));
  await ingest(store, [msg({ accountId: account!, providerMsgId: "z-last" })]);
  await store.close(); store = await IdbMailStore.open({ name, factory: indexedDB, platform, instantSearch: false });
  expect((await store.providerStore(account!).syncedMessagePage(second.next)).items.map((r) => r.providerMsgId)).toEqual(["z-last"]);
  expect(await store.providerStore(account!).syncedMessagePage("z-last")).toEqual({ items: [], next: undefined });
});

it("upgrades a populated v18 image atomically and reopens the new indexed reader", async () => {
  const { databaseName } = await import("./schema");
  const name = crypto.randomUUID(), legacyName = crypto.randomUUID();
  const platform = { uuid: () => crypto.randomUUID(), yield: async () => {} };
  const request = <T,>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  const source = await IdbMailStore.open({ name, factory: indexedDB, platform, instantSearch: false });
  const [account] = await withAccounts(source, 1);
  await ingest(source, [msg({ accountId: account!, providerMsgId: "local:draft" }), msg({ accountId: account!, providerMsgId: "remote" })]);
  await source.close();
  const raw = await request(indexedDB.open(databaseName(name)));
  const names = Array.from(raw.objectStoreNames);
  const images = await Promise.all(names.map(async (table) => {
    const tx = raw.transaction(table), os = tx.objectStore(table);
    return { table, keys: await request(os.getAllKeys()), rows: await request(os.getAll()), indexes: Array.from(os.indexNames).filter((index) => index !== "cached_provider").map((index) => ({ name: index, keyPath: os.index(index).keyPath!, unique: os.index(index).unique })) };
  }));
  raw.close();
  const old = indexedDB.open(databaseName(legacyName), 18);
  old.onupgradeneeded = () => {
    for (const image of images) {
      const os = old.result.createObjectStore(image.table);
      for (const index of image.indexes) os.createIndex(index.name, index.keyPath, { unique: index.unique });
      image.rows.forEach((row, i) => os.put(row, image.keys[i]));
    }
  };
  (await request(old)).close();
  const create = IDBObjectStore.prototype.createIndex;
  const failure = vi.spyOn(IDBObjectStore.prototype, "createIndex").mockImplementation(function (this: IDBObjectStore, ...args) {
    if (args[0] === "cached_provider") throw new Error("upgrade refused");
    return create.call(this, ...args);
  });
  await expect(IdbMailStore.open({ name: legacyName, factory: indexedDB, platform, instantSearch: false })).rejects.toThrow();
  failure.mockRestore();
  const unchanged = await request(indexedDB.open(databaseName(legacyName)));
  expect(unchanged.version).toBe(18); unchanged.close();
  const upgraded = await IdbMailStore.open({ name: legacyName, factory: indexedDB, platform, instantSearch: false });
  expect((await upgraded.providerStore(account!).syncedMessagePage()).items.map((r) => r.providerMsgId)).toEqual(["remote"]);
  await upgraded.close();
});
