import type { SAHPoolUtil, Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import { assertCertain, UNCERTAINTY_KEY, UncertainWriteError } from "@terno/idb/uncertainty";
import { OP_PART_STORES, readOpCopyBatch, validateCompleteOpStorage, type OpPhysicalStore } from "@terno/idb/op-storage";

/**
 * The web build was called Única: its IndexedDB databases were "unica-<name>"
 * (the mailbox "unica", the key store "unica-keys"), its SQLite pool lived in
 * OPFS ".unica-sahpool" and its caches in "unica-files". Once, under both Web
 * Locks (the tab owns every storage handle), each moves to its Terno name:
 * copied, checked, and only then the legacy copy deleted. A name that exists
 * under both is left alone (Terno's wins, Única's stays). A failure deletes
 * nothing legacy and is reported: the caller must not open an empty mailbox
 * in its place.
 */
export const LEGACY_MAILBOX = "unica";
export const MAILBOX = "terno";
export const LEGACY_IDB_PREFIX = "unica-";
export const IDB_PREFIX = "terno-";
export const LEGACY_POOL = { name: "unica-sahpool", directory: ".unica-sahpool" } as const;
export const LEGACY_FILES_DIR = "unica-files";
export const FILES_DIR = "terno-files";

/** A mailbox's (or the key store's) name under Terno: the default mailbox was "unica", any other keeps its name. */
export const mailboxName = (legacy: string): string => (legacy === LEGACY_MAILBOX ? MAILBOX : legacy);
/** "unica-<x>" → "terno-<x'>"; null for a database that isn't Única's. */
export function idbName(legacy: string): string | null {
  return legacy.startsWith(LEGACY_IDB_PREFIX) ? IDB_PREFIX + mailboxName(legacy.slice(LEGACY_IDB_PREFIX.length)) : null;
}
/** A cache file beside a mailbox ("unica.db.search", "unica.pagecache") under the mailbox's new name. */
export function fileName(legacy: string): string {
  const dot = legacy.indexOf(".");
  return dot > 0 ? mailboxName(legacy.slice(0, dot)) + legacy.slice(dot) : legacy;
}

type Log = (message: string) => void;

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function committed(tx: IDBTransaction, enqueue: (track: (request: IDBRequest) => void) => void): Promise<void> {
  let failed = false, failure: unknown;
  let accepted = 0, succeeded = 0, enqueueDone = false;
  const record = (error: unknown) => { if (!failed) { failed = true; failure = error; } };
  const observeError = (event: Event) => record((event.target as IDBRequest | null)?.error ?? tx.error);
  const ended = new Promise<"complete" | "abort">((resolve) => {
    tx.addEventListener("error", observeError, true);
    tx.addEventListener("complete", () => resolve("complete"));
    tx.addEventListener("abort", () => resolve("abort"));
  });
  const success = () => { succeeded++; };
  try {
    enqueue((request) => {
      accepted++;
      request.addEventListener("error", observeError);
      request.addEventListener("success", success);
    });
    enqueueDone = true;
  }
  catch (error) { record(error); try { tx.abort(); } catch { /* Wait before copy cleanup. */ } }
  const outcome = await ended;
  if (failed) throw failure;
  if (outcome === "abort") throw tx.error ?? new Error("IndexedDB transaction aborted");
  if (!enqueueDone || succeeded !== accepted) throw new Error("IndexedDB transaction did not confirm every request");
}

/** Whether a database exists, without creating it (browsers without databases() get an aborted open). */
export async function idbExists(factory: IDBFactory, name: string): Promise<boolean> {
  if (typeof factory.databases === "function") return (await factory.databases()).some((d) => d.name === name);
  return new Promise((resolve, reject) => {
    const open = factory.open(name);
    let created = false;
    open.onupgradeneeded = (e) => {
      created = e.oldVersion === 0;
      if (created) open.transaction!.abort();
    };
    open.onsuccess = () => {
      open.result.close();
      resolve(true);
    };
    open.onerror = (e) => {
      if (created) {
        e.preventDefault();
        resolve(false);
      } else reject(open.error);
    };
  });
}

/** The legacy database names to move: every "unica-*" this origin has (or, without databases(), the ones Única used). */
async function legacyIdbNames(factory: IDBFactory, mailbox: string): Promise<string[]> {
  if (typeof factory.databases === "function") return (await factory.databases()).map((d) => d.name ?? "").filter((n) => idbName(n) !== null);
  const candidates = [`${LEGACY_IDB_PREFIX}keys`, `${LEGACY_IDB_PREFIX}${mailbox === MAILBOX ? LEGACY_MAILBOX : mailbox}`];
  const found: string[] = [];
  for (const c of candidates) if (await idbExists(factory, c)) found.push(c);
  return found;
}

const BATCH = 500;

async function certainDatabases(factory: IDBFactory, ...names: string[]): Promise<void> {
  for (const name of names) {
    try {
      if (!(await idbExists(factory, name))) continue;
      const open = factory.open(name);
      open.onupgradeneeded = () => open.transaction!.abort();
      const db = await request(open);
      try {
        if (db.objectStoreNames.contains("meta")) await assertCertain(db);
        else {
          const keysOnly = (name === "unica-keys" || name === "terno-keys") && db.objectStoreNames.length === 1 && db.objectStoreNames.contains("keys");
          if (!keysOnly) throw new UncertainWriteError("unreadable");
          const tx = db.transaction("keys"), ended = copyReadEnd(tx), keys = tx.objectStore("keys");
          const valid = keys.keyPath === null && !keys.autoIncrement && !keys.indexNames.length;
          await ended;
          if (!valid) throw new UncertainWriteError("unreadable");
        }
      }
      finally { db.close(); }
    } catch (error) {
      throw error instanceof UncertainWriteError ? error : new UncertainWriteError("unreadable", error);
    }
  }
}

type CopyManifest = { version: number; stores: {
  name: string; keyPath: string | string[] | null; autoIncrement: boolean;
  indexes: { name: string; keyPath: string | string[]; unique: boolean; multiEntry: boolean }[];
}[] };
type CopyReceipt = { from: string; to: string; manifest: CopyManifest; lease: { lost: boolean } };
const unreadableCopy = () => new UncertainWriteError("unreadable", new Error("Could not inspect operation copy"));
const yieldCopy = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function watchCopy(db: IDBDatabase, lease: { lost: boolean }) {
  let closed = false;
  const close = () => { if (!closed) { closed = true; db.close(); } };
  db.addEventListener("versionchange", () => { lease.lost = true; close(); });
  return close;
}
function keyPathEqual(a: string | string[] | null, b: string | string[] | null): boolean {
  return typeof a === "string" || a === null ? a === b : Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
}
function manifestEqual(a: CopyManifest, b: CopyManifest): boolean {
  return a.version === b.version && a.stores.length === b.stores.length && a.stores.every((x, i) => {
    const y = b.stores[i]!;
    return x.name === y.name && x.autoIncrement === y.autoIncrement && keyPathEqual(x.keyPath, y.keyPath)
      && x.indexes.length === y.indexes.length && x.indexes.every((v, j) => {
        const w = y.indexes[j]!;
        return v.name === w.name && v.unique === w.unique && v.multiEntry === w.multiEntry && keyPathEqual(v.keyPath, w.keyPath);
      });
  });
}
function keysOnly(name: string, manifest: CopyManifest): boolean {
  const store = manifest.stores[0];
  return (name === "unica-keys" || name === "terno-keys") && manifest.stores.length === 1 && store?.name === "keys"
    && store.keyPath === null && !store.autoIncrement && !store.indexes.length;
}
async function copyManifest(db: IDBDatabase): Promise<CopyManifest> {
  const manifest: CopyManifest = { version: db.version, stores: [] };
  let slice = performance.now();
  for (const name of db.objectStoreNames) {
    const descriptor = await new Promise<{ spec: CopyManifest["stores"][number]; indexNames: string[] }>((resolve, reject) => {
      let tx: IDBTransaction;
      try { tx = db.transaction(name, "readonly"); } catch { reject(unreadableCopy()); return; }
      let result: { spec: CopyManifest["stores"][number]; indexNames: string[] } | undefined, failed = false;
      tx.addEventListener("error", () => { failed = true; }, true);
      tx.addEventListener("abort", () => reject(unreadableCopy()));
      tx.addEventListener("complete", () => failed || !result ? reject(unreadableCopy()) : resolve(result));
      try {
        const store = tx.objectStore(name);
        result = { spec: { name, keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes: [] }, indexNames: [...store.indexNames] };
      } catch { failed = true; try { tx.abort(); } catch { /* Join terminal. */ } }
    });
    for (const indexName of descriptor.indexNames) {
      const index = await new Promise<CopyManifest["stores"][number]["indexes"][number]>((resolve, reject) => {
        let tx: IDBTransaction;
        try { tx = db.transaction(name, "readonly"); } catch { reject(unreadableCopy()); return; }
        let result: CopyManifest["stores"][number]["indexes"][number] | undefined, failed = false;
        tx.addEventListener("error", () => { failed = true; }, true);
        tx.addEventListener("abort", () => reject(unreadableCopy()));
        tx.addEventListener("complete", () => failed || !result ? reject(unreadableCopy()) : resolve(result));
        try {
          const value = tx.objectStore(name).index(indexName);
          result = { name: indexName, keyPath: value.keyPath, unique: value.unique, multiEntry: value.multiEntry };
        } catch { failed = true; try { tx.abort(); } catch { /* Join terminal. */ } }
      });
      descriptor.spec.indexes.push(index);
      if (performance.now() - slice > 8) { await yieldCopy(); slice = performance.now(); }
    }
    manifest.stores.push(descriptor.spec);
    if (performance.now() - slice > 8) { await yieldCopy(); slice = performance.now(); }
  }
  return manifest;
}

async function existingCopy(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  if (!(await idbExists(factory, name))) throw unreadableCopy();
  const open = factory.open(name);
  open.onupgradeneeded = () => open.transaction!.abort();
  return request(open);
}
async function completeCopySource(factory: IDBFactory, name: string): Promise<CopyManifest> {
  await certainDatabases(factory, name);
  const db = await existingCopy(factory, name), lease = { lost: false }, close = watchCopy(db, lease);
  try {
    const manifest = await copyManifest(db);
    if (!keysOnly(name, manifest)) await validateCompleteOpStorage(db);
    if (lease.lost) throw unreadableCopy();
    return manifest;
  } finally { close(); }
}
async function disposablePrefix(factory: IDBFactory, from: string, to: string, source: CopyManifest): Promise<void> {
  if (idbName(from) !== to) throw unreadableCopy();
  await certainDatabases(factory, from, to);
  if (!(await idbExists(factory, to))) return;
  const db = await existingCopy(factory, to), lease = { lost: false }, close = watchCopy(db, lease);
  try {
    if (!manifestEqual(source, await copyManifest(db)) || lease.lost) throw unreadableCopy();
  } finally { close(); }
}
function copyBatch(db: IDBDatabase, name: string, after: IDBValidKey | undefined): Promise<{ keys: IDBValidKey[]; values: unknown[] }> {
  if (name === "ops" || (OP_PART_STORES as readonly string[]).includes(name)) return readOpCopyBatch(db, name as OpPhysicalStore, after, BATCH);
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try { tx = db.transaction([...new Set([name, ...(db.objectStoreNames.contains("meta") ? ["meta"] : [])])], "readonly"); }
    catch { reject(unreadableCopy()); return; }
    let failed = false, pending = 2, ready = false, keys: IDBValidKey[] = [], values: unknown[] = [];
    let dirty = false;
    const fail = () => { failed = true; try { tx.abort(); } catch { /* Join terminal. */ } };
    tx.addEventListener("error", fail, true);
    tx.addEventListener("abort", () => reject(dirty ? new UncertainWriteError() : unreadableCopy()));
    tx.addEventListener("complete", () => {
      if (failed || !ready || keys.length !== values.length) reject(dirty ? new UncertainWriteError() : unreadableCopy());
      else resolve({ keys, values });
    });
    const body = () => {
      try {
        const range = after === undefined ? undefined : IDBKeyRange.lowerBound(after, true);
        const k = tx.objectStore(name).getAllKeys(range, BATCH), v = tx.objectStore(name).getAll(range, BATCH);
        k.addEventListener("success", () => { keys = k.result; if (--pending === 0) ready = true; });
        v.addEventListener("success", () => { values = v.result; if (--pending === 0) ready = true; });
      } catch { fail(); }
    };
    try {
      if (db.objectStoreNames.contains("meta")) {
        const guard = tx.objectStore("meta").getKey(UNCERTAINTY_KEY);
        guard.addEventListener("success", () => {
          if (guard.result !== undefined) { dirty = true; fail(); } else body();
        });
      } else body();
    } catch { fail(); }
  });
}
async function copyDatabase(factory: IDBFactory, from: string, to: string, afterBatch: (() => Promise<void>) | undefined, mailbox: boolean): Promise<{ counts: Record<string, number>; receipt: CopyReceipt }> {
  await certainDatabases(factory, from, to);
  const source = await existingCopy(factory, from), lease = { lost: false }, closeSource = watchCopy(source, lease);
  try {
    const manifest = await copyManifest(source);
    if (mailbox && !keysOnly(from, manifest) && !source.objectStoreNames.contains("ops")) throw unreadableCopy();
    const open = factory.open(to, source.version);
    open.onupgradeneeded = (event) => {
      if (event.oldVersion !== 0) { open.transaction!.abort(); return; }
      for (const spec of manifest.stores) {
        const store = open.result.createObjectStore(spec.name, { keyPath: spec.keyPath, autoIncrement: spec.autoIncrement });
        for (const index of spec.indexes) store.createIndex(index.name, index.keyPath, { unique: index.unique, multiEntry: index.multiEntry });
      }
    };
    const target = await request(open), closeTarget = watchCopy(target, lease);
    try {
      const counts: Record<string, number> = {};
      let slice = performance.now();
      for (const spec of manifest.stores) {
        let after: IDBValidKey | undefined, copied = 0;
        for (;;) {
          if (lease.lost) throw unreadableCopy();
          const batch = await copyBatch(source, spec.name, after);
          if (!batch.keys.length) break;
          const tx = target.transaction(spec.name, "readwrite");
          await committed(tx, (track) => {
            for (let i = 0; i < batch.keys.length; i++) track(tx.objectStore(spec.name).put(batch.values[i], spec.keyPath === null ? batch.keys[i] : undefined));
          });
          copied += batch.keys.length;
          after = batch.keys[batch.keys.length - 1];
          await afterBatch?.();
          if (performance.now() - slice > 8) { await yieldCopy(); slice = performance.now(); }
          if (batch.keys.length < BATCH) break;
        }
        counts[spec.name] = copied;
      }
      // Verify target keys/parts/row counts without fetching BASE wire again.
      for (const spec of manifest.stores) {
        let after: IDBValidKey | undefined, count = 0;
        for (;;) {
          const keys = await copyKeyBatch(target, spec.name, after);
          if (!keys.length) break;
          count += keys.length; after = keys[keys.length - 1];
          if (performance.now() - slice > 8) { await yieldCopy(); slice = performance.now(); }
          if (keys.length < BATCH) break;
        }
        if (count !== counts[spec.name]) throw unreadableCopy();
      }
      await certainDatabases(factory, from, to);
      if (!manifestEqual(manifest, await copyManifest(target)) || lease.lost) throw unreadableCopy();
      return { counts, receipt: { from, to, manifest, lease } };
    } finally { closeTarget(); }
  } finally { closeSource(); }
}
function copyKeyBatch(db: IDBDatabase, name: string, after: IDBValidKey | undefined): Promise<IDBValidKey[]> {
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try { tx = db.transaction([...new Set([name, ...(db.objectStoreNames.contains("meta") ? ["meta"] : [])])], "readonly"); }
    catch { reject(unreadableCopy()); return; }
    let keys: IDBValidKey[] = [], ready = false, failed = false, dirty = false;
    const fail = () => { failed = true; try { tx.abort(); } catch { /* Join terminal. */ } };
    tx.addEventListener("error", fail, true);
    tx.addEventListener("abort", () => reject(dirty ? new UncertainWriteError() : unreadableCopy()));
    tx.addEventListener("complete", () => failed || !ready ? reject(dirty ? new UncertainWriteError() : unreadableCopy()) : resolve(keys));
    const body = () => {
      try {
        const r = tx.objectStore(name).getAllKeys(after === undefined ? undefined : IDBKeyRange.lowerBound(after, true), BATCH);
        r.addEventListener("success", () => { keys = r.result; ready = true; });
      } catch { fail(); }
    };
    if (db.objectStoreNames.contains("meta")) {
      try {
        const guard = tx.objectStore("meta").getKey(UNCERTAINTY_KEY);
        guard.addEventListener("success", () => { if (guard.result !== undefined) { dirty = true; fail(); } else body(); });
      } catch { fail(); }
    } else body();
  });
}
function copyReadEnd(tx: IDBTransaction): Promise<void> {
  const ended = new Promise<void>((resolve, reject) => {
    let failed = false;
    tx.addEventListener("error", () => { failed = true; }, true);
    tx.addEventListener("complete", () => failed ? reject(unreadableCopy()) : resolve());
    tx.addEventListener("abort", () => reject(unreadableCopy()));
  });
  void ended.catch(() => {});
  return ended;
}
export async function copyIdbDatabase(factory: IDBFactory, from: string, to: string, afterBatch?: () => Promise<void>): Promise<Record<string, number>> {
  return (await copyDatabase(factory, from, to, afterBatch, false)).counts;
}

