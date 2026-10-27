import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { expect, it, vi } from "vitest";
import { idbExists, MIGRATION_JOURNAL, migrateLegacyIdb } from "./legacy-storage";

const request = <T,>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const complete = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });

async function mailbox(factory: IDBFactory, name: string, dirty: boolean) {
  const open = factory.open(name, 1);
  open.onupgradeneeded = () => { open.result.createObjectStore("meta"); open.result.createObjectStore("threads"); };
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
