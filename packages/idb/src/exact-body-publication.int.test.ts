import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import { nodePlatform } from "../../db/src/node-driver";
import { msg, withAccounts } from "../../store/src/conformance/fixtures";
import { IdbMailStore } from "./store";
import * as schema from "./schema";

function gate() {
  let release!: () => void;
  return { promise: new Promise<void>((resolve) => { release = resolve; }), get release() { return release; } };
}
function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error); });
}

it("keeps a queued local publication's exact parts when cleanup queues behind an active native body read", async () => {
  const name = `publication-${crypto.randomUUID()}`, entered = gate(), release = gate();
  let hold = false, armed = false, reader: Promise<unknown> | undefined, capture: string | undefined, cleanupScans = 0;
  const platform = { ...nodePlatform, async yield() { await nodePlatform.yield(); if (hold) { hold = false; entered.release(); await release.promise; } } };
  let store = await IdbMailStore.open({ name, factory: indexedDB, platform, instantSearch: false });
  const native = await request(indexedDB.open(`terno-${name}`));
  const put = IDBObjectStore.prototype.put, keys = IDBObjectStore.prototype.getAllKeys;
  const spies: { mockRestore(): void }[] = [];
  let sending: ReturnType<typeof store.compose.queueSend> | undefined;
  try {
    const [accountId] = await withAccounts(store, 1);
    const old = await store.sync.ingest([msg({ accountId: accountId!, bodyText: "held native read ".repeat(4000), bodyState: "full" })], { now: 1, classifier: null, applyFilters: false });
    spies.push(vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value, key) {
      const result = put.call(this, value, key);
      if (armed && this.name === "body_captures" && value.ready === 1) {
        armed = false; capture = value.id;
        this.transaction.addEventListener("complete", () => { hold = true; reader = store.threads.get(old.touched[0]!); }, { once: true });
      }
      return result;
    }));
    spies.push(vi.spyOn(IDBObjectStore.prototype, "getAllKeys").mockImplementation(function (this: IDBObjectStore, range, count) {
      if (this.name === "body_parts" && range instanceof IDBKeyRange && Array.isArray(range.lower) && range.lower[0] === capture) cleanupScans++;
      return keys.call(this, range, count);
    }));
    const asset = await store.attachments.create({ accountId: accountId!, filename: "exact.bin", mime: "application/octet-stream", size: 3, now: 1 });
    await store.attachments.append(accountId!, asset.assetId!, 0, "AP+A"); await store.attachments.seal(accountId!, asset.assetId!);
    const text = "😀 exact publication phrase\r\n".repeat(3000), html = `<p>${text}</p>`;
    armed = true;
    sending = store.compose.queueSend({ accountId: accountId!, to: [{ name: "", email: "synthetic@example.test" }], cc: [], bcc: [], subject: "synthetic", bodyText: text, bodyHtml: html, attachments: [asset], recordReply: false, now: 2 });
    await entered.promise;
    // A real native read completes while the store's exclusive body reader holds publication queued.
    await request(native.transaction("body_parts").objectStore("body_parts").count());
    release.release(); await reader;
    const sent = await sending;
    await store.close();
    store = await IdbMailStore.open({ name, factory: indexedDB, platform, instantSearch: false });
    const message = (await store.threads.get(sent.threadId))!.messages[0]!;
    expect(message.bodyText === text && message.bodyHtml === html).toBe(true);
    expect(await store.attachments.read(accountId!, message.attachments[0]!.assetId!, 0)).toBe("AP+A");
    expect(cleanupScans, "a publishing capture must remain protected from orphan scans").toBe(0);
    expect((await store.threads.searchText({ query: '"exact publication phrase"', now: 2, limit: 10 })).items.map((row) => row.id)).toEqual([sent.threadId]);
    expect(await request(native.transaction("body_heads").objectStore("body_heads").count())).toBe(2);
    expect(await request(native.transaction("body_parts").objectStore("body_parts").count(IDBKeyRange.bound([capture!], [capture!, 3])))).toBeGreaterThan(0);
  } finally {
    release.release(); await Promise.allSettled([reader, sending].filter((p) => p !== undefined));
    for (const spy of spies) spy.mockRestore(); native.close(); await store.close(); indexedDB.deleteDatabase(`terno-${name}`);
  }
});