function deleteIdb(factory: IDBFactory, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const r = factory.deleteDatabase(name);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
    // nothing else holds it (both Web Locks are ours): a blocked delete still completes once the last connection closes
  });
}

/**
 * The copies in flight, in their own small database: a destination is
 * recorded "copying" before it is created and "copied" once verified, and the
 * record goes after the legacy database is deleted. A start that finds
 * "copying" (the tab closed mid-copy) rebuilds that destination from the
 * untouched legacy database; one that finds "copied" finishes the cleanup.
 */
export const MIGRATION_JOURNAL = "terno-legacy-migration";
type CopyState = { from: string; state: "copying" | "copied" };

async function openJournal(factory: IDBFactory): Promise<IDBDatabase> {
  const open = factory.open(MIGRATION_JOURNAL, 1);
  open.onupgradeneeded = () => open.result.createObjectStore("copies");
  return request(open);
}

async function journalWrite(journal: IDBDatabase, to: string, value: CopyState | null): Promise<void> {
  const tx = journal.transaction("copies", "readwrite");
  await committed(tx, (track) => {
    if (value) track(tx.objectStore("copies").put(value, to));
    else track(tx.objectStore("copies").delete(to));
  });
}

async function journalEntries(journal: IDBDatabase): Promise<Map<string, CopyState>> {
  const image = await new Promise<{ keys: IDBValidKey[]; values: unknown[] }>((resolve, reject) => {
    const tx = journal.transaction("copies", "readonly");
    let keys: IDBValidKey[] = [], values: unknown[] = [], observed = 0, failed = false;
    const fail = () => { failed = true; try { tx.abort(); } catch { /* Join terminal. */ } };
    tx.addEventListener("error", fail, true);
    tx.addEventListener("abort", () => reject(unreadableCopy()));
    tx.addEventListener("complete", () => failed || observed !== 2 || keys.length !== values.length
      ? reject(unreadableCopy()) : resolve({ keys, values }));
    try {
      const k = tx.objectStore("copies").getAllKeys(), v = tx.objectStore("copies").getAll();
      k.addEventListener("success", () => { keys = k.result; observed++; });
      v.addEventListener("success", () => { values = v.result; observed++; });
    } catch { fail(); }
  });
  const entries = new Map<string, CopyState>();
  let slice = performance.now();
  for (let i = 0; i < image.keys.length; i++) {
    const key = image.keys[i], value = image.values[i] as Partial<CopyState> | null;
    if (typeof key !== "string" || !value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype
      || Reflect.ownKeys(value).length !== 2 || !Object.hasOwn(value, "from") || !Object.hasOwn(value, "state")
      || typeof value.from !== "string" || (value.state !== "copying" && value.state !== "copied") || idbName(value.from) !== key) throw unreadableCopy();
    entries.set(key, value as CopyState);
    if (performance.now() - slice > 8) { await yieldCopy(); slice = performance.now(); }
  }
  return entries;
}

