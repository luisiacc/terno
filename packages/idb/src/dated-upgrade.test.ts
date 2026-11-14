import "fake-indexeddb/auto";
import { ingest, msg, threadOf, withAccounts } from "@terno/store/conformance";
import { expect, it } from "vitest";
import { databaseName, IDB_VERSION } from "./schema";
import { IdbMailStore } from "./store";
import { legacyBodyUpgrade, physicalImage } from "./test/legacy-stores";

/** Plan 204: version 34 adds `ai_dated_mail` and `dated_items`. A version-33 mailbox opens with them empty, the rest kept. */

const platform = { uuid: () => crypto.randomUUID(), yield: async () => {} };
const request = <T,>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const open = (name: string) => IdbMailStore.open({ legacyUpgrade: legacyBodyUpgrade(indexedDB), name, factory: indexedDB, platform, instantSearch: false });

it("a version-33 mailbox gains empty dated stores; its mail and pins stay, and dated items work after", async () => {
  const name = crypto.randomUUID(), legacyName = crypto.randomUUID();
  const source = await open(name);
  const [account] = await withAccounts(source, 1);
  await ingest(source, [msg({ accountId: account!, providerMsgId: "x", rfcMessageId: "x@t", date: 1e12 })]);
  const x = await threadOf(source, "x");
  await source.pins.add([{ threadId: x, pinnedAt: 5 }], 10);
  await source.close();
  // the same image as version 33 wrote it: no dated stores, logical schema 55
  const raw = await request(indexedDB.open(databaseName(name)));
  const image = (await physicalImage(raw)).filter((s) => s.name !== "ai_dated_mail" && s.name !== "dated_items").map((s) => (s.name === "meta" ? { ...s, values: s.values.map((v, i) => (s.keys[i] === "logicalSchema" ? 55 : v)) } : s));
  raw.close();
  const old = indexedDB.open(databaseName(legacyName), 33);
  old.onupgradeneeded = () => {
    for (const s of image) {
      const os = old.result.createObjectStore(s.name, { keyPath: s.keyPath, autoIncrement: s.autoIncrement });
      for (const index of s.indexes) os.createIndex(index.name, index.keyPath, index);
      s.values.forEach((row, i) => os.put(row, s.keys[i]));
    }
  };
  (await request(old)).close();

  const upgraded = await open(legacyName);
  expect(await upgraded.dated.active()).toEqual([]);
  expect(await upgraded.dated.marks.count()).toBe(0);
  expect(await upgraded.pins.list()).toEqual([{ threadId: x, pinnedAt: 5 }]);
  const [id] = (await upgraded.sync.ingest([msg({ accountId: account!, providerMsgId: "y", date: 1e12 - 1000 })], { applyFilters: false, now: 1e12, classifier: null, datedMail: { since: null } })).inserted;
  const thread = await threadOf(upgraded, "y");
  expect(await upgraded.dated.finish({ messageId: id!, threadId: thread, fromScan: false, rows: [{ kind: "pay", item: 0, text: "Pay", quote: "due", dueDay: "2001-09-12", dueAt: 1e12 + 1, timed: false, dated: true, actAt: 1e12 }], settled: [], now: 1e12, model: null, provider: null, promptVersion: null, clearGeneration: upgraded.dated.clearGeneration() })).toBe("written");
  await upgraded.close();
  const reopened = await open(legacyName);
  expect((await reopened.dated.active()).map((r) => r.threadId)).toEqual([thread]);
  const db = await request(indexedDB.open(databaseName(legacyName)));
  expect(db.version).toBe(IDB_VERSION);
  db.close();
  await reopened.close();
});
