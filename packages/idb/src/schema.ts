import { installAssetAccounting } from "./asset-accounting";
import { MemDb, type Committed, type ForeignKey, type Key, type Row, type Table, type TableSpec } from "./mem";

/**
 * The IndexedDB schema: one object store per table of the SQL schema (same
 * columns, so the store commands read like their SQL counterparts), plus
 * `meta`. Logical migration ids follow the SQL ones; this adapter starts at
 * the v7 shape (bodies split, search outbox) as IndexedDB version 1; version 2
 * is SQL's v8 (the move journal keeps each removed row with its category);
 * version 3 is SQL's v9 (drafts v2); version 4 is SQL's v14 (plan 17: correspondents, thread facts); version 5 is SQL's v15 (Reply-To, defaulted on read).
 * Version 6 adds attachment assets (SQL v16); SQL v17 adds an in-memory partial index, with no persisted shape change.
 */
export const IDB_VERSION = 6;
/** the SQL schema this one mirrors (migration ids are shared across adapters) */
export const LOGICAL_SCHEMA = 19;
/** the last logical schema that changed what the instant search index holds (its snapshots carry it) */
export const SEARCH_SCHEMA = 7;

const fk = (column: string) => ({ [`fk_${column}`]: [column] as const });

/**
 * `early`: loaded before the store opens (what the first screen and the
 * backend's startup read: lists, counts, accounts, settings, ops, the
 * training set); the rest (messages and their satellites) loads right after,
 * and every command and read that needs it waits for it.
 */
export const TABLES: readonly (TableSpec & { memoryOnly?: boolean; early?: boolean })[] = [
  { name: "accounts", early: true, key: ["id"] },
  { name: "threads", early: true, key: ["id"], autoId: true, indexes: { ...fk("account_id"), provider: ["account_id", "provider_thread_id"] } },
  {
    name: "messages",
    key: ["id"],
    indexes: { ...fk("thread_id"), ...fk("account_id"), provider: ["account_id", "provider_msg_id"], rfc: ["account_id", "rfc_message_id"], from: ["from_email"], domain: ["from_domain"], list: ["list_id"], body_state: ["body_state"], attachment_pending: ["account_id", "attachment_pending"], pending_bodies: { columns: ["account_id"], where: (r) => r.attachment_pending === 1 || (r.body_state !== "full" && r.attachments_captured !== 2) } },
  },
  { name: "message_bodies", key: ["message_id"], lazy: true },
  { name: "message_refs", key: ["account_id", "ref", "message_id"], indexes: { ...fk("message_id"), ref: ["account_id", "ref"] } },
  { name: "message_locations", key: ["message_id", "mailbox"], indexes: { ...fk("message_id"), uid: ["account_id", "mailbox", "uidvalidity", "uid"], mailbox: ["account_id", "mailbox"] } },
  { name: "attachment_assets", key: ["id"], indexes: fk("account_id") },
  { name: "attachment_chunks", key: ["id"], indexes: fk("asset_id") },
  { name: "attachment_bytes", key: ["chunk_id"], lazy: true },
  { name: "attachment_links", key: ["id"], indexes: { ...fk("asset_id"), ...fk("draft_id"), ...fk("message_id"), ...fk("op_id") } },
  { name: "attachments", key: ["id"], autoId: true, indexes: fk("message_id") },
  { name: "categories", early: true, key: ["id"], autoId: true },
  { name: "thread_categories", early: true, key: ["thread_id", "category_id"], indexes: { ...fk("thread_id"), ...fk("category_id"), batch: ["batch_id"] } },
  { name: "filters", early: true, key: ["id"], autoId: true },
  { name: "filter_applications", key: ["filter_id", "message_id"], indexes: { ...fk("filter_id"), ...fk("message_id") } },
  { name: "ops", early: true, key: ["id"], indexes: { ...fk("account_id"), state: ["state"] }, track: ["seq"] },
  { name: "op_targets", early: true, key: ["op_id", "message_id"], indexes: { ...fk("op_id"), message: ["message_id"] } },
  { name: "user_actions", key: ["id"], autoId: true },
  { name: "dismissed_suggestions", early: true, key: ["key"] },
  { name: "drafts", early: true, key: ["id"], autoId: true, indexes: { ...fk("account_id"), ...fk("thread_id") } },
  { name: "settings", early: true, key: ["key"] },
  // plan 17: the addresses you send from (own) and have written to (written)
  { name: "correspondents", early: true, key: ["email"], indexes: { own: ["own"] } },
  { name: "secrets", early: true, key: ["name"] },
  { name: "owner", early: true, key: ["id"], indexes: fk("account_id") },
  { name: "owner_history", key: ["id"], autoId: true },
  { name: "cls_examples", early: true, key: ["thread_id", "category_id"], indexes: { ...fk("thread_id"), ...fk("category_id"), sender: ["category_id", "sender"], batch: ["batch_id"], source: ["source"] } },
  { name: "cls_decisions", early: true, key: ["thread_id", "category_id"], indexes: { ...fk("thread_id"), ...fk("category_id"), outcome: ["kind", "outcome"], kind: ["kind"] } },
  { name: "cat_batches", early: true, key: ["id"], autoId: true, indexes: fk("category_id") },
  { name: "cls_snapshot", early: true, key: ["id"] },
  { name: "cat_move_threads", key: ["batch_id", "thread_id"], indexes: fk("batch_id") },
  { name: "cat_move_rows", key: ["batch_id", "thread_id", "category_id"], indexes: fk("batch_id") },
  { name: "cat_move_examples", key: ["batch_id", "thread_id", "category_id"], indexes: fk("batch_id") },
  { name: "cat_move_decisions", key: ["batch_id", "thread_id", "category_id"], indexes: fk("batch_id") },
  { name: "search_outbox", early: true, key: ["seq"] },
  { name: "search_state", early: true, key: ["id"] },
  // a rebuild's hold on the log: no build survives a restart (SQL clears them on open)
  { name: "search_leases", key: ["id"], autoId: true, memoryOnly: true },
];

