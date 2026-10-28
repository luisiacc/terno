import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { expect, it, vi } from "vitest";
import { IdbMailStore } from "@terno/idb";
import { ingest, msg, threadOf } from "@terno/store/conformance";
import { UncertainWriteError, UNCERTAINTY_KEY } from "@terno/idb/uncertainty";
import { validateCompleteOpStorage } from "@terno/idb/op-storage";
import { MIGRATION_JOURNAL, migrateLegacyIdb } from "./legacy-storage";

const request = <T,>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const terminal = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setImmediate(resolve)) };
type Image = { version: number; stores: {
  name: string; keyPath: string | string[] | null; autoIncrement: boolean;
  indexes: { name: string; keyPath: string | string[]; unique: boolean; multiEntry: boolean }[];
  keys: IDBValidKey[]; values: unknown[];
}[] };
async function image(factory: IDBFactory, name: string): Promise<Image> {
  const db = await request(factory.open(name));
  try {
    const names = [...db.objectStoreNames], tx = db.transaction(names), done = terminal(tx);
    const stores = await Promise.all(names.map(async (name) => {
      const store = tx.objectStore(name);
      const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
      return { name, keyPath: store.keyPath, autoIncrement: store.autoIncrement,
        indexes: [...store.indexNames].map((name) => { const i = store.index(name); return { name, keyPath: i.keyPath, unique: i.unique, multiEntry: i.multiEntry }; }),
        keys, values };
    }));
    await done; return { version: db.version, stores };
  } finally { db.close(); }
}
async function create(factory: IDBFactory, name: string, saved: Image, prefix = false, omit?: string) {
  const open = factory.open(name, saved.version);
  open.onupgradeneeded = () => {
    for (const spec of saved.stores) {
      if (spec.name === omit) continue;
      const store = open.result.createObjectStore(spec.name, { keyPath: spec.keyPath, autoIncrement: spec.autoIncrement });
      for (const i of spec.indexes) store.createIndex(i.name, i.keyPath, { unique: i.unique, multiEntry: i.multiEntry });
      if (!prefix || spec.name === "op_control") spec.values.forEach((value, at) => store.put(value, spec.keyPath === null ? spec.keys[at] : undefined));
    }
  };
  (await request(open)).close();
}
async function journal(factory: IDBFactory, state: "copying" | "copied", from = "unica-case") {
  const open = factory.open(MIGRATION_JOURNAL, 1);
  open.onupgradeneeded = () => open.result.createObjectStore("copies");
  const db = await request(open);
  try { const tx = db.transaction("copies", "readwrite"), done = terminal(tx); tx.objectStore("copies").put({ from, state }, "terno-case"); await done; }
  finally { db.close(); }
}
async function fixture() {
  const factory = new IDBFactory(), store = await IdbMailStore.open({ factory, name: "seed", instantSearch: false, platform });
  let expected: Awaited<ReturnType<typeof store.ops.get>> = null;
  let opId = "";
  try {
    const { account } = await store.accounts.create({ kind: "gmail", email: "sender@example.com", displayName: "Synthetic", color: "indigo", now: 1 });
    const queued = await store.compose.queueSend({ accountId: account.id, to: [{ name: "", email: "recipient@example.com" }], cc: [], bcc: [], subject: "copy", bodyText: "synthetic copy wire", recordReply: false, now: 1 });
    opId = queued.opId; await store.ops.claimReady(2, 1); await store.ops.awaitAuth(opId, "synthetic auth error", 3);
    expected = await store.ops.get(opId);
    expect(expected).not.toBeNull();
  } finally { await store.close(); }
  const saved = await image(factory, "terno-seed");
  await request(factory.deleteDatabase("terno-seed"));
  await create(factory, "unica-case", saved);
  return { factory, saved, expected, opId };
}
async function dispose(factory: IDBFactory) {
  for (const { name } of await factory.databases()) if (name) await request(factory.deleteDatabase(name));
}
async function snapshot(factory: IDBFactory) {
  const names = (await factory.databases()).map((d) => d.name!).sort();
  return Promise.all(names.map(async (name) => ({ name, image: await image(factory, name) })));
}
async function assertPublic(factory: IDBFactory, opId: string, expected: unknown) {
  const store = await IdbMailStore.open({ factory, name: "case", instantSearch: false, platform });
  try { expect(await store.ops.get(opId)).toEqual(expected); await store.debug.verify(); }
  finally { await store.close(); }
}

