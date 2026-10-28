import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { expect, it, vi } from "vitest";
import { idbExists, MIGRATION_JOURNAL, migrateLegacyIdb } from "./legacy-storage";

const request = <T,>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const complete = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });

async function mailbox(factory: IDBFactory, name: string, dirty: boolean) {
  const open = factory.open(name, 1);
  open.onupgradeneeded = () => { open.result.createObjectStore("meta"); open.result.createObjectStore("threads"); open.result.createObjectStore("ops"); };
  const db = await request(open);
  try {
    const tx = db.transaction(["meta", "threads"], "readwrite"), ended = complete(tx);
    tx.objectStore("threads").put({ id: 1, subject: "Exact retained content" }, 1);
    tx.objectStore("meta").put({ version: 7 }, "retainedState");
    if (dirty) tx.objectStore("meta").put(undefined, "uncertainWrite");
    await ended;
  } finally { db.close(); }
}

async function journal(factory: IDBFactory, state: "copying" | "copied") {
  const open = factory.open(MIGRATION_JOURNAL, 1);
  open.onupgradeneeded = () => open.result.createObjectStore("copies");
  const db = await request(open);
  try {
    const tx = db.transaction("copies", "readwrite"), ended = complete(tx);
    tx.objectStore("copies").put({ from: "unica-case", state }, "terno-case");
    await ended;
  } finally { db.close(); }
}

async function snapshot(factory: IDBFactory) {
  const result: Record<string, unknown> = {};
  for (const { name } of await factory.databases()) {
    const db = await request(factory.open(name!));
    try {
      const names = Array.from(db.objectStoreNames), tx = db.transaction(names), ended = complete(tx);
      const rows = await Promise.all(names.map(async (name) => {
        const store = tx.objectStore(name);
        const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
        return { name, keys, values };
      }));
      await ended;
      result[name!] = { version: db.version, rows };
    } finally { db.close(); }
  }
  return result;
}

it.each(["source", "copying", "copied", "orphan-copied"] as const)("keeps dirty legacy data and its %s journal untouched", async (state) => {
  const factory = new IDBFactory();
  if (state !== "orphan-copied") await mailbox(factory, "unica-case", state === "source");
  if (state !== "source") {
    await mailbox(factory, "terno-case", true);
    await journal(factory, state === "copying" ? "copying" : "copied");
  }
  const before = await snapshot(factory);
  const error = await migrateLegacyIdb(factory, "case").then(() => null, (failure: unknown) => failure);
  expect.soft(error).toMatchObject({ name: "UncertainWriteError" });
  expect(await snapshot(factory)).toEqual(before);
});

it("preserves both copies and the journal if uncertainty appears during a copy", async () => {
  const factory = new IDBFactory();
  await mailbox(factory, "unica-case", false);
  let injected = false;
  const error = await migrateLegacyIdb(factory, "case", undefined, { afterBatch: async () => {
    if (injected) return;
    injected = true;
    const db = await request(factory.open("unica-case"));
    try {
      const tx = db.transaction("meta", "readwrite"), ended = complete(tx);
      tx.objectStore("meta").put({ version: 1 }, "uncertainWrite");
      await ended;
    } finally { db.close(); }
  } }).then(() => null, (failure: unknown) => failure);
  expect(injected).toBe(true);
  expect.soft(error).toMatchObject({ name: "UncertainWriteError" });
  expect(await idbExists(factory, "unica-case")).toBe(true);
  expect(await idbExists(factory, "terno-case")).toBe(true);
  const db = await request(factory.open(MIGRATION_JOURNAL));
  try { expect(await request(db.transaction("copies").objectStore("copies").get("terno-case"))).toEqual({ from: "unica-case", state: "copying" }); }
  finally { db.close(); }
});

it("keeps copy ownership if deleting an interrupted destination fails", async () => {
  const factory = new IDBFactory();
  await mailbox(factory, "unica-case", false);
  const remove = factory.deleteDatabase.bind(factory);
  const failure = new Error("injected delete refusal");
  const spy = vi.spyOn(factory, "deleteDatabase").mockImplementation((name) => {
    if (name === "terno-case") throw failure;
    return remove(name);
  });
  try {
    const error = await migrateLegacyIdb(factory, "case", undefined, { afterBatch: async () => { throw new Error("copy interrupted"); } }).then(() => null, (value: unknown) => value);
    expect(error).not.toBeNull();
    const after = await snapshot(factory);
    expect.soft(after[MIGRATION_JOURNAL]).toMatchObject({ rows: [{ name: "copies", keys: ["terno-case"], values: [{ from: "unica-case", state: "copying" }] }] });
    expect(await idbExists(factory, "unica-case")).toBe(true);
    expect(await idbExists(factory, "terno-case")).toBe(true);
  } finally { spy.mockRestore(); }
  await migrateLegacyIdb(factory, "case");
  expect(await idbExists(factory, "unica-case")).toBe(false);
  const db = await request(factory.open("terno-case"));
  try { expect(await request(db.transaction("threads").objectStore("threads").get(1))).toEqual({ id: 1, subject: "Exact retained content" }); }
  finally { db.close(); }
});

