import "fake-indexeddb/auto";
import { ingest, msg, threadOf, withAccounts } from "@terno/store/conformance";
import { expect, it } from "vitest";
import { databaseName, IDB_VERSION } from "./schema";
import { IdbMailStore } from "./store";
import { legacyBodyUpgrade, physicalImage } from "./test/legacy-stores";

/** Plan 210 (iteration 4): version 36 adds `dated_mutes`. A version-35 mailbox opens with it empty, the rest kept. */

const platform = { uuid: () => crypto.randomUUID(), yield: async () => {} };
const request = <T,>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const open = (name: string) => IdbMailStore.open({ legacyUpgrade: legacyBodyUpgrade(indexedDB), name, factory: indexedDB, platform, instantSearch: false });
const NOW = 1e12;

it("a version-35 mailbox gains an empty store; its mail and waiting conversations stay, and a mute is kept after", async () => {
  const name = crypto.randomUUID(), legacyName = crypto.randomUUID();
  const source = await open(name);
  const [account] = await withAccounts(source, 1);
  const me = (await source.accounts.list())[0]!;
  const ana = { name: "Ana", email: "ana@people.test" };
  await ingest(source, [msg({ accountId: account!, providerMsgId: "out", rfcMessageId: "out@t", from: { name: "Me", email: me.email }, to: [ana], isSent: true, isRead: true, date: NOW - 5000 })]);
  await source.sync.ingest([msg({ accountId: account!, providerMsgId: "ask", from: ana, to: [{ name: "Me", email: me.email }], inReplyTo: "out@t", references: ["out@t"], date: NOW - 1000 })], { applyFilters: false, now: NOW, classifier: null });
  const talk = await threadOf(source, "ask");
  await source.close();
  // the same image as version 35 wrote it: no `dated_mutes`, logical schema 60
  const raw = await request(indexedDB.open(databaseName(name)));
  const image = (await physicalImage(raw)).filter((s) => s.name !== "dated_mutes" && s.name !== "dated_mute_pairs").map((s) => (s.name === "meta" ? { ...s, values: s.values.map((v, i) => (s.keys[i] === "logicalSchema" ? 60 : v)) } : s));
  raw.close();
  const old = indexedDB.open(databaseName(legacyName), 35);
  old.onupgradeneeded = () => {
    for (const s of image) {
      const os = old.result.createObjectStore(s.name, { keyPath: s.keyPath, autoIncrement: s.autoIncrement });
      for (const index of s.indexes) os.createIndex(index.name, index.keyPath, index);
      s.values.forEach((row, i) => os.put(row, s.keys[i]));
    }
  };
  (await request(old)).close();

  const upgraded = await open(legacyName);
  expect(await upgraded.dated.mutes.list()).toEqual([]);
  expect(await upgraded.today.waitingAmong([talk], NOW)).toEqual([talk]);
  expect(await upgraded.dated.mutes.add({ on: "sender", key: ana.email, name: ana.name, at: NOW })).toBe("added");
  expect(await upgraded.today.waitingAmong([talk], NOW)).toEqual([]);
  await upgraded.close();
  const reopened = await open(legacyName);
  expect((await reopened.dated.mutes.list()).map((m) => m.key)).toEqual([ana.email]);
  expect(await reopened.today.waitingAmong([talk], NOW)).toEqual([]);
  const db = await request(indexedDB.open(databaseName(legacyName)));
  expect(db.version).toBe(IDB_VERSION);
  expect(db.objectStoreNames.contains("dated_mutes")).toBe(true);
  db.close();
  await reopened.close();
});

/** Plan 210 (iteration 5): version 37 adds `dated_mute_pairs`. A version-36 mailbox opens with it empty, its mutes kept. */
it("a version-36 mailbox gains an empty pair store; its mutes stay, and a pair is kept after a reopen", async () => {
  const name = crypto.randomUUID(), legacyName = crypto.randomUUID();
  const source = await open(name);
  await withAccounts(source, 1);
  expect(await source.dated.mutes.add({ on: "kind", key: "pay", name: "", at: NOW })).toBe("added");
  await source.close();
  // the same image as version 36 wrote it: no `dated_mute_pairs`, logical schema 69
  const raw = await request(indexedDB.open(databaseName(name)));
  const image = (await physicalImage(raw)).filter((s) => s.name !== "dated_mute_pairs").map((s) => (s.name === "meta" ? { ...s, values: s.values.map((v, i) => (s.keys[i] === "logicalSchema" ? 69 : v)) } : s));
  raw.close();
  const old = indexedDB.open(databaseName(legacyName), 36);
  old.onupgradeneeded = () => {
    for (const s of image) {
      const os = old.result.createObjectStore(s.name, { keyPath: s.keyPath, autoIncrement: s.autoIncrement });
      for (const index of s.indexes) os.createIndex(index.name, index.keyPath, index);
      s.values.forEach((row, i) => os.put(row, s.keys[i]));
    }
  };
  (await request(old)).close();

  const upgraded = await open(legacyName);
  expect(await upgraded.dated.mutes.list()).toEqual([{ on: "kind", key: "pay", name: "", at: NOW }]);
  expect(await upgraded.dated.mutes.add({ on: "pair", key: "delivery|Track+eu@Parcelo.test", name: "Parcelo", at: NOW + 1 })).toBe("added");
  await upgraded.close();
  const reopened = await open(legacyName);
  expect((await reopened.dated.mutes.list()).map((m) => [m.on, m.key])).toEqual([["pair", "delivery|track@parcelo.test"], ["kind", "pay"]]);
  const db = await request(indexedDB.open(databaseName(legacyName)));
  expect(db.version).toBe(IDB_VERSION);
  expect(db.objectStoreNames.contains("dated_mute_pairs")).toBe(true);
  db.close();
  await reopened.close();
});