/** Every legacy IndexedDB database (the key store first, the mailboxes) to its Terno name. */
export async function migrateLegacyIdb(factory: IDBFactory, mailbox: string, log: Log = () => {}, options: { afterBatch?: (to: string) => Promise<void> } = {}): Promise<string[]> {
  const report: string[] = [];
  const names = (await legacyIdbNames(factory, mailbox)).sort((a, b) => Number(b.endsWith("-keys")) - Number(a.endsWith("-keys")));
  if (!names.length && !(await idbExists(factory, MIGRATION_JOURNAL))) return report;
  for (const from of names) await certainDatabases(factory, from, idbName(from)!);
  const journal = await openJournal(factory);
  try {
    const entries = await journalEntries(journal);
    for (const from of names) {
      const to = idbName(from)!, entry = entries.get(to);
      if (entry && entry.from !== from) throw unreadableCopy();
      await certainDatabases(factory, from, to);
      if (entry?.state === "copied") {
        const source = await completeCopySource(factory, from);
        const target = await completeCopySource(factory, to);
        if (!manifestEqual(source, target)) throw unreadableCopy();
        await certainDatabases(factory, from, to);
        await deleteIdb(factory, from);
        await certainDatabases(factory, to);
        await journalWrite(journal, to, null);
        report.push(`IndexedDB ${from} → ${to} (finished)`);
        continue;
      }
      if (entry?.state === "copying") {
        const source = await completeCopySource(factory, from);
        await disposablePrefix(factory, from, to, source);
        await certainDatabases(factory, from, to);
        await deleteIdb(factory, to);
      } else if (await idbExists(factory, to)) {
        log(`IndexedDB ${from} left alone: ${to} exists`);
        continue;
      }
      await certainDatabases(factory, from, to);
      await journalWrite(journal, to, { from, state: "copying" });
      let copied: Awaited<ReturnType<typeof copyDatabase>>;
      try {
        copied = await copyDatabase(factory, from, to, options.afterBatch && (() => options.afterBatch!(to)), true);
      } catch (error) {
        if (error instanceof UncertainWriteError) throw error;
        const source = await completeCopySource(factory, from);
        await disposablePrefix(factory, from, to, source);
        await certainDatabases(factory, from, to);
        await deleteIdb(factory, to);
        await certainDatabases(factory, from);
        await journalWrite(journal, to, null);
        throw error;
      }
      if (copied.receipt.lease.lost || copied.receipt.from !== from || copied.receipt.to !== to) throw unreadableCopy();
      await certainDatabases(factory, from, to);
      await journalWrite(journal, to, { from, state: "copied" });
      if (copied.receipt.lease.lost) throw unreadableCopy();
      await certainDatabases(factory, from, to);
      await deleteIdb(factory, from);
      await certainDatabases(factory, to);
      await journalWrite(journal, to, null);
      report.push(`IndexedDB ${from} → ${to} (${Object.values(copied.counts).reduce((a, b) => a + b, 0)} records)`);
    }
    for (const [to, entry] of await journalEntries(journal)) {
      await certainDatabases(factory, entry.from, to);
      if (entry.state === "copied") {
        const source = await idbExists(factory, entry.from) ? await completeCopySource(factory, entry.from) : null;
        const target = await completeCopySource(factory, to);
        if (source && !manifestEqual(source, target)) throw unreadableCopy();
        await certainDatabases(factory, entry.from, to);
        await journalWrite(journal, to, null);
      } else log(`IndexedDB ${to}: an interrupted copy of ${entry.from}, which no longer exists; kept as it is`);
    }
    const empty = (await journalEntries(journal)).size === 0;
    journal.close();
    if (empty) await deleteIdb(factory, MIGRATION_JOURNAL);
  } finally { journal.close(); }
  return report;
}

