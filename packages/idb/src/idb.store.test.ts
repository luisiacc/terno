import "fake-indexeddb/auto";
import { CategorizerModel } from "@unica/core";
import { generateDataset } from "@unica/mock-data";
import type { Platform } from "@unica/store";
import { ingest, msg, withAccounts } from "@unica/store/conformance";
import { afterEach, describe, expect, it } from "vitest";
import { createMemDb, databaseName, IDB_VERSION, openIdb, TABLES } from "./schema";
import { IdbMailStore } from "./store";

const platform: Pick<Platform, "uuid" | "yield"> = { uuid: () => crypto.randomUUID(), yield: () => new Promise((r) => setTimeout(r, 0)) };
const NOW = Date.UTC(2026, 9, 22, 15, 30);
const opened: IdbMailStore[] = [];
let n = 0;
const open = async (name = `store-${Date.now()}-${++n}`, instantSearch = false) => {
  const s = await IdbMailStore.open({ name, factory: indexedDB, platform, instantSearch });
  opened.push(s);
  return s;
};
afterEach(async () => {
  for (const s of opened.splice(0)) await s.close();
});

describe("bodies the store knows are absent", () => {
  it("setBody(id, null, null) with classification on: the body is known to be gone, nothing throws", async () => {
    const store = await open();
    const [a] = await withAccounts(store);
    await ingest(store, [msg({ accountId: a!, providerMsgId: "b1", bodyState: "partial", bodyText: "hola", date: NOW })], NOW);
    const id = (await store.debug.snapshot()).messages[0]!.id;
    const classifier = { model: new CategorizerModel({ decayRef: NOW }), mode: "auto" as const };
    await expect(store.sync.setBody(id, null, null, { now: NOW, classifier })).resolves.toMatchObject({ touched: expect.any(Array) });
    expect((await store.debug.snapshot()).messages[0]).toMatchObject({ bodyText: null, bodyState: "full" });
  });

  it("knowing a body is absent is part of the transaction: a rollback forgets it", () => {
    const db = createMemDb();
    const bodies = db.table("message_bodies");
    db.tx(() => {
      db.table("accounts").insert({ id: 1 });
      db.table("threads").insert({ id: 1, account_id: 1 });
      db.table("messages").insert({ id: 7, account_id: 1, thread_id: 1 });
    });
    expect(() =>
      db.tx(() => {
        bodies.delete(7);
        expect(bodies.absent.has(7)).toBe(true);
        throw new Error("abort");
      }),
    ).toThrow("abort");
    expect(bodies.absent.has(7)).toBe(false);
  });
});

describe("the body cache", () => {
  it("stays within its count and byte budget whatever loads bodies (threads, the feed, scans)", async () => {
    const store = await open();
    await store.dev.seed(generateDataset({ threads: 1800, accounts: 2, seed: 3, now: NOW, bodyScale: 3 }), { now: NOW });
    const { threads } = await store.debug.snapshot();
    for (const t of threads) await store.threads.get(t.id);
    expect(store.bodyCache().count).toBeLessThanOrEqual(2000);
    const head = await store.feed.head();
    await store.feed.changes({ epoch: head.epoch, seq: 0 }, head, 10_000);
    expect(store.bodyCache().count).toBeLessThanOrEqual(2000);
    expect(store.bodyCache().bytes).toBeLessThanOrEqual(store.bodyCache().budgetBytes);
    await store.threads.searchText({ query: "presupuesto", limit: 50, now: NOW });
    expect(store.bodyCache().count).toBeLessThanOrEqual(2000);
  });
});

describe("the exact scan", () => {
  it("stops when the caller no longer wants the answer (a newer search)", async () => {
    const store = await open();
    await store.dev.seed(generateDataset({ threads: 2000, accounts: 2, seed: 5, now: NOW }), { now: NOW });
    const abort = new AbortController();
    const search = store.threads.searchText({ query: "presupuesto zzqxjv", limit: 50, now: NOW, signal: abort.signal });
    setTimeout(() => abort.abort(), 1);
    await expect(search).rejects.toMatchObject({ name: "SearchCancelledError" });
    // the next search answers
    expect((await store.threads.searchText({ query: "zzqxjv", limit: 50, now: NOW })).items).toEqual([]);
  });
});

describe("right after a reopen", () => {
  it("sender, domain and list scopes wait for the late tables instead of answering empty", async () => {
    const name = `scopes-${Date.now()}`;
    let store = await open(name);
    const data = generateDataset({ threads: 300, accounts: 2, seed: 9, now: NOW });
    const seeded = await store.dev.seed(data, { now: NOW });
    const sender = data.messages.find((m) => !m.isSent)!.from.email;
    const before = await store.categorize.countScope(seeded.categoryIds[0]!, { kind: "sender", email: sender }, NOW);
    expect(before.count).toBeGreaterThan(0);
    await store.close();
    store = await open(name);
    expect(await store.categorize.countScope(seeded.categoryIds[0]!, { kind: "sender", email: sender }, NOW)).toEqual(before);
  });
});

describe("IndexedDB version 2 (SQL v8)", () => {
  it("re-keys a version-1 database's journaled move rows by category, from the old move's single source", async () => {
    const name = `upgrade-${Date.now()}`;
    const req = (r: IDBRequest | IDBOpenDBRequest) => new Promise((resolve, reject) => ((r.onsuccess = () => resolve(r.result)), (r.onerror = () => reject(r.error))));
    // version 1 as the previous adapter left it: out-of-line keys, [batch, thread] for move rows
    const v1 = indexedDB.open(databaseName(name), 1);
    v1.onupgradeneeded = () => {
      for (const t of TABLES.filter((t) => !t.memoryOnly)) v1.result.createObjectStore(t.name);
      v1.result.createObjectStore("meta");
      const tx = v1.transaction!;
      tx.objectStore("cat_batches").put({ id: 5, category_id: 2, source: "dnd", scope_json: JSON.stringify({ kind: "move", from: 1, phase: "done" }), added: 1, created_at: 0, undone_at: null }, 5);
      tx.objectStore("cat_move_rows").put({ batch_id: 5, thread_id: 9, added_by: "user", added_at: 10, prev_batch_id: null }, [5, 9]);
    };
    const old = (await req(v1)) as IDBDatabase;
    old.close();
    const db = await openIdb(indexedDB, name);
    expect(db.version).toBe(IDB_VERSION);
    const tx = db.transaction("cat_move_rows");
    const [keys, rows] = await Promise.all([req(tx.objectStore("cat_move_rows").getAllKeys()), req(tx.objectStore("cat_move_rows").getAll())]);
    expect(keys).toEqual([[5, 9, 1]]);
    expect(rows).toEqual([{ batch_id: 5, thread_id: 9, category_id: 1, added_by: "user", added_at: 10, prev_batch_id: null }]);
    db.close();
  });
});