it("fresh copy reuses BASE reads and publicly reopens the effective operation", async () => {
  const f = await fixture(), getAll = IDBObjectStore.prototype.getAll;
  let sourceBase = 0, targetBase = 0;
  const spy = vi.spyOn(IDBObjectStore.prototype, "getAll").mockImplementation(function (this: IDBObjectStore, ...args) {
    if (this.name === "ops" && this.transaction.db.name === "unica-case") sourceBase++;
    if (this.name === "ops" && this.transaction.db.name === "terno-case") targetBase++;
    return getAll.call(this, ...args);
  });
  try {
    await migrateLegacyIdb(f.factory, "case");
    expect(sourceBase).toBe(1); expect(targetBase).toBe(0);
    spy.mockRestore();
    expect((await f.factory.databases()).map((d) => d.name)).toEqual(["terno-case"]);
    await assertPublic(f.factory, f.opId, f.expected);
  } finally { spy.mockRestore(); await dispose(f.factory); }
});

it("matching COPYING disposes a clean manifest-matching orphan prefix, never admitting it as a mailbox", async () => {
  const f = await fixture();
  try {
    await create(f.factory, "terno-case", f.saved, true); await journal(f.factory, "copying");
    const prefix = await image(f.factory, "terno-case");
    expect(prefix.stores.find((s) => s.name === "ops")!.keys).toHaveLength(0);
    expect(prefix.stores.find((s) => s.name === "op_control")!.keys).toHaveLength(1);
    await expect(IdbMailStore.open({ factory: f.factory, name: "case", instantSearch: false, platform })).rejects.toBeInstanceOf(UncertainWriteError);
    await migrateLegacyIdb(f.factory, "case");
    await assertPublic(f.factory, f.opId, f.expected);
    expect((await f.factory.databases()).map((d) => d.name)).toEqual(["terno-case"]);
  } finally { await dispose(f.factory); }
});

it.each(["source-orphan", "prefix-manifest", "prefix-dirty", "journal-owner"] as const)("%s refuses before prefix disposal and preserves both images/journal", async (fault) => {
  const f = await fixture();
  try {
    await create(f.factory, "terno-case", f.saved, true, fault === "prefix-manifest" ? "op_error" : undefined);
    await journal(f.factory, "copying", fault === "journal-owner" ? "unica-other" : "unica-case");
    if (fault === "source-orphan" || fault === "prefix-dirty") {
      const db = await request(f.factory.open(fault === "source-orphan" ? "unica-case" : "terno-case"));
      const name = fault === "source-orphan" ? "op_error" : "meta", tx = db.transaction(name, "readwrite"), done = terminal(tx);
      tx.objectStore(name).put(fault === "source-orphan" ? { last_error: null } : undefined, fault === "source-orphan" ? "absent-op" : UNCERTAINTY_KEY);
      await done; db.close();
    }
    const before = await snapshot(f.factory), remove = vi.spyOn(f.factory, "deleteDatabase");
    try {
      await expect(migrateLegacyIdb(f.factory, "case")).rejects.toBeInstanceOf(UncertainWriteError);
      expect(remove).not.toHaveBeenCalled();
      expect(await snapshot(f.factory)).toEqual(before);
    } finally { remove.mockRestore(); }
  } finally { await dispose(f.factory); }
});

