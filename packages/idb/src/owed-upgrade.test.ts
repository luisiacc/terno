import "fake-indexeddb/auto";
import { ingest, msg, threadOf, withAccounts } from "@terno/store/conformance";
import { expect, it } from "vitest";
import { databaseName, IDB_VERSION, LOGICAL_SCHEMA } from "./schema";
import { IdbMailStore } from "./store";
import { legacyBodyUpgrade, physicalImage } from "./test/legacy-stores";

/**
 * Plan 280: version 44 adds `ai_owed_mail` (the follow-ups reader's marks of received mail). A version-43 mailbox with a
 * follow-up opens with an empty one, the follow-up kept and read as a firm promise with none of the new fields.
 */

const platform = { uuid: () => crypto.randomUUID(), yield: async () => {} };
const request = <T,>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const open = (name: string) => IdbMailStore.open({ legacyUpgrade: legacyBodyUpgrade(indexedDB), name, factory: indexedDB, platform, instantSearch: false });
const rows = async (name: string, store: string) => {
  const db = await request(indexedDB.open(databaseName(name)));
  const image = await physicalImage(db);
  db.close();
  return { version: db.version, names: image.map((s) => s.name), values: image.find((s) => s.name === store)?.values };
};

it("a version-43 mailbox gains an empty ai_owed_mail store; its follow-ups stay and read as firm promises", async () => {
  const name = crypto.randomUUID(), legacyName = crypto.randomUUID();
  const source = await open(name);
  const [account] = await withAccounts(source, 1);
  await ingest(source, [msg({ accountId: account!, providerMsgId: "a" })]);
  const thread = await threadOf(source, "a");
  await source.close();
  // the same image as version 43 wrote it: no ai_owed_mail store, logical schema 84, one promise of yours
  const raw = await request(indexedDB.open(databaseName(name)));
  const promise = { id: 1, thread_id: thread, message_id: 1, item: 0, kind: "promise", text: "send the deck", quote: "I'll send it", person_name: "Ana", person_email: "ana@x.mx", sent_at: 1, due_at: 5, dated: 1, state: "open", inbox_state: "none", from_scan: 0, revision: 2, created_at: 2 };
  const image = (await physicalImage(raw))
    .filter((s) => s.name !== "ai_owed_mail")
    .map((s) => (s.name === "meta" ? { ...s, values: s.values.map((v, i) => (s.keys[i] === "logicalSchema" ? 84 : v)) } : s.name === "followups" ? { ...s, keys: [1], values: [promise] } : s));
  raw.close();
  const old = indexedDB.open(databaseName(legacyName), 43);
  old.onupgradeneeded = () => {
    for (const s of image) {
      const os = old.result.createObjectStore(s.name, { keyPath: s.keyPath, autoIncrement: s.autoIncrement });
      for (const index of s.indexes) os.createIndex(index.name, index.keyPath, index);
      s.values.forEach((row, i) => os.put(row, s.keys[i]));
    }
  };
  (await request(old)).close();

  const upgraded = await open(legacyName);
  const [row] = await upgraded.followups.active();
  expect(row).toMatchObject({ id: 1, kind: "promise", text: "send the deck", revision: 2, firm: true, dueDay: null, personKey: null, arrivedHint: null });
  await upgraded.close();
  const after = await rows(legacyName, "ai_owed_mail");
  expect(after).toMatchObject({ version: IDB_VERSION, values: [] });
  expect(after.names).toContain("ai_owed_mail");
  expect((await rows(legacyName, "meta")).values).toContain(LOGICAL_SCHEMA);
});
