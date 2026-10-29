import { IDB_VERSION, OP_STORAGE_VERSION, OP_PART_STORES, decodeOpImage, inspectOpLayout, prepareOpWrites, type OpPartImage, type OpPartStore } from "./op-storage";
import { installAssetAccounting } from "./asset-accounting";
import { MemDb, type Committed, type ForeignKey, type Key, type Row, type Table, type TableSpec } from "./mem";
import { assertCertain, UNCERTAINTY_KEY, UncertainWriteError } from "./uncertainty";

/**
 * The IndexedDB schema: one object store per table of the SQL schema (same
 * columns, so the store commands read like their SQL counterparts), plus
 * `meta`. Logical migration ids follow the SQL ones; this adapter starts at
 * the v7 shape (bodies split, search outbox) as IndexedDB version 1; version 2
 * is SQL's v8 (the move journal keeps each removed row with its category);
 * version 3 is SQL's v9 (drafts v2); version 4 is SQL's v14 (plan 17: correspondents, thread facts); version 5 is SQL's v15 (Reply-To, defaulted on read).
 * Version 6 adds attachment assets (SQL v16); SQL v17 adds an in-memory partial index, with no persisted shape change.
 * Version 10 fences older adapters from mailboxes with incomplete-save markers.
 * Version 12 adds an account's own folders and their memberships (SQL v24, plan 65).
 */
export { IDB_VERSION };
/** the SQL schema this one mirrors (migration ids are shared across adapters) */
export const LOGICAL_SCHEMA = 24;
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
  { name: "flag_clocks", early: true, key: ["account_id"], indexes: fk("account_id") },
  { name: "message_flag_intents", key: ["message_id", "field"], indexes: { ...fk("account_id"), ...fk("message_id"), snapshot: ["snapshot_account_id"] } },
  { name: "flag_op_effects", key: ["op_id", "message_id", "field"], indexes: { ...fk("account_id"), ...fk("op_id"), ...fk("message_id"), parked_version: { columns: ["message_id", "field", "intent_version", "value"], where: (r) => r.active === 0 && r.intent_version != null && r.intent_version !== 0 }, parked_zero: { columns: ["message_id", "field", "value"], where: (r) => r.active === 0 && (r.intent_version == null || r.intent_version === 0) } } },
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
  // plan 65: an account's own folders, and which threads are in them (the sidebar and counts read both at startup)
  { name: "folders", early: true, key: ["account_id", "key"], indexes: fk("account_id") },
  { name: "folder_rebuilds", key: ["account_id", "key"], indexes: fk("account_id") },
  { name: "thread_folders", early: true, key: ["thread_id", "folder"], indexes: { ...fk("thread_id"), folder: ["account_id", "folder"], unread: { columns: ["account_id", "folder"], where: (r) => r.unread === 1 } } },
  { name: "thread_categories", early: true, key: ["thread_id", "category_id"], indexes: { ...fk("thread_id"), ...fk("category_id"), batch: ["batch_id"] } },
  { name: "filters", early: true, key: ["id"], autoId: true },
  { name: "filter_applications", key: ["filter_id", "message_id"], indexes: { ...fk("filter_id"), ...fk("message_id") } },
  { name: "ops", early: true, key: ["id"], indexes: { ...fk("account_id"), state: ["state"] }, track: ["seq"] },
  { name: "op_targets", early: true, key: ["op_id", "message_id"], indexes: { ...fk("op_id"), message: ["message_id"] } },
  { name: "user_actions", key: ["id"], autoId: true },
  { name: "dismissed_suggestions", early: true, key: ["key"] },
  { name: "draft_counter", early: true, key: ["id"] },
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
  c("flag_clocks", "account_id", "accounts"),
  c("message_flag_intents", "account_id", "accounts"),
  c("message_flag_intents", "message_id", "messages"),
  c("flag_op_effects", "account_id", "accounts"),
  c("flag_op_effects", "message_id", "messages"),
  c("flag_op_effects", "op_id", "ops"),
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
  c("folders", "account_id", "accounts"),
  c("folder_rebuilds", "account_id", "accounts"),
  c("thread_folders", "thread_id", "threads"),
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
  const pending = new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  void pending.catch(() => {});
  return pending;
}

/** A write that completed after an error may have persisted only part of a command. */
export class PartialCommit extends Error {
  constructor(readonly original: unknown) { super("IndexedDB completed after a write error"); }
}

