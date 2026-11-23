import "fake-indexeddb/auto";
import { msg, threadOf, withAccounts } from "@terno/store/conformance";
import { expect, it } from "vitest";
import { databaseName, IDB_VERSION, LOGICAL_SCHEMA } from "./schema";
import { IdbMailStore } from "./store";
import { legacyBodyUpgrade, physicalImage } from "./test/legacy-stores";

/** Plan 248: version 40 adds `preference_verdicts`, `wanted_items` and `wanted_marks`. A version-39 mailbox opens with them empty, the rest kept. */

const platform = { uuid: () => crypto.randomUUID(), yield: async () => {} };
const request = <T,>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const open = (name: string) => IdbMailStore.open({ legacyUpgrade: legacyBodyUpgrade(indexedDB), name, factory: indexedDB, platform, instantSearch: false });
const NOW = 1e12;
const ADDED = ["preference_verdicts", "wanted_items", "wanted_marks"];

it("a version-39 mailbox gains the three stores empty; its mail and dated items stay, and the words, a verdict, a wanted item and a mark are kept after", async () => {
  const name = crypto.randomUUID(), legacyName = crypto.randomUUID();
  const source = await open(name);
  const [account] = await withAccounts(source, 1);
  const gym = { name: "Gym", email: "hello@gym.test" };
  const dated = { applyFilters: false, now: NOW, classifier: null, datedMail: { since: null } };
  const [bill, renewal, later] = (await source.sync.ingest([1, 2, 3].map((i) => msg({ accountId: account!, providerMsgId: `m${i}`, from: gym, date: NOW - i * 1000 })), dated)).inserted;
  const thread = await threadOf(source, "m1");
  expect(await source.dated.finish({ messageId: bill!, threadId: thread, fromScan: false, rows: [{ kind: "pay", item: 0, text: "Pay", quote: "due", dueDay: "2001-09-12", dueAt: NOW + 1, timed: false, dated: true, actAt: NOW + 1 }], settled: [], now: NOW, model: null, provider: null, promptVersion: 1, clearGeneration: source.dated.clearGeneration() })).toBe("written");
  await source.close();
  // the same image as version 39 wrote it: none of the three stores, logical schema 76
  const raw = await request(indexedDB.open(databaseName(name)));
  const image = (await physicalImage(raw)).filter((s) => !ADDED.includes(s.name)).map((s) => (s.name === "meta" ? { ...s, values: s.values.map((v, i) => (s.keys[i] === "logicalSchema" ? 76 : v)) } : s));
  raw.close();
  const old = indexedDB.open(databaseName(legacyName), 39);
  old.onupgradeneeded = () => {
    for (const s of image) {
      const os = old.result.createObjectStore(s.name, { keyPath: s.keyPath, autoIncrement: s.autoIncrement });
      for (const index of s.indexes) os.createIndex(index.name, index.keyPath, index);
      s.values.forEach((row, i) => os.put(row, s.keys[i]));
    }
  };
  (await request(old)).close();

  const upgraded = await open(legacyName);
  const wm = upgraded.whatMatters;
  expect((await wm.preferences.get()).revision).toBe(0);
  expect(await wm.wanted.active()).toEqual([]);
  expect(await wm.wanted.marks.count()).toBe(0);
  expect((await upgraded.dated.active()).map((r) => r.threadId)).toEqual([thread]);
  expect((await upgraded.debug.snapshot()).messages).toHaveLength(3);
  const saved = await wm.preferences.save({ text: "Show me gym renewals", rules: [], notes: [], compiledWith: null, savedAt: NOW, language: "en" }, 0);
  expect(saved?.revision).toBe(1);
  expect(await wm.verdicts.put([{ target: "d:1:0", basis: "b", rules: ["h1"], at: NOW }], 1)).toBe(true);
  const renewalThread = await threadOf(upgraded, "m2");
  expect(await wm.wanted.marks.add({ messageId: renewal!, threadId: renewalThread, arrivedAt: NOW - 2000, source: "live" }, NOW)).toBe(true);
  expect(await wm.wanted.finish({ messageId: renewal!, threadId: renewalThread, senderKey: "hello@gym.test", arrivedAt: NOW - 2000, rows: [{ kind: "renew", text: "Renew", quote: "renews", dueDay: "2001-09-12", dueAt: NOW + 1, timed: false, dated: true, actAt: NOW + 1, rules: ["s1"] }], now: NOW, model: null, provider: null, promptVersion: 1, fromLook: false, revision: 1 })).toBe("written");
  expect(await wm.wanted.marks.add({ messageId: later!, threadId: await threadOf(upgraded, "m3"), arrivedAt: NOW - 3000, source: "look" }, NOW)).toBe(true);
  await upgraded.close();

  const reopened = await open(legacyName);
  expect(await reopened.whatMatters.preferences.get()).toEqual(saved);
  expect((await reopened.whatMatters.verdicts.get(["d:1:0"])).get("d:1:0")).toMatchObject({ basis: "b", rules: ["h1"] });
  expect((await reopened.whatMatters.wanted.active()).map((r) => [r.threadId, r.messageId, r.rules])).toEqual([[renewalThread, renewal, ["s1"]]]);
  expect((await reopened.whatMatters.wanted.marks.page(10)).map((m) => [m.messageId, m.source])).toEqual([[later, "look"]]);
  expect((await reopened.dated.active()).map((r) => r.threadId)).toEqual([thread]);
  const db = await request(indexedDB.open(databaseName(legacyName)));
  expect(db.version).toBe(IDB_VERSION);
  for (const s of ADDED) expect(db.objectStoreNames.contains(s)).toBe(true);
  const meta = db.transaction("meta").objectStore("meta");
  expect(await request(meta.get("logicalSchema"))).toBe(LOGICAL_SCHEMA);
  db.close();
  await reopened.close();
});