async function directory(root: FileSystemDirectoryHandle, name: string): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await root.getDirectoryHandle(name);
  } catch (error) {
    if (error instanceof DOMException && (error.name === "NotFoundError" || error.name === "TypeMismatchError")) return null;
    throw error;
  }
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Every database in Única's sahpool to Terno's pool, byte for byte: opened
 * once first (SQLite rolls a hot journal back), exported, imported, compared;
 * then unlinked from the old pool, which is removed once empty.
 */
export async function migrateLegacyPool(root: FileSystemDirectoryHandle, sqlite3: Sqlite3Static, pool: () => Promise<SAHPoolUtil>, log: Log = () => {}): Promise<string[]> {
  if (!(await directory(root, LEGACY_POOL.directory))) return [];
  // preserveOnInitFailure: by default a pool that fails to initialize is removed (removeVfs), mailbox and all
  const legacy = await sqlite3.installOpfsSAHPoolVfs({ ...LEGACY_POOL, preserveOnInitFailure: true });
  const target = await pool();
  const report: string[] = [];
  for (const from of legacy.getFileNames().filter((f) => f.endsWith(".db"))) {
    const to = `/${mailboxName(from.replace(/^\/+/, "").replace(/\.db$/, ""))}.db`;
    if (target.getFileNames().includes(to)) {
      log(`OPFS ${LEGACY_POOL.directory}${from} left alone: ${to} exists`);
      continue;
    }
    const db = new legacy.OpfsSAHPoolDb(from);
    try {
      db.exec("SELECT count(*) FROM sqlite_schema");
    } finally {
      db.close();
    }
    const bytes = legacy.exportFile(from);
    await target.reserveMinimumCapacity(Number(target.getFileCount()) + 2);
    await target.importDb(to, bytes);
    if (!sameBytes(target.exportFile(to), bytes)) {
      target.unlink(to);
      throw new Error(`${from} → ${to}: the copy differs`);
    }
    for (const f of legacy.getFileNames()) if (f === from || f.startsWith(`${from}-`)) legacy.unlink(f);
    report.push(`OPFS ${from} → ${to} (${bytes.length} bytes)`);
  }
  if (legacy.getFileNames().length === 0) await legacy.removeVfs();
  else legacy.pauseVfs();
  return report;
}