it.each(["source", "copying", "copied", "orphan-copied"] as const)("preserves an unreadable missing-meta mailbox at %s cleanup", async (state) => {
  const factory = new IDBFactory();
  if (state !== "orphan-copied") await mailbox(factory, "unica-case", false);
  if (state !== "source") {
    await mailbox(factory, "terno-case", false);
    await journal(factory, state === "copying" ? "copying" : "copied");
  }
  const name = state === "source" ? "unica-case" : "terno-case";
  const upgrade = factory.open(name, 2);
  upgrade.onupgradeneeded = () => upgrade.result.deleteObjectStore("meta");
  (await request(upgrade)).close();
  const before = await snapshot(factory), remove = vi.spyOn(factory, "deleteDatabase");
  try {
    const error = await migrateLegacyIdb(factory, "case").then(() => null, (failure: unknown) => failure);
    expect.soft(error).toMatchObject({ name: "UncertainWriteError", reason: "unreadable" });
    expect.soft(remove).not.toHaveBeenCalled();
    expect(await snapshot(factory)).toEqual(before);
  } finally { vi.restoreAllMocks(); }
});

it("still migrates the genuine native keys-only database", async () => {
  const factory = new IDBFactory(), open = factory.open("unica-keys", 1);
  open.onupgradeneeded = () => open.result.createObjectStore("keys").put(new Uint8Array([1, 2, 3]), "device");
  (await request(open)).close();
  await migrateLegacyIdb(factory, "case");
  expect(await idbExists(factory, "unica-keys")).toBe(false);
  const db = await request(factory.open("terno-keys"));
  try { expect(await request(db.transaction("keys").objectStore("keys").get("device"))).toEqual(new Uint8Array([1, 2, 3])); }
  finally { db.close(); }
});

it.each(["unica-case", "unica-keys"])("does not exempt a missing-meta mailbox based on its %s name or keys store", async (name) => {
  const factory = new IDBFactory(), open = factory.open(name, 1);
  open.onupgradeneeded = () => {
    open.result.createObjectStore("keys");
    open.result.createObjectStore("drafts").put({ id: 1, body_text: "retained work" }, 1);
  };
  (await request(open)).close();
  const before = await snapshot(factory);
  const error = await migrateLegacyIdb(factory, "case").then(() => null, (failure: unknown) => failure);
  expect.soft(error).toMatchObject({ name: "UncertainWriteError", reason: "unreadable" });
  expect(await snapshot(factory)).toEqual(before);
});

it.each(["suffix", "inline keys", "auto increment", "index"])("rejects a non-native key-store %s shape without deleting data", async (shape) => {
  const factory = new IDBFactory(), open = factory.open(shape === "suffix" ? "unica-demo-keys" : "unica-keys", 1);
  open.onupgradeneeded = () => {
    const store = open.result.createObjectStore("keys", { keyPath: shape === "inline keys" ? "id" : null, autoIncrement: shape === "auto increment" });
    if (shape === "index") store.createIndex("extra", "id");
  };
  (await request(open)).close();
  const before = await snapshot(factory);
  const error = await migrateLegacyIdb(factory, "case").then(() => null, (failure: unknown) => failure);
  expect(error).toMatchObject({ name: "UncertainWriteError", reason: "unreadable" });
  expect(await snapshot(factory)).toEqual(before);
});

