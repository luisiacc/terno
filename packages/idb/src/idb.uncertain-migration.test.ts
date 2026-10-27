import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { expect, it, vi } from "vitest";
import { databaseName, openIdb } from "./schema";
import { IdbMailStore } from "./store";
import { legacyStores } from "./test/legacy-stores";
import { UNCERTAINTY_KEY } from "./uncertainty";

const request = <T,>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setImmediate(resolve)) };

async function version1(factory: IDBFactory, name: string) {
  const open = factory.open(databaseName(name), 1);
  open.onupgradeneeded = () => {
    for (const store of legacyStores(1)) open.result.createObjectStore(store);
    open.result.createObjectStore("meta");
    const tx = open.transaction!;
    tx.objectStore("cat_batches").put({ id: 5, category_id: 2, source: "dnd", scope_json: JSON.stringify({ kind: "move", from: 1, phase: "done" }), added: 2, created_at: 0, undone_at: null }, 5);
    for (const id of [9, 10]) tx.objectStore("cat_move_rows").put({ batch_id: 5, thread_id: id, added_by: "user", added_at: 10, prev_batch_id: null }, [5, id]);
    tx.objectStore("threads").put({ id: 9 }, 9);
    for (const id of [41, 42]) tx.objectStore("messages").put({ id, thread_id: 9, attachment_pending: 0 }, id);
    for (const id of [21, 22]) tx.objectStore("drafts").put({ id, account_id: 1, to_json: "[]", cc_json: "[]", subject: "exact", body_text: `retained body ${id}`, in_reply_to_message_id: id === 21 ? 41 : null, updated_at: 5 }, id);
    tx.objectStore("settings").put({ key: "anchor", value_json: "true" }, "anchor");
  };
  (await request(open)).close();
}

async function moveImage(db: IDBDatabase) {
  const rows = db.transaction("cat_move_rows").objectStore("cat_move_rows");
  const [keys, values] = await Promise.all([request(rows.getAllKeys()), request(rows.getAll())]);
  const marker = await request(db.transaction("meta").objectStore("meta").getKey(UNCERTAINTY_KEY));
  return { version: db.version, keys, values, marker };
}

async function image(db: IDBDatabase) {
  const stores = Array.from(db.objectStoreNames);
  const tx = db.transaction(stores);
  const ended = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
  const rows = await Promise.all(stores.map(async (name) => {
    const s = tx.objectStore(name);
    const [keys, values] = await Promise.all([request(s.getAllKeys()), request(s.getAll())]);
    return { name, keyPath: s.keyPath, autoIncrement: s.autoIncrement, indexes: Array.from(s.indexNames).map((name) => { const i = s.index(name); return { name, keyPath: i.keyPath, unique: i.unique, multiEntry: i.multiEntry }; }), keys, values };
  }));
  await ended;
  return { version: db.version, rows };
}

