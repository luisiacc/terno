import "fake-indexeddb/auto";
import { CategorizerModel } from "@terno/core";
import { generateDataset } from "@terno/mock-data";
import type { Platform } from "@terno/store";
import { ingest, msg, withAccounts } from "@terno/store/conformance";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemDb, databaseName, IDB_VERSION, openIdb } from "./schema";
import { IdbMailStore } from "./store";
import { legacyImage, legacyStores } from "./test/legacy-stores";

const platform: Pick<Platform, "uuid" | "yield"> = { uuid: () => crypto.randomUUID(), yield: () => new Promise((r) => setTimeout(r, 0)) };
const NOW = Date.UTC(2026, 9, 22, 15, 30);
const opened: IdbMailStore[] = [];
const raw: IDBDatabase[] = [];
let n = 0;
const open = async (name = `store-${Date.now()}-${++n}`, instantSearch = false) => {
  const s = await IdbMailStore.open({ name, factory: indexedDB, platform, instantSearch });
  opened.push(s);
  return s;
};
afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of raw.splice(0)) db.close();
  for (const s of opened.splice(0)) await s.close();
});

it("an aborted send-completion transaction restores running state and its unknown outcome survives reopen", async () => {
  const store = await open();
  const [accountId] = await withAccounts(store);
  const send = await store.compose.queueSend({ accountId: accountId!, to: [{ name: "", email: "receiver@example.com" }], cc: [], bcc: [], subject: "once", bodyText: "hello", recordReply: false, now: NOW });
  await store.ops.claimReady(NOW, 20);
  const transaction = IDBDatabase.prototype.transaction;
  let abort = true;
  vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args) {
    const tx = transaction.call(this, ...args);
    if (abort && args[1] === "readwrite") {
      abort = false;
      queueMicrotask(() => tx.abort());
    }
    return tx;
  });
  await expect(store.ops.complete(send.opId, { providerMsgId: "accepted" }, NOW + 1)).rejects.toThrow();
  expect((await store.ops.get(send.opId))?.state).toBe("running");
  await store.ops.markUnknown(send.opId, "completion failed", NOW + 2);
  await store.close();
  const reopened = await open(store.name);
  expect((await reopened.ops.get(send.opId))?.state).toBe("unknown");
  expect(await reopened.ops.claimReady(NOW + 3_600_000, 20)).toEqual([]);
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
      for (const table of legacyStores(1)) v1.result.createObjectStore(table);
      v1.result.createObjectStore("meta");
      const tx = v1.transaction!;
      tx.objectStore("cat_batches").put({ id: 5, category_id: 2, source: "dnd", scope_json: JSON.stringify({ kind: "move", from: 1, phase: "done" }), added: 1, created_at: 0, undone_at: null }, 5);
      tx.objectStore("cat_move_rows").put({ batch_id: 5, thread_id: 9, added_by: "user", added_at: 10, prev_batch_id: null }, [5, 9]);
    };
    const old = (await req(v1)) as IDBDatabase;
    old.close();
    const db = await openIdb(indexedDB, name);
    raw.push(db);
    expect(db.version).toBe(IDB_VERSION);
    const tx = db.transaction("cat_move_rows");
    const [keys, rows] = await Promise.all([req(tx.objectStore("cat_move_rows").getAllKeys()), req(tx.objectStore("cat_move_rows").getAll())]);
    expect(keys).toEqual([[5, 9, 1]]);
    expect(rows).toEqual([{ batch_id: 5, thread_id: 9, category_id: 1, added_by: "user", added_at: 10, prev_batch_id: null }]);
    db.close();
  });
});

