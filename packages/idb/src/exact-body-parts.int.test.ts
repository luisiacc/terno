import { defineExactBodyLifecycle } from "../../store/src/conformance/exact-body-lifecycle";
import { nodePlatform } from "../../db/src/node-driver";
import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import { msg, withAccounts } from "../../store/src/conformance/fixtures";
import { IdbMailStore } from "./store";

const platform = nodePlatform;

it("persists complete bodies in bounded physical clones and reads exact phrases after reopen", async () => {
  const name = `exact-${crypto.randomUUID()}`;
  let store = await IdbMailStore.open({ name, factory: indexedDB, platform, instantSearch: false });
  const text = `${"alpha e\u0301 😀\r\n".repeat(90000)} boundaryneedle acrossboundary `;
  const html = `<p>${"Exact &amp; complete. ".repeat(90000)}</p>`;
  let largest = 0;
  const put = IDBObjectStore.prototype.put;
  const visit = (value: unknown): void => {
    if (typeof value === "string") largest = Math.max(largest, value.length);
    else if (value && typeof value === "object" && !ArrayBuffer.isView(value) && !(value instanceof ArrayBuffer)) for (const child of Object.values(value)) visit(child);
  };
  const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value, key) { visit(value); return put.call(this, value, key); });
  try {
    const [accountId] = await withAccounts(store, 1);
    await store.filters.save({ name: "boundary match", enabled: true, source: "manual", rule: { match: "all", conditions: [{ field: "body", op: "contains", value: "boundaryneedle acrossboundary" }], actions: [{ type: "star" }] } }, 1);
    const result = await store.sync.ingest([msg({ accountId: accountId!, providerMsgId: "large", bodyText: text, bodyHtml: html, bodyState: "full", attachments: [{ filename: "witness.bin", mime: "application/octet-stream", size: 3, bytes: new Uint8Array([0, 255, 128]) }] })], { now: 1, classifier: null, applyFilters: true });
    const threadId = result.touched[0]!;
    await store.close();
    store = await IdbMailStore.open({ name, factory: indexedDB, platform, instantSearch: false });
    const message = (await store.threads.get(threadId))!.messages[0]!;
    expect(message.bodyText === text).toBe(true);
    expect(message.bodyHtml === html).toBe(true);
    expect(message.isStarred).toBe(true);
    expect(await store.attachments.read(accountId!, message.attachments[0]!.assetId!, 0)).toBe("AP+A");
    expect((await store.threads.searchText({ query: '"boundaryneedle acrossboundary"', now: 1, limit: 10 })).items.map((t) => t.id)).toEqual([threadId]);
    expect(largest, "every physical record clone must use bounded string fields").toBeLessThanOrEqual(32768);
  } finally { spy.mockRestore(); await store.close(); indexedDB.deleteDatabase(`terno-${name}`); }
});

it("keeps parent normalization bounded for an adversarial complete token and falls back to exact search", async () => {
  const store = await IdbMailStore.open({ name: `token-${crypto.randomUUID()}`, factory: indexedDB, platform, instantSearch: true });
  const text = "a\u0301".repeat(200000);
  let largest = 0;
  const normalize = String.prototype.normalize;
  const spy = vi.spyOn(String.prototype, "normalize").mockImplementation(function (this: string, form) { largest = Math.max(largest, this.length); return normalize.call(this, form); });
  try {
    const [accountId] = await withAccounts(store, 1);
    const result = await store.sync.ingest([msg({ accountId: accountId!, bodyText: text, bodyState: "full" })], { now: 1, classifier: null, applyFilters: false });
    const id = result.touched[0]!;
    expect((await store.threads.get(id))!.messages[0]!.bodyText === text).toBe(true);
    await store.instant!.settled();
    expect((await store.threads.searchText({ query: "aaa*", now: 1, limit: 10 })).items.map((t) => t.id)).toEqual([id]);
    expect((await store.threads.searchText({ query: '"aaa"', now: 1, limit: 10 })).items).toEqual([]);
    expect(largest).toBeLessThanOrEqual(32768);
  } finally { spy.mockRestore(); await store.close(); }
});