it.each(["healthy", "abort", "prevented"] as const)("protects legacy move migration writes on %s completion", async (fault) => {
  const factory = new IDBFactory(), name = crypto.randomUUID();
  await version1(factory, name);
  let raw = await request(factory.open(databaseName(name))), exposed: IDBDatabase | undefined;
  const before = await moveImage(raw), wholeBefore = await image(raw); raw.close();
  const put = IDBObjectStore.prototype.put;
  let writes = 0, errors = 0, terminal: string | null = null;
  vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value, key) {
    if (this.transaction.mode !== "versionchange" || this.name !== "cat_move_rows") return put.call(this, value, key);
    writes++;
    if (writes === 1) {
      this.transaction.addEventListener("complete", () => { terminal = "complete"; });
      this.transaction.addEventListener("abort", () => { terminal = "abort"; });
    }
    if (writes !== 2 || fault === "healthy") return put.call(this, value, key);
    const r = this.add(value, [5, 9, 1]);
    r.addEventListener("error", (event) => { errors++; if (fault === "prevented") event.preventDefault(); });
    return r;
  });
  try {
    const error = await openIdb(factory, name).then((db) => { exposed = db; return null; }, (failure: unknown) => failure);
    exposed?.close(); vi.restoreAllMocks();
    raw = await request(factory.open(databaseName(name)));
    const after = await moveImage(raw);
    expect({ writes, errors, terminal }).toEqual({ writes: 2, errors: fault === "healthy" ? 0 : 1, terminal: fault === "abort" ? "abort" : "complete" });
    if (fault === "healthy") {
      expect(error).toBeNull(); expect(after.keys).toEqual([[5, 9, 1], [5, 10, 1]]); expect(after.marker).toBeUndefined();
      const migrated = await image(raw);
      expect(migrated.rows.find((s) => s.name === "drafts")?.values).toEqual([
        expect.objectContaining({ id: 21, mode: "reply", thread_id: 9, body_text: "retained body 21", format: 1 }),
        expect.objectContaining({ id: 22, mode: "new", thread_id: null, body_text: "retained body 22", format: 1 }),
      ]);
      expect(migrated.rows.find((s) => s.name === "messages")?.values).toEqual([expect.objectContaining({ id: 41, attachment_pending: 1 }), expect.objectContaining({ id: 42, attachment_pending: 1 })]);
      expect(migrated.rows.find((s) => s.name === "settings")?.values).toContainEqual({ key: "facts_backfill", value_json: JSON.stringify({ phase: "senders", after: 0 }) });
    } else if (fault === "abort") {
      expect(error).not.toBeNull(); expect(after).toEqual(before);
      expect(await image(raw)).toEqual(wholeBefore);
    } else {
      expect(after.keys).toEqual([[5, 9, 1]]);
      expect.soft(after.marker).toBe(UNCERTAINTY_KEY);
      expect.soft(exposed !== undefined).toBe(false);
      expect(error).not.toBeNull();
      raw.close();
      await expect(IdbMailStore.open({ factory, name, instantSearch: true, platform })).rejects.toMatchObject({ name: "UncertainWriteError", reason: "dirty" });
    }
  } finally { vi.restoreAllMocks(); raw.close(); exposed?.close(); }
});

it.each(["child success", "cursor exhaustion", "callback throw"] as const)("does not clear the migration marker after unconfirmed %s", async (fault) => {
  const factory = new IDBFactory(), name = crypto.randomUUID();
  await version1(factory, name);
  let raw = await request(factory.open(databaseName(name))), exposed: IDBDatabase | undefined;
  const before = await image(raw); raw.close();
  const get = IDBObjectStore.prototype.get, cursor = IDBObjectStore.prototype.openCursor, clear = IDBObjectStore.prototype.clear;
  const injected = new Error("migration callback could not enqueue");
  let hits = 0, terminal: string | null = null;
  const observe = (tx: IDBTransaction) => {
    tx.addEventListener("complete", () => { terminal = "complete"; });
    tx.addEventListener("abort", () => { terminal = "abort"; });
  };
  vi.spyOn(IDBObjectStore.prototype, "get").mockImplementation(function (this: IDBObjectStore, ...args) {
    const r = get.call(this, ...args);
    if (fault === "child success" && this.transaction.mode === "versionchange" && this.name === "messages" && args[0] === 41) {
      hits++; observe(this.transaction); r.addEventListener("success", (event) => event.stopImmediatePropagation());
    }
    return r;
  });
  vi.spyOn(IDBObjectStore.prototype, "openCursor").mockImplementation(function (this: IDBObjectStore, ...args) {
    const r = cursor.call(this, ...args);
    if (fault === "cursor exhaustion" && this.transaction.mode === "versionchange" && this.name === "messages") {
      observe(this.transaction); r.addEventListener("success", (event) => { if (r.result === null) { hits++; event.stopImmediatePropagation(); } });
    }
    return r;
  });
  vi.spyOn(IDBObjectStore.prototype, "clear").mockImplementation(function (this: IDBObjectStore) {
    if (fault === "callback throw" && this.transaction.mode === "versionchange" && this.name === "cat_move_rows") { hits++; observe(this.transaction); throw injected; }
    return clear.call(this);
  });
  try {
    const error = await openIdb(factory, name).then((db) => { exposed = db; return null; }, (failure: unknown) => failure);
    exposed?.close(); vi.restoreAllMocks();
    expect({ hits, terminal, exposed: exposed !== undefined }).toEqual({ hits: 1, terminal: fault === "callback throw" ? "abort" : "complete", exposed: false });
    raw = await request(factory.open(databaseName(name)));
    if (fault === "callback throw") { expect(error).toBe(injected); expect(await image(raw)).toEqual(before); }
    else {
      expect(error).toMatchObject({ name: "UncertainWriteError", reason: "unreadable" });
      expect((await moveImage(raw)).marker).toBe(UNCERTAINTY_KEY); raw.close();
      await expect(openIdb(factory, name)).rejects.toMatchObject({ name: "UncertainWriteError", reason: "dirty" });
    }
  } finally { vi.restoreAllMocks(); raw.close(); exposed?.close(); }
});

