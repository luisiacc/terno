import type { Committed, Key, Row } from "./mem";
import { UNCERTAINTY_KEY, UncertainWriteError } from "./uncertainty";

export const OP_STORAGE_VERSION = 11;
/** the database's physical version (schema.ts says what each one added); a newer one is another adapter's */
export const IDB_VERSION = 20;
export const OP_PART_STORES = ["op_control", "op_target", "op_error"] as const;
export type OpPartStore = typeof OP_PART_STORES[number];
export type OpPhysicalStore = "ops" | OpPartStore;
type YieldHost = { yield(): Promise<void> };
export type OpPartImage = { keys: IDBValidKey[]; values: unknown[] };
type PartCell = { present: boolean; value: unknown };
export type OpWrite =
  | { kind: "delete"; key: Key }
  | { kind: "base"; key: Key; value: Row }
  | { kind: "parts"; key: Key; control: Row; target?: Row; error?: Row };

const FIELDS = ["id", "seq", "account_id", "kind", "target_json", "payload_json", "state", "attempts", "next_attempt_at", "last_error", "created_at", "updated_at"] as const;
const CONTROL = ["state", "attempts", "next_attempt_at", "updated_at"] as const;
const STATES = new Set(["queued", "running", "succeeded", "failed", "unknown"]);
const IMMUTABLE = ["id", "seq", "account_id", "kind", "created_at", "payload_json"] as const;
const PART_FIELDS: Record<OpPartStore, readonly string[]> = {
  op_control: CONTROL, op_target: ["target_json"], op_error: ["last_error"],
};

function unreadable(): UncertainWriteError {
  return new UncertainWriteError("unreadable", new Error("Operation storage inspection failed"));
}
function exact(value: unknown, fields: readonly string[]): value is Row {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === fields.length && fields.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value");
  });
}
function canonical(value: unknown, key: IDBValidKey): value is Row {
  if (!exact(value, FIELDS) || typeof key !== "string" || value.id !== key) return false;
  return ["seq", "account_id", "attempts", "next_attempt_at", "created_at", "updated_at"].every((f) => typeof value[f] === "number")
    && ["id", "kind", "target_json", "payload_json"].every((f) => typeof value[f] === "string")
    && STATES.has(value.state as string) && (value.last_error === null || typeof value.last_error === "string");
}
function part(name: OpPartStore, key: IDBValidKey, value: unknown): Row {
  if (typeof key !== "string" || !exact(value, PART_FIELDS[name])) throw unreadable();
  if (name === "op_control") {
    if (!STATES.has(value.state as string) || !CONTROL.slice(1).every((f) => typeof value[f] === "number")) throw unreadable();
  } else if (name === "op_target" ? typeof value.target_json !== "string" : value.last_error !== null && typeof value.last_error !== "string") throw unreadable();
  return value;
}
function checkParts(key: IDBValidKey, base: unknown, cells: readonly PartCell[]): void {
  if (!cells.some((cell) => cell.present)) return;
  if (!canonical(base, key)) throw unreadable();
  cells.forEach((cell, i) => { if (cell.present) part(OP_PART_STORES[i]!, key, cell.value); });
}
async function slice(started: number, host?: YieldHost): Promise<number> {
  if (performance.now() - started <= 8) return started;
  if (host) await host.yield();
  else await new Promise<void>((resolve) => setTimeout(resolve, 0));
  return performance.now();
}

export async function prepareOpWrites(commit: Committed, host?: YieldHost): Promise<OpWrite[]> {
  const writes: OpWrite[] = [];
  let started = performance.now();
  for (const [table, rows] of commit.writes) {
    if (table.spec.name !== "ops") continue;
    for (const [key, row] of rows) {
      const preimage = commit.opPreimages?.get(key);
      const before = preimage?.before;
      if (row === null) writes.push({ kind: "delete", key });
      else if (!preimage || preimage.forceRebase || !canonical(before, key) || !canonical(row, key)
        || IMMUTABLE.some((field) => !Object.is(before[field], row[field]))) writes.push({ kind: "base", key, value: row });
      else {
        const control = Object.fromEntries(CONTROL.map((field) => [field, row[field]]));
        writes.push({ kind: "parts", key, control,
          ...(!Object.is(before.target_json, row.target_json) ? { target: { target_json: row.target_json } } : {}),
          ...(!Object.is(before.last_error, row.last_error) ? { error: { last_error: row.last_error } } : {}) });
      }
      started = await slice(started, host);
    }
  }
  return writes;
}

