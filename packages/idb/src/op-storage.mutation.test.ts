import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { expect, it, vi } from "vitest";
import { MemDb, type Row } from "./mem";
import { databaseName, openIdb, persist, readAll, PartialCommit } from "./schema";
import { OP_PART_STORES, validateCompleteOpStorage } from "./op-storage";
import { UNCERTAINTY_KEY, UncertainWriteError } from "./uncertainty";

const request = <T,>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const ended = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
const row = (id = "a"): Row => ({ id, seq: id === "a" ? 1 : 2, account_id: 1, kind: "send", target_json: '{"messageIds":[1]}', payload_json: '{"text":"synthetic-wire"}', state: "queued", attempts: 0, next_attempt_at: 0, last_error: "old-error", created_at: 1, updated_at: 1 });
const host = { yield: () => new Promise<void>((resolve) => setImmediate(resolve)) };

async function setup() {
  const factory = new IDBFactory(), name = crypto.randomUUID(), idb = await openIdb(factory, name);
  const mem = new MemDb([{ name: "ops", key: ["id"], indexes: { state: ["state"] } }], []);
  const ops = mem.table("ops");
  const flush = async () => { const commit = mem.takeCommit()!; await persist(idb, commit, "strict", host); mem.confirm(); };
  mem.tx(() => { ops.insert(row()); ops.insert(row("b")); });
  await flush();
  return { factory, name, idb, mem, ops, flush };
}
async function disk(idb: IDBDatabase) {
  const tx = idb.transaction(["ops", ...OP_PART_STORES, "meta"]), done = ended(tx);
  const image = await Promise.all(["ops", ...OP_PART_STORES, "meta"].map(async (name) => {
    const store = tx.objectStore(name);
    const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
    return { name, keys, values };
  }));
  await done; return image;
}
async function close(context: Awaited<ReturnType<typeof setup>>) {
  context.idb.close();
  await request(context.factory.deleteDatabase(databaseName(context.name)));
}

it("caught nested replacement rollback keeps a surviving control update off BASE", async () => {
  const c = await setup(), put = IDBObjectStore.prototype.put;
  let basePuts = 0, controlPuts = 0;
  const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
    const r = Reflect.apply(put, this, args) as IDBRequest;
    if (this.name === "ops") basePuts++;
    if (this.name === "op_control") controlPuts++;
    return r;
  });
  try {
    c.mem.tx(() => {
      try { c.mem.tx(() => { c.ops.put({ ...c.ops.get("a")!, payload_json: "rolled-back-wire" }); throw new Error("rollback"); }); } catch { /* savepoint */ }
      c.ops.update(c.ops.get("a")!, { state: "running", attempts: 1 });
    });
    await c.flush();
    expect({ basePuts, controlPuts }).toEqual({ basePuts: 0, controlPuts: 1 });
    expect((await readAll(c.idb)).get("ops")!.find((r) => r.id === "a")).toEqual({ ...row(), state: "running", attempts: 1 });
  } finally { spy.mockRestore(); await close(c); }
});

it.each(["put", "delete-reinsert", "payload", "move", "collision"] as const)("%s rebases the final row and clears owned stale parts", async (kind) => {
  const c = await setup();
  try {
    c.mem.tx(() => c.ops.update(c.ops.get("a")!, { target_json: '{"messageIds":[9]}', last_error: "changed-error" }));
    await c.flush();
    const latest = { ...c.ops.get("a")! };
    let key = "a";
    c.mem.tx(() => {
      if (kind === "put") c.mem.tx(() => c.ops.put({ ...latest }));
      if (kind === "delete-reinsert") { c.ops.delete("a"); c.ops.insert({ ...latest }); }
      if (kind === "payload") c.ops.update(c.ops.get("a")!, { payload_json: '{"text":"new-wire"}' });
      if (kind === "move" || kind === "collision") {
        key = kind === "move" ? "c" : "b";
        c.ops.update(c.ops.get("a")!, { id: key });
      }
    });
    await c.flush();
    const image = await disk(c.idb), base = image.find((t) => t.name === "ops")!;
    const at = base.keys.indexOf(key);
    expect(base.values[at]).toEqual(c.ops.get(key));
    for (const name of OP_PART_STORES) expect(image.find((t) => t.name === name)!.keys).not.toContain(key);
    if (key !== "a") {
      expect(base.keys).not.toContain("a");
      for (const name of OP_PART_STORES) expect(image.find((t) => t.name === name)!.keys).not.toContain("a");
    }
    c.idb.close();
    const reopened = await openIdb(c.factory, c.name);
    try { expect((await readAll(reopened)).get("ops")!.find((r) => r.id === key)).toEqual(c.ops.get(key)); }
    finally { reopened.close(); }
  } finally { await close(c); }
});

