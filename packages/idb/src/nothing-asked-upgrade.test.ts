import "fake-indexeddb/auto";
import { DATED_NOTHING_ASKED_SINCE } from "@terno/store";
import { ingest, msg, threadOf, withAccounts } from "@terno/store/conformance";
import { expect, it } from "vitest";
import { databaseName, IDB_VERSION } from "./schema";
import { IdbMailStore } from "./store";
import { legacyBodyUpgrade, physicalImage } from "./test/legacy-stores";

/** Plan 210 (iteration 2): version 35 adds `dated_nothing_asked`. A version-34 mailbox opens with it empty, the rest kept. */

const platform = { uuid: () => crypto.randomUUID(), yield: async () => {} };
const request = <T,>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const open = (name: string) => IdbMailStore.open({ legacyUpgrade: legacyBodyUpgrade(indexedDB), name, factory: indexedDB, platform, instantSearch: false });
const NOW = 1e12;

it("a version-34 mailbox gains an empty store; its mail and dated items stay, and what's read with nothing asked is kept after", async () => {
  const name = crypto.randomUUID(), legacyName = crypto.randomUUID();
  const source = await open(name);
  const [account] = await withAccounts(source, 1);
  const me = (await source.accounts.list())[0]!;
  const ana = { name: "Ana", email: "ana@people.test" };
  await ingest(source, [msg({ accountId: account!, providerMsgId: "out", rfcMessageId: "out@t", from: { name: "Me", email: me.email }, to: [ana], isSent: true, isRead: true, date: NOW - 5000 })]);
  const dated = { applyFilters: false, now: NOW, classifier: null, datedMail: { since: null } };
  const [bill] = (await source.sync.ingest([msg({ accountId: account!, providerMsgId: "bill", from: ana, to: [{ name: "Me", email: me.email }], date: NOW - 4000 })], dated)).inserted;
  const thread = await threadOf(source, "bill");
  expect(await source.dated.finish({ messageId: bill!, threadId: thread, fromScan: false, rows: [{ kind: "pay", item: 0, text: "Pay", quote: "due", dueDay: "2001-09-12", dueAt: NOW + 1, timed: false, dated: true, actAt: NOW }], settled: [], now: NOW, model: null, provider: null, promptVersion: 11, clearGeneration: source.dated.clearGeneration() })).toBe("written");
  await source.close();
  // the same image as version 34 wrote it: no `dated_nothing_asked`, logical schema 56
  const raw = await request(indexedDB.open(databaseName(name)));
  const image = (await physicalImage(raw)).filter((s) => s.name !== "dated_nothing_asked").map((s) => (s.name === "meta" ? { ...s, values: s.values.map((v, i) => (s.keys[i] === "logicalSchema" ? 56 : v)) } : s));
  raw.close();
  const old = indexedDB.open(databaseName(legacyName), 34);
  old.onupgradeneeded = () => {
    for (const s of image) {
      const os = old.result.createObjectStore(s.name, { keyPath: s.keyPath, autoIncrement: s.autoIncrement });
      for (const index of s.indexes) os.createIndex(index.name, index.keyPath, index);
      s.values.forEach((row, i) => os.put(row, s.keys[i]));
    }
  };
  (await request(old)).close();

  const upgraded = await open(legacyName);
  expect((await upgraded.dated.active()).map((r) => r.threadId)).toEqual([thread]);
  const [thanks] = (await upgraded.sync.ingest([msg({ accountId: account!, providerMsgId: "thanks", from: ana, to: [{ name: "Me", email: me.email }], inReplyTo: "out@t", references: ["out@t"], date: NOW - 1000, bodyText: "Thanks so much, that's perfect!" })], dated)).inserted;
  const talk = await threadOf(upgraded, "thanks");
  expect(await upgraded.today.waitingAmong([talk], NOW)).toEqual([talk]);
  expect(await upgraded.dated.finish({ messageId: thanks!, threadId: talk, fromScan: false, rows: [], settled: [], now: NOW, model: null, provider: null, promptVersion: DATED_NOTHING_ASKED_SINCE, nothingAsked: true, clearGeneration: upgraded.dated.clearGeneration() })).toBe("written");
  expect(await upgraded.today.waitingAmong([talk], NOW)).toEqual([]);
  await upgraded.close();
  const reopened = await open(legacyName);
  expect(await reopened.today.waitingAmong([talk], NOW)).toEqual([]);
  const db = await request(indexedDB.open(databaseName(legacyName)));
  expect(db.version).toBe(IDB_VERSION);
  expect(db.objectStoreNames.contains("dated_nothing_asked")).toBe(true);
  db.close();
  await reopened.close();
});