export function inspectOpLayout(db: IDBDatabase, tx: IDBTransaction): "legacy" | "parts" {
  if (db.version > IDB_VERSION || !db.objectStoreNames.contains("meta") || !db.objectStoreNames.contains("ops")) throw unreadable();
  for (const name of ["ops", "meta"]) {
    const store = tx.objectStore(name);
    if (store.keyPath !== null || store.autoIncrement) throw unreadable();
  }
  const count = OP_PART_STORES.filter((name) => db.objectStoreNames.contains(name)).length;
  if (db.version < OP_STORAGE_VERSION) {
    if (count) throw unreadable();
    return "legacy";
  }
  if (count !== OP_PART_STORES.length) throw unreadable();
  for (const name of OP_PART_STORES) {
    const store = tx.objectStore(name);
    if (store.keyPath !== null || store.autoIncrement || store.indexNames.length) throw unreadable();
  }
  return "parts";
}

export async function decodeOpImage(keys: IDBValidKey[], rows: Row[], images: Record<OpPartStore, OpPartImage>, host?: YieldHost): Promise<void> {
  if (keys.length !== rows.length) throw unreadable();
  const index = new Map<string, number>();
  let started = performance.now();
  for (let i = 0; i < keys.length; i++) {
    if (typeof keys[i] === "string") index.set(keys[i] as string, i);
    started = await slice(started, host);
  }
  for (const name of OP_PART_STORES) {
    const image = images[name];
    if (image.keys.length !== image.values.length) throw unreadable();
    for (let i = 0; i < image.keys.length; i++) {
      const key = image.keys[i]!;
      const value = part(name, key, image.values[i]);
      const at = typeof key === "string" ? index.get(key) : undefined;
      if (at === undefined || !canonical(rows[at], key)) throw unreadable();
      Object.assign(rows[at]!, value);
      started = await slice(started, host);
    }
  }
}

/** A copy batch owns its marker, body requests and actual readonly terminal. */
export function readOpCopyBatch(db: IDBDatabase, name: OpPhysicalStore, after: IDBValidKey | undefined, count: number): Promise<{ keys: IDBValidKey[]; values: unknown[] }> {
  const layout = db.version >= OP_STORAGE_VERSION ? "parts" : "legacy";
  if (name !== "ops" && layout !== "parts") return Promise.reject(unreadable());
  const names = layout === "parts" ? ["ops", ...OP_PART_STORES, "meta"] : ["ops", "meta"];
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try { tx = db.transaction(names, "readonly"); } catch { reject(unreadable()); return; }
    let failure: unknown, failed = false, ready = false;
    let keys: IDBValidKey[] = [], values: unknown[] = [];
    const abort = (error: unknown) => {
      if (!failed) { failed = true; failure = error; }
      try { tx.abort(); } catch { /* Reconcile only at the actual terminal. */ }
    };
    const guarded = (fn: () => void) => () => { try { fn(); } catch (error) { abort(error); } };
    const watch = <T>(request: IDBRequest<T>, success: (value: T) => void) => {
      request.addEventListener("error", () => abort(unreadable()));
      request.addEventListener("success", guarded(() => success(request.result)));
    };
    tx.addEventListener("error", () => { if (!failed) { failed = true; failure = unreadable(); } }, true);
    tx.addEventListener("abort", () => reject(failure ?? unreadable()));
    tx.addEventListener("complete", () => {
      if (failed || !ready) reject(failure ?? unreadable());
      else resolve({ keys, values });
    });
    const visit = (i: number): void => {
      if (i === keys.length) { ready = true; return; }
      const key = keys[i]!;
      if (name !== "ops") {
        part(name, key, values[i]);
        watch(tx.objectStore("ops").getKey(key), (present) => {
          if (present === undefined) throw unreadable();
          visit(i + 1);
        });
      } else if (layout === "parts") {
        const cells: PartCell[] = [];
        let remaining = OP_PART_STORES.length;
        OP_PART_STORES.forEach((storeName, at) => {
          // A cursor distinguishes a stored undefined value from absence.
          watch(tx.objectStore(storeName).openCursor(IDBKeyRange.only(key)), (cursor) => {
            cells[at] = { present: cursor !== null, value: cursor?.value };
            if (--remaining === 0) { checkParts(key, values[i], cells); visit(i + 1); }
          });
        });
      } else visit(i + 1);
    };
    try {
      inspectOpLayout(db, tx);
      watch(tx.objectStore("meta").getKey(UNCERTAINTY_KEY), (marker) => {
        if (marker !== undefined) throw new UncertainWriteError();
        const range = after === undefined ? undefined : IDBKeyRange.lowerBound(after, true);
        let remaining = 2;
        const received = () => { if (--remaining === 0) { if (keys.length !== values.length) throw unreadable(); visit(0); } };
        watch(tx.objectStore(name).getAllKeys(range, count), (result) => { keys = result; received(); });
        watch(tx.objectStore(name).getAll(range, count), (result) => { values = result; received(); });
      });
    } catch (error) { abort(error); }
  });
}

