import "fake-indexeddb/auto";
import { ingest, msg, threadOf, withAccounts } from "@terno/store/conformance";
import { expect, it } from "vitest";
import { databaseName, IDB_VERSION } from "./schema";
import { IdbMailStore } from "./store";
import { legacyBodyUpgrade, physicalImage } from "./test/legacy-stores";

/**
 * Plan 278: version 42 adds `person_rules` and stamps a mailbox that has threads as computed with plan 17's rules: its facts
 * are checked again once (an app's receipt through a sending service stops being a person's), its mail kept. An empty one
 * starts with the current rules.
 */

const platform = { uuid: () => crypto.randomUUID(), yield: async () => {} };
const request = <T,>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const open = (name: string) => IdbMailStore.open({ legacyUpgrade: legacyBodyUpgrade(indexedDB), name, factory: indexedDB, platform, instantSearch: false });
const rows = async (name: string, store: string) => {
  const db = await request(indexedDB.open(databaseName(name)));
  const image = await physicalImage(db);
  db.close();
  return { version: db.version, keys: image.find((s) => s.name === store)?.keys, values: image.find((s) => s.name === store)?.values };
};

/** The image as version 41 wrote it: no person_rules store, logical schema 82, and its facts computed before plan 278. */
async function asVersion41(name: string, legacyName: string, facts?: (thread: Record<string, unknown>) => Record<string, unknown>) {
  const raw = await request(indexedDB.open(databaseName(name)));
  const image = (await physicalImage(raw))
    .filter((s) => s.name !== "person_rules")
    .map((s) => (s.name === "meta" ? { ...s, values: s.values.map((v, i) => (s.keys[i] === "logicalSchema" ? 82 : v)) } : s.name === "threads" && facts ? { ...s, values: s.values.map((v) => facts(v as Record<string, unknown>)) } : s));
  raw.close();
  const old = indexedDB.open(databaseName(legacyName), 41);
  old.onupgradeneeded = () => {
    for (const s of image) {
      const os = old.result.createObjectStore(s.name, { keyPath: s.keyPath, autoIncrement: s.autoIncrement });
      for (const index of s.indexes) os.createIndex(index.name, index.keyPath, index);
      s.values.forEach((row, i) => os.put(row, s.keys[i]));
    }
  };
  (await request(old)).close();
}

it("a version-41 mailbox gains person_rules, and its facts are checked again once: an app's receipt stops being a person's", async () => {
  const name = crypto.randomUUID(), legacyName = crypto.randomUUID();
  const source = await open(name);
  const [account] = await withAccounts(source, 1);
  await ingest(source, [
    msg({ accountId: account!, providerMsgId: "app", from: { name: "App", email: "hello@app.test" }, to: [{ name: "", email: "me0@example.com" }], rfcMessageId: "0100-a@email.amazonses.com" }),
    msg({ accountId: account!, providerMsgId: "ana", from: { name: "Ana", email: "ana@friends.test" }, to: [{ name: "", email: "me0@example.com" }] }),
  ]);
  const app = await threadOf(source, "app"), ana = await threadOf(source, "ana");
  await source.close();
  // before plan 278, the app's receipt was a person's
  await asVersion41(name, legacyName, (t) => (t.id === app ? { ...t, person: 1 } : t));

  const upgraded = await open(legacyName);
  expect(await upgraded.facts.idle()).toBe(false);
  expect((await upgraded.threads.counts(0)).inboxWaiting).toBeNull();
  while ((await upgraded.facts.backfill({ limit: 1 })).more);
  expect(await upgraded.facts.idle()).toBe(true);
  const judged = new Map((await upgraded.threads.summaries([app, ana])).map((t) => [t.id, t.person]));
  expect([judged.get(app), judged.get(ana)]).toEqual([false, true]);
  await upgraded.facts.rules.set({ id: "r", email: "hello@app.test", name: "App", person: true, at: 1 });
  await upgraded.close();
  expect(await rows(legacyName, "person_rules")).toMatchObject({ version: IDB_VERSION, values: [{ key: "hello@app.test", id: "r", person: 1 }] });
  expect((await rows(legacyName, "settings")).values).toContainEqual({ key: "facts_rules", value_json: "2" });
  const reopened = await open(legacyName);
  expect(await reopened.facts.idle()).toBe(true);
  expect((await reopened.threads.summaries([app]))[0]!.person).toBe(true);
  await reopened.close();
});

it("an empty version-41 mailbox starts with the current rules: nothing to check again", async () => {
  const name = crypto.randomUUID(), legacyName = crypto.randomUUID();
  await (await open(name)).close();
  await asVersion41(name, legacyName);
  const upgraded = await open(legacyName);
  expect(await upgraded.facts.idle()).toBe(true);
  await upgraded.close();
  expect((await rows(legacyName, "settings")).keys ?? []).not.toContain("facts_rules");
});