it("keeps the existing bounded sent-text projection for segmented complete bodies", async () => {
  const store = await IdbMailStore.open({ name: `sent-${crypto.randomUUID()}`, factory: indexedDB, platform, instantSearch: false });
  try {
    const [accountId] = await withAccounts(store, 1);
    const text = "😀a".repeat(40000);
    const result = await store.sync.ingest([msg({ accountId: accountId!, providerMsgId: "sent", isSent: true, size: 200000, bodyText: text, bodyState: "full" })], { now: 1, classifier: null, applyFilters: false });
    const message = (await store.threads.get(result.touched[0]!))!.messages[0]!;
    expect((await store.autocomplete.sentTexts([message.id]))[0]?.text === text.slice(0, 65536)).toBe(true);
    expect((await store.autocomplete.sentAfter(0, 10)).texts[0]?.text === text.slice(0, 65536)).toBe(true);
  } finally { await store.close(); }
});

defineExactBodyLifecycle(async () => {
  const name = `lifetime-${crypto.randomUUID()}`;
  let fail = false;
  const ownedPlatform = { ...platform, async yield() { await platform.yield(); if (fail) { fail = false; throw new Error("Interrupted preparation"); } } };
  const create = () => IdbMailStore.open({ name, factory: indexedDB, platform: ownedPlatform, instantSearch: false });
  let store = await create();
  return { store, async reopen() { await store.close(); return store = await create(); }, async dispose() { indexedDB.deleteDatabase(`terno-${name}`); }, async interrupt(work) { fail = true; await expect(work()).rejects.toThrow("Interrupted preparation"); } };
});

it("retains a replaced capture until its actual token reader finishes, then reclaims it without another command", async () => {
  const name = `reader-${crypto.randomUUID()}`, store = await IdbMailStore.open({ name, factory: indexedDB, platform, instantSearch: false });
  let release: (() => Promise<unknown>) | undefined;
  let build: Awaited<ReturnType<typeof store.feed.beginBuild>> | undefined;
  const remove = IDBObjectStore.prototype.delete;
  let deleted!: () => void;
  const retired = new Promise<void>((resolve) => { deleted = resolve; });
  const spy = vi.spyOn(IDBObjectStore.prototype, "delete").mockImplementation(function (this: IDBObjectStore, key) { const request = remove.call(this, key); if (this.name === "body_captures") this.transaction.addEventListener("complete", deleted, { once: true }); return request; });
  try {
    const [accountId] = await withAccounts(store, 1);
    const result = await store.sync.ingest([msg({ accountId: accountId!, bodyText: "old exact phrase ".repeat(5000), bodyState: "full" })], { now: 1, classifier: null, applyFilters: false });
    const message = (await store.threads.get(result.touched[0]!, { bodyFormat: "parts" }))!.messages[0]!;
    build = await store.feed.beginBuild();
    const pages = build.messages()[Symbol.asyncIterator](), docs = (await pages.next()).value!;
    const reader = docs[0]!.bodyTokenParts!()[Symbol.asyncIterator]();
    await reader.next(); release = async () => reader.return?.();
    await store.sync.setBody(message.id, "new exact phrase ".repeat(5000), null, { now: 2, classifier: null });
    const native = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(`terno-${name}`); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try {
      const count = () => new Promise<number>((resolve, reject) => { const request = native.transaction("body_captures").objectStore("body_captures").count(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      expect(await count()).toBe(2);
      await release(); release = undefined;
      await retired;
      expect(await count()).toBe(1);
    } finally { native.close(); await pages.return?.(); }
  } finally { await release?.(); await build?.release(); spy.mockRestore(); await store.close(); }
});
