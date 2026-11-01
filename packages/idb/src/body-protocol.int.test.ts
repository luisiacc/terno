import { expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { nodePlatform } from "../../db/src/node-driver";
import { IdbMailStore } from "./store";
import * as schema from "./schema";
import { msg, withAccounts } from "../../store/src/conformance/fixtures";

for (const operation of ["ingest", "setBody"] as const) it(`publishes exact ${operation} content with the filter definition acknowledged during token preparation`, async () => {
  const name = `protocol-${crypto.randomUUID()}`;
  let entered!: () => void, release!: () => void;
  const held = new Promise<void>((r) => { entered = r; }), resume = new Promise<void>((r) => { release = r; });
  let armed = false, tokenRead = false;
  const platform = { ...nodePlatform, async yield() { await nodePlatform.yield(); if (armed && tokenRead) { armed = false; entered(); await resume; } } };
  const store = await IdbMailStore.open({ name, factory: indexedDB, platform, instantSearch: false });
  const get = IDBObjectStore.prototype.get;
  const spy = vi.spyOn(IDBObjectStore.prototype, "get").mockImplementation(function (this: IDBObjectStore, key) {
    const request = get.call(this, key);
    if (this.name === "body_parts" && Array.isArray(key) && key[1] === 2) request.addEventListener("success", () => { tokenRead = true; }, { once: true });
    return request;
  });
  let pending: Promise<unknown> | undefined;
  try {
    const [accountId] = await withAccounts(store, 1);
    const filter = await store.filters.save({ name: "live definition", enabled: true, source: "manual", rule: { match: "all", conditions: [{ field: "body", op: "contains", value: "alpha" }], actions: [{ type: "star" }] } }, 1);
    const initial = operation === "setBody" ? await store.sync.ingest([msg({ accountId: accountId!, bodyText: "old cached content", bodyState: "partial" })], { now: 1, classifier: null, applyFilters: false }) : undefined;
    const messageId = initial ? (await store.threads.get(initial.touched[0]!))!.messages[0]!.id : undefined;
    const text = "😀 beta exact\r\n".repeat(5000), html = `<p>${text}</p>`;
    tokenRead = false; armed = true;
    pending = messageId === undefined ? store.sync.ingest([msg({ accountId: accountId!, bodyText: text, bodyHtml: html, bodyState: "full" })], { now: 2, classifier: null, applyFilters: true }) : store.sync.setBody(messageId, text, html, { now: 2, classifier: null });
    const outcome = pending.then(() => null, (error: unknown) => error);
    await held;
    await store.filters.save({ ...filter, rule: { ...filter.rule, conditions: [{ field: "body", op: "contains", value: "beta exact" }] } }, 3);
    release();
    expect(await outcome).toBeNull();
    const result = await store.threads.searchText({ query: '"beta exact"', now: 4, limit: 10 });
    expect(result.items).toHaveLength(1);
    const message = (await store.threads.get(result.items[0]!.id))!.messages[0]!;
    expect(message.bodyText === text && message.bodyHtml === html).toBe(true);
    expect(message.isStarred).toBe(true);
  } finally { release(); await Promise.allSettled(pending ? [pending] : []); spy.mockRestore(); await store.close(); indexedDB.deleteDatabase(`terno-${name}`); }
});

for (const conflict of ["reset", "writer"] as const) it(`rejects ${conflict} at the physical body transaction authority read without replacing cached responsibility`, async () => {
  const name = `authority-${crypto.randomUUID()}`, abort = new AbortController();
  let store = await IdbMailStore.open({ name, factory: indexedDB, platform: nodePlatform, instantSearch: false });
  let peer: IdbMailStore | undefined, pending: Promise<unknown> | undefined;
  let entered!: () => void, release!: () => void;
  const held = new Promise<void>((r) => { entered = r; }), resume = new Promise<void>((r) => { release = r; });
  const spies: { mockRestore(): void }[] = [];
  let injected = false, armed = false;
  try {
    const [accountId] = await withAccounts(store, 1);
    const old = "old complete cached body\r\n".repeat(3000);
    const result = await store.sync.ingest([msg({ accountId: accountId!, bodyText: old, bodyHtml: `<p>${old}</p>`, bodyState: "full", attachments: [{ filename: "old.bin", mime: "application/octet-stream", size: 3, bytes: new Uint8Array([0, 255, 128]) }] })], { now: 1, classifier: null, applyFilters: false });
    const message = (await store.threads.get(result.touched[0]!))!.messages[0]!;
    if (conflict === "writer") peer = await IdbMailStore.open({ name, factory: indexedDB, platform: nodePlatform, instantSearch: false });
    const persist = schema.persist, get = IDBObjectStore.prototype.get;
    spies.push(vi.spyOn(schema, "persist").mockImplementation(async (...args) => {
      if (!injected && [...args[1].writes.keys()].some((t) => t.spec.name === "body_heads")) {
        injected = true;
        if (conflict === "writer") { entered(); await resume; }
        else armed = true;
      }
      return persist(...args);
    }));
    spies.push(vi.spyOn(IDBObjectStore.prototype, "get").mockImplementation(function (this: IDBObjectStore, key) {
      const request = get.call(this, key);
      if (armed && this.name === "body_protocol") {
        armed = false;
        request.addEventListener("success", () => abort.abort(new DOMException("Synthetic captured reset", "AbortError")), { once: true });
      }
      return request;
    }));
    pending = store.sync.setBody(message.id, "new exact body ".repeat(4000), null, { now: 2, classifier: null, check: () => abort.signal.throwIfAborted() });
    const outcome = pending.then(() => null, (error: unknown) => error);
    if (peer) {
      await held;
      await peer.filters.save({ name: "committed other writer", enabled: true, source: "manual", rule: { match: "all", conditions: [{ field: "body", op: "contains", value: "new" }], actions: [{ type: "star" }] } }, 3);
      release();
    }
    const error = await outcome;
    expect(error).toBeTruthy();
    if (conflict === "writer") expect(error).toMatchObject({ code: "STALE" });
    else expect(abort.signal.aborted).toBe(true);
    expect(injected).toBe(true);
    for (const spy of spies) spy.mockRestore();
    await store.close(); await peer?.close(); peer = undefined;
    store = await IdbMailStore.open({ name, factory: indexedDB, platform: nodePlatform, instantSearch: false });
    const current = (await store.threads.get(result.touched[0]!))!.messages[0]!;
    expect(current.bodyText === old && current.bodyHtml === `<p>${old}</p>`).toBe(true);
    expect(current.isStarred).toBe(false);
    expect(await store.attachments.read(accountId!, current.attachments[0]!.assetId!, 0)).toBe("AP+A");
  } finally { release(); await Promise.allSettled(pending ? [pending] : []); for (const spy of spies) spy.mockRestore(); await peer?.close(); await store.close(); indexedDB.deleteDatabase(`terno-${name}`); }
});