it.each(["drafts", "settings", "messages"])("retains uncertainty after a real prevented %s migration error", async (stage) => {
  const factory = new IDBFactory(), name = crypto.randomUUID();
  await version1(factory, name);
  const put = IDBObjectStore.prototype.put, update = IDBCursor.prototype.update;
  let hits = 0, errors = 0, terminal: string | null = null, exposed: IDBDatabase | undefined, raw: IDBDatabase | undefined;
  const fail = (store: IDBObjectStore, value: unknown, key: IDBValidKey) => {
    hits++;
    store.transaction.addEventListener("complete", () => { terminal = "complete"; });
    const r = store.add(value, key);
    r.addEventListener("error", (event) => { errors++; event.preventDefault(); });
    return r;
  };
  vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value, key) {
    if (this.transaction.mode === "versionchange" && this.name === stage && !hits) return fail(this, value, stage === "drafts" ? 21 : "anchor");
    return put.call(this, value, key);
  });
  vi.spyOn(IDBCursor.prototype, "update").mockImplementation(function (this: IDBCursor, value) {
    if (stage === "messages" && this.source instanceof IDBObjectStore && this.source.transaction.mode === "versionchange" && !hits) return fail(this.source, value, 41);
    return update.call(this, value);
  });
  try {
    const error = await openIdb(factory, name).then((db) => { exposed = db; return null; }, (failure: unknown) => failure);
    exposed?.close(); vi.restoreAllMocks();
    expect({ hits, errors, terminal }).toEqual({ hits: 1, errors: 1, terminal: "complete" });
    raw = await request(factory.open(databaseName(name)));
    const after = await moveImage(raw);
    const saved = await image(raw);
    if (stage === "drafts") {
      expect(saved.rows.find((s) => s.name === "drafts")!.values).toEqual([
        expect.objectContaining({ id: 21, mode: "reply", format: 1, body_text: "retained body 21" }),
        { id: 22, account_id: 1, to_json: "[]", cc_json: "[]", subject: "exact", body_text: "retained body 22", in_reply_to_message_id: null, updated_at: 5 },
      ]);
    } else if (stage === "settings") {
      expect(saved.rows.find((s) => s.name === "settings")!.values).toEqual([{ key: "anchor", value_json: "true" }]);
    } else {
      expect(saved.rows.find((s) => s.name === "messages")!.values).toEqual([{ id: 41, thread_id: 9, attachment_pending: 0 }, { id: 42, thread_id: 9, attachment_pending: 1 }]);
    }
    expect.soft(after.marker).toBe(UNCERTAINTY_KEY);
    expect.soft(exposed !== undefined).toBe(false);
    expect(error).not.toBeNull(); raw.close();
    await expect(openIdb(factory, name)).rejects.toMatchObject({ name: "UncertainWriteError", reason: "dirty" });
  } finally { vi.restoreAllMocks(); raw?.close(); exposed?.close(); }
});

