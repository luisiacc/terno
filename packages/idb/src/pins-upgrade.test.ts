import "fake-indexeddb/auto";
import { ingest, msg, threadOf, withAccounts } from "@terno/store/conformance";
import { expect, it } from "vitest";
import { databaseName, LOGICAL_SCHEMA } from "./schema";
import { IdbMailStore } from "./store";
import { legacyBodyUpgrade, physicalImage } from "./test/legacy-stores";

/** Plan 177: version 33 adds `pins`. A version-32 mailbox (mail and a reminder in it) opens with an empty one, the rest kept. */

const platform = { uuid: () => crypto.randomUUID(), yield: async () => {} };
const request = <T,>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const open = (name: string) => IdbMailStore.open({ legacyUpgrade: legacyBodyUpgrade(indexedDB), name, factory: indexedDB, platform, instantSearch: false });

it("a version-32 mailbox gains an empty pins store; its mail and reminders stay, and pins work after", async () => {
  const name = crypto.randomUUID(), legacyName = crypto.randomUUID();
  const source = await open(name);
  const [account] = await withAccounts(source, 1);
  await ingest(source, [msg({ accountId: account!, providerMsgId: "x", rfcMessageId: "x@t" }), msg({ accountId: account!, providerMsgId: "y", rfcMessageId: "y@t" })]);
  const x = await threadOf(source, "x");
  await source.reminders.put([{ threadId: x, dueAt: 2e12, kind: "always", setAt: 1e12 }], 10);
  await source.close();
  // the same image as version 32 wrote it: no pins store, the logical schema before it
  const raw = await request(indexedDB.open(databaseName(name)));
  const image = (await physicalImage(raw)).filter((s) => s.name !== "pins").map((s) => (s.name === "meta" ? { ...s, values: s.values.map((v, i) => (s.keys[i] === "logicalSchema" ? LOGICAL_SCHEMA - 1 : v)) } : s));
  raw.close();
  const old = indexedDB.open(databaseName(legacyName), 32);
  old.onupgradeneeded = () => {
    for (const s of image) {
      const os = old.result.createObjectStore(s.name, { keyPath: s.keyPath, autoIncrement: s.autoIncrement });
      for (const index of s.indexes) os.createIndex(index.name, index.keyPath, index);
      s.values.forEach((row, i) => os.put(row, s.keys[i]));
    }
  };
  (await request(old)).close();

  const upgraded = await open(legacyName);
  expect(await upgraded.pins.list()).toEqual([]);
  expect((await upgraded.reminders.list()).map((r) => r.threadId)).toEqual([x]);
  expect(await upgraded.threads.summaries([x])).toHaveLength(1);
  expect(await upgraded.pins.add([{ threadId: x, pinnedAt: 5 }], 10)).toEqual({ ok: true, added: [{ threadId: x, pinnedAt: 5 }] });
  await upgraded.close();
  const reopened = await open(legacyName);
  expect(await reopened.pins.list()).toEqual([{ threadId: x, pinnedAt: 5 }]);
  const db = await request(indexedDB.open(databaseName(legacyName)));
  expect(db.version).toBe(33);
  db.close();
  await reopened.close();
});
