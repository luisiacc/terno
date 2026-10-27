import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { parseSearch, resolveSearch } from "@terno/core";
import { ingest, memoryFiles, msg, withAccounts } from "@terno/store/conformance";
import { expect, it, vi } from "vitest";
import { IdbMailStore } from "./store";
import { databaseName } from "./schema";
import { UncertainWriteError } from "./uncertainty";

const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setImmediate(resolve)) };
const request = <T,>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

for (const instantSearch of [false, true]) {
  it(`a synchronous enqueue failure aborts before admission and preserves durable flags (instant=${instantSearch})`, async () => {
    const factory = new IDBFactory(), name = crypto.randomUUID();
    let store = await IdbMailStore.open({ name, factory, instantSearch, platform });
    try {
      const [account] = await withAccounts(store, 1);
      await ingest(store, [msg({ accountId: account!, providerMsgId: "one" }), msg({ accountId: account!, providerMsgId: "two" })]);
      const before = await store.debug.snapshot();
      const transaction = IDBDatabase.prototype.transaction, put = IDBObjectStore.prototype.put;
      let target: IDBTransaction | undefined, terminal: "abort" | "complete" | null = null, writes = 0;
      const txSpy = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args) {
        const tx = transaction.call(this, ...args);
        const names = typeof args[0] === "string" ? [args[0]] : Array.from(args[0]);
        if (!target && args[1] === "readwrite" && names.includes("messages")) {
          target = tx;
          tx.addEventListener("abort", () => { terminal = "abort"; });
          tx.addEventListener("complete", () => { terminal = "complete"; });
        }
        return tx;
      });
      const putSpy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value, key) {
        if (this.transaction === target && this.name === "messages" && ++writes === 2) return put.call(this, { ...value, uncloneable: () => {} }, key);
        return put.call(this, value, key);
      });
      let terminalWhenRejected: typeof terminal;
      try {
        await expect(store.threads.act({ threadIds: before.messages.map((m) => m.threadId), action: "markRead", signal: null, now: 1 })).rejects.toMatchObject({ name: "DataCloneError" });
        terminalWhenRejected = terminal;
      } finally { putSpy.mockRestore(); txSpy.mockRestore(); }
      const verification = await store.debug.verify().then(() => null, (error: Error) => error.message);
      const memory = (await store.debug.snapshot()).messages.map((m) => m.isRead);
      await store.close();
      store = await IdbMailStore.open({ name, factory, instantSearch, platform });
      expect({ writes, terminalWhenRejected, verification, memory, reopened: (await store.debug.snapshot()).messages.map((m) => m.isRead) }).toEqual({
        writes: 2, terminalWhenRejected: "abort", verification: null,
        memory: before.messages.map((m) => m.isRead), reopened: before.messages.map((m) => m.isRead),
      });
    } finally { vi.restoreAllMocks(); await store.close(); }
  });
}