for (const fixture of ["mixed v1", "last child v2"] as const) {
  it.each(["healthy", "abort", "prevented"] as const)(`confirms the exact reply-child migration write in ${fixture}: %s`, async (fault) => {
    const factory = new IDBFactory(), name = crypto.randomUUID();
    if (fixture === "mixed v1") await version1(factory, name);
    else {
      const open = factory.open(databaseName(name), 2);
      open.onupgradeneeded = () => {
        for (const store of legacyStores(2)) open.result.createObjectStore(store);
        open.result.createObjectStore("meta");
        // No other row work: this missing-source lookup is the last tracked read.
        open.transaction!.objectStore("drafts").put({ id: 21, account_id: 1, to_json: "[]", cc_json: "[]", subject: "exact", body_text: "retained body 21", in_reply_to_message_id: 41, updated_at: 5 }, 21);
      };
      (await request(open)).close();
    }
    let raw = await request(factory.open(databaseName(name))), exposed: IDBDatabase | undefined;
    const before = await image(raw); raw.close();
    const put = IDBObjectStore.prototype.put, get = IDBObjectStore.prototype.get;
    let markerSuccess = 0, sourceSuccess = 0, childWrites = 0, directWrites = 0, errors = 0, requestError: unknown, terminal: string | null = null;
    let childAt: { markerSuccess: number; sourceSuccess: number } | undefined;
    vi.spyOn(IDBObjectStore.prototype, "get").mockImplementation(function (this: IDBObjectStore, ...args) {
      const r = get.call(this, ...args);
      if (this.transaction.mode === "versionchange" && this.name === "messages" && args[0] === 41) r.addEventListener("success", () => { sourceSuccess++; });
      return r;
    });
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.transaction.mode !== "versionchange") return put.call(this, value, key);
      if (this.name === "meta" && key === UNCERTAINTY_KEY) {
        const r = put.call(this, value, key); r.addEventListener("success", () => { markerSuccess++; }); return r;
      }
      if (this.name === "drafts" && key === 22) directWrites++;
      if (this.name !== "drafts" || key !== 21 || value.mode !== "reply" || value.thread_id !== (fixture === "mixed v1" ? 9 : null)) return put.call(this, value, key);
      childWrites++;
      childAt = { markerSuccess, sourceSuccess };
      this.transaction.addEventListener("complete", () => { terminal = "complete"; });
      this.transaction.addEventListener("abort", () => { terminal = "abort"; });
      const r = fault === "healthy" ? put.call(this, value, key) : this.add(value, 21);
      r.addEventListener("error", (event) => { errors++; requestError = r.error; if (fault === "prevented") event.preventDefault(); });
      return r;
    });
    try {
      const error = await openIdb(factory, name).then((db) => { exposed = db; return null; }, (failure: unknown) => failure);
      exposed?.close(); vi.restoreAllMocks();
      expect({ markerSuccess, sourceSuccess, childWrites, directWrites, errors, terminal }).toEqual({ markerSuccess: 1, sourceSuccess: 1, childWrites: 1, directWrites: fixture === "mixed v1" ? 1 : 0, errors: fault === "healthy" ? 0 : 1, terminal: fault === "abort" ? "abort" : "complete" });
      expect(childAt).toEqual({ markerSuccess: 1, sourceSuccess: 1 });
      raw = await request(factory.open(databaseName(name)));
      const after = await image(raw), drafts = after.rows.find((s) => s.name === "drafts")!.values;
      expect(drafts).toContainEqual(expect.objectContaining({ id: 21, body_text: "retained body 21" }));
      if (fixture === "mixed v1") expect(drafts).toContainEqual(expect.objectContaining({ id: 22, body_text: "retained body 22" }));
      if (fault === "healthy") {
        expect(error).toBeNull();
        expect(drafts).toContainEqual(expect.objectContaining({ id: 21, mode: "reply", format: 1, thread_id: fixture === "mixed v1" ? 9 : null }));
        expect(await request(raw.transaction("meta").objectStore("meta").getKey(UNCERTAINTY_KEY))).toBeUndefined();
      } else if (fault === "abort") {
        expect(error).toBe(requestError); expect(after).toEqual(before);
      } else {
        expect(requestError).toMatchObject({ name: "ConstraintError" });
        expect(error).toMatchObject({ name: "UncertainWriteError", reason: "unreadable" });
        expect(exposed !== undefined).toBe(false);
        expect(await request(raw.transaction("meta").objectStore("meta").getKey(UNCERTAINTY_KEY))).toBe(UNCERTAINTY_KEY);
        expect(drafts.find((d) => (d as { id: number }).id === 21)).toEqual(before.rows.find((s) => s.name === "drafts")!.values.find((d) => (d as { id: number }).id === 21));
        if (fixture === "mixed v1") expect(drafts).toContainEqual(expect.objectContaining({ id: 22, mode: "new", format: 1 }));
        raw.close();
        await expect(IdbMailStore.open({ factory, name, instantSearch: true, platform })).rejects.toMatchObject({ name: "UncertainWriteError", reason: "dirty" });
      }
    } finally { vi.restoreAllMocks(); raw.close(); exposed?.close(); }
  });
}