const WRITE_MARKER = Object.freeze({ version: 1 });
type TrackRequest = <T>(request: IDBRequest<T>, success?: (result: T) => void) => void;
type TrackCursor = (request: IDBRequest<IDBCursorWithValue | null>, visit: (cursor: IDBCursorWithValue) => void) => void;

async function writeTransaction(tx: IDBTransaction, enqueue: (track: TrackRequest, scan: TrackCursor) => void, inspected?: () => void): Promise<void> {
  let firstError: unknown, failed = false;
  let enqueued = 0, succeeded = 0, enqueueDone = false, cleared = false, clearQueued = false;
  const record = (error: unknown) => {
    if (!failed) { failed = true; firstError = error; }
  };
  const abort = (error: unknown) => {
    record(error);
    try { tx.abort(); } catch { /* Wait for the actual terminal event. */ }
  };
  const guarded = (fn: () => void) => () => {
    try { fn(); } catch (error) { abort(error); }
  };
  const observeError = (event: Event) => record((event.target as IDBRequest | null)?.error ?? tx.error ?? new Error("IndexedDB transaction failed"));
  const terminal = new Promise<"complete" | "abort">((resolve) => {
    tx.addEventListener("error", observeError, true);
    tx.addEventListener("complete", () => resolve("complete"));
    tx.addEventListener("abort", () => resolve("abort"));
  });
  const clear = () => {
    if (failed || !enqueueDone || succeeded !== enqueued || clearQueued) return;
    clearQueued = true;
    const request = tx.objectStore("meta").delete(UNCERTAINTY_KEY);
    request.addEventListener("error", observeError);
    request.addEventListener("success", guarded(() => { cleared = true; }));
  };
  const bodySucceeded = guarded(() => { succeeded++; clear(); });
  const track: TrackRequest = (request, success) => {
    enqueued++;
    request.addEventListener("error", observeError);
    request.addEventListener("success", success ? guarded(() => { success(request.result); bodySucceeded(); }) : bodySucceeded);
  };
  const scan: TrackCursor = (request, visit) => {
    enqueued++;
    request.addEventListener("error", observeError);
    request.addEventListener("success", guarded(() => {
      const cursor = request.result;
      if (cursor) { visit(cursor); cursor.continue(); }
      else bodySucceeded();
    }));
  };
  try {
    const meta = tx.objectStore("meta");
    const guard = meta.getKey(UNCERTAINTY_KEY);
    guard.addEventListener("error", observeError);
    guard.addEventListener("success", guarded(() => {
      inspected?.();
      if (guard.result !== undefined) { abort(new UncertainWriteError()); return; }
      const marker = meta.put(WRITE_MARKER, UNCERTAINTY_KEY);
      marker.addEventListener("error", observeError);
      marker.addEventListener("success", guarded(() => {
        if (failed) return;
        enqueue(track, scan);
        enqueueDone = true;
        clear();
      }));
    }));
  } catch (error) {
    abort(error);
  }
  const outcome = await terminal;
  if (firstError instanceof UncertainWriteError) throw firstError;
  if (outcome === "complete") {
    if (failed) throw new PartialCommit(firstError);
    if (!enqueueDone || succeeded !== enqueued || !cleared) throw new PartialCommit(new Error("IndexedDB write did not confirm every request"));
    return;
  }
  if (failed) throw firstError;
  throw tx.error ?? new Error("IndexedDB transaction aborted");
}

export const databaseName = (name: string) => `terno-${name}`;

/**
 * Opens (creating) the mailbox's database. A database written by a newer
 * version of this adapter is refused with the same message as SQL's
 * migrations, so hosts treat both alike (reload to update, change nothing).
 */
