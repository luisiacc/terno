import "fake-indexeddb/auto";
import { msg, threadOf, withAccounts } from "@terno/store/conformance";
import { expect, it } from "vitest";
import { databaseName, IDB_VERSION } from "./schema";
import { IdbMailStore } from "./store";
import { legacyBodyUpgrade, physicalImage } from "./test/legacy-stores";

/** Plan 215: version 38 adds `waiting_acts`. A version-37 mailbox opens with it empty, its waiting conversation kept. */

const platform = { uuid: () => crypto.randomUUID(), yield: async () => {} };
const request = <T,>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const open = (name: string) => IdbMailStore.open({ legacyUpgrade: legacyBodyUpgrade(indexedDB), name, factory: indexedDB, platform, instantSearch: false });
const NOW = 1e12;

it("a version-37 mailbox gains an empty store; its waiting conversation stays, and a Done is kept after a reopen", async () => {
  const name = crypto.randomUUID(), legacyName = crypto.randomUUID();
  const source = await open(name);
  const [account] = await withAccounts(source, 1);
  const me = (await source.accounts.list())[0]!;
  const ana = { name: "Ana", email: "ana@people.test" };
  await source.sync.ingest([msg({ accountId: account!, providerMsgId: "out", rfcMessageId: "out@t", from: { name: "Me", email: me.email }, to: [ana], isSent: true, isRead: true, date: NOW - 5000 })], { applyFilters: false, now: NOW, classifier: null });
  await source.sync.ingest([msg({ accountId: account!, providerMsgId: "ask", from: ana, to: [{ name: "Me", email: me.email }], inReplyTo: "out@t", references: ["out@t"], date: NOW - 1000 })], { applyFilters: false, now: NOW, classifier: null });
  const talk = await threadOf(source, "ask");
  await source.close();
  // the same image as version 37 wrote it: no `waiting_acts`, logical schema 73
  const raw = await request(indexedDB.open(databaseName(name)));
  const image = (await physicalImage(raw)).filter((s) => s.name !== "waiting_acts").map((s) => (s.name === "meta" ? { ...s, values: s.values.map((v, i) => (s.keys[i] === "logicalSchema" ? 73 : v)) } : s));
  raw.close();
  const old = indexedDB.open(databaseName(legacyName), 37);
  old.onupgradeneeded = () => {
    for (const s of image) {
      const os = old.result.createObjectStore(s.name, { keyPath: s.keyPath, autoIncrement: s.autoIncrement });
      for (const index of s.indexes) os.createIndex(index.name, index.keyPath, index);
      s.values.forEach((row, i) => os.put(row, s.keys[i]));
    }
  };
  (await request(old)).close();

  const upgraded = await open(legacyName);
  expect(await upgraded.today.waiting.donePage({ since: 0, after: null, limit: 10 })).toEqual([]);
  expect(await upgraded.today.waitingAmong([talk], NOW)).toEqual([talk]);
  const message = (await upgraded.today.waiting.rows([{ threadId: talk, since: NOW - 1000 }], NOW, { messages: true })).get(talk)!.message!;
  const done = await upgraded.today.waiting.act({ threadId: talk, since: NOW - 1000, message, rev: 0, state: "done", until: null, now: NOW });
  expect(done?.rev).toBe(1);
  expect(await upgraded.today.waitingAmong([talk], NOW)).toEqual([]);
  await upgraded.close();
  const reopened = await open(legacyName);
  expect((await reopened.today.waiting.donePage({ since: 0, after: null, limit: 10 })).map((d) => d.threadId)).toEqual([talk]);
  expect(await reopened.today.waitingAmong([talk], NOW)).toEqual([]);
  const db = await request(indexedDB.open(databaseName(legacyName)));
  expect(db.version).toBe(IDB_VERSION);
  expect(db.objectStoreNames.contains("waiting_acts")).toBe(true);
  db.close();
  await reopened.close();
});
