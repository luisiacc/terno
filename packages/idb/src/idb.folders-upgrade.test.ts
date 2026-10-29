/**
 * Plan 65 (Codex R1): a web mailbox from before schema 24 gets its Gmail folder memberships once, after its
 * messages load. The mark that says so goes in with the upgrade and comes off only when they're saved, so a
 * close in between, or a failure, resumes on the next open.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { ingest, msg, withAccounts } from "@terno/store/conformance";
import { afterEach, expect, it, vi } from "vitest";
import { machineBusy } from "../../db/src/test/timing";

// the backfill can be made to fail once (what a close mid-way or a storage failure leaves behind)
const fail = vi.hoisted(() => ({ next: false, batches: [] as number[], batchMs: [] as number[] }));
vi.mock("./folders", async (original) => {
  const real = await original<typeof import("./folders")>();
  return {
    ...real,
    addMessageLabels: (c: Parameters<typeof real.addMessageLabels>[0], ids: Parameters<typeof real.addMessageLabels>[1]) => {
      const started = performance.now();
      real.addMessageLabels(c, ids);
      fail.batches.push(ids.length);
      fail.batchMs.push(performance.now() - started);
    },
    messagesWithUserLabels: (...args: Parameters<typeof real.messagesWithUserLabels>) => {
      if (fail.next) {
        fail.next = false;
        throw new Error("synthetic backfill failure");
      }
      return real.messagesWithUserLabels(...args);
    },
  };
});

const { databaseName, LOGICAL_SCHEMA } = await import("./schema");
const { IdbMailStore } = await import("./store");
type IdbMailStore = import("./store").IdbMailStore;

const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setImmediate(resolve)) };
const request = <T,>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const done = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
const opened: IdbMailStore[] = [];
afterEach(async () => {
  for (const s of opened.splice(0)) if (s.isOpen) await s.close();
});

/** A mailbox as schema 23 left it: labels on its messages, no memberships, the older schema in its meta. */
async function legacyMailbox(factory: IDBFactory, name: string) {
  const store = await IdbMailStore.open({ factory, name, instantSearch: false, platform });
  const [g] = await withAccounts(store, 1);
  await store.folders.replace(g!, [{ key: "Label_1", path: ["Clientes"], selectable: true }]);
  await ingest(store, [msg({ accountId: g!, providerMsgId: "g1", gmailLabels: ["INBOX", "Label_1"] })]);
  await store.close();
  const raw = await request(factory.open(databaseName(name)));
  const tx = raw.transaction(["thread_folders", "meta"], "readwrite");
  tx.objectStore("thread_folders").clear();
  tx.objectStore("meta").put(23, "logicalSchema");
  await done(tx);
  raw.close();
  return g!;
}

async function meta(factory: IDBFactory, name: string, key: string) {
  const raw = await request(factory.open(databaseName(name)));
  try {
    return await request(raw.transaction("meta").objectStore("meta").get(key));
  } finally {
    raw.close();
  }
}

const inFolder = (store: IdbMailStore, accountId: number) => store.threads.list({ view: "all", accountId, folder: "Label_1", limit: 10 }).then((p) => p.items.length);

it("a backfill that doesn't save leaves the mark; the next open finishes it and takes the mark off", async () => {
  const factory = new IDBFactory();
  const name = crypto.randomUUID();
  const account = await legacyMailbox(factory, name);
  fail.next = true;
  const first = await IdbMailStore.open({ factory, name, instantSearch: false, platform });
  await first.whenLoaded();
  expect(await inFolder(first, account)).toBe(0);
  await first.close();
  expect(await meta(factory, name, "logicalSchema")).toBe(LOGICAL_SCHEMA);
  expect(await meta(factory, name, "foldersPending")).toBe(true);
  const second = await IdbMailStore.open({ factory, name, instantSearch: false, platform });
  opened.push(second);
  await second.whenLoaded();
  await expect.poll(() => inFolder(second, account)).toBe(1);
  await expect.poll(() => meta(factory, name, "foldersPending")).toBe(false);
  await second.close();
  // done: a third open does nothing more
  const third = await IdbMailStore.open({ factory, name, instantSearch: false, platform });
  opened.push(third);
  await third.whenLoaded();
  expect(await inFolder(third, account)).toBe(1);
});