for (const instantSearch of [false, true]) {
  for (const fault of ["failed abort", "prevented request error"] as const) {
    it(`poisons before readers and queued commands after ${fault} completes (instant=${instantSearch})`, async () => {
      const factory = new IDBFactory(), name = crypto.randomUUID();
      let store = await IdbMailStore.open({ name, factory, instantSearch, platform });
      const injected = new Error("enqueue failed");
      try {
        const [account] = await withAccounts(store, 1);
        await ingest(store, [msg({ accountId: account!, providerMsgId: "one" }), msg({ accountId: account!, providerMsgId: "two" })]);
        const before = await store.debug.snapshot();
        const transaction = IDBDatabase.prototype.transaction, put = IDBObjectStore.prototype.put, add = IDBObjectStore.prototype.add;
        let target: IDBTransaction | undefined, writes = 0, requestError: DOMException | null = null;
        let terminal: string | null = null;
        let started!: () => void;
        const startedTx = new Promise<void>((resolve) => { started = resolve; });
        const txSpy = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args) {
          const tx = transaction.call(this, ...args);
          const names = typeof args[0] === "string" ? [args[0]] : Array.from(args[0]);
          if (!target && args[1] === "readwrite" && names.includes("messages")) {
            target = tx;
            started();
            tx.addEventListener("complete", () => { terminal = "complete"; });
            if (fault === "failed abort") vi.spyOn(tx, "abort").mockImplementation(() => { throw new Error("abort refused"); });
          }
          return tx;
        });
        const putSpy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value, key) {
          if (this.transaction === target && this.name === "messages" && ++writes === 2) {
            if (fault === "failed abort") throw injected;
            const req = add.call(this, value, key);
            req.addEventListener("error", (event) => { requestError = req.error; event.preventDefault(); });
            return req;
          }
          return put.call(this, value, key);
        });
        const command = store.threads.act({ threadIds: before.messages.map((m) => m.threadId), action: "markRead", signal: null, now: 1 }).then(() => null, (e: unknown) => e);
        await startedTx;
        const reader = store.threads.list({ view: "all", limit: 10 }).then(() => null, (e: unknown) => e);
        const queued = store.settings.set("after-failure", true).then(() => null, (e: unknown) => e);
        const [error, readError, queueError] = await Promise.all([command, reader, queued]);
        expect(readError).toEqual(expect.objectContaining({ message: "the store is closed" }));
        expect(queueError).toEqual(expect.objectContaining({ message: "the store is closed" }));
        expect(terminal).toBe("complete");
        expect(error).toBe(fault === "failed abort" ? injected : requestError);
        expect(store.isOpen).toBe(false);
        putSpy.mockRestore(); txSpy.mockRestore();
        await store.close();
        const raw = await new Promise<IDBDatabase>((resolve, reject) => {
          const open = factory.open(databaseName(name));
          open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
        });
        try {
          const rows = await new Promise<{ is_read: number }[]>((resolve, reject) => {
            const request = raw.transaction("messages").objectStore("messages").getAll();
            request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
          });
          expect(rows.map((m) => m.is_read === 1)).toEqual([true, false]);
        } finally { raw.close(); }
        await expect(IdbMailStore.open({ name, factory, instantSearch, platform })).rejects.toBeInstanceOf(UncertainWriteError);
      } finally { vi.restoreAllMocks(); await store.close(); }
    });
  }
}

it("verify holds the command queue while reading its physical snapshot", async () => {
  const store = await IdbMailStore.open({ name: crypto.randomUUID(), factory: new IDBFactory(), instantSearch: false, platform });
  try {
    await store.whenLoaded();
    const getAll = IDBObjectStore.prototype.getAll;
    let command: Promise<void> | undefined;
    const spy = vi.spyOn(IDBObjectStore.prototype, "getAll").mockImplementation(function (this: IDBObjectStore, ...args) {
      if (!command && this.name === "settings") command = store.settings.set("during-verify", 1);
      return getAll.call(this, ...args);
    });
    try { await store.debug.verify(); await command; } finally { spy.mockRestore(); }
    await store.debug.verify();
  } finally { vi.restoreAllMocks(); await store.close(); }
});

for (const boundary of ["early load", "search state", "metadata"] as const) {
  it(`closes the acquired connection when ${boundary} fails`, async () => {
    const factory = new IDBFactory(), name = crypto.randomUUID(), injected = new Error(boundary);
    const close = IDBDatabase.prototype.close, transaction = IDBDatabase.prototype.transaction;
    let closed = false;
    const closeSpy = vi.spyOn(IDBDatabase.prototype, "close").mockImplementation(function (this: IDBDatabase) { closed = true; return close.call(this); });
    const txSpy = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args) {
      const names = typeof args[0] === "string" ? [args[0]] : Array.from(args[0]);
      if ((boundary === "early load" && args[1] === "readonly" && names.includes("accounts")) || (boundary === "search state" && args[1] === "readwrite" && names.includes("search_state")) || (boundary === "metadata" && args[1] === "readwrite" && names.length === 1 && names[0] === "meta")) throw injected;
      return transaction.call(this, ...args);
    });
    try {
      expect(await IdbMailStore.open({ name, factory, instantSearch: false, platform }).then(() => null, (e: unknown) => e)).toBe(injected);
      expect(closed).toBe(true);
    } finally { closeSpy.mockRestore(); txSpy.mockRestore(); }
    const reopened = await IdbMailStore.open({ name, factory, instantSearch: false, platform });
    await reopened.close();
  });
}