it.each(["copied-undefined", "copied-missing", "copied-sole"] as const)("%s revalidates complete COPIED images before cleanup", async (fault) => {
  const f = await fixture();
  try {
    if (fault !== "copied-missing") await create(f.factory, "terno-case", f.saved);
    await journal(f.factory, "copied");
    if (fault === "copied-sole") await request(f.factory.deleteDatabase("unica-case"));
    if (fault === "copied-undefined") {
      const db = await request(f.factory.open("terno-case")), tx = db.transaction("op_error", "readwrite"), done = terminal(tx);
      tx.objectStore("op_error").put(undefined, f.opId); await done; db.close();
    }
    const before = await snapshot(f.factory), remove = vi.spyOn(f.factory, "deleteDatabase");
    try {
      if (fault === "copied-sole") {
        await migrateLegacyIdb(f.factory, "case");
        expect((await f.factory.databases()).map((d) => d.name)).toEqual(["terno-case"]);
      } else {
        await expect(migrateLegacyIdb(f.factory, "case")).rejects.toBeInstanceOf(UncertainWriteError);
        expect(remove).not.toHaveBeenCalled();
        expect(await snapshot(f.factory)).toEqual(before);
      }
    } finally { remove.mockRestore(); }
    if (fault === "copied-sole") await assertPublic(f.factory, f.opId, f.expected);
  } finally { await dispose(f.factory); }
});

it("matching complete COPIED pair deletes only its source and clears the journal", async () => {
  const f = await fixture();
  try {
    await create(f.factory, "terno-case", f.saved); await journal(f.factory, "copied");
    const remove = vi.spyOn(f.factory, "deleteDatabase");
    try {
      await migrateLegacyIdb(f.factory, "case");
      expect(remove.mock.calls.map(([name]) => name)).toEqual(["unica-case", MIGRATION_JOURNAL]);
      expect((await f.factory.databases()).map((d) => d.name)).toEqual(["terno-case"]);
    } finally { remove.mockRestore(); }
    await assertPublic(f.factory, f.opId, f.expected);
  } finally { await dispose(f.factory); }
});

it.each(["version", "index-manifest"] as const)("individually complete COPIED images with different %s preserve both images and journal", async (difference) => {
  const f = await fixture();
  try {
    if (difference === "version") {
      // A real pre-P0 schema holds the effective operation in BASE, without private stores.
      const old: Image = { version: 10, stores: f.saved.stores.filter((store) => !["op_control", "op_target", "op_error"].includes(store.name)).map((store) => {
        if (store.name !== "ops") return store;
        return { ...store, values: store.values.map((value, i) => {
          const row = { ...(value as Record<string, unknown>) };
          for (const name of ["op_control", "op_target", "op_error"]) {
            const part = f.saved.stores.find((entry) => entry.name === name)!;
            const at = part.keys.indexOf(store.keys[i]!);
            if (at !== -1) Object.assign(row, part.values[at]);
          }
          return row;
        }) };
      }) };
      await request(f.factory.deleteDatabase("unica-case"));
      await create(f.factory, "unica-case", old);
      await create(f.factory, "terno-case", f.saved);
    } else {
      const target: Image = { ...f.saved, stores: f.saved.stores.map((store) => store.name !== "threads" ? store : ({
        ...store, indexes: [...store.indexes, { name: "synthetic_extra", keyPath: "id", unique: false, multiEntry: false }],
      })) };
      await create(f.factory, "terno-case", target);
    }
    // Both operation images are individually readable; the failure must be paired lineage/manifest admission.
    for (const name of ["unica-case", "terno-case"]) {
      const db = await request(f.factory.open(name));
      try { await validateCompleteOpStorage(db); } finally { db.close(); }
    }
    await journal(f.factory, "copied");
    const before = await snapshot(f.factory), remove = vi.spyOn(f.factory, "deleteDatabase");
    try {
      await expect(migrateLegacyIdb(f.factory, "case")).rejects.toBeInstanceOf(UncertainWriteError);
      expect(remove).not.toHaveBeenCalled();
      expect(await snapshot(f.factory)).toEqual(before);
    } finally { remove.mockRestore(); }
  } finally { await dispose(f.factory); }
});