it("Codex R3, R9: a big mailbox's backfill goes in small batches, a command per slice of time, never all at once", async () => {
  const factory = new IDBFactory();
  const name = crypto.randomUUID();
  const store = await IdbMailStore.open({ factory, name, instantSearch: false, platform });
  const [g] = await withAccounts(store, 1);
  await store.folders.replace(g!, [{ key: "Label_1", path: ["Clientes"], selectable: true }]);
  for (let i = 0; i < 2500; i += 500) await ingest(store, Array.from({ length: 500 }, (_, j) => msg({ accountId: g!, providerMsgId: `m${i + j}`, gmailLabels: ["Label_1"] })));
  await store.close();
  const raw = await request(factory.open(databaseName(name)));
  const tx = raw.transaction(["thread_folders", "meta"], "readwrite");
  tx.objectStore("thread_folders").clear();
  tx.objectStore("meta").put(23, "logicalSchema");
  await done(tx);
  raw.close();
  fail.batches.length = 0;
  const reopened = await IdbMailStore.open({ factory, name, instantSearch: false, platform });
  opened.push(reopened);
  await reopened.whenLoaded();
  await expect.poll(() => meta(factory, name, "foldersPending")).toBe(false);
  // batches of 50 messages (Codex R9, R15: a thread with many labels or messages is many memberships), as many commands as time takes
  expect(fail.batches.length).toBeGreaterThanOrEqual(50);
  expect(Math.max(...fail.batches)).toBeLessThanOrEqual(50);
  expect((await reopened.threads.list({ view: "all", accountId: g!, folder: "Label_1", limit: 500 })).items).toHaveLength(500);
}, 120_000);

it("Codex R15: one conversation of 50,000 messages with 20 labels each is many small batches, never one", async () => {
  const factory = new IDBFactory();
  const name = crypto.randomUUID();
  const store = await IdbMailStore.open({ factory, name, instantSearch: false, platform });
  const [g] = await withAccounts(store, 1);
  const labels = Array.from({ length: 20 }, (_, i) => `Label_${i}`);
  await store.folders.replace(g!, labels.map((key) => ({ key, path: [key], selectable: true })));
  // one thread: every message a reply in the same Gmail thread
  for (let i = 0; i < 50_000; i += 5000) await ingest(store, Array.from({ length: 5000 }, (_, j) => msg({ accountId: g!, providerMsgId: `m${i + j}`, providerThreadId: "one", gmailLabels: labels })));
  const threads = new Set((await store.debug.snapshot()).messages.map((m) => m.threadId));
  expect(threads.size).toBe(1);
  await store.close();
  const raw = await request(factory.open(databaseName(name)));
  const tx = raw.transaction(["thread_folders", "meta"], "readwrite");
  tx.objectStore("thread_folders").clear();
  tx.objectStore("meta").put(23, "logicalSchema");
  await done(tx);
  raw.close();
  fail.batches.length = 0;
  fail.batchMs.length = 0;
  const reopened = await IdbMailStore.open({ factory, name, instantSearch: false, platform });
  opened.push(reopened);
  await reopened.whenLoaded();
  await expect.poll(() => meta(factory, name, "foldersPending"), { timeout: 120_000 }).toBe(false);
  expect(Math.max(...fail.batches)).toBeLessThanOrEqual(50);
  // each batch a small part of a frame (the slice of time around them is 8 ms); on a busy machine the OS may hold one
  if (!machineBusy()) expect(fail.batchMs.sort((a, b) => a - b).at(-1)!).toBeLessThan(8);
  for (const key of labels) expect((await reopened.threads.list({ view: "all", accountId: g!, folder: key, limit: 10 })).items).toHaveLength(1);
}, 300_000);

