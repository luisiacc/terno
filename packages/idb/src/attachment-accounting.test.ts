import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import { createMemDb, openIdb } from "./schema";
import { idbAssets } from "./attachments";
import { IdbMailStore } from "./store";
import { withAccounts } from "@terno/store/conformance";

it("maintains exact usage and bounded orphan traversal through load, rollback and cascades", () => {
  const db = createMemDb(); const assets = idbAssets(db);
  db.tx(() => {
    db.table("accounts").insert({ id: 1 }); db.table("accounts").insert({ id: 2 });
    db.table("drafts").insert({ id: 1, account_id: 1 });
    for (let i = 0; i < 500; i++) db.table("attachment_assets").insert({ id: `old-${i}`, account_id: 1, filename: "x", mime: "text/plain", size: i, created_at: 500 - i, orphan_grace_started_at: 500 - i });
    db.table("attachment_assets").insert({ id: "other", account_id: 2, filename: "x", mime: "text/plain", size: 7, created_at: 0, orphan_grace_started_at: 0 });
    for (let i = 0; i < 500; i += 2) assets.link(`old-${i}`, "draft", 1);
  }); db.confirm();
  const total = 500 * 1024 + 499 * 500 / 2;
  expect(assets.used(1)).toBe(total); expect(assets.used(2)).toBe(1031);
  expect(assets.orphans(1, 1000)).toHaveLength(50);
  expect(() => db.tx(() => { assets.unlink("draft", 1); assets.remove("old-1"); throw new Error("rollback"); })).toThrow("rollback");
  expect(assets.used(1)).toBe(total); expect(assets.orphans(1, 1000).every((id) => Number(id.split("-")[1]) % 2)).toBe(true);
  db.tx(() => assets.unlink("draft", 1)); const commit = db.takeCommit(); expect(commit).toBeTruthy(); db.revert();
  expect(assets.orphans(1, 1000).every((id) => Number(id.split("-")[1]) % 2)).toBe(true);
  db.tx(() => db.table("drafts").delete(1)); db.confirm();
  db.tx(() => assets.beginOrphanGrace(1, 600)); db.confirm();
  expect(assets.orphans(1, 1000)).toHaveLength(50);
  // Anchoring is bounded; finish the remaining pending batches without scanning assets.
  for (let i = 0; i < 4; i++) { db.tx(() => assets.beginOrphanGrace(1, 600)); db.confirm(); }
  let deleted = 0;
  for (;;) {
    const batch = assets.orphans(1, 1000); if (!batch.length) break;
    expect(batch.length).toBeLessThanOrEqual(50);
    db.tx(() => { for (const id of batch) assets.remove(id); }); db.confirm(); deleted += batch.length;
  }
  expect(deleted).toBe(500); expect(assets.used(1)).toBe(0);
  db.tx(() => db.table("accounts").delete(1)); db.confirm();
  expect(assets.used(2)).toBe(1031); expect(assets.orphans(2, 1)).toEqual(["other"]);
});

it("anchors legacy pending rows at most 50 at a time, preserving committed anchors across later rollback", () => {
  const db = createMemDb(); const assets = idbAssets(db);
  db.tx(() => {
    db.table("accounts").insert({ id: 1 });
    for (let i = 0; i < 120; i++) db.table("attachment_assets").insert({ id: `legacy-${i}`, account_id: 1, filename: "x", mime: "text/plain", size: 0, created_at: 0 });
  }); db.confirm();
  expect(assets.orphans(1, 1000)).toEqual([]);
  const pending = () => [...db.table("attachment_assets").all()].filter((r) => r.orphan_grace_started_at === undefined).length;
  db.tx(() => assets.beginOrphanGrace(1, 100)); db.confirm();
  expect(pending()).toBe(70); expect(assets.orphans(1, 101)).toHaveLength(50);
  expect(() => db.tx(() => { assets.beginOrphanGrace(1, 200); assets.remove("legacy-0"); throw new Error("rollback"); })).toThrow("rollback");
  expect(pending()).toBe(70); expect(assets.used(1)).toBe(120 * 1024);
  db.tx(() => assets.beginOrphanGrace(1, 200)); expect(db.takeCommit()).toBeTruthy(); db.revert();
  expect(pending()).toBe(70); expect(assets.orphans(1, 101)).toHaveLength(50);
  db.tx(() => db.table("accounts").delete(1)); db.confirm();
  expect(assets.orphans(1, 1000)).toEqual([]); expect(assets.used(1)).toBe(0);
});

it("upgrades legacy rows on observation and keeps grace across aborted reservation and reopen", async () => {
  const options = { name: crypto.randomUUID(), factory: indexedDB, instantSearch: false, platform: { uuid: () => crypto.randomUUID(), yield: () => Promise.resolve() } };
  let store = await IdbMailStore.open(options);
  try {
    const [a] = await withAccounts(store, 1);
    const ref = await store.attachments.create({ accountId: a!, filename: "old", mime: "text/plain", size: 3, now: 0 });
    await store.attachments.append(a!, ref.assetId, 0, "AP+A"); await store.attachments.seal(a!, ref.assetId);
    const draft = (await store.drafts.save({ accountId: a!, to: [], cc: [], subject: "undo", bodyText: "", attachments: [ref] }, 0))!;
    await store.close();
    const raw = await openIdb(indexedDB, options.name);
    const tx = raw.transaction("attachment_assets", "readwrite");
    const row = tx.objectStore("attachment_assets").get(ref.assetId);
    row.onsuccess = () => { const { orphan_grace_started_at: _, ...legacy } = row.result; tx.objectStore("attachment_assets").put(legacy, ref.assetId); };
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); raw.close();
    store = await IdbMailStore.open(options);
    await store.drafts.delete(draft.id);
    const transaction = IDBDatabase.prototype.transaction;
    let writes = 0;
    const spy = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args) {
      const next = transaction.call(this, ...args);
      if (args[1] === "readwrite" && ++writes === 2) queueMicrotask(() => next.abort());
      return next;
    });
    await expect(store.attachments.create({ accountId: a!, filename: "new", mime: "text/plain", size: 0, now: 172800000 })).rejects.toThrow();
    spy.mockRestore();
    expect(writes).toBe(2);
    expect(await store.attachments.read(a!, ref.assetId, 0)).toBe("AP+A");
    await store.close(); store = await IdbMailStore.open(options);
    const restored = (await store.drafts.save({ accountId: a!, to: [], cc: [], subject: "undo", bodyText: "", attachments: [ref] }, 259200000))!;
    await store.drafts.delete(restored.id);
    await store.attachments.create({ accountId: a!, filename: "observe", mime: "text/plain", size: 0, now: 259200000 });
    await store.close(); store = await IdbMailStore.open(options);
    await store.attachments.create({ accountId: a!, filename: "after grace", mime: "text/plain", size: 0, now: 345600001 });
    await expect(store.attachments.info(a!, ref.assetId)).rejects.toThrow();
  } finally { vi.restoreAllMocks(); await store.close(); }
});