export async function openIdb(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  const open = factory.open(databaseName(name), IDB_VERSION);
  let admissionFailure: unknown, admissionFailed = false, upgradeInspected = true;
  let upgradeWrite: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined;
  open.onupgradeneeded = (event) => {
    const db = open.result, tx = open.transaction!;
    upgradeInspected = false;
    const refuse = (error: unknown) => {
      if (!admissionFailed) { admissionFailed = true; admissionFailure = error; }
      try { tx.abort(); } catch { /* The open result still must be refused. */ }
    };
    const upgrade = (track: TrackRequest, scan: TrackCursor) => {
      if (event.oldVersion < OP_STORAGE_VERSION) for (const name of OP_PART_STORES) db.createObjectStore(name);
      if (event.oldVersion >= 1) {
        if (event.oldVersion < 8) for (const name of ["flag_clocks", "message_flag_intents", "flag_op_effects"]) db.createObjectStore(name);
        if (event.oldVersion < 7) db.createObjectStore("draft_counter");
        if (event.oldVersion < 2) upgradeMoveRows(tx, track);
        if (event.oldVersion < 3) upgradeDrafts(tx, track);
        if (event.oldVersion < 4) upgradeFacts(db, tx, track);
        if (event.oldVersion < 6) {
          for (const name of ["attachment_assets", "attachment_chunks", "attachment_bytes", "attachment_links"]) db.createObjectStore(name);
          const messages = open.transaction!.objectStore("messages");
          scan(messages.openCursor(), (cursor) => track(cursor.update({ ...cursor.value, attachment_pending: 1 })));
        }
      }
      if (event.oldVersion >= 1 && event.oldVersion < 12) for (const name of ["folders", "thread_folders", "folder_rebuilds"]) db.createObjectStore(name);
      if (event.oldVersion < 8) {
        open.transaction!.objectStore("ops").createIndex("flag_account_seq", ["account_id", "seq", "id"]);
        open.transaction!.objectStore("message_flag_intents").createIndex("flag_snapshots", ["snapshot_account_id", "message_id"]);
      }
    };
    if (!db.objectStoreNames.contains("meta")) {
      if (event.oldVersion !== 0) { refuse(new UncertainWriteError("unreadable")); return; }
      try {
        for (const t of PERSISTED) db.createObjectStore(t.name);
        db.createObjectStore("meta");
      } catch (error) { refuse(error); return; }
    }
    upgradeWrite = writeTransaction(tx, upgrade, () => { upgradeInspected = true; }).then(
      () => ({ ok: true }), (error: unknown) => ({ ok: false, error }),
    );
  };
  open.onblocked = () => {};
  let acquired: IDBDatabase | undefined;
  try {
    const db = await request(open);
    acquired = db;
    // another tab upgrading: let it (leadership makes this rare); this connection closes
    db.onversionchange = () => db.close();
    if (admissionFailed) throw admissionFailure;
    const outcome = await upgradeWrite;
    if (outcome && !outcome.ok) throw outcome.error;
    if (!upgradeInspected) throw new UncertainWriteError("unreadable");
    await assertCertain(db);
    return db;
  } catch (error) {
    acquired?.close();
    const outcome = await upgradeWrite;
    if (admissionFailed) throw admissionFailure;
    const failure = outcome && !outcome.ok ? outcome.error : error;
    if (!upgradeInspected || failure instanceof PartialCommit) throw new UncertainWriteError("unreadable", failure instanceof PartialCommit ? failure.original : failure);
    if (outcome && !outcome.ok) throw failure;
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
function upgradeMoveRows(tx: IDBTransaction, track: TrackRequest): void {
  const rows = tx.objectStore("cat_move_rows");
  track(tx.objectStore("cat_batches").getAll() as IDBRequest<Row[]>, (batches) => {
    const from = new Map(batches.map((b) => [b.id as number, (JSON.parse(b.scope_json as string) as { from?: number }).from]));
    track(rows.getAll() as IDBRequest<Row[]>, (all) => {
      track(rows.clear());
      for (const r of all) {
        const categoryId = from.get(r.batch_id as number);
        if (categoryId !== undefined) track(rows.put({ ...r, category_id: categoryId }, [r.batch_id as number, r.thread_id as number, categoryId]));
      }
    });
  });
}

/**
 * Version 4 (SQL v14, plan 17): the correspondents store. Thread rows keep
 * their shape: a missing `person` is a fact not computed yet, which the
 * backfill fills in after the store opens (slices, never this transaction).
 * A mailbox with threads starts it from its first phase; an empty one has
 * nothing to do.
 */
function upgradeFacts(db: IDBDatabase, tx: IDBTransaction, track: TrackRequest): void {
  if (!db.objectStoreNames.contains("correspondents")) db.createObjectStore("correspondents");
  track(tx.objectStore("threads").count(), (count) => {
    if (count > 0) track(tx.objectStore("settings").put({ key: "facts_backfill", value_json: JSON.stringify({ phase: "senders", after: 0 }) }, "facts_backfill"));
  });
}

/**
 * Version 3 (SQL v9): drafts v2. Existing drafts are format 1 (bodyText holds
 * everything) and take their conversation from the message they reply to.
 */
function upgradeDrafts(tx: IDBTransaction, track: TrackRequest): void {
  const drafts = tx.objectStore("drafts");
  const messages = tx.objectStore("messages");
  track(drafts.getAll() as IDBRequest<Row[]>, (all) => {
    for (const d of all) {
      const v2 = { thread_id: null, format: 1, mode: "new", bcc_json: "[]", subject_edited: 0, quoted_text: "", include_quote: 0, forward_of_message_id: null, ui_state: "open", revision: 1, ...d };
      if (d.in_reply_to_message_id == null) {
        track(drafts.put(v2, d.id as number));
        continue;
      }
      track(messages.get(d.in_reply_to_message_id as number) as IDBRequest<Row | undefined>, (m) => {
        track(drafts.put({ ...v2, mode: "reply", thread_id: (m?.thread_id as number | undefined) ?? null }, d.id as number));
      });
    }
  });
}

export async function idbExists(factory: IDBFactory, name: string): Promise<boolean> {
  if (typeof factory.databases === "function") return (await factory.databases()).some((d) => d.name === databaseName(name));
  return false;
}

const idbKey = (t: Table, key: Key): IDBValidKey => (t.spec.key.length === 1 ? (key as IDBValidKey) : (JSON.parse(key as string) as IDBValidKey));

export const EARLY_TABLES = PERSISTED.filter((t) => !t.lazy && t.early).map((t) => t.name);
export const LATE_TABLES = PERSISTED.filter((t) => !t.lazy && !t.early).map((t) => t.name);

type Snapshot = {
  tables: Map<string, Row[]>;
  meta: Record<string, unknown>;
  opKeys: IDBValidKey[];
  parts: Record<OpPartStore, OpPartImage>;
};

/** One completed physical snapshot; missing observable child success is refusal. */
function physicalSnapshot(idb: IDBDatabase, names: readonly string[]): Promise<Snapshot> {
  const hasOps = names.includes("ops"), split = hasOps && idb.version >= OP_STORAGE_VERSION;
  const scope = [...new Set([...names, "meta", ...(split ? OP_PART_STORES : [])])];
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try { tx = idb.transaction(scope, "readonly"); }
    catch { reject(new UncertainWriteError("unreadable")); return; }
    const tables = new Map<string, Row[]>();
    const parts: Record<OpPartStore, OpPartImage> = {
      op_control: { keys: [], values: [] },
      op_target: { keys: [], values: [] },
      op_error: { keys: [], values: [] },
    };
    let opKeys: IDBValidKey[] = [], metaKeys: IDBValidKey[] = [], metaValues: unknown[] = [];
    let failed = false, queued = false, accepted = 0, observed = 0;
    let failure: unknown;
    const abort = (error: unknown) => {
      if (!failed) { failed = true; failure = error; }
      try { tx.abort(); } catch { /* Actual completion still owns admission. */ }
    };
    const watch = <T>(r: IDBRequest<T>, receive: (value: T) => void) => {
      accepted++;
      r.addEventListener("error", () => abort(new UncertainWriteError("unreadable")));
      r.addEventListener("success", () => {
        try { receive(r.result); observed++; } catch (error) { abort(error); }
      });
    };
    tx.addEventListener("error", () => { failed = true; failure ??= new UncertainWriteError("unreadable"); }, true);
    tx.addEventListener("abort", () => reject(failure ?? new UncertainWriteError("unreadable")));
    tx.addEventListener("complete", () => {
      if (failed || !queued || accepted !== observed || metaKeys.length !== metaValues.length) {
        reject(failure ?? new UncertainWriteError("unreadable")); return;
      }
      if (metaKeys.some((key) => key === UNCERTAINTY_KEY)) { reject(new UncertainWriteError()); return; }
      resolve({ tables, opKeys, parts, meta: Object.fromEntries(metaKeys.map((key, i) => [String(key), metaValues[i]])) });
    });
    try {
      if (hasOps) inspectOpLayout(idb, tx);
      for (const name of names) watch(tx.objectStore(name).getAll() as IDBRequest<Row[]>, (rows) => tables.set(name, rows));
      watch(tx.objectStore("meta").getAllKeys(), (keys) => { metaKeys = keys; });
      watch(tx.objectStore("meta").getAll(), (values) => { metaValues = values; });
      if (hasOps) watch(tx.objectStore("ops").getAllKeys(), (keys) => { opKeys = keys; });
      if (split) for (const name of OP_PART_STORES) {
        watch(tx.objectStore(name).getAllKeys(), (keys) => { parts[name].keys = keys; });
        watch(tx.objectStore(name).getAll(), (values) => { parts[name].values = values; });
      }
      queued = true;
    } catch (error) { abort(error); }
  });
}

