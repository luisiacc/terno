import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import { ATTACHMENT_CHUNK } from "@terno/core";
import { withAccounts } from "@terno/store/conformance";
import { IdbMailStore } from "./store";
import { openIdb } from "./schema";
import { assetAccounting } from "./asset-accounting";
import type { MemDb } from "./mem";

it("persists partial cold-byte deletion, fences owners, and resumes a reverted final step after reopen", async () => {
  let interrupt = false;
  const options = { name: crypto.randomUUID(), factory: indexedDB, instantSearch: false, platform: { uuid: () => crypto.randomUUID(), yield: async () => { if (interrupt) throw new Error("interrupted cleanup"); } } };
  let store = await IdbMailStore.open(options);
  const counts = async () => {
    const raw = await openIdb(indexedDB, options.name);
    try { return await Promise.all(["attachment_assets", "attachment_chunks", "attachment_bytes"].map((name) => new Promise<number>((resolve, reject) => {
      const r = raw.transaction(name).objectStore(name).count(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    }))); } finally { raw.close(); }
  };
  try {
    const [a] = await withAccounts(store, 1), size = ATTACHMENT_CHUNK * 9, data = btoa(String.fromCharCode(...new Uint8Array(ATTACHMENT_CHUNK).fill(90)));
    const ref = await store.attachments.create({ accountId: a!, filename: "expired", mime: "application/octet-stream", size, now: 0 });
    for (let i = 0; i < 9; i++) await store.attachments.append(a!, ref.assetId, i, data);
    await store.attachments.seal(a!, ref.assetId);
    const create = () => store.attachments.create({ accountId: a!, filename: "next", mime: "text/plain", size: 0, now: 172800000 });
    interrupt = true;
    await expect(create()).rejects.toThrow("interrupted cleanup");
    expect(await counts()).toEqual([1, 1, 1]);
    let mem = Reflect.get(store, "db") as MemDb;
    expect(assetAccounting(mem).used(a!)).toBe(size + 1024);
    expect(mem.table("attachment_assets").get(ref.assetId)?.complete).toBe(-1);
    expect(mem.table("attachment_bytes").absent.size).toBe(0);
    interrupt = false;
    await store.close(); store = await IdbMailStore.open(options); await store.whenLoaded();
    for (const action of [
      () => store.attachments.info(a!, ref.assetId), () => store.attachments.read(a!, ref.assetId, 8),
      () => store.attachments.append(a!, ref.assetId, 8, data), () => store.attachments.seal(a!, ref.assetId), () => store.attachments.discard(a!, ref.assetId),
      () => store.drafts.save({ accountId: a!, to: [], cc: [], subject: "owner", bodyText: "", attachments: [ref] }, 1),
      () => store.compose.queueSend({ accountId: a!, to: [], cc: [], bcc: [], subject: "owner", bodyText: "", attachments: [ref], recordReply: false, now: 1 }),
    ]) await expect(action()).rejects.toThrow();
    const transaction = IDBDatabase.prototype.transaction;
    let writes = 0;
    const spy = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args) {
      const tx = transaction.call(this, ...args);
      if (args[1] === "readwrite" && ++writes === 1) queueMicrotask(() => tx.abort());
      return tx;
    });
    try { await expect(create()).rejects.toThrow(); } finally { spy.mockRestore(); }
    expect(writes).toBe(1);
    expect(await counts()).toEqual([1, 1, 1]);
    mem = Reflect.get(store, "db") as MemDb;
    expect(assetAccounting(mem).used(a!)).toBe(size + 1024);
    expect(mem.table("attachment_assets").get(ref.assetId)?.complete).toBe(-1);
    const raw = await openIdb(indexedDB, options.name);
    try {
      const bytes = await new Promise<{ data_base64: string }>((resolve, reject) => { const r = raw.transaction("attachment_bytes").objectStore("attachment_bytes").get(`${ref.assetId}:8`); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      expect(bytes.data_base64).toBe(data);
    } finally { raw.close(); }
    await store.close(); store = await IdbMailStore.open(options); await store.whenLoaded();
    await create();
    expect(await counts()).toEqual([1, 0, 0]);
    mem = Reflect.get(store, "db") as MemDb;
    expect(assetAccounting(mem).used(a!)).toBe(1024);
    expect(mem.table("attachment_bytes").absent.size).toBe(0);
    await store.debug.verify();
  } finally { vi.restoreAllMocks(); await store.close(); }
});

it("rechecks live owners and pending Undo grace after yielding, without accepting mutated admission inputs", async () => {
  let between: (() => Promise<void>) | undefined;
  const options = { name: crypto.randomUUID(), factory: indexedDB, instantSearch: false, platform: { uuid: () => crypto.randomUUID(), yield: async () => { const fn = between; between = undefined; await fn?.(); } } };
  const store = await IdbMailStore.open(options);
  try {
    const [a] = await withAccounts(store, 1);
    const refs = [];
    for (let i = 0; i < 3; i++) {
      const ref = await store.attachments.create({ accountId: a!, filename: "old", mime: "text/plain", size: 3, now: 0 });
      await store.attachments.append(a!, ref.assetId, 0, "AP+A"); await store.attachments.seal(a!, ref.assetId); refs.push(ref);
    }
    const mem = Reflect.get(store, "db") as MemDb, ids = assetAccounting(mem).aged(a!, 1);
    const pin = refs.find((r) => r.assetId === ids[1])!, grace = refs.find((r) => r.assetId === ids[2])!;
    const request = { accountId: a!, filename: "requested", mime: "text/plain", size: 0, now: 172800000 };
    between = async () => {
      await store.drafts.save({ accountId: a!, to: [], cc: [], subject: "pin", bodyText: "", attachments: [pin] }, 1);
      const d = (await store.drafts.save({ accountId: a!, to: [], cc: [], subject: "undo", bodyText: "", attachments: [grace] }, 1))!;
      await store.drafts.delete(d.id);
      request.size = 19 * 1024 * 1024; request.filename = "mutated";
    };
    expect(await store.attachments.create(request)).toMatchObject({ filename: "requested", size: 0 });
    for (const r of [pin, grace]) expect(await store.attachments.read(a!, r.assetId, 0)).toBe("AP+A");
  } finally { await store.close(); }
});
