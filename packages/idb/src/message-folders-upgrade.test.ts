import "fake-indexeddb/auto";
import { ingest, msg, outlookAccount, threadOf, withAccounts } from "@terno/store/conformance";
import { expect, it } from "vitest";
import { databaseName, IDB_VERSION, LOGICAL_SCHEMA } from "./schema";
import { IdbMailStore } from "./store";
import { legacyBodyUpgrade, physicalImage } from "./test/legacy-stores";

/**
 * Plan 259: version 41 adds `message_folders` (an Outlook message's one folder). A version-40 mailbox (mail and a folder
 * membership in it) opens with an empty one, the rest kept; a folder written after survives a reopen and goes with its
 * message, or its account.
 */

const platform = { uuid: () => crypto.randomUUID(), yield: async () => {} };
const request = <T,>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const open = (name: string) => IdbMailStore.open({ legacyUpgrade: legacyBodyUpgrade(indexedDB), name, factory: indexedDB, platform, instantSearch: false });
const rows = async (name: string, store: string) => {
  const db = await request(indexedDB.open(databaseName(name)));
  const image = await physicalImage(db);
  db.close();
  return { version: db.version, values: image.find((s) => s.name === store)?.values };
};

it("a version-40 mailbox gains an empty message_folders store; its mail and folders stay, and an Outlook message's folder works after", async () => {
  const name = crypto.randomUUID(), legacyName = crypto.randomUUID();
  const source = await open(name);
  const [gmail] = await withAccounts(source, 1);
  await source.folders.replace(gmail!, [{ key: "Label_1", path: ["Clients"], selectable: true }]);
  await ingest(source, [msg({ accountId: gmail!, providerMsgId: "g", gmailLabels: ["Label_1"] })]);
  const g = await threadOf(source, "g");
  await source.close();
  // the same image as version 40 wrote it: no message_folders store, logical schema 79
  const raw = await request(indexedDB.open(databaseName(name)));
  const image = (await physicalImage(raw)).filter((s) => s.name !== "message_folders").map((s) => (s.name === "meta" ? { ...s, values: s.values.map((v, i) => (s.keys[i] === "logicalSchema" ? 79 : v)) } : s));
  raw.close();
  const old = indexedDB.open(databaseName(legacyName), 40);
  old.onupgradeneeded = () => {
    for (const s of image) {
      const os = old.result.createObjectStore(s.name, { keyPath: s.keyPath, autoIncrement: s.autoIncrement });
      for (const index of s.indexes) os.createIndex(index.name, index.keyPath, index);
      s.values.forEach((row, i) => os.put(row, s.keys[i]));
    }
  };
  (await request(old)).close();

  const upgraded = await open(legacyName);
  const list = async (store: IdbMailStore, accountId: number, folder: string) => (await store.threads.list({ view: "all", accountId, folder, limit: 50 })).items.map((t) => t.id);
  expect(await list(upgraded, gmail!, "Label_1")).toEqual([g]);
  const outlook = await outlookAccount(upgraded);
  await upgraded.folders.replace(outlook, [{ key: "F1", path: ["Projects"], selectable: true }]);
  const { inserted: [m] } = await ingest(upgraded, [msg({ accountId: outlook, providerMsgId: "o", inInbox: false, folder: "F1" })]);
  const o = await threadOf(upgraded, "o");
  expect(await list(upgraded, outlook, "F1")).toEqual([o]);
  await upgraded.close();
  expect(await rows(legacyName, "message_folders")).toEqual({ version: IDB_VERSION, values: [{ message_id: m, account_id: outlook, folder: "F1" }] });
  expect((await rows(legacyName, "meta")).values).toContain(LOGICAL_SCHEMA);

  // the folder is read back (a copy that doesn't say keeps it), and goes with its message
  const reopened = await open(legacyName);
  await ingest(reopened, [msg({ accountId: outlook, providerMsgId: "o", inInbox: false, isRead: true })]);
  expect(await list(reopened, outlook, "F1")).toEqual([o]);
  await reopened.sync.remove([m!]);
  expect(await list(reopened, outlook, "F1")).toEqual([]);
  // and with its account (Codex code review #9)
  await ingest(reopened, [msg({ accountId: outlook, providerMsgId: "o2", inInbox: false, folder: "F1" })]);
  await reopened.close();
  expect((await rows(legacyName, "message_folders")).values).toHaveLength(1);
  const last = await open(legacyName);
  await last.accounts.remove(outlook);
  await last.close();
  expect((await rows(legacyName, "message_folders")).values).toEqual([]);
});
