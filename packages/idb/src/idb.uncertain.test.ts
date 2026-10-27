import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { ingest, memoryFiles, msg, withAccounts } from "@terno/store/conformance";
import { expect, it, vi } from "vitest";
import { databaseName } from "./schema";
import { IdbMailStore } from "./store";
import { UncertainWriteError } from "./uncertainty";

const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setImmediate(resolve)) };
const request = <T,>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

for (const instantSearch of [false, true]) {
  it(`refuses to expose a mailbox after a completed partial write (instant=${instantSearch})`, async () => {
    const name = crypto.randomUUID(), factory = new IDBFactory(), p = { ...platform, files: memoryFiles() };
    const store = await IdbMailStore.open({ name, factory, instantSearch: instantSearch ? { settleMs: 0 } : false, platform: p });
    let reopened: IdbMailStore | undefined, raw: IDBDatabase | undefined;
    try {
      const [account] = await withAccounts(store, 1);
      const id = (await ingest(store, [msg({ accountId: account!, providerMsgId: "partial" })])).inserted[0]!;
      if (store.instant) expect(await store.instant.settled()).toBe(true);
      const revision = await store.feed.head();
      const transaction = IDBDatabase.prototype.transaction, put = IDBObjectStore.prototype.put;
      const injected = new Error("body prefix only");
      let target: IDBTransaction | undefined, terminal: string | null = null, wroteBody = false;
      vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args) {
        const tx = transaction.call(this, ...args), names = typeof args[0] === "string" ? [args[0]] : Array.from(args[0]);
        if (!target && args[1] === "readwrite" && names.includes("message_bodies")) {
          target = tx;
          tx.addEventListener("complete", () => { terminal = "complete"; });
          vi.spyOn(tx, "abort").mockImplementation(() => { throw new Error("injected abort refusal"); });
        }
        return tx;
      });
      vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value, key) {
        if (this.transaction === target && this.name === "threads") throw injected;
        if (this.transaction === target && this.name === "message_bodies") wroteBody = true;
        return put.call(this, value, key);
      });
      try {
        expect(await store.sync.setBody(id, "quartzuniqueword", null, { now: 1, classifier: null }).then(() => null, (error: unknown) => error)).toBe(injected);
      } finally { vi.restoreAllMocks(); }
      expect({ terminal, wroteBody, usable: store.isOpen }).toEqual({ terminal: "complete", wroteBody: true, usable: false });
      await store.close();
      raw = await request(factory.open(databaseName(name)));
      const tx = raw.transaction(["message_bodies", "search_state", "meta"]);
      const ended = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
      const [body, head] = await Promise.all([request(tx.objectStore("message_bodies").get(id)), request(tx.objectStore("search_state").get(1))]);
      await ended;
      expect(body.body_text).toBe("quartzuniqueword");
      expect({ epoch: head.epoch, seq: head.seq }).toEqual(revision);
      raw.close(); raw = undefined;
      const error = await IdbMailStore.open({ name, factory, instantSearch, platform: p }).then((value) => { reopened = value; return null; }, (failure: unknown) => failure);
      expect(reopened !== undefined).toBe(false);
      expect(error).toMatchObject({ name: "UncertainWriteError" });
    } finally { vi.restoreAllMocks(); raw?.close(); await reopened?.close(); await store.close(); }
  });
}

it.each([
  { label: "current", value: { version: 1 } },
  { label: "unknown version", value: { version: 999 } },
  { label: "null", value: null },
  { label: "zero", value: 0 },
  { label: "undefined", value: undefined },
])("keeps an existing $label uncertainty marker and exposes no mailbox", async ({ value }) => {
  const name = crypto.randomUUID(), factory = new IDBFactory();
  const clean = await IdbMailStore.open({ name, factory, instantSearch: false, platform });
  await clean.settings.set("retained", "exact");
  await clean.close();
  let raw = await request(factory.open(databaseName(name)));
  let reopened: IdbMailStore | undefined;
  try {
    const tx = raw.transaction("meta", "readwrite");
    const ended = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
    tx.objectStore("meta").put(value, "uncertainWrite");
    await ended;
    raw.close();
    const error = await IdbMailStore.open({ name, factory, instantSearch: true, platform }).then((store) => { reopened = store; return null; }, (failure: unknown) => failure);
    expect(reopened !== undefined).toBe(false);
    expect(error).toMatchObject({ name: "UncertainWriteError" });
    raw = await request(factory.open(databaseName(name)));
    const read = raw.transaction(["meta", "settings"]);
    const values = await Promise.all([
      request(read.objectStore("meta").count("uncertainWrite")),
      request(read.objectStore("meta").get("uncertainWrite")),
      request(read.objectStore("settings").get("retained")),
    ]);
    expect(values).toEqual([1, value, { key: "retained", value_json: JSON.stringify("exact") }]);
  } finally { raw.close(); await reopened?.close(); }
});

