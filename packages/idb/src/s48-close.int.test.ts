import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import { IdbMailStore } from "./store";
import * as schema from "./schema";
import { nodePlatform } from "../../db/src/node-driver";
import { encodeBodyPart } from "@terno/store";
import { msg, withAccounts } from "../../store/src/conformance/fixtures";

function request<T>(r: IDBRequest<T>): Promise<T> { return new Promise((yes, no) => { r.onsuccess = () => yes(r.result); r.onerror = () => no(r.error); }); }
function complete(tx: IDBTransaction): Promise<void> { return new Promise((yes, no) => { tx.oncomplete = () => yes(); tx.onabort = () => no(tx.error); }); }
for (const held of [false, true]) it(`joins native IDB closure after startup cleanup abort${held ? " with admitted reader" : ""}`, async () => {
  const name = `close-${crypto.randomUUID()}`, database = `terno-${name}`;
  let hold = false, entered!: () => void, release!: () => void;
  const started = new Promise<void>((r) => { entered = r; }), resume = new Promise<void>((r) => { release = r; });
  const platform = { ...nodePlatform, async yield() { await nodePlatform.yield(); if (hold) { hold = false; entered(); await resume; } } };
  let store = await IdbMailStore.open({ name, factory: indexedDB, platform, instantSearch: false });
  const [accountId] = await withAccounts(store, 1);
  const result = await store.sync.ingest([msg({ accountId: accountId!, bodyText: "exact cached body\r\n".repeat(3000), bodyState: "full" })], { now: 1, classifier: null, applyFilters: false });
  await store.close();
  const native = await request(indexedDB.open(database));
  const tx = native.transaction(["body_captures", "body_parts"], "readwrite"), done = complete(tx);
  tx.objectStore("body_captures").put({ id: "interrupted-stage", account_id: accountId!, message_id: null, text_parts: 1, html_parts: null, token_parts: 1, ready: 1 }, "interrupted-stage");
  tx.objectStore("body_parts").put({ capture_id: "interrupted-stage", field: 0, ordinal: 0, value: encodeBodyPart("interrupted exact stage") }, ["interrupted-stage", 0, 0]);
  tx.objectStore("body_parts").put({ capture_id: "interrupted-stage", field: 2, ordinal: 0, value: encodeBodyPart("\0interrupted\0exact\0stage\0") }, ["interrupted-stage", 2, 0]);
  await done; native.close();
  const keys = IDBObjectStore.prototype.getAllKeys;
  const fault = vi.spyOn(IDBObjectStore.prototype, "getAllKeys").mockImplementation(function (this: IDBObjectStore, ...args) { const r = keys.apply(this, args); if (this.name === "body_parts") this.transaction.abort(); return r; });
  const close = vi.spyOn(IDBDatabase.prototype, "close");
  let reading: ReturnType<typeof store.threads.get> | undefined, closing: Promise<unknown> | undefined;
  try {
    store = await IdbMailStore.open({ name, factory: indexedDB, platform, instantSearch: !held });
    const indexClose = store.instant ? vi.spyOn(store.instant, "close") : undefined;
    if (held) { hold = true; reading = store.threads.get(result.touched[0]!); await started; }
    let settled = false;
    closing = store.close().then(() => null, (e: unknown) => e).finally(() => { settled = true; });
    const concurrent = store.close().then(() => null, (e: unknown) => e);
    if (held) { await nodePlatform.yield(); await nodePlatform.yield(); expect(settled).toBe(false); expect(close).not.toHaveBeenCalled(); release(); expect((await reading)!.messages[0]!.bodyText === "exact cached body\r\n".repeat(3000)).toBe(true); }
    const error = await closing;
    expect(error).not.toBeNull(); expect(await concurrent).toBe(error);
    expect(close).toHaveBeenCalledTimes(1);
    if (indexClose) expect(indexClose).toHaveBeenCalledTimes(1);
    expect(await store.close().catch((e: unknown) => e)).toBe(error);
    expect(close).toHaveBeenCalledTimes(1);
    fault.mockRestore();
    const reopened = await IdbMailStore.open({ name, factory: indexedDB, platform, instantSearch: false });
    try { expect((await reopened.threads.get(result.touched[0]!))!.messages[0]!.bodyText === "exact cached body\r\n".repeat(3000)).toBe(true); } finally { await reopened.close(); }
  } finally { release(); await Promise.allSettled([reading, closing].filter((x) => x !== undefined)); fault.mockRestore(); await store.instant?.close(); await store.close().catch(() => {}); close.mockRestore(); indexedDB.deleteDatabase(database); }
});

it("does not close the same native IDB connection twice after an uncertain publication acknowledgement", async () => {
  const name = `preclosed-${crypto.randomUUID()}`, store = await IdbMailStore.open({ name, factory: indexedDB, platform: nodePlatform, instantSearch: false });
  const close = vi.spyOn(IDBDatabase.prototype, "close"), persist = schema.persist;
  let injected = false;
  const failure = vi.spyOn(schema, "persist").mockImplementation(async (...args) => {
    await persist(...args);
    if (!injected && [...args[1].writes.keys()].some((table) => table.spec.name === "body_heads")) { injected = true; throw new schema.PartialCommit(new Error("Synthetic acknowledgement loss")); }
  });
  try {
    const [accountId] = await withAccounts(store, 1);
    await expect(store.sync.ingest([msg({ accountId: accountId!, bodyText: "complete exact body ".repeat(3000), bodyState: "full" })], { now: 1, classifier: null, applyFilters: false })).rejects.toThrow();
    expect(injected).toBe(true); expect(close).toHaveBeenCalledTimes(1);
    failure.mockRestore(); await Promise.all([store.close(), store.close()]);
    expect(close).toHaveBeenCalledTimes(1);
  } finally { failure.mockRestore(); await store.close().catch(() => {}); close.mockRestore(); indexedDB.deleteDatabase(`terno-${name}`); }
});