for (const instantSearch of [false, true]) {
  it(`rejects delayed search, exclusive work and an existing provider after poison (instant=${instantSearch})`, async () => {
    const name = crypto.randomUUID(), factory = new IDBFactory();
    const seed = await IdbMailStore.open({ name, factory, instantSearch: false, platform });
    await seed.secrets.put("probe", new Uint8Array([1]));
    await seed.close();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const getAll = IDBObjectStore.prototype.getAll;
    let delayed = false;
    const getSpy = vi.spyOn(IDBObjectStore.prototype, "getAll").mockImplementation(function (this: IDBObjectStore, ...args) {
      const req = getAll.call(this, ...args);
      if (this.name !== "messages" || delayed) return req;
      delayed = true;
      return new Proxy(req, {
        get: (target, key) => Reflect.get(target, key, target),
        set: (target, key, value) => {
          if (key === "onsuccess") {
            target.onsuccess = (event) => { void gate.then(() => value.call(target, event)); };
            return true;
          }
          return Reflect.set(target, key, value, target);
        },
      });
    });
    let store: IdbMailStore | undefined;
    try {
      store = await IdbMailStore.open({ name, factory, instantSearch, platform });
      const provider = store.providerStore(1);
      const search = store.threads.search({ search: resolveSearch(parseSearch("example"), "example", {}, { accounts: [], categories: [] }), limit: 10 }).then(() => null, (e: unknown) => e);
      const exclusive = store.debug.snapshot().then(() => null, (e: unknown) => e);
      const injected = new Error("after enqueue");
      const transaction = IDBDatabase.prototype.transaction, put = IDBObjectStore.prototype.put;
      let target: IDBTransaction | undefined;
      let markers = 0, bodies = 0, refused = 0, terminal: string | null = null;
      const txSpy = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args) {
        const tx = transaction.call(this, ...args);
        const names = typeof args[0] === "string" ? [args[0]] : Array.from(args[0]);
        if (!target && args[1] === "readwrite" && names.includes("secrets")) {
          target = tx;
          tx.addEventListener("complete", () => { terminal = "complete"; });
          vi.spyOn(tx, "abort").mockImplementation(() => { refused++; throw new Error("abort refused"); });
        }
        return tx;
      });
      const putSpy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value, key) {
        const result = put.call(this, value, key);
        if (this.transaction === target && this.name === "meta" && key === "uncertainWrite") result.addEventListener("success", () => { markers++; });
        if (this.transaction === target && this.name === "secrets") { bodies++; throw injected; }
        return result;
      });
      expect(await store.secrets.replace("probe", new Uint8Array([1]), new Uint8Array([2])).then(() => null, (e: unknown) => e)).toBe(injected);
      putSpy.mockRestore(); txSpy.mockRestore();
      expect({ markers, bodies, refused, terminal }).toEqual({ markers: 1, bodies: 1, refused: 1, terminal: "complete" });
      const raw = await request(factory.open(databaseName(name)));
      try { expect(await request(raw.transaction("meta").objectStore("meta").getKey("uncertainWrite"))).toBe("uncertainWrite"); }
      finally { raw.close(); }
      let closed = false;
      const closing = store.close().then(() => { closed = true; });
      await Promise.resolve();
      expect(closed).toBe(false);
      release();
      expect(await search).toEqual(expect.objectContaining({ message: "the store is closed" }));
      expect(await exclusive).toEqual(expect.objectContaining({ message: "the store is closed" }));
      await expect(provider.messageByProviderId("x")).rejects.toThrow("closed");
      await closing;
    } finally { release(); getSpy.mockRestore(); vi.restoreAllMocks(); await store?.close(); }
  });
}