/** Única's caches beside the mailbox (instant index snapshots, page cache sizes) under their new names; the old directory goes once empty. */
export async function migrateLegacyFiles(root: FileSystemDirectoryHandle, log: Log = () => {}): Promise<string[]> {
  const from = await directory(root, LEGACY_FILES_DIR);
  if (!from) return [];
  const to = await root.getDirectoryHandle(FILES_DIR, { create: true });
  const report: string[] = [];
  const entries: [string, FileSystemHandle][] = [];
  for await (const entry of from as unknown as AsyncIterable<[string, FileSystemHandle]>) entries.push(entry);
  let kept = entries.length;
  for (const [name, handle] of entries) {
    if (handle.kind !== "file") continue;
    const target = fileName(name);
    try {
      await to.getFileHandle(target);
      log(`OPFS ${LEGACY_FILES_DIR}/${name} left alone: ${FILES_DIR}/${target} exists`);
      continue;
    } catch {
      /* not there: copy */
    }
    const file = await (handle as FileSystemFileHandle).getFile();
    const writable = await (await to.getFileHandle(target, { create: true })).createWritable();
    await writable.write(await file.arrayBuffer());
    await writable.close();
    if ((await (await to.getFileHandle(target)).getFile()).size !== file.size) throw new Error(`${name} → ${target}: the copy differs`);
    await from.removeEntry(name);
    kept--;
    report.push(`OPFS ${LEGACY_FILES_DIR}/${name} → ${FILES_DIR}/${target}`);
  }
  if (kept === 0) await root.removeEntry(LEGACY_FILES_DIR);
  return report;
}