const c = (table: string, column: string, parent: string): ForeignKey => ({ table, column, parent, onDelete: "cascade" });

export const FOREIGN_KEYS: readonly ForeignKey[] = [
  c("threads", "account_id", "accounts"),
  c("messages", "account_id", "accounts"),
  c("messages", "thread_id", "threads"),
  c("message_bodies", "message_id", "messages"),
  c("message_refs", "message_id", "messages"),
  c("message_locations", "message_id", "messages"),
  c("attachment_assets", "account_id", "accounts"),
  c("attachment_chunks", "asset_id", "attachment_assets"),
  c("attachment_bytes", "chunk_id", "attachment_chunks"),
  c("attachment_links", "asset_id", "attachment_assets"),
  c("attachment_links", "draft_id", "drafts"),
  c("attachment_links", "message_id", "messages"),
  c("attachment_links", "op_id", "ops"),
  c("attachments", "message_id", "messages"),
  c("thread_categories", "thread_id", "threads"),
  c("thread_categories", "category_id", "categories"),
  c("filter_applications", "filter_id", "filters"),
  c("filter_applications", "message_id", "messages"),
  c("ops", "account_id", "accounts"),
  c("op_targets", "op_id", "ops"),
  c("drafts", "account_id", "accounts"),
  { table: "drafts", column: "thread_id", parent: "threads", onDelete: "setNull" },
  { table: "owner", column: "account_id", parent: "accounts", onDelete: "setNull" },
  c("cls_examples", "thread_id", "threads"),
  c("cls_examples", "category_id", "categories"),
  c("cls_decisions", "thread_id", "threads"),
  c("cls_decisions", "category_id", "categories"),
  c("cat_batches", "category_id", "categories"),
  c("cat_move_threads", "batch_id", "cat_batches"),
  c("cat_move_rows", "batch_id", "cat_batches"),
  c("cat_move_examples", "batch_id", "cat_batches"),
  c("cat_move_decisions", "batch_id", "cat_batches"),
];

const PERSISTED = TABLES.filter((t) => !t.memoryOnly);