for (const instantSearch of [false, true]) {
  for (const fault of ["transaction", "first enqueue", "request"] as const) {
    it(`rolls back a ${fault} failure with its original error (instant=${instantSearch})`, async () => {
      const name = crypto.randomUUID(), factory = new IDBFactory();
      let store = await IdbMailStore.open({ name, factory, instantSearch, platform });
      const injected = new Error(fault);
      try {
        const [account] = await withAccounts(store, 1);
        await ingest(store, [msg({ accountId: account!, providerMsgId: "one" })]);
        const before = await store.debug.snapshot();
        const transaction = IDBDatabase.prototype.transaction, put = IDBObjectStore.prototype.put, add = IDBObjectStore.prototype.add;
        let target: IDBTransaction | undefined, requestError: DOMException | null = null, terminal: string | null = null;
        const txSpy = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args) {
          const names = typeof args[0] === "string" ? [args[0]] : Array.from(args[0]);
          if (!target && args[1] === "readwrite" && names.includes("messages")) {
            if (fault === "transaction") throw injected;
            target = transaction.call(this, ...args);
            target.addEventListener("abort", () => { terminal = "abort"; });
            return target;
          }
          return transaction.call(this, ...args);
        });
        const putSpy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value, key) {
          if (this.transaction === target && this.name === "messages") {
            if (fault === "first enqueue") throw injected;
            if (fault === "request") {
              const req = add.call(this, value, key);
              req.addEventListener("error", () => { requestError = req.error; });
              return req;
            }
          }
          return put.call(this, value, key);
        });
        const error = await store.threads.act({ threadIds: before.messages.map((m) => m.threadId), action: "markRead", signal: null, now: 1 }).then(() => null, (e: unknown) => e);
        expect(error).toBe(fault === "request" ? requestError : injected);
        if (fault !== "transaction") expect(terminal).toBe("abort");
        putSpy.mockRestore(); txSpy.mockRestore();
        await store.debug.verify();
        expect((await store.debug.snapshot()).messages.map((m) => m.isRead)).toEqual([false]);
        await store.close();
        store = await IdbMailStore.open({ name, factory, instantSearch, platform });
        expect((await store.debug.snapshot()).messages.map((m) => m.isRead)).toEqual([false]);
      } finally { vi.restoreAllMocks(); await store.close(); }
    });
  }
}

for (const instantSearch of [false, true]) {
  it(`keeps a committed action when its caller loses the acknowledgement (instant=${instantSearch})`, async () => {
    const name = crypto.randomUUID(), factory = new IDBFactory();
    let store = await IdbMailStore.open({ name, factory, instantSearch, platform });
    try {
      const [account] = await withAccounts(store, 1);
      await ingest(store, [msg({ accountId: account!, providerMsgId: "one" })]);
      const before = await store.debug.snapshot();
      const lost = new Error("caller lost response");
      const error = await store.threads.act({ threadIds: before.messages.map((m) => m.threadId), action: "markRead", signal: null, now: 1 }).then(() => { throw lost; }).catch((e: unknown) => e);
      expect(error).toBe(lost);
      expect((await store.debug.snapshot()).messages.map((m) => m.isRead)).toEqual([true]);
      await store.debug.verify();
      await store.close();
      store = await IdbMailStore.open({ name, factory, instantSearch, platform });
      expect((await store.debug.snapshot()).messages.map((m) => m.isRead)).toEqual([true]);
    } finally { await store.close(); }
  });
}