describe("IndexedDB version 3 (SQL v9): drafts v2", () => {
  for (const from of [1, 2] as const) {
    it(`upgrades a version-${from} database's drafts to format 1 with their conversation`, async () => {
      const name = `drafts-v${from}-${Date.now()}`;
      const req = (r: IDBRequest | IDBOpenDBRequest) => new Promise((resolve, reject) => ((r.onsuccess = () => resolve(r.result)), (r.onerror = () => reject(r.error))));
      const old = indexedDB.open(databaseName(name), from);
      old.onupgradeneeded = () => {
        for (const table of legacyStores(from)) old.result.createObjectStore(table);
        old.result.createObjectStore("meta");
        const tx = old.transaction!;
        tx.objectStore("messages").put({ id: 40, thread_id: 7, account_id: 1 }, 40);
        tx.objectStore("drafts").put({ id: 1, account_id: 1, to_json: "[]", cc_json: "[]", subject: "Re: x", body_text: "Sí.\n> hola", in_reply_to_message_id: 40, updated_at: 5 }, 1);
        tx.objectStore("drafts").put({ id: 2, account_id: 1, to_json: "[]", cc_json: "[]", subject: "Nuevo", body_text: "texto", in_reply_to_message_id: null, updated_at: 6 }, 2);
      };
      ((await req(old)) as IDBDatabase).close();
      const db = await openIdb(indexedDB, name);
    raw.push(db);
      expect(db.version).toBe(IDB_VERSION);
      const rows = (await req(db.transaction("drafts").objectStore("drafts").getAll())) as Record<string, unknown>[];
      expect(rows.map((r) => ({ id: r.id, format: r.format, mode: r.mode, thread_id: r.thread_id, body_text: r.body_text, quoted_text: r.quoted_text, include_quote: r.include_quote, revision: r.revision }))).toEqual([
        { id: 1, format: 1, mode: "reply", thread_id: 7, body_text: "Sí.\n> hola", quoted_text: "", include_quote: 0, revision: 1 },
        { id: 2, format: 1, mode: "new", thread_id: null, body_text: "texto", quoted_text: "", include_quote: 0, revision: 1 },
      ]);
      db.close();
    });
  }
});

describe("an undo of a version-1 move left half-restored", () => {
  it("finishes after the upgrade: the legacy source counts as touched, the journal replaces what is there", async () => {
    const name = `legacy-restore-${Date.now()}`;
    const req = (r: IDBRequest | IDBOpenDBRequest) => new Promise((resolve, reject) => ((r.onsuccess = () => resolve(r.result)), (r.onerror = () => reject(r.error))));
    const ex = (t: number, cat: number, label: number, source: string) => ({ thread_id: t, category_id: cat, label, weight: 1, source, at: 1, sender: "s", content: 1, batch_id: null, features: new Uint8Array([1]) });
    const v1 = indexedDB.open(databaseName(name), 1);
    v1.onupgradeneeded = () => {
      for (const table of legacyStores(1)) v1.result.createObjectStore(table);
      v1.result.createObjectStore("meta");
      const tx = v1.transaction!;
      const put = (store: string, row: Record<string, unknown>, key: IDBValidKey) => tx.objectStore(store).put(row, key);
      put("accounts", { id: 1, kind: "imap", email: "yo@x.mx", display_name: "", color: "indigo", provider_config: "{}", secret_ref: null, sync_state_json: "{}", created_at: 0 }, 1);
      for (const t of [7, 8]) put("threads", { id: t, account_id: 1, provider_thread_id: null, subject: "s", snippet: "", participants_json: "[]", last_date: t, message_count: 0, unread_count: 0, has_attachments: 0, is_starred: 0, in_inbox: 1, has_sent: 0, in_trash: 0, in_spam: 0, last_from_name: "", last_from_email: "" }, t);
      put("categories", { id: 1, name: "Origen", color: "rose", position: 0, auto_apply: 1 }, 1);
      put("categories", { id: 2, name: "Destino", color: "cyan", position: 1, auto_apply: 1 }, 2);
      put("cat_batches", { id: 5, category_id: 2, source: "dnd", scope_json: JSON.stringify({ kind: "move", from: 1, addedBy: "user", phase: "restoring" }), added: 2, created_at: 0, undone_at: 9 }, 5);
      // 7 was in the source, 8 wasn't (a stale drag); version 1 journaled both categories' examples for both
      put("cat_move_threads", { batch_id: 5, thread_id: 7, added: 1, moved: 1, done: 0 }, [5, 7]);
      put("cat_move_threads", { batch_id: 5, thread_id: 8, added: 1, moved: 0, done: 0 }, [5, 8]);
      put("cat_move_rows", { batch_id: 5, thread_id: 7, added_by: "user", added_at: 10, prev_batch_id: null }, [5, 7]);
      for (const t of [7, 8]) put("cat_move_examples", { batch_id: 5, thread_id: t, category_id: 1, label: 1, weight: 1, source: "user", at: 1, sender: "s", content: 1, example_batch_id: null, features: new Uint8Array([1]) }, [5, t, 1]);
      for (const t of [7, 8]) put("thread_categories", { thread_id: t, category_id: 1, added_by: "user", added_at: 10, batch_id: null }, [t, 1]);
      for (const row of [ex(7, 1, -1, "removal"), ex(7, 2, 1, "user"), ex(8, 1, 1, "user"), ex(8, 2, 1, "user")]) put("cls_examples", row, [row.thread_id, row.category_id]);
    };
    ((await req(v1)) as IDBDatabase).close();
    const store = await open(name);
    const deltas = await store.categories.restoreMoveSlice(5, await store.categories.movePending(5));
    expect(await store.categories.movePhase(5)).toBe("undone");
    expect((await store.debug.snapshot()).examples.map((e) => [e.threadId, e.categoryId, e.label, e.source])).toEqual([
      [7, 1, 1, "user"],
      [8, 1, 1, "user"],
    ]);
    // every example that went back in replaced one that was taken out: the model stays in step
    const trained = deltas.filter((d) => d.op === "train").length;
    expect(trained).toBe(2);
    expect(deltas.filter((d) => d.op === "untrain").length).toBe(4);
  });
});

