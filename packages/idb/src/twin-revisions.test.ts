/**
 * Plan 65 (Codex R32): the IndexedDB twin cache follows only the buckets looked up, at most 10,000 of them, so mail
 * churn and many lookups never pile up keys; letting them all go starts a new generation, so no kept order is stale.
 */
import "fake-indexeddb/auto";
import { ingest, msg, withAccounts } from "@terno/store/conformance";
import { IDBFactory } from "fake-indexeddb";
import { expect, it } from "vitest";
import { twinBucketsWatched } from "./provider-store";
import { IdbMailStore } from "./store";

const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setImmediate(resolve)) };

it("churn and lookups keep the followed buckets bounded, and a kept order is never stale after letting go", async () => {
  const store = await IdbMailStore.open({ factory: new IDBFactory(), name: crypto.randomUUID(), instantSearch: false, platform });
  const db = (store as unknown as { c: { db: object } }).c.db;
  const [, m] = await withAccounts(store);
  const locations = store.providerStore(m!).locations;
  const base = { from: { name: "", email: "ana@example.test" }, date: 1_800_000_000_000, size: 100, rfcMessageId: null };
  const x = await ingest(store, [msg({ accountId: m!, providerMsgId: "x1", subject: "X", ...base })]);
  const ex = { subject: "X", fromEmail: "ana@example.test", date: base.date, size: base.size };
  expect(await locations.twins(ex, 0, 50)).toEqual(x.inserted);
  // 2,000 other messages in and out: nothing more followed
  const churn = await ingest(store, Array.from({ length: 2000 }, (_, i) => msg({ accountId: m!, providerMsgId: `c${i}`, subject: `C${i}`, ...base })));
  await store.sync.remove(churn.inserted);
  expect(twinBucketsWatched(db)).toBe(1);
  // 12,000 lookups of other envelopes: at most 10,000 followed
  for (let i = 0; i < 12_000; i++) await locations.twins({ ...ex, subject: `L${i}` }, 0, 50);
  expect(twinBucketsWatched(db)).toBeLessThanOrEqual(10_000);
  // X's bucket changes after it was let go: its next lookup is exact
  const x2 = await ingest(store, [msg({ accountId: m!, providerMsgId: "x2", subject: "X", ...base })]);
  expect(await locations.twins(ex, 0, 50)).toEqual([...x.inserted, ...x2.inserted]);
  await store.close();
}, 120_000);