for (const boundary of ["early load", "search state", "metadata"] as const) {
  it(`waits for termination and closes after ${boundary} enqueue fails`, async () => {
    const factory = new IDBFactory(), name = crypto.randomUUID(), injected = new Error(boundary);
    const transaction = IDBDatabase.prototype.transaction, getAll = IDBObjectStore.prototype.getAll, put = IDBObjectStore.prototype.put, close = IDBDatabase.prototype.close;
    let target: IDBTransaction | undefined, terminal: string | null = null, closedAfterTerminal = false;
    const txSpy = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args) {
      const tx = transaction.call(this, ...args);
      const names = typeof args[0] === "string" ? [args[0]] : Array.from(args[0]);
      if (!target && ((boundary === "early load" && args[1] === "readonly" && names.includes("accounts")) || (boundary === "search state" && args[1] === "readwrite" && names.includes("search_state")) || (boundary === "metadata" && args[1] === "readwrite" && names.length === 1 && names[0] === "meta"))) {
        target = tx;
        tx.addEventListener("abort", () => { terminal = "abort"; });
      }
      return tx;
    });
    const closeSpy = vi.spyOn(IDBDatabase.prototype, "close").mockImplementation(function (this: IDBDatabase) { closedAfterTerminal = terminal === "abort"; return close.call(this); });
    const getSpy = vi.spyOn(IDBObjectStore.prototype, "getAll").mockImplementation(function (this: IDBObjectStore, ...args) {
      const result = getAll.call(this, ...args);
      if (boundary === "early load" && this.transaction === target) throw injected;
      return result;
    });
    const putSpy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value, key) {
      const result = put.call(this, value, key);
      if (this.transaction === target && (boundary === "search state" && this.name === "search_state" || boundary === "metadata" && key === "logicalSchema")) throw injected;
      return result;
    });
    try {
      expect(await IdbMailStore.open({ name, factory, instantSearch: false, platform }).then(() => null, (e: unknown) => e)).toBe(injected);
      expect(closedAfterTerminal).toBe(true);
    } finally { putSpy.mockRestore(); getSpy.mockRestore(); closeSpy.mockRestore(); txSpy.mockRestore(); }
    const reopened = await IdbMailStore.open({ name, factory, instantSearch: false, platform });
    await reopened.close();
  });
}

it("point reads wait if a write starts after settlement but before the read", async () => {
  const store = await IdbMailStore.open({ name: crypto.randomUUID(), factory: new IDBFactory(), instantSearch: false, platform });
  try {
    await store.whenLoaded();
    await store.settings.set("race", 0);
    const transaction = IDBDatabase.prototype.transaction;
    const spy = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args) {
      const tx = transaction.call(this, ...args);
      const names = typeof args[0] === "string" ? [args[0]] : Array.from(args[0]);
      if (args[1] === "readwrite" && names.includes("settings")) queueMicrotask(() => tx.abort());
      return tx;
    });
    try {
      const write = store.settings.set("race", 1).then(() => null, (error: unknown) => error);
      const read = new Promise<number>((resolve, reject) => queueMicrotask(() => queueMicrotask(() => { void store.settings.get("race", 0).then(resolve, reject); })));
      const [error, value] = await Promise.all([write, read]);
      expect(error).toBeTruthy();
      expect(value).toBe(0);
      await store.debug.verify();
    } finally { spy.mockRestore(); }
  } finally { await store.close(); }
});

it("close joins verification admitted while late loading is pending", async () => {
  let releaseLoad!: () => void, releaseVerify!: () => void, enteredVerify!: () => void;
  const loadGate = new Promise<void>((r) => { releaseLoad = r; });
  const verifyGate = new Promise<void>((r) => { releaseVerify = r; });
  const verifyStarted = new Promise<void>((r) => { enteredVerify = r; });
  const getAll = IDBObjectStore.prototype.getAll;
  let heldLoad = false, holdVerify = false;
  const spy = vi.spyOn(IDBObjectStore.prototype, "getAll").mockImplementation(function (this: IDBObjectStore, ...args) {
    const req = getAll.call(this, ...args);
    const gate = !heldLoad && this.name === "messages" ? (heldLoad = true, loadGate) : holdVerify && this.name === "settings" ? (holdVerify = false, enteredVerify(), verifyGate) : null;
    if (!gate) return req;
    return new Proxy(req, {
      get: (target, key) => Reflect.get(target, key, target),
      set: (target, key, value) => {
        if (key === "onsuccess") { target.onsuccess = (event) => { void gate.then(() => value.call(target, event)); }; return true; }
        return Reflect.set(target, key, value, target);
      },
    });
  });
  let store: IdbMailStore | undefined, verification: Promise<unknown> | undefined, closing: Promise<unknown> | undefined;
  try {
    store = await IdbMailStore.open({ name: crypto.randomUUID(), factory: new IDBFactory(), instantSearch: false, platform });
    verification = store.debug.verify().then(() => null, (e: unknown) => e);
    let closeSettled = false;
    closing = store.close().then(() => { closeSettled = true; }, () => { closeSettled = true; });
    await new Promise<void>((r) => setImmediate(r));
    holdVerify = true;
    releaseLoad();
    await verifyStarted;
    await new Promise<void>((r) => setImmediate(r));
    expect(closeSettled).toBe(false);
    releaseVerify();
    expect(await verification).toBeNull();
    await closing;
  } finally {
    releaseLoad(); releaseVerify(); spy.mockRestore();
    await verification; await closing; await store?.close();
  }
});