it("source-absent COPYING remains kept/reported with its prefix and journal", async () => {
  const f = await fixture();
  try {
    await create(f.factory, "terno-case", f.saved, true); await journal(f.factory, "copying");
    await request(f.factory.deleteDatabase("unica-case"));
    const before = await snapshot(f.factory), reports: string[] = [];
    await migrateLegacyIdb(f.factory, "case", (message) => reports.push(message));
    expect(reports).toHaveLength(1);
    expect(await snapshot(f.factory)).toEqual(before);
  } finally { await dispose(f.factory); }
});

async function streamingFixture() {
  const factory = new IDBFactory();
  const store = await IdbMailStore.open({ factory, name: "seed", instantSearch: false, platform });
  const expected = new Map<string, NonNullable<Awaited<ReturnType<typeof store.ops.get>>>>();
  try {
    const { account } = await store.accounts.create({ kind: "gmail", email: "sender@example.com", displayName: "Synthetic", color: "indigo", now: 1 });
    const send = await store.compose.queueSend({ accountId: account.id, to: [{ name: "", email: "recipient@example.com" }], cc: [], bcc: [], subject: "streaming", bodyText: "~".repeat(32 * 1024), recordReply: false, now: 1 });
    await store.ops.claimReady(2, 1);
    await store.ops.awaitAuth(send.opId, "synthetic-error-".repeat(1024), 3);
    await ingest(store, Array.from({ length: 129 }, (_, i) => msg({ accountId: account.id, providerMsgId: `stream-${i}`, providerThreadId: `stream-thread-${i}` })));
    const threads = await Promise.all(Array.from({ length: 129 }, (_, i) => threadOf(store, `stream-${i}`)));
    const flags = await store.threads.act({ threadIds: threads, action: "markRead", signal: null, now: 4 });
    expect(flags.opIds).toHaveLength(1);
    const flagId = flags.opIds[0]!;
    expect((await store.ops.claimReady(5, 10)).some((op) => op.id === flagId)).toBe(true);
    await store.ops.awaitAuth(flagId, "synthetic-target-error-".repeat(1024), 6);
    const superseding = await store.threads.act({ threadIds: [threads[0]!], action: "markUnread", signal: null, now: 7 });
    for (const id of [send.opId, flagId, ...superseding.opIds]) {
      const op = await store.ops.get(id);
      expect(op).not.toBeNull();
      expected.set(id, op!);
    }
    expect(expected.get(flagId)!.target_json.length).toBeGreaterThan(400);
    expect(expected.get(flagId)!.last_error!.length).toBeGreaterThan(16 * 1024);
    await store.debug.verify();
  } finally { await store.close(); }
  const saved = await image(factory, "terno-seed");
  for (const name of ["op_control", "op_target", "op_error"]) expect(saved.stores.find((s) => s.name === name)!.keys.length).toBeGreaterThan(0);
  await request(factory.deleteDatabase("terno-seed"));
  await create(factory, "unica-case", saved);
  return { factory, saved, expected };
}