/** Reads logical tables eagerly, including effective operation controls. */
export async function loadAll(
  idb: IDBDatabase, mem: MemDb, timings: Record<string, number> = {},
  eager: readonly string[] = [...EARLY_TABLES, ...LATE_TABLES],
  yieldTo?: () => Promise<void>,
): Promise<Record<string, unknown>> {
  const started = performance.now();
  const image = await physicalSnapshot(idb, eager);
  timings.read = performance.now() - started;
  if (eager.includes("ops")) await decodeOpImage(image.opKeys, image.tables.get("ops")!, image.parts, yieldTo ? { yield: yieldTo } : undefined);
  let slice = performance.now();
  for (const name of eager) {
    const table = mem.table(name);
    for (const row of image.tables.get(name)!) {
      table.load(row);
      if (yieldTo && performance.now() - slice > 8) { await yieldTo(); slice = performance.now(); }
    }
  }
  timings.build = performance.now() - started - timings.read;
  return image.meta;
}

export async function writeMeta(idb: IDBDatabase, values: Record<string, unknown>): Promise<void> {
  if (Object.hasOwn(values, UNCERTAINTY_KEY)) throw new Error("The IndexedDB save marker is reserved");
  if (!Object.keys(values).length) return;
  const tx = idb.transaction("meta", "readwrite");
  await writeTransaction(tx, (track) => {
    for (const [k, v] of Object.entries(values)) track(tx.objectStore("meta").put(v, k));
  });
}