function readCompleteOpStep(db: IDBDatabase, name: OpPhysicalStore, after: IDBValidKey | undefined): Promise<IDBValidKey | undefined> {
  const layout = db.version >= OP_STORAGE_VERSION ? "parts" : "legacy";
  const names = layout === "parts" ? ["ops", ...OP_PART_STORES, "meta"] : ["ops", "meta"];
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try { tx = db.transaction(names, "readonly"); } catch { reject(unreadable()); return; }
    let failure: unknown, failed = false, ready = false, pending = 0;
    let next: IDBValidKey | undefined, base: unknown, cells: PartCell[] = [];
    const listeners: (() => void)[] = [];
    const release = () => {
      // Drop app-owned values and request closures before returning a key to the yielding loop.
      base = undefined;
      cells = [];
      for (const remove of listeners) remove();
      listeners.length = 0;
    };
    const abort = (error: unknown) => {
      if (!failed) { failed = true; failure = error; }
      try { tx.abort(); } catch { /* Reconcile only at the actual terminal. */ }
    };
    const watch = <T>(request: IDBRequest<T>, success: (value: T) => void) => {
      pending++;
      const onError = () => abort(unreadable());
      const onSuccess = () => {
        try { success(request.result); pending--; } catch (error) { abort(error); }
      };
      request.addEventListener("error", onError);
      request.addEventListener("success", onSuccess);
      listeners.push(() => {
        request.removeEventListener("error", onError);
        request.removeEventListener("success", onSuccess);
      });
    };
    tx.addEventListener("error", () => { if (!failed) { failed = true; failure = unreadable(); } }, true);
    tx.addEventListener("abort", () => { release(); reject(failure ?? unreadable()); });
    tx.addEventListener("complete", () => {
      release();
      if (failed || !ready || pending) reject(failure ?? unreadable());
      else resolve(next);
    });
    try {
      inspectOpLayout(db, tx);
      watch(tx.objectStore("meta").getKey(UNCERTAINTY_KEY), (marker) => {
        if (marker !== undefined) throw new UncertainWriteError();
        const range = after === undefined ? undefined : IDBKeyRange.lowerBound(after, true);
        if (name === "ops") {
          watch(tx.objectStore(name).openCursor(range), (cursor) => {
            if (!cursor) { ready = true; return; }
            next = cursor.primaryKey;
            if (layout === "legacy") { ready = true; return; }
            base = cursor.value;
            let remaining = OP_PART_STORES.length;
            OP_PART_STORES.forEach((storeName, at) => {
              watch(tx.objectStore(storeName).openCursor(IDBKeyRange.only(next!)), (partCursor) => {
                cells[at] = { present: partCursor !== null, value: partCursor?.value };
                if (--remaining === 0) { checkParts(next!, base, cells); ready = true; }
              });
            });
          });
        } else {
          watch(tx.objectStore(name).openKeyCursor(range), (cursor) => {
            if (!cursor) { ready = true; return; }
            next = cursor.primaryKey;
            if (typeof next !== "string") throw unreadable();
            watch(tx.objectStore("ops").getKey(next), (present) => {
              if (present === undefined) throw unreadable();
              ready = true;
            });
          });
        }
      });
    } catch (error) { abort(error); }
  });
}

export async function validateCompleteOpStorage(db: IDBDatabase): Promise<void> {
  const layout = db.version >= OP_STORAGE_VERSION ? "parts" : "legacy";
  let started = performance.now();
  for (const name of ["ops", ...(layout === "parts" ? OP_PART_STORES : [])] as OpPhysicalStore[]) {
    let after: IDBValidKey | undefined;
    for (;;) {
      const key = await readCompleteOpStep(db, name, after);
      if (key === undefined) break;
      after = key;
      started = await slice(started);
    }
  }
}
