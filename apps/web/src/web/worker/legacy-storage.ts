import type { SAHPoolUtil, Sqlite3Static } from "@sqlite.org/sqlite-wasm";

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

function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
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

/**
 * Copies a whole database: same version, same object stores and indexes,
 * every record (in batches, so no transaction holds a whole mailbox), then
 * checks every store's count. The target must not exist.
 */
export async function copyIdbDatabase(factory: IDBFactory, from: string, to: string, afterBatch?: () => Promise<void>): Promise<Record<string, number>> {
  const source = await request(factory.open(from));
  try {
    const stores = [...source.objectStoreNames].map((name) => {
      const s = source.transaction(name).objectStore(name);
      return { name, keyPath: s.keyPath, autoIncrement: s.autoIncrement, indexes: [...s.indexNames].map((i) => s.index(i)).map((i) => ({ name: i.name, keyPath: i.keyPath, unique: i.unique, multiEntry: i.multiEntry })) };
    });
    const open = factory.open(to, source.version);
    open.onupgradeneeded = (e) => {
      if (e.oldVersion !== 0) {
        open.transaction!.abort();
        return;
      }
      for (const s of stores) {
        const store = open.result.createObjectStore(s.name, { keyPath: s.keyPath, autoIncrement: s.autoIncrement });
        for (const i of s.indexes) store.createIndex(i.name, i.keyPath, { unique: i.unique, multiEntry: i.multiEntry });
      }
    };
    const target = await request(open);
    try {
      const counts: Record<string, number> = {};
      for (const s of stores) {
        let after: IDBValidKey | undefined;
        for (;;) {
          const range = after === undefined ? undefined : IDBKeyRange.lowerBound(after, true);
          const read = source.transaction(s.name).objectStore(s.name);
          const [keys, values] = await Promise.all([request(read.getAllKeys(range, BATCH)), request(read.getAll(range, BATCH))]);
          if (keys.length === 0) break;
          const tx = target.transaction(s.name, "readwrite");
          const write = tx.objectStore(s.name);
          for (let i = 0; i < keys.length; i++) write.put(values[i], s.keyPath === null ? keys[i] : undefined);
          await committed(tx);
          await afterBatch?.();
          after = keys[keys.length - 1];
          if (keys.length < BATCH) break;
        }
        const [a, b] = await Promise.all([request(source.transaction(s.name).objectStore(s.name).count()), request(target.transaction(s.name).objectStore(s.name).count())]);
        if (a !== b) throw new Error(`${from} → ${to}: ${s.name} has ${b} of ${a} records`);
        counts[s.name] = b;
      }
      return counts;
    } finally {
      target.close();
    }
  } finally {
    source.close();
  }
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
  if (value) tx.objectStore("copies").put(value, to);
  else tx.objectStore("copies").delete(to);
  await committed(tx);
}

async function journalEntries(journal: IDBDatabase): Promise<Map<string, CopyState>> {
  const store = journal.transaction("copies").objectStore("copies");
  const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
  return new Map(keys.map((k, i) => [String(k), values[i] as CopyState]));
}

/** Every legacy IndexedDB database (the key store first, the mailboxes) to its Terno name. */
export async function migrateLegacyIdb(factory: IDBFactory, mailbox: string, log: Log = () => {}, options: { afterBatch?: (to: string) => Promise<void> } = {}): Promise<string[]> {
  const report: string[] = [];
  const names = (await legacyIdbNames(factory, mailbox)).sort((a, b) => Number(b.endsWith("-keys")) - Number(a.endsWith("-keys")));
  const hadJournal = await idbExists(factory, MIGRATION_JOURNAL);
  if (names.length === 0 && !hadJournal) return report;
  const journal = await openJournal(factory);
  try {
    const entries = await journalEntries(journal);
    for (const from of names) {
      const to = idbName(from)!;
      const state = entries.get(to)?.state;
      if (state === "copied") {
        // verified before the tab went away: only the cleanup was left
        await deleteIdb(factory, from);
        await journalWrite(journal, to, null);
        report.push(`IndexedDB ${from} → ${to} (finished)`);
        continue;
      }
      if (state === "copying") {
        log(`IndexedDB ${to} is an interrupted copy of ${from}: copying it again`);
        await deleteIdb(factory, to);
      } else if (await idbExists(factory, to)) {
        log(`IndexedDB ${from} left alone: ${to} exists`);
        continue;
      }
      await journalWrite(journal, to, { from, state: "copying" });
      let counts: Record<string, number>;
      try {
        counts = await copyIdbDatabase(factory, from, to, options.afterBatch && (() => options.afterBatch!(to)));
      } catch (error) {
        // a partial copy goes (and its record after it); the legacy database stays as it was
        await deleteIdb(factory, to).catch(() => {});
        await journalWrite(journal, to, null).catch(() => {});
        throw new Error(`${from}: ${error instanceof Error ? error.message : String(error)}`);
      }
      await journalWrite(journal, to, { from, state: "copied" });
      await deleteIdb(factory, from);
      await journalWrite(journal, to, null);
      report.push(`IndexedDB ${from} → ${to} (${Object.values(counts).reduce((a, b) => a + b, 0)} records)`);
    }
    for (const [to, { from, state }] of await journalEntries(journal)) {
      // a record whose legacy database is gone: a verified copy is simply done; an unverified one is kept and reported
      if (state === "copied") await journalWrite(journal, to, null);
      else log(`IndexedDB ${to}: an interrupted copy of ${from}, which no longer exists; kept as it is`);
    }
    const empty = (await journalEntries(journal)).size === 0;
    journal.close();
    if (empty) await deleteIdb(factory, MIGRATION_JOURNAL);
  } finally {
    journal.close();
  }
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