function migrationRequests() {
  const names = ["ops", "op_control", "op_target", "op_error"];
  const calls: { method: string; store: string; db: string; selector: unknown; point: boolean; succeeded: boolean }[] = [];
  const transactions: { mode: IDBTransactionMode; terminal: string | null }[] = [];
  const spies: { mockRestore(): void }[] = [];
  let drops = 0;
  const transaction = IDBDatabase.prototype.transaction;
  spies.push(vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args) {
    const tx = Reflect.apply(transaction, this, args) as IDBTransaction;
    if (["unica-case", "terno-case"].includes(this.name) && names.some((name) => tx.objectStoreNames.contains(name))) {
      const entry = { mode: tx.mode, terminal: null as string | null };
      transactions.push(entry);
      tx.addEventListener("complete", () => { entry.terminal = "complete"; });
      tx.addEventListener("abort", () => { entry.terminal = "abort"; });
    }
    return tx;
  }));
  for (const method of ["getAll", "openCursor", "openKeyCursor", "getKey", "put"] as const) {
    const delegate = IDBObjectStore.prototype[method];
    spies.push(vi.spyOn(IDBObjectStore.prototype, method).mockImplementation(function (this: IDBObjectStore, ...args: unknown[]) {
      const result = Reflect.apply(delegate, this, args) as IDBRequest;
      if (names.includes(this.name) && ["unica-case", "terno-case"].includes(this.transaction.db.name)) {
        if (calls.length === 2048) drops++;
        else {
          const query = method === "put" ? args[1] : args[0];
          const selector = query instanceof IDBKeyRange ? { lower: query.lower, upper: query.upper, lowerOpen: query.lowerOpen, upperOpen: query.upperOpen } : query;
          const point = query instanceof IDBKeyRange && typeof query.lower === "string" && query.lower === query.upper && !query.lowerOpen && !query.upperOpen;
          const entry = { method, store: this.name, db: this.transaction.db.name, selector, point, succeeded: false };
          calls.push(entry);
          result.addEventListener("success", () => { entry.succeeded = true; });
        }
      }
      return result;
    }));
  }
  return { calls, transactions, get drops() { return drops; }, restore: () => { for (const spy of spies) spy.mockRestore(); } };
}

for (const copied of [true, false]) it(`public streaming admission ${copied ? "COPIED uses cursor and key-only validation" : "fresh copy retains batched values"}`, async () => {
  const f = await streamingFixture();
  try {
    if (copied) { await create(f.factory, "terno-case", f.saved); await journal(f.factory, "copied"); }
    const observed = migrationRequests();
    try { await migrateLegacyIdb(f.factory, "case"); }
    finally { observed.restore(); }
    expect((await f.factory.databases()).map((d) => d.name)).toEqual(["terno-case"]);
    // These full public reads deliberately happen after instrumentation ends.
    for (const [id, op] of f.expected) await assertPublic(f.factory, id, op);
    expect(observed.drops).toBe(0);
    expect(observed.calls.length).toBeGreaterThan(0);
    expect(observed.calls.every((call) => call.succeeded)).toBe(true);
    expect(observed.transactions.filter((tx) => tx.mode === "readonly").length).toBeGreaterThan(0);
    expect(observed.transactions.every((tx) => tx.terminal === "complete")).toBe(true);
    const count = (method: string, store: string, db?: string) => observed.calls.filter((call) => call.method === method && call.store === store && (!db || call.db === db)).length;
    console.info("streaming-admission-witness", JSON.stringify({ copied, publicReopened: f.expected.size,
      requests: observed.calls.length, successes: observed.calls.filter((call) => call.succeeded).length,
      terminals: observed.transactions.length, complete: observed.transactions.filter((tx) => tx.terminal === "complete").length,
      counts: ["ops", "op_control", "op_target", "op_error"].map((store) => ({ store,
        getAll: count("getAll", store), cursor: count("openCursor", store), keyCursor: count("openKeyCursor", store),
        getKey: count("getKey", store), put: count("put", store) })) }));
    if (copied) {
      expect(count("getAll", "ops"), "complete admission must not batch BASE values").toBe(0);
      for (const name of ["op_control", "op_target", "op_error"]) {
        expect(count("getAll", name), "complete admission must not reread part value batches").toBe(0);
        expect(count("openCursor", name)).toBeGreaterThan(0);
        expect(observed.calls.filter((call) => call.method === "openCursor" && call.store === name).every((call) => call.point)).toBe(true);
        expect(count("openKeyCursor", name)).toBeGreaterThan(0);
      }
      expect(count("openCursor", "ops")).toBeGreaterThan(0);
      expect(count("getKey", "ops")).toBeGreaterThan(0);
    } else {
      for (const name of ["ops", "op_control", "op_target", "op_error"]) {
        expect(count("getAll", name, "unica-case")).toBeGreaterThan(0);
        expect(count("put", name, "terno-case")).toBeGreaterThan(0);
      }
      expect(count("getAll", "ops", "terno-case")).toBe(0);
    }
  } finally { await dispose(f.factory); }
});
