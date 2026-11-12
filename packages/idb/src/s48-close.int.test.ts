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

it("rejects new body-part admission while joining a held body-part reader", async () => {
  let hold = false, entered!: () => void, release!: () => void;
  const held = new Promise<void>((r) => { entered = r; }), resume = new Promise<void>((r) => { release = r; });
  const platform = { ...nodePlatform, async yield() { await nodePlatform.yield(); if (hold) { hold = false; entered(); await resume; } } };
  const store = await IdbMailStore.open({ name: `closing-parts-${crypto.randomUUID()}`, factory: indexedDB, platform, instantSearch: false });
  let reading: Promise<unknown> | undefined, late: Promise<unknown> | undefined, closing: Promise<void> | undefined;
  try {
    const [accountId] = await withAccounts(store, 1), text = "exact body-part lifecycle ".repeat(3000);
    const r = await store.sync.ingest([msg({ accountId: accountId!, bodyText: text })], { now: 1, classifier: null, applyFilters: false });
    const m = (await store.threads.get(r.touched[0]!, { bodyFormat: "parts" }))!.messages[0]!;
    const request = { messageId: m.id, accountId: accountId!, version: m.bodyReference!.version, field: "text" as const, ordinal: 0 };
    hold = true; reading = store.threads.bodyPart(request); await held;
    let closed = false, refused = false;
    closing = store.close().finally(() => { closed = true; });
    late = store.threads.bodyPart(request).then(() => "admitted", (error: unknown) => { refused = true; return error; });
    await nodePlatform.yield(); await nodePlatform.yield();
    expect(refused, "external work must be rejected at closing admission, before queueing behind the reader").toBe(true);
    expect(closed).toBe(false);
    release(); expect(await reading).toBe(text.slice(0, 32768));
    expect(await late).toBeInstanceOf(Error); await closing;
  } finally { release(); await Promise.allSettled([reading, late, closing].filter((p) => p !== undefined)); await store.close(); }
});

it("refuses every new public body consumer while an admitted native part keeps closing pending", async () => {
  let hold = false, entered!: () => void, release!: () => void;
  const held = new Promise<void>((r) => { entered = r; }), resume = new Promise<void>((r) => { release = r; });
  const platform = { ...nodePlatform, async yield() { await nodePlatform.yield(); if (hold) { hold = false; entered(); await resume; } } };
  const store = await IdbMailStore.open({ name: `closing-consumers-${crypto.randomUUID()}`, factory: indexedDB, platform, instantSearch: false });
  let reading: Promise<unknown> | undefined, closing: Promise<void> | undefined; const late: Promise<unknown>[] = [];
  try {
    const [accountId] = await withAccounts(store, 1);
    const r = await store.sync.ingest([msg({ accountId: accountId!, isSent: true, bodyText: "exact lifecycle phrase ".repeat(3000) })], { now: 1, classifier: null, applyFilters: false });
    const m = (await store.threads.get(r.touched[0]!, { bodyFormat: "parts" }))!.messages[0]!, category = await store.categories.create("Synthetic", "brown");
    const rule = { match: "all" as const, conditions: [{ field: "body" as const, op: "contains" as const, value: "exact lifecycle phrase" }], actions: [{ type: "star" as const }] };
    hold = true; reading = store.threads.bodyPart({ messageId: m.id, accountId: accountId!, version: m.bodyReference!.version, field: "text", ordinal: 0 }); await held;
    closing = store.close();
    const calls = [() => store.threads.searchText({ query: '"exact lifecycle phrase"', now: 1, limit: 10 }), () => store.filters.preview(rule, 1, 10), () => store.filters.matchWindow(rule, 1, { from: m.id, to: m.id }), () => store.filters.matchMessages(rule, 1, [m.id]), () => store.categorize.countScope(category.id, { kind: "query", query: "exact" }, 1), () => store.categorize.resolveScope(category.id, { kind: "query", query: "exact" }, 1, 10), () => store.autocomplete.sentTexts([m.id]), () => store.autocomplete.sentAfter(0, 10), () => store.debug.snapshot(), () => store.folderExport.messages([m.id])];
    const refused: boolean[] = [];
    for (const [i, call] of calls.entries()) late.push(call().then(() => { refused[i] = false; }, (error: unknown) => { refused[i] = error instanceof Error && error.message.includes("closing"); }));
    await nodePlatform.yield(); await nodePlatform.yield();
    expect(refused).toEqual([true, true, true, true, true, true, true, true, true, true]);
    release(); await reading; await Promise.all(late); await closing;
  } finally { release(); await Promise.allSettled([reading, closing, ...late].filter((p) => p !== undefined)); await store.close(); }
});