/** One readwrite transaction with every row a store command touched. Resolves once IndexedDB committed it. */
export async function persist(idb: IDBDatabase, commit: Committed, durability: "strict" | "relaxed", host?: { yield(): Promise<void> }): Promise<void> {
  const stores = [...commit.writes.keys()].filter((t) => !TABLES.find((s) => s.name === t.spec.name)?.memoryOnly);
  if (!stores.length) return;
  const plans = await prepareOpWrites(commit, host);
  const hasOps = stores.some((t) => t.spec.name === "ops");
  const names = [...new Set([...stores.map((t) => t.spec.name), "meta", ...(hasOps ? OP_PART_STORES : [])])];
  const tx = idb.transaction(names, "readwrite", { durability });
  await writeTransaction(tx, (track) => {
    for (const table of stores) {
      if (table.spec.name === "ops") continue;
      for (const [key, row] of commit.writes.get(table)!) {
        if (row) track(tx.objectStore(table.spec.name).put(row, idbKey(table, key)));
        else track(tx.objectStore(table.spec.name).delete(idbKey(table, key)));
      }
    }
    const iterator = plans[Symbol.iterator]();
    const next = (): void => {
      const item = iterator.next();
      if (item.done) return;
      const plan = item.value;
      const body: [string, Row | null][] = [];
      if (plan.kind === "delete" || plan.kind === "base") {
        body.push(["ops", plan.kind === "base" ? plan.value : null]);
        for (const name of OP_PART_STORES) body.push([name, null]);
      } else {
        body.push(["op_control", plan.control]);
        if (plan.target) body.push(["op_target", plan.target]);
        if (plan.error) body.push(["op_error", plan.error]);
      }
      body.forEach(([name, value], i) => {
        const store = tx.objectStore(name);
        if (value === null) track(store.delete(plan.key), i === body.length - 1 ? next : undefined);
        else track(store.put(value, plan.key), i === body.length - 1 ? next : undefined);
      });
    };
    next();
  });
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

/** Effective logical disk rows, after one completed admitted snapshot. */
export async function readAll(idb: IDBDatabase, host?: { yield(): Promise<void> }): Promise<Map<string, Row[]>> {
  const names = PERSISTED.filter((table) => !table.lazy).map((table) => table.name);
  const image = await physicalSnapshot(idb, names);
  await decodeOpImage(image.opKeys, image.tables.get("ops")!, image.parts, host);
  return image.tables;
}