describe("scope pages after the mailbox changes", () => {
  it("the seek index follows threads and memberships that come and go, and commands that fail", async () => {
    const store = await open();
    const [a] = await withAccounts(store);
    await ingest(store, Array.from({ length: 6 }, (_, i) => msg({ accountId: a!, providerMsgId: `s${i}`, date: NOW - i * 1000 })), NOW);
    const ids = (await store.debug.snapshot()).threads.map((t) => t.id).sort((x, y) => x - y);
    const cat = (await store.categories.create("C", "rose")).id;
    const page = (p: { categoryId?: number }) => store.threads.scopeIds({ view: "all", ...p, after: 0, limit: 100 });
    expect(await page({})).toEqual(ids);
    expect(await page({ categoryId: cat })).toEqual([]);
    await store.categories.add({ categoryId: cat, threadIds: ids.slice(0, 3), addedBy: "user", now: NOW });
    expect(await page({ categoryId: cat })).toEqual(ids.slice(0, 3));
    await store.categories.remove({ categoryId: cat, threadIds: [ids[1]!], reason: "user", now: NOW });
    expect(await page({ categoryId: cat })).toEqual([ids[0], ids[2]]);
    // a failed command rolls memory back: the index follows the rollback too
    await expect(store.categories.add({ categoryId: cat + 999, threadIds: [ids[4]!], addedBy: "user", now: NOW })).rejects.toThrow();
    expect(await page({ categoryId: cat })).toEqual([ids[0], ids[2]]);
    await store.sync.remove((await store.debug.snapshot()).messages.filter((m) => m.threadId === ids[0]).map((m) => m.id));
    expect(await page({})).toEqual(ids.slice(1));
    expect(await page({ categoryId: cat })).toEqual([ids[2]]);
    await ingest(store, [msg({ accountId: a!, providerMsgId: "new", date: NOW })], NOW);
    expect((await page({})).length).toBe(ids.length);
  });
});


it("version 4 messages default Reply-To on read without rewriting persisted mail", async () => {
  const store = await open();
  const [accountId] = await withAccounts(store);
  await ingest(store, [msg({ accountId: accountId!, providerMsgId: "legacy-reply" })], NOW);
  const message = (await store.debug.snapshot()).messages[0]!;
  const req = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  await store.close();
  const source = await req(indexedDB.open(databaseName(store.name)));
  raw.push(source);
  const names = Array.from(source.objectStoreNames);
  const tx = source.transaction(names, "readonly");
  const rows = legacyImage(await Promise.all(names.map(async (table) => ({ name: table, values: await req(tx.objectStore(table).getAll()), keys: await req(tx.objectStore(table).getAllKeys()) }))), 4).map(({ name, values, keys }) => ({ table: name, rows: values, keys }));
  source.close();
  const name = `${store.name}-v4`;
  const legacy = indexedDB.open(databaseName(name), 4);
  legacy.onupgradeneeded = () => {
    for (const { table, rows: saved, keys } of rows.filter(({ table }) => table === "meta" || legacyStores(4).includes(table))) {
      const target = legacy.result.createObjectStore(table);
      saved.forEach((row: Record<string, unknown>, i: number) => {
        if (table === "messages") delete row.reply_to_json;
        target.put(row, keys[i]!);
      });
    }
  };
  (await req(legacy)).close();
  const reopened = await open(name);
  expect((await reopened.threads.get(message.threadId))!.messages[0]!.replyTo).toEqual([]);
  const persisted = await req(indexedDB.open(databaseName(name)));
  raw.push(persisted);
  try {
    const row = await req(persisted.transaction("messages").objectStore("messages").get(message.id)) as Record<string, unknown>;
    expect(row).not.toHaveProperty("reply_to_json");
  } finally { persisted.close(); }
  await reopened.debug.verify();
  await reopened.close();
  const again = await open(name);
  expect((await again.threads.get(message.threadId))!.messages[0]!.replyTo).toEqual([]);
  await again.debug.verify();
});