it("rechecks reader ownership inside deletion after a native orphan-key read", async () => {
  const name = `cleanup-reader-${crypto.randomUUID()}`, store = await IdbMailStore.open({ name, factory: indexedDB, platform: nodePlatform, instantSearch: false });
  let reader: AsyncIterator<string> | undefined, first: Promise<IteratorResult<string>> | undefined;
  let build: Awaited<ReturnType<typeof store.feed.beginBuild>> | undefined;
  let spy: { mockRestore(): void } | undefined;
  try {
    const [accountId] = await withAccounts(store, 1), text = "old exact phrase ".repeat(5000);
    const result = await store.sync.ingest([msg({ accountId: accountId!, bodyText: text, bodyState: "full" })], { now: 1, classifier: null, applyFilters: false });
    build = await store.feed.beginBuild();
    const pages = build.messages()[Symbol.asyncIterator](), docs = (await pages.next()).value!;
    await pages.return?.();
    const message = (await store.threads.get(result.touched[0]!, { bodyFormat: "parts" }))!.messages[0]!;
    const keys = IDBObjectStore.prototype.getAllKeys;
    let selected = false;
    spy = vi.spyOn(IDBObjectStore.prototype, "getAllKeys").mockImplementation(function (this: IDBObjectStore, range, count) {
      const request = keys.call(this, range, count);
      if (!selected && this.name === "body_parts" && range instanceof IDBKeyRange && Array.isArray(range.lower) && range.lower[0] === message.bodyReference!.version) {
        selected = true;
        request.addEventListener("success", () => { const active = docs[0]!.bodyTokenParts!()[Symbol.asyncIterator](); reader = active; first = active.next(); }, { once: true });
      }
      return request;
    });
    await store.sync.setBody(message.id, "new committed phrase ".repeat(4000), null, { now: 2, classifier: null });
    expect(selected).toBe(true);
    let tokens = (await first!)!.value ?? "";
    for (;;) { const part = await reader!.next(); if (part.done) break; tokens += part.value; }
    expect(tokens === `\0${"old\0exact\0phrase\0".repeat(5000)}`).toBe(true);
    expect((await store.threads.get(result.touched[0]!))!.messages[0]!.bodyText === "new committed phrase ".repeat(4000)).toBe(true);
  } finally { await reader?.return?.(); spy?.mockRestore(); await build?.release(); await store.close(); indexedDB.deleteDatabase(`terno-${name}`); }
});


for (const mode of ["abort", "cancel", "ack"] as const) it(`retains acknowledged body responsibility after native publication ${mode} and reopen`, async () => {
  const name = `publication-${mode}-${crypto.randomUUID()}`;
  let store = await IdbMailStore.open({ name, factory: indexedDB, platform: nodePlatform, instantSearch: false });
  const abort = new AbortController(), spies: { mockRestore(): void }[] = [];
  const old = "old cached bytes ".repeat(4000), next = "😀 new exact phrase\r\n".repeat(4000);
  try {
    const [accountId] = await withAccounts(store, 1);
    const result = await store.sync.ingest([msg({ accountId: accountId!, bodyText: old, bodyHtml: `<p>${old}</p>`, bodyState: "full", isStarred: true, attachments: [{ filename: "old.bin", mime: "application/octet-stream", size: 3, bytes: new Uint8Array([0, 255, 128]) }] })], { now: 1, classifier: null, applyFilters: false });
    const message = (await store.threads.get(result.touched[0]!))!.messages[0]!;
    let injected = false;
    if (mode === "ack") {
      const persist = schema.persist;
      spies.push(vi.spyOn(schema, "persist").mockImplementation(async (...args) => {
        await persist(...args);
        if (!injected && [...args[1].writes.keys()].some((table) => table.spec.name === "body_heads")) { injected = true; throw new schema.PartialCommit(new Error("Synthetic lost publication acknowledgement")); }
      }));
    } else {
      const put = IDBObjectStore.prototype.put;
      spies.push(vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value, key) {
        const request = put.call(this, value, key);
        if (!injected && (mode === "abort" ? this.name === "body_heads" : this.name === "body_captures" && value.ready === 1)) {
          injected = true;
          if (mode === "abort") this.transaction.abort();
          else this.transaction.addEventListener("complete", () => abort.abort(new DOMException("Synthetic cancellation", "AbortError")), { once: true });
        }
        return request;
      }));
    }
    await expect(store.sync.setBody(message.id, next, `<p>${next}</p>`, { now: 2, classifier: null, check: () => abort.signal.throwIfAborted() })).rejects.toThrow();
    expect(injected).toBe(true);
    for (const spy of spies) spy.mockRestore();
    await store.close();
    store = await IdbMailStore.open({ name, factory: indexedDB, platform: nodePlatform, instantSearch: false });
    const complete = (await store.threads.get(result.touched[0]!))!.messages[0]!, expected = mode === "ack" ? next : old;
    expect(complete.bodyText === expected && complete.bodyHtml === `<p>${expected}</p>`).toBe(true);
    expect(complete.isStarred).toBe(true);
    expect(await store.attachments.read(accountId!, complete.attachments[0]!.assetId!, 0)).toBe("AP+A");
    await store.close();
    const native = await request(indexedDB.open(`terno-${name}`));
    try { expect(await request(native.transaction("body_captures").objectStore("body_captures").count())).toBe(1); expect(await request(native.transaction("body_heads").objectStore("body_heads").count())).toBe(1); }
    finally { native.close(); }
  } finally { for (const spy of spies) spy.mockRestore(); await store.close(); indexedDB.deleteDatabase(`terno-${name}`); }
});