it("restored instant index rechecks admission after delayed loading", async () => {
  const name = crypto.randomUUID(), factory = new IDBFactory(), files = memoryFiles(), p = { ...platform, files };
  let store = await IdbMailStore.open({ name, factory, instantSearch: { settleMs: 0 }, platform: p });
  await store.secrets.put("probe", new Uint8Array([1]));
  expect(await store.instant!.settled()).toBe(true);
  const healthy = await store.threads.search({ search: resolveSearch(parseSearch("example"), "example", {}, { accounts: [], categories: [] }), limit: 10 });
  expect(healthy.strategy).not.toBe("scan");
  await store.close();
  expect(files.files.size).toBeGreaterThan(0);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const getAll = IDBObjectStore.prototype.getAll;
  let delayed = false;
  const getSpy = vi.spyOn(IDBObjectStore.prototype, "getAll").mockImplementation(function (this: IDBObjectStore, ...args) {
    const req = getAll.call(this, ...args);
    if (this.name !== "messages" || delayed) return req;
    delayed = true;
    return new Proxy(req, {
      get: (target, key) => Reflect.get(target, key, target),
      set: (target, key, value) => {
        if (key === "onsuccess") { target.onsuccess = (event) => { void gate.then(() => value.call(target, event)); }; return true; }
        return Reflect.set(target, key, value, target);
      },
    });
  });
  try {
    store = await IdbMailStore.open({ name, factory, instantSearch: { settleMs: 0 }, platform: p });
    expect(await store.instant!.settled()).toBe(true);
    expect(store.instant!.at(await store.feed.head())).not.toBeNull();
    const search = store.threads.search({ search: resolveSearch(parseSearch("example"), "example", {}, { accounts: [], categories: [] }), limit: 10 }).then(() => null, (e: unknown) => e);
    await new Promise<void>((r) => setImmediate(r));
    const transaction = IDBDatabase.prototype.transaction, put = IDBObjectStore.prototype.put;
    let target: IDBTransaction | undefined;
    let markers = 0, bodies = 0, refused = 0, terminal: string | null = null;
    const injected = new Error("after enqueue");
    const txSpy = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args) {
      const tx = transaction.call(this, ...args);
      const names = typeof args[0] === "string" ? [args[0]] : Array.from(args[0]);
      if (!target && args[1] === "readwrite" && names.includes("secrets")) { target = tx; tx.addEventListener("complete", () => { terminal = "complete"; }); vi.spyOn(tx, "abort").mockImplementation(() => { refused++; throw new Error("refused"); }); }
      return tx;
    });
    const putSpy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value, key) {
      const result = put.call(this, value, key);
      if (this.transaction === target && this.name === "meta" && key === "uncertainWrite") result.addEventListener("success", () => { markers++; });
      if (this.transaction === target && this.name === "secrets") { bodies++; throw injected; }
      return result;
    });
    try { expect(await store.secrets.replace("probe", new Uint8Array([1]), new Uint8Array([2])).then(() => null, (e: unknown) => e)).toBe(injected); }
    finally { putSpy.mockRestore(); txSpy.mockRestore(); }
    expect({ markers, bodies, refused, terminal }).toEqual({ markers: 1, bodies: 1, refused: 1, terminal: "complete" });
    const raw = await request(factory.open(databaseName(name)));
    try { expect(await request(raw.transaction("meta").objectStore("meta").getKey("uncertainWrite"))).toBe("uncertainWrite"); }
    finally { raw.close(); }
    release();
    expect(await search).toEqual(expect.objectContaining({ message: "the store is closed" }));
  } finally { release(); getSpy.mockRestore(); vi.restoreAllMocks(); await store.close(); }
});