it("body plus later top-level unit compares the first surviving error preimage", async () => {
  const c = await setup(), put = IDBObjectStore.prototype.put;
  let errors = 0;
  const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
    const r = Reflect.apply(put, this, args) as IDBRequest;
    if (this.name === "op_error") errors++;
    return r;
  });
  try {
    c.mem.tx(() => c.ops.update(c.ops.get("a")!, { last_error: null }));
    c.mem.tx(() => c.ops.update(c.ops.get("a")!, { last_error: "old-error", state: "succeeded" }));
    await c.flush();
    expect(errors).toBe(0);
    expect((await readAll(c.idb)).get("ops")!.find((r) => r.id === "a")).toEqual({ ...row(), state: "succeeded" });
  } finally { spy.mockRestore(); await close(c); }
});

it("unknown own presence uses a full final rebase without losing latest fields", async () => {
  const c = await setup();
  try {
    c.mem.tx(() => c.ops.put({ ...row(), legacy_extra: undefined, last_error: null }));
    await c.flush();
    c.mem.tx(() => c.ops.update(c.ops.get("a")!, { state: "running" }));
    await c.flush();
    const stored = (await readAll(c.idb)).get("ops")!.find((r) => r.id === "a")!;
    expect(stored.state).toBe("running");
    expect(stored.last_error).toBeNull();
    expect(Object.hasOwn(stored, "legacy_extra")).toBe(true);
    const image = await disk(c.idb);
    for (const name of OP_PART_STORES) expect(image.find((t) => t.name === name)!.keys).not.toContain("a");
  } finally { await close(c); }
});

for (const hidden of [false, true]) it(`actual error-part ${hidden ? "hidden success refuses completed image" : "enqueue failure waits for abort and restores old image"}`, async () => {
  const c = await setup(), before = await disk(c.idb), put = IDBObjectStore.prototype.put;
  const injected = new Error("synthetic error-part enqueue");
  let faults = 0, controls = 0, terminal: string | null = null;
  const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
    if (this.name === "op_control") {
      controls++;
      this.transaction.addEventListener("abort", () => { terminal = "abort"; });
      this.transaction.addEventListener("complete", () => { terminal = "complete"; });
    }
    if (this.name === "op_error") {
      faults++;
      if (!hidden) throw injected;
      const r = Reflect.apply(put, this, args) as IDBRequest;
      r.addEventListener("success", (event) => event.stopImmediatePropagation());
      return r;
    }
    return Reflect.apply(put, this, args) as IDBRequest;
  });
  try {
    c.mem.tx(() => c.ops.update(c.ops.get("a")!, { state: "failed", last_error: "new-error" }));
    const failure = await persist(c.idb, c.mem.takeCommit()!, "strict", host).then(() => null, (e: unknown) => e);
    expect({ controls, faults, terminal }).toEqual({ controls: 1, faults: 1, terminal: hidden ? "complete" : "abort" });
    spy.mockRestore();
    if (hidden) {
      expect(failure).toBeInstanceOf(PartialCommit);
      const tx = c.idb.transaction("meta"), done = ended(tx), marker = await request(tx.objectStore("meta").getKey(UNCERTAINTY_KEY));
      await done; expect(marker).toBe(UNCERTAINTY_KEY);
      await expect(validateCompleteOpStorage(c.idb)).rejects.toBeInstanceOf(UncertainWriteError);
    } else {
      expect(failure).toBe(injected);
      c.mem.revert();
      expect(await disk(c.idb)).toEqual(before);
      expect(c.ops.get("a")).toEqual(row());
    }
  } finally { spy.mockRestore(); await close(c); }
});

it.each([undefined, null, { last_error: undefined }, { last_error: null, extra: 1 }])("stored malformed private error value refuses, including present undefined: %j", async (value) => {
  const c = await setup();
  try {
    const tx = c.idb.transaction("op_error", "readwrite"), done = ended(tx);
    tx.objectStore("op_error").put(value, "a");
    await done;
    const before = await disk(c.idb);
    await expect(validateCompleteOpStorage(c.idb)).rejects.toBeInstanceOf(UncertainWriteError);
    await expect(readAll(c.idb)).rejects.toBeInstanceOf(UncertainWriteError);
    expect(await disk(c.idb)).toEqual(before);
  } finally { await close(c); }
});