it.each(["request-prevent", "request-stop", "capture-stop"] as const)("retains dirty state when an earlier %s listener permits completion", async (listener) => {
  const name = crypto.randomUUID(), factory = new IDBFactory();
  const store = await IdbMailStore.open({ name, factory, instantSearch: false, platform });
  let raw: IDBDatabase | undefined;
  try {
    await store.settings.set("existing", 1);
    const transaction = IDBDatabase.prototype.transaction, put = IDBObjectStore.prototype.put;
    let target: IDBTransaction | undefined, original: DOMException | null = null, terminal: string | null = null, hits = 0;
    vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args) {
      const tx = transaction.call(this, ...args), names = typeof args[0] === "string" ? [args[0]] : Array.from(args[0]);
      if (args[1] === "readwrite" && names.includes("settings")) {
        target = tx;
        tx.addEventListener("complete", () => { terminal = "complete"; });
        if (listener === "capture-stop") tx.addEventListener("error", (event) => { event.preventDefault(); event.stopImmediatePropagation(); }, true);
      }
      return tx;
    });
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.transaction !== target || this.name !== "settings") return put.call(this, value, key);
      hits++;
      const failed = this.add(value, key);
      failed.addEventListener("error", (event) => {
        original = failed.error;
        event.preventDefault();
        if (listener === "request-stop") event.stopImmediatePropagation();
      });
      return failed;
    });
    const error = await store.settings.set("existing", 2).then(() => null, (failure: unknown) => failure);
    expect({ hits, terminal, usable: store.isOpen }).toEqual({ hits: 1, terminal: "complete", usable: false });
    if (listener === "capture-stop") expect(error).toMatchObject({ message: "IndexedDB write did not confirm every request" });
    else expect(error).toBe(original);
    vi.restoreAllMocks();
    await store.close();
    raw = await request(factory.open(databaseName(name)));
    const tx = raw.transaction(["meta", "settings"]);
    const [marker, row] = await Promise.all([request(tx.objectStore("meta").getKey("uncertainWrite")), request(tx.objectStore("settings").get("existing"))]);
    expect(marker).toBe("uncertainWrite");
    expect(row).toEqual({ key: "existing", value_json: "1" });
    raw.close(); raw = undefined;
    await expect(IdbMailStore.open({ name, factory, instantSearch: false, platform })).rejects.toBeInstanceOf(UncertainWriteError);
  } finally { vi.restoreAllMocks(); raw?.close(); await store.close(); }
});

it("poisons a participating writer that detects another writer's dirty marker", async () => {
  const name = crypto.randomUUID(), factory = new IDBFactory();
  const first = await IdbMailStore.open({ name, factory, instantSearch: false, platform });
  let second: IdbMailStore | undefined;
  try {
    const [account] = await withAccounts(first, 1);
    const id = (await ingest(first, [msg({ accountId: account!, providerMsgId: "shared" })])).inserted[0]!;
    second = await IdbMailStore.open({ name, factory, instantSearch: false, platform });
    await second.whenLoaded();
    const provider = second.providerStore(account!);
    const transaction = IDBDatabase.prototype.transaction, put = IDBObjectStore.prototype.put;
    let target: IDBTransaction | undefined;
    vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args) {
      const tx = transaction.call(this, ...args), names = typeof args[0] === "string" ? [args[0]] : Array.from(args[0]);
      if (args[1] === "readwrite" && names.includes("message_bodies")) {
        target = tx;
        vi.spyOn(tx, "abort").mockImplementation(() => { throw new Error("injected abort refusal"); });
      }
      return tx;
    });
    const failure = new Error("partial body");
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.transaction === target && this.name === "threads") throw failure;
      return put.call(this, value, key);
    });
    expect(await first.sync.setBody(id, "partial retained body", null, { now: 1, classifier: null }).then(() => null, (error: unknown) => error)).toBe(failure);
    vi.restoreAllMocks();
    const getKey = IDBObjectStore.prototype.getKey;
    let guardEntered!: () => void;
    const guard = new Promise<void>((resolve) => { guardEntered = resolve; });
    let guardHits = 0;
    vi.spyOn(IDBObjectStore.prototype, "getKey").mockImplementation(function (this: IDBObjectStore, ...args) {
      const result = getKey.call(this, ...args);
      if (this.name === "meta" && this.transaction.mode === "readwrite") { guardHits++; result.addEventListener("success", guardEntered); }
      return result;
    });
    const write = second.settings.set("forbidden", 1).then(() => null, (error: unknown) => error);
    await guard;
    const pendingRead = second.settings.get("forbidden", null).then(() => null, (error: unknown) => error);
    const queuedWrite = second.settings.set("also-forbidden", 2).then(() => null, (error: unknown) => error);
    expect(await write).toBeInstanceOf(UncertainWriteError);
    expect(guardHits).toBe(1);
    expect(second.isOpen).toBe(false);
    expect(await pendingRead).toMatchObject({ message: "the store is closed" });
    expect(await queuedWrite).toMatchObject({ message: "the store is closed" });
    await expect(provider.providerIds([id])).rejects.toMatchObject({ message: "the store is closed" });
  } finally { vi.restoreAllMocks(); await second?.close(); await first.close(); }
});