it("refuses reopening a defensive partial body completion before restoring search", async () => {
  const name = crypto.randomUUID(), factory = new IDBFactory(), files = memoryFiles(), p = { ...platform, files };
  let store = await IdbMailStore.open({ name, factory, instantSearch: { settleMs: 0 }, platform: p });
  try {
    const [account] = await withAccounts(store, 1);
    const id = (await ingest(store, [msg({ accountId: account!, providerMsgId: "one" })])).inserted[0]!;
    expect(await store.instant!.settled()).toBe(true);
    await store.close();
    expect(files.files.size).toBeGreaterThan(0);
    store = await IdbMailStore.open({ name, factory, instantSearch: { settleMs: 0 }, platform: p });
    expect(await store.instant!.settled()).toBe(true);
    const transaction = IDBDatabase.prototype.transaction, put = IDBObjectStore.prototype.put;
    const writes: string[] = [];
    const injected = new Error("prefix only");
    let target: IDBTransaction | undefined, terminal: string | null = null;
    const txSpy = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args) {
      const tx = transaction.call(this, ...args), names = typeof args[0] === "string" ? [args[0]] : Array.from(args[0]);
      if (!target && args[1] === "readwrite" && names.includes("message_bodies")) {
        target = tx; tx.addEventListener("complete", () => { terminal = "complete"; });
        vi.spyOn(tx, "abort").mockImplementation(() => { throw new Error("refused"); });
      }
      return tx;
    });
    const putSpy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.transaction === target) { writes.push(this.name); if (this.name === "threads") throw injected; }
      return put.call(this, value, key);
    });
    try { expect(await store.sync.setBody(id, "quartzuniqueword", null, { now: 1, classifier: null }).then(() => null, (e: unknown) => e)).toBe(injected); }
    finally { putSpy.mockRestore(); txSpy.mockRestore(); }
    expect(terminal).toBe("complete");
    expect(writes).toContain("message_bodies");
    expect(writes).toContain("threads");
    await store.close();
    await expect(IdbMailStore.open({ name, factory, instantSearch: { settleMs: 0 }, platform: p })).rejects.toBeInstanceOf(UncertainWriteError);
  } finally { vi.restoreAllMocks(); await store.close(); }
});

it("close persists a healthy command admitted before late loading finishes", async () => {
  const name = crypto.randomUUID(), factory = new IDBFactory();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const getAll = IDBObjectStore.prototype.getAll;
  let held = false;
  const spy = vi.spyOn(IDBObjectStore.prototype, "getAll").mockImplementation(function (this: IDBObjectStore, ...args) {
    const req = getAll.call(this, ...args);
    if (held || this.name !== "messages") return req;
    held = true;
    return new Proxy(req, {
      get: (target, key) => Reflect.get(target, key, target),
      set: (target, key, value) => {
        if (key === "onsuccess") { target.onsuccess = (event) => { void gate.then(() => value.call(target, event)); }; return true; }
        return Reflect.set(target, key, value, target);
      },
    });
  });
  let store: IdbMailStore | undefined, write: Promise<unknown> | undefined, closing: Promise<unknown> | undefined;
  try {
    store = await IdbMailStore.open({ name, factory, instantSearch: false, platform });
    write = store.settings.set("before-close", 7).then(() => null, (e: unknown) => e);
    closing = store.close();
    await new Promise<void>((r) => setImmediate(r));
    release();
    expect(await write).toBeNull();
    await closing;
    spy.mockRestore();
    store = await IdbMailStore.open({ name, factory, instantSearch: false, platform });
    expect(await store.settings.get("before-close", 0)).toBe(7);
  } finally { release(); spy.mockRestore(); await write; await closing; await store?.close(); }
});
