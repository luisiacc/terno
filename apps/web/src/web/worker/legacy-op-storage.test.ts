import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { expect, it, vi } from "vitest";
import { IdbMailStore } from "@terno/idb";
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