export function createMemDb(): MemDb {
  const db = new MemDb(TABLES, FOREIGN_KEYS);
  installAssetAccounting(db);
  return db;
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

export const databaseName = (name: string) => `terno-${name}`;

/**
 * Opens (creating) the mailbox's database. A database written by a newer
 * version of this adapter is refused with the same message as SQL's
 * migrations, so hosts treat both alike (reload to update, change nothing).
 */
export async function openIdb(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  const open = factory.open(databaseName(name), IDB_VERSION);
  open.onupgradeneeded = (event) => {
    const db = open.result;
    if (event.oldVersion < 1) {
      for (const t of PERSISTED) db.createObjectStore(t.name);
      db.createObjectStore("meta");
    } else {
      if (event.oldVersion < 2) upgradeMoveRows(open.transaction!);
      if (event.oldVersion < 3) upgradeDrafts(open.transaction!);
      if (event.oldVersion < 4) upgradeFacts(db, open.transaction!);
      if (event.oldVersion < 6) {
        for (const name of ["attachment_assets", "attachment_chunks", "attachment_bytes", "attachment_links"]) db.createObjectStore(name);
        const messages = open.transaction!.objectStore("messages");
        const cursor = messages.openCursor();
        cursor.onsuccess = () => { const c = cursor.result; if (!c) return; c.update({ ...c.value, attachment_pending: 1 }); c.continue(); };
      }
    }
  };
  open.onblocked = () => {};
  try {
    const db = await request(open);
    // another tab upgrading: let it (leadership makes this rare); this connection closes
    db.onversionchange = () => db.close();
    return db;
  } catch (error) {
    if (error instanceof DOMException && error.name === "VersionError") {
      throw new Error(`Database schema is newer than this app (IndexedDB v${IDB_VERSION}). Update Terno.`);
    }
    throw error;
  }
}

/**
 * Version 2 (SQL v8): journaled move rows are keyed by their category too.
 * Rows of earlier moves came from the batch's single source (`from`).
 */
function upgradeMoveRows(tx: IDBTransaction): void {
  const rows = tx.objectStore("cat_move_rows");
  const batches = tx.objectStore("cat_batches").getAll() as IDBRequest<Row[]>;
  batches.onsuccess = () => {
    const from = new Map(batches.result.map((b) => [b.id as number, (JSON.parse(b.scope_json as string) as { from?: number }).from]));
    const all = rows.getAll() as IDBRequest<Row[]>;
    all.onsuccess = () => {
      rows.clear();
      for (const r of all.result) {
        const categoryId = from.get(r.batch_id as number);
        if (categoryId !== undefined) rows.put({ ...r, category_id: categoryId }, [r.batch_id as number, r.thread_id as number, categoryId]);
      }
    };
  };
}

/**
 * Version 4 (SQL v14, plan 17): the correspondents store. Thread rows keep
 * their shape: a missing `person` is a fact not computed yet, which the
 * backfill fills in after the store opens (slices, never this transaction).
 * A mailbox with threads starts it from its first phase; an empty one has
 * nothing to do.
 */
function upgradeFacts(db: IDBDatabase, tx: IDBTransaction): void {
  if (!db.objectStoreNames.contains("correspondents")) db.createObjectStore("correspondents");
  const count = tx.objectStore("threads").count();
  count.onsuccess = () => {
    if (count.result > 0) tx.objectStore("settings").put({ key: "facts_backfill", value_json: JSON.stringify({ phase: "senders", after: 0 }) }, "facts_backfill");
  };
}

/**
 * Version 3 (SQL v9): drafts v2. Existing drafts are format 1 (bodyText holds
 * everything) and take their conversation from the message they reply to.
 */
function upgradeDrafts(tx: IDBTransaction): void {
  const drafts = tx.objectStore("drafts");
  const messages = tx.objectStore("messages");
  const all = drafts.getAll() as IDBRequest<Row[]>;
  all.onsuccess = () => {
    for (const d of all.result) {
      const v2 = { thread_id: null, format: 1, mode: "new", bcc_json: "[]", subject_edited: 0, quoted_text: "", include_quote: 0, forward_of_message_id: null, ui_state: "open", revision: 1, ...d };
      if (d.in_reply_to_message_id == null) {
        drafts.put(v2, d.id as number);
        continue;
      }
      const m = messages.get(d.in_reply_to_message_id as number) as IDBRequest<Row | undefined>;
      m.onsuccess = () => drafts.put({ ...v2, mode: "reply", thread_id: (m.result?.thread_id as number | undefined) ?? null }, d.id as number);
    }
  };
}

export async function idbExists(factory: IDBFactory, name: string): Promise<boolean> {
  if (typeof factory.databases === "function") return (await factory.databases()).some((d) => d.name === databaseName(name));
  return false;
}

const idbKey = (t: Table, key: Key): IDBValidKey => (t.spec.key.length === 1 ? (key as IDBValidKey) : (JSON.parse(key as string) as IDBValidKey));

export const EARLY_TABLES = PERSISTED.filter((t) => !t.lazy && t.early).map((t) => t.name);
export const LATE_TABLES = PERSISTED.filter((t) => !t.lazy && !t.early).map((t) => t.name);

/** Reads tables into memory (bodies stay in IndexedDB), with the meta store. */
export async function loadAll(
  idb: IDBDatabase,
  mem: MemDb,
  timings: Record<string, number> = {},
  eager: readonly string[] = [...EARLY_TABLES, ...LATE_TABLES],
  /** given: memory is built in ~8 ms slices with a yield between them (the late tables load while the app runs) */
  yieldTo?: () => Promise<void>,
): Promise<Record<string, unknown>> {
  const started = performance.now();
  const tx = idb.transaction([...eager, "meta"], "readonly");
  const finished = done(tx);
  const [tables, metaKeys, metaValues] = await Promise.all([
    Promise.all(eager.map((name) => request(tx.objectStore(name).getAll() as IDBRequest<Row[]>))),
    request(tx.objectStore("meta").getAllKeys()),
    request(tx.objectStore("meta").getAll()),
  ]);
  await finished;
  timings.read = performance.now() - started;
  let slice = performance.now();
  for (const [i, name] of eager.entries()) {
    const t = mem.table(name);
    for (const row of tables[i]!) {
      t.load(row);
      if (yieldTo && performance.now() - slice > 8) {
        await yieldTo();
        slice = performance.now();
      }
    }
  }
  timings.build = performance.now() - started - timings.read;
  return Object.fromEntries(metaKeys.map((k, i) => [String(k), metaValues[i]]));
}

export async function writeMeta(idb: IDBDatabase, values: Record<string, unknown>): Promise<void> {
  const tx = idb.transaction("meta", "readwrite");
  for (const [k, v] of Object.entries(values)) tx.objectStore("meta").put(v, k);
  await done(tx);
}

/** One readwrite transaction with every row a store command touched. Resolves once IndexedDB committed it. */
export async function persist(idb: IDBDatabase, commit: Committed, durability: "strict" | "relaxed"): Promise<void> {
  const stores = [...commit.writes.keys()].filter((t) => !TABLES.find((s) => s.name === t.spec.name)?.memoryOnly);
  if (stores.length === 0) return;
  const tx = idb.transaction(
    stores.map((t) => t.spec.name),
    "readwrite",
    { durability },
  );
  const finished = done(tx);
  for (const t of stores) {
    const store = tx.objectStore(t.spec.name);
    for (const [key, row] of commit.writes.get(t)!) {
      if (row) store.put(row, idbKey(t, key));
      else store.delete(idbKey(t, key));
    }
  }
  await finished;
}

/** Lazy rows (bodies) by key, into memory: absent ones are remembered as absent. */
export async function readLazy(idb: IDBDatabase, t: Table, keys: readonly Key[]): Promise<void> {
  const missing = keys.filter((k) => !t.rows.has(k) && !t.absent.has(k));
  if (missing.length === 0) return;
  const tx = idb.transaction(t.spec.name, "readonly");
  const store = tx.objectStore(t.spec.name);
  const rows = await Promise.all(missing.map((k) => request(store.get(idbKey(t, k)) as IDBRequest<Row | undefined>)));
  missing.forEach((k, i) => {
    const row = rows[i];
    // a write may have landed meanwhile (commands are serialized, but be exact): memory wins
    if (t.rows.has(k)) return;
    if (row) t.load(row);
    else t.absent.add(k);
  });
}

/** Every key of a lazy table (body scans). */
export async function lazyKeys(idb: IDBDatabase, table: string): Promise<IDBValidKey[]> {
  const tx = idb.transaction(table, "readonly");
  return request(tx.objectStore(table).getAllKeys());
}

/** A range of a lazy table's rows in key order (sliced scans). */
export async function readLazyRange(idb: IDBDatabase, table: string, after: number | null, count: number): Promise<Row[]> {
  const tx = idb.transaction(table, "readonly");
  const range = after === null ? undefined : IDBKeyRange.lowerBound(after, true);
  return request(tx.objectStore(table).getAll(range, count) as IDBRequest<Row[]>);
}

/** Every persisted row, straight from IndexedDB (debug.verify compares it with memory). */
export async function readAll(idb: IDBDatabase): Promise<Map<string, Row[]>> {
  const names = PERSISTED.filter((t) => !t.lazy).map((t) => t.name);
  const tx = idb.transaction(names, "readonly");
  const all = await Promise.all(names.map((n) => request(tx.objectStore(n).getAll() as IDBRequest<Row[]>)));
  return new Map(names.map((n, i) => [n, all[i]!]));
}