it("does not begin copying when ownership success was not observed", async () => {
  const factory = new IDBFactory();
  await mailbox(factory, "unica-case", false);
  const before = await snapshot(factory), put = IDBObjectStore.prototype.put;
  let hits = 0, batches = 0;
  vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value, key) {
    const r = put.call(this, value, key);
    if (this.name === "copies" && key === "terno-case" && value.state === "copying") {
      hits++; r.addEventListener("success", (event) => event.stopImmediatePropagation());
    }
    return r;
  });
  try {
    const error = await migrateLegacyIdb(factory, "case", undefined, { afterBatch: async () => { batches++; throw new Error("unconfirmed ownership"); } }).then(() => null, (failure: unknown) => failure);
    expect(hits).toBe(1); expect.soft(batches).toBe(0); expect(error).not.toBeNull();
    expect.soft(await idbExists(factory, "terno-case")).toBe(false);
    const after = await snapshot(factory);
    expect(after["unica-case"]).toEqual(before["unica-case"]);
    expect(after[MIGRATION_JOURNAL]).toMatchObject({ rows: [{ name: "copies", keys: ["terno-case"], values: [{ from: "unica-case", state: "copying" }] }] });
  } finally { vi.restoreAllMocks(); }
});

it.each([false, true])("requires confirmed journal ownership before creating the destination (hidden error=%s)", async (hideError) => {
  const factory = new IDBFactory();
  await mailbox(factory, "unica-case", false);
  const open = factory.open(MIGRATION_JOURNAL, 1);
  open.onupgradeneeded = () => open.result.createObjectStore("copies").put({ from: "unica-anchor", state: "copied" }, "terno-anchor");
  (await request(open)).close();
  const before = await snapshot(factory), put = IDBObjectStore.prototype.put, transaction = IDBDatabase.prototype.transaction;
  let hits = 0, errors = 0, batches = 0, terminal: string | null = null;
  vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args) {
    const tx = transaction.call(this, ...args);
    if (this.name === MIGRATION_JOURNAL && args[1] === "readwrite") tx.addEventListener("error", (event) => {
      errors++;
      if (hideError) { event.preventDefault(); event.stopImmediatePropagation(); }
    }, true);
    return tx;
  });
  vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value, key) {
    if (this.name !== "copies" || key !== "terno-case" || value.state !== "copying") return put.call(this, value, key);
    hits++;
    const tx = this.transaction;
    tx.addEventListener("complete", () => { terminal = "complete"; });
    tx.addEventListener("abort", () => { terminal = "abort"; });
    // Earlier capture listener hides this real ConstraintError from both later observers.
    return this.add(value, "terno-anchor");
  });
  try {
    const error = await migrateLegacyIdb(factory, "case", undefined, { afterBatch: async () => { batches++; throw new Error("copy started without ownership"); } }).then(() => null, (failure: unknown) => failure);
    expect({ hits, errors, terminal }).toEqual({ hits: 1, errors: 1, terminal: hideError ? "complete" : "abort" });
    expect.soft(batches).toBe(0);
    expect(error).not.toBeNull();
    expect.soft(await idbExists(factory, "terno-case")).toBe(false);
    expect(await snapshot(factory)).toEqual(before);
  } finally { vi.restoreAllMocks(); }
});

it.each(["copied", "delete"])("refuses unconfirmed later journal %s success without losing the verified copy", async (stage) => {
  const factory = new IDBFactory();
  await mailbox(factory, "unica-case", false);
  const put = IDBObjectStore.prototype.put, remove = IDBObjectStore.prototype.delete;
  let hits = 0;
  const hide = <T,>(r: IDBRequest<T>) => { hits++; r.addEventListener("success", (event) => event.stopImmediatePropagation()); return r; };
  vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value, key) {
    const r = put.call(this, value, key);
    return stage === "copied" && this.name === "copies" && value.state === "copied" ? hide(r) : r;
  });
  vi.spyOn(IDBObjectStore.prototype, "delete").mockImplementation(function (this: IDBObjectStore, key) {
    const r = remove.call(this, key);
    return stage === "delete" && this.name === "copies" && key === "terno-case" ? hide(r) : r;
  });
  try {
    const error = await migrateLegacyIdb(factory, "case").then(() => null, (failure: unknown) => failure);
    expect(hits).toBe(1); expect(error).not.toBeNull();
    expect(await idbExists(factory, "unica-case")).toBe(stage === "copied");
    const db = await request(factory.open("terno-case"));
    try { expect(await request(db.transaction("threads").objectStore("threads").get(1))).toEqual({ id: 1, subject: "Exact retained content" }); }
    finally { db.close(); }
    const after = await snapshot(factory);
    expect(after[MIGRATION_JOURNAL]).toMatchObject({ rows: [{ name: "copies", keys: stage === "copied" ? ["terno-case"] : [] }] });
  } finally { vi.restoreAllMocks(); }
  await migrateLegacyIdb(factory, "case");
  expect(await idbExists(factory, "unica-case")).toBe(false);
  expect(await idbExists(factory, "terno-case")).toBe(true);
});
