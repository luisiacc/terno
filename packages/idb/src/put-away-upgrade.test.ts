import "fake-indexeddb/auto";
import { ingest, msg, threadOf, withAccounts } from "@terno/store/conformance";
import { expect, it } from "vitest";
import { databaseName, IDB_VERSION, LOGICAL_SCHEMA } from "./schema";
import { IdbMailStore } from "./store";
import { legacyBodyUpgrade, physicalImage } from "./test/legacy-stores";

/**
 * Plan 282: version 43 adds `placements` and `cls_kept_senders`. A version-42 mailbox (mail, a rule and its claims, a
 * category) opens with both empty, the rest kept; a rule archiving new mail after the upgrade puts it away.
 */

const NOW = Date.UTC(2026, 10, 25, 12);
const platform = { uuid: () => crypto.randomUUID(), yield: async () => {} };
const request = <T,>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const open = (name: string) => IdbMailStore.open({ legacyUpgrade: legacyBodyUpgrade(indexedDB), name, factory: indexedDB, platform, instantSearch: false });

it("a version-42 mailbox gains empty placements and kept senders; its mail, rules and claims stay, and Put away works after", async () => {
  const name = crypto.randomUUID(), legacyName = crypto.randomUUID();
  const source = await open(name);
  const [account] = await withAccounts(source, 1);
  const filter = await source.filters.save({ name: "Xataka", enabled: true, source: "manual", rule: { match: "all", conditions: [{ field: "from", op: "equals", value: "news@xataka.test" }], actions: [{ type: "archive" }] } }, NOW);
  await ingest(source, [msg({ accountId: account!, providerMsgId: "old", from: { name: "Xataka", email: "news@xataka.test" } })]);
  const old = await threadOf(source, "old");
  await source.close();
  // the same image as version 42 wrote it: no placements or kept senders, logical schema 83
  const raw = await request(indexedDB.open(databaseName(name)));
  const image = (await physicalImage(raw)).filter((s) => s.name !== "placements" && s.name !== "cls_kept_senders").map((s) => (s.name === "meta" ? { ...s, values: s.values.map((v, i) => (s.keys[i] === "logicalSchema" ? 83 : v)) } : s));
  raw.close();
  const claims = image.find((s) => s.name === "filter_applications")!.values;
  const legacy = indexedDB.open(databaseName(legacyName), 42);
  legacy.onupgradeneeded = () => {
    for (const s of image) {
      const os = legacy.result.createObjectStore(s.name, { keyPath: s.keyPath, autoIncrement: s.autoIncrement });
      for (const index of s.indexes) os.createIndex(index.name, index.keyPath, index);
      s.values.forEach((row, i) => os.put(row, s.keys[i]));
    }
  };
  (await request(legacy)).close();

  const upgraded = await open(legacyName);
  expect((await upgraded.threads.summaries([old]))[0]!.inInbox).toBe(false);
  expect((await upgraded.filters.list()).map((f) => f.id)).toEqual([filter.id]);
  expect(await upgraded.putAway.page({ now: NOW, limit: 10 })).toEqual({ items: [], next: null });
  await upgraded.sync.ingest([msg({ accountId: account!, providerMsgId: "new", from: { name: "Xataka", email: "news@xataka.test" }, date: NOW - 1 })], { applyFilters: true, now: NOW, classifier: null });
  const fresh = await threadOf(upgraded, "new");
  expect(await upgraded.putAway.of(fresh, NOW)).toMatchObject({ detail: { by: "rule", filterId: filter.id, action: "archive" } });
  await upgraded.close();
  const after = await request(indexedDB.open(databaseName(legacyName)));
  const stores = await physicalImage(after);
  after.close();
  expect(after.version).toBe(IDB_VERSION);
  expect(stores.find((s) => s.name === "placements")!.values).toHaveLength(1);
  expect(stores.find((s) => s.name === "cls_kept_senders")!.values).toEqual([]);
  // the claims from before are all still there
  expect(stores.find((s) => s.name === "filter_applications")!.values).toEqual(expect.arrayContaining(claims));
  expect(stores.find((s) => s.name === "meta")!.values).toContain(LOGICAL_SCHEMA);
});
