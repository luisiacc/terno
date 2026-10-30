import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { ingest, memoryFiles, msg, withAccounts } from "@terno/store/conformance";
import { expect, it, vi } from "vitest";
import { databaseName, IDB_VERSION, LOGICAL_SCHEMA } from "./schema";
import { IdbMailStore } from "./store";
import { legacyImage } from "./test/legacy-stores";
import { UNCERTAINTY_KEY, UncertainWriteError } from "./uncertainty";

const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setImmediate(resolve)) };
const request = <T,>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const ended = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => { tx.addEventListener("complete", () => resolve()); tx.addEventListener("abort", () => reject(tx.error)); });

type StoreImage = {
  name: string; keyPath: string | string[] | null; autoIncrement: boolean;
  indexes: { name: string; keyPath: string | string[]; unique: boolean; multiEntry: boolean }[];
  keys: IDBValidKey[]; values: unknown[];
};

async function image(db: IDBDatabase): Promise<StoreImage[]> {
  const tx = db.transaction(Array.from(db.objectStoreNames)), finished = ended(tx);
  const values = await Promise.all(Array.from(db.objectStoreNames).map(async (name) => {
    const store = tx.objectStore(name);
    const indexes = Array.from(store.indexNames).map((name) => {
      const index = store.index(name);
      return { name, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
    });
    const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
    return { name, keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes, keys, values };
  }));
  await finished; return values;
}

/** what an upgrade adds empty: physical11's operation parts, physical12's folders (plan 68), physical13's Sent recovery */
function withEmptyParts(source: StoreImage[]): StoreImage[] {
  return [...source, ...["op_control", "op_target", "op_error", "folders", "thread_folders", "folder_rebuilds", "send_copies", "send_copy_bytes", "recipient_receipts", "recipient_receipt_parts"].map((name) => ({
    name, keyPath: null, autoIncrement: false, indexes: [], keys: [], values: [],
  }))].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

// Fixture model: reconstruct fixed physical9 stores with effective wide operations.
// This deliberately does not execute an old binary or assert older historical manifests.
async function copyAsV9(factory: IDBFactory, name: string, source: StoreImage[]) {
  source = legacyImage(source, 9);
  const open = factory.open(databaseName(name), 9);
  open.onupgradeneeded = () => {
    for (const saved of source) {
      const store = open.result.createObjectStore(saved.name, { keyPath: saved.keyPath, autoIncrement: saved.autoIncrement });
      for (const index of saved.indexes) store.createIndex(index.name, index.keyPath, { unique: index.unique, multiEntry: index.multiEntry });
      saved.values.forEach((value, i) => store.put(value, saved.keys[i]!));
    }
  };
  return request(open);
}

it("preserves a complete canonical physical9/logical23 fixture through the physical11 downgrade barrier", async () => {
  const factory = new IDBFactory(), name = crypto.randomUUID();
  const seed = await IdbMailStore.open({ factory, name: `${name}-source`, instantSearch: false, platform });
  let store: IdbMailStore | undefined, raw: IDBDatabase | undefined;
  try {
    expect({ physical: IDB_VERSION, logical: LOGICAL_SCHEMA }).toEqual({ physical: 17, logical: 29 });
    const [account] = await withAccounts(seed, 1);
    const id = (await ingest(seed, [msg({ accountId: account!, providerMsgId: "fixture-message", bodyText: "preserved canonical body" })])).inserted[0]!;
    const message = (await seed.debug.snapshot()).messages[0]!;
    const common = { accountId: account!, to: [], cc: [], subject: "preserved draft", bodyText: "exact draft body", mode: "reply" as const, inReplyToMessageId: id, threadId: message.threadId };
    const shown = await seed.drafts.save({ ...common, showSourceContext: true, subjectEdited: true, includeQuote: true, quotedText: "exact quote" }, 17);
    const quiet = await seed.drafts.save({ ...common, showSourceContext: false }, 18);
    const ordinary = await seed.drafts.save({ accountId: account!, to: [], cc: [], subject: "default", bodyText: "default body" }, 19);
    expect(shown).toMatchObject({ show_source_context: 1, subject_edited: 1, include_quote: 1 });
    expect(quiet).toMatchObject({ show_source_context: 0 });
    expect(ordinary).toMatchObject({ mode: "new", format: 2, show_source_context: 0, subject_edited: 0, include_quote: 0, revision: 1 });
    const publicBefore = { snapshot: await seed.debug.snapshot(), drafts: await seed.drafts.list(), head: await seed.feed.head() };
    await seed.close();
    raw = await request(factory.open(databaseName(`${name}-source`)));
    expect(raw.version).toBe(IDB_VERSION);
    const original = legacyImage(await image(raw), 9);
    expect(original.find((s) => s.name === "meta")?.values[original.find((s) => s.name === "meta")!.keys.indexOf("logicalSchema")]).toBe(LOGICAL_SCHEMA);
    expect(original.find((s) => s.name === "drafts")?.values).toHaveLength(3);
    expect(original.find((s) => s.name === "search_state")?.values).toHaveLength(1);
    raw.close();
    raw = await copyAsV9(factory, name, original);
    expect(raw.version).toBe(9);
    expect(await image(raw)).toEqual(original);
    raw.close(); raw = undefined;
    store = await IdbMailStore.open({ factory, name, instantSearch: false, platform });
    expect({ snapshot: await store.debug.snapshot(), drafts: await store.drafts.list(), head: await store.feed.head() }).toEqual(publicBefore);
    await store.debug.verify(); await store.close();
    raw = await request(factory.open(databaseName(name)));
    expect(raw.version).toBe(IDB_VERSION);
    expect(await image(raw)).toEqual(withEmptyParts(original));
    raw.close(); raw = undefined;
    await expect(request(factory.open(databaseName(name), 9))).rejects.toMatchObject({ name: "VersionError" });
  } finally { vi.restoreAllMocks(); raw?.close(); await store?.close(); await seed.close(); }
});

it("preserves a complete canonical physical10/logical23 fixture through the physical11 downgrade barrier", async () => {
  const factory = new IDBFactory(), name = crypto.randomUUID();
  const seedName = `${name}-v10-source`;
  const seed = await IdbMailStore.open({ factory, name: seedName, instantSearch: false, platform });
  const opened: IdbMailStore[] = [seed];
  let raw: IDBDatabase | undefined;
  let cleanupFailure: PromiseRejectedResult | undefined;
  try {
    expect({ physical: IDB_VERSION, logical: LOGICAL_SCHEMA }).toEqual({ physical: 17, logical: 29 });
    const [account] = await withAccounts(seed, 1);
    await ingest(seed, [msg({ accountId: account!, providerMsgId: "physical10-message", bodyText: "exact physical10 message body" })]);
    await seed.drafts.save({ accountId: account!, to: [], cc: [], subject: "physical10 draft", bodyText: "exact physical10 draft body" }, 17);
    const queued = await seed.compose.queueSend({ accountId: account!, to: [{ name: "", email: "recipient@example.com" }], cc: [], bcc: [], subject: "physical10 send", bodyText: "exact physical10 wire body", recordReply: false, now: 20 });
    expect((await seed.ops.claimReady(21, 1)).map((op) => op.id)).toEqual([queued.opId]);
    await seed.ops.awaitAuth(queued.opId, "exact physical10 auth error", 22);
    const publicBefore = { snapshot: await seed.debug.snapshot(), drafts: await seed.drafts.list(), head: await seed.feed.head(), ops: await seed.ops.recent(100) };
    await seed.close();
    raw = await request(factory.open(databaseName(seedName)));
    const original = legacyImage(await image(raw), 10);
    expect(original.some((store) => ["op_control", "op_target", "op_error"].includes(store.name))).toBe(false);
    const base = original.find((store) => store.name === "ops")!;
    const legacyOp = base.values[base.keys.indexOf(queued.opId)] as Record<string, unknown>;
    const expectedOp = publicBefore.ops.find((op) => op.id === queued.opId)!;
    expect(legacyOp).toMatchObject(expectedOp);
    expect(legacyOp.last_error).toBe("exact physical10 auth error");
    raw.close(); raw = undefined;
    // Reconstruct a complete fixed v10 image; this never executes an older binary.
    const old = factory.open(databaseName(name), 10);
    old.onupgradeneeded = () => {
      for (const saved of original) {
        const store = old.result.createObjectStore(saved.name, { keyPath: saved.keyPath, autoIncrement: saved.autoIncrement });
        for (const index of saved.indexes) store.createIndex(index.name, index.keyPath, { unique: index.unique, multiEntry: index.multiEntry });
        saved.values.forEach((value, i) => store.put(value, saved.keys[i]!));
      }
    };
    raw = await request(old);
    expect(raw.version).toBe(10); expect(await image(raw)).toEqual(original);
    raw.close(); raw = undefined;
    let store = await IdbMailStore.open({ factory, name, instantSearch: false, platform }); opened.push(store);
    expect({ snapshot: await store.debug.snapshot(), drafts: await store.drafts.list(), head: await store.feed.head(), ops: await store.ops.recent(100) }).toEqual(publicBefore);
    await store.debug.verify(); await store.close();
    raw = await request(factory.open(databaseName(name)));
    expect(raw.version).toBe(IDB_VERSION); expect(await image(raw)).toEqual(withEmptyParts(original));
    raw.close(); raw = undefined;
    // The barrier must protect a now-stale wide BASE after a real public control transition.
    store = await IdbMailStore.open({ factory, name, instantSearch: false, platform }); opened.push(store);
    expect(await store.ops.resumeAuth(account!, 23)).toEqual([queued.opId]);
    expect((await store.ops.claimReady(24, 1)).map((op) => op.id)).toEqual([queued.opId]);
    const latest = (await store.ops.get(queued.opId))!;
    expect(latest.state).toBe("running"); expect(legacyOp.state).not.toBe(latest.state);
    await store.close();
    store = await IdbMailStore.open({ factory, name, instantSearch: false, platform }); opened.push(store);
    expect(await store.ops.get(queued.opId)).toEqual(latest);
    await store.debug.verify(); await store.close();
    raw = await request(factory.open(databaseName(name)));
    const after = await image(raw);
    expect(after.find((entry) => entry.name === "ops")).toEqual(base);
    const control = after.find((entry) => entry.name === "op_control")!;
    expect(control.values[control.keys.indexOf(queued.opId)]).toMatchObject({ state: "running", attempts: latest.attempts });
    raw.close(); raw = undefined;
    await expect(request(factory.open(databaseName(name), 10))).rejects.toMatchObject({ name: "VersionError" });
  } finally {
    raw?.close();
    const closed = await Promise.allSettled(opened.map((store) => store.close()));
    const removals = await Promise.allSettled([databaseName(name), databaseName(seedName)].map((dbName) => request(factory.deleteDatabase(dbName))));
    cleanupFailure = [...closed, ...removals].find((result) => result.status === "rejected");
  }
  if (cleanupFailure) throw cleanupFailure.reason;
});

it("refuses a completed upgrade whose inspection success was hidden", async () => {
  const factory = new IDBFactory(), name = crypto.randomUUID();
  const seed = await IdbMailStore.open({ factory, name: `${name}-source`, instantSearch: false, platform });
  let store: IdbMailStore | undefined, raw: IDBDatabase | undefined, acquired: IDBDatabase | undefined;
  try {
    await seed.settings.set("retained", "exact");
    await seed.close();
    raw = await request(factory.open(databaseName(`${name}-source`)));
    const before = legacyImage(await image(raw), 9); raw.close();
    raw = await copyAsV9(factory, name, before); raw.close(); raw = undefined;
    const getKey = IDBObjectStore.prototype.getKey, open = factory.open.bind(factory);
    let hits = 0, terminal: string | null = null;
    vi.spyOn(IDBObjectStore.prototype, "getKey").mockImplementation(function (this: IDBObjectStore, ...args) {
      const r = getKey.call(this, ...args);
      if (this.transaction.mode === "versionchange" && args[0] === UNCERTAINTY_KEY) {
        hits++;
        this.transaction.addEventListener("complete", () => { terminal = "complete"; });
        r.addEventListener("success", (event) => event.stopImmediatePropagation());
      }
      return r;
    });
    vi.spyOn(factory, "open").mockImplementation((...args) => {
      const r = open(...args);
      r.addEventListener("success", () => { acquired = r.result; });
      return r;
    });
    const error = await IdbMailStore.open({ factory, name, instantSearch: true, platform }).then((value) => { store = value; return null; }, (failure: unknown) => failure);
    expect({ hits, terminal, exposed: store !== undefined }).toEqual({ hits: 1, terminal: "complete", exposed: false });
    expect(error).toMatchObject({ name: "UncertainWriteError", reason: "unreadable" });
    expect(() => acquired!.transaction("meta")).toThrow(expect.objectContaining({ name: "InvalidStateError" }));
    vi.restoreAllMocks();
    raw = await request(factory.open(databaseName(name)));
    expect(raw.version).toBe(IDB_VERSION);
    expect(await image(raw)).toEqual(before);
  } finally { vi.restoreAllMocks(); raw?.close(); acquired?.close(); await store?.close(); await seed.close(); }
});

it("classifies an aborted upgrade whose inspection error was hidden as unreadable", async () => {
  const factory = new IDBFactory(), name = crypto.randomUUID();
  const seed = await IdbMailStore.open({ factory, name: `${name}-source`, instantSearch: false, platform });
  let raw: IDBDatabase | undefined, exposed: IdbMailStore | undefined;
  try {
    await seed.settings.set("retained", "exact aborted upgrade control"); await seed.close();
    raw = await request(factory.open(databaseName(`${name}-source`)));
    const before = legacyImage(await image(raw), 9); raw.close();
    raw = await copyAsV9(factory, name, before); raw.close(); raw = undefined;
    const getKey = IDBObjectStore.prototype.getKey, getAll = IDBObjectStore.prototype.getAll;
    let hits = 0, errors = 0, rowReads = 0, terminal: string | null = null;
    vi.spyOn(IDBObjectStore.prototype, "getAll").mockImplementation(function (this: IDBObjectStore, ...args) { rowReads++; return getAll.call(this, ...args); });
    vi.spyOn(IDBObjectStore.prototype, "getKey").mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.transaction.mode !== "versionchange" || args[0] !== UNCERTAINTY_KEY) return getKey.call(this, ...args);
      hits++;
      const tx = this.transaction;
      tx.addEventListener("abort", () => { terminal = "abort"; });
      const first = this.get("logicalSchema");
      first.addEventListener("success", () => tx.abort());
      const r = getKey.call(this, ...args);
      r.addEventListener("error", (event) => { errors++; event.stopImmediatePropagation(); });
      return r;
    });
    const error = await IdbMailStore.open({ factory, name, instantSearch: true, platform }).then((store) => { exposed = store; return null; }, (failure: unknown) => failure);
    expect({ hits, errors, rowReads, terminal, exposed: exposed !== undefined }).toEqual({ hits: 1, errors: 1, rowReads: 0, terminal: "abort", exposed: false });
    expect.soft(error).toMatchObject({ name: "UncertainWriteError", reason: "unreadable" });
    vi.restoreAllMocks();
    raw = await request(factory.open(databaseName(name)));
    expect(raw.version).toBe(9); expect(await image(raw)).toEqual(before);
  } finally { vi.restoreAllMocks(); raw?.close(); await exposed?.close(); await seed.close(); }
});

async function sentinel(factory: IDBFactory, name: string, version: number, marker: unknown) {
  const open = factory.open(databaseName(name), version);
  open.onupgradeneeded = () => {
    open.result.createObjectStore("meta").put(marker, UNCERTAINTY_KEY);
    // Admission sentinels, not a genuine historical mailbox schema.
    open.result.createObjectStore("drafts").put({ id: 7, body_text: "do not migrate", in_reply_to_message_id: null }, 7);
    open.result.createObjectStore("messages").put({ id: 4, attachment_pending: 0 }, 4);
    open.result.createObjectStore("cat_move_rows").put({ batch_id: 2, thread_id: 3 }, [2, 3]);
  };
  return request(open);
}

function observeAdmission() {
  const getKey = IDBObjectStore.prototype.getKey, getAll = IDBObjectStore.prototype.getAll;
  const put = IDBObjectStore.prototype.put, clear = IDBObjectStore.prototype.clear, cursor = IDBObjectStore.prototype.openCursor;
  const create = IDBDatabase.prototype.createObjectStore, createIndex = IDBObjectStore.prototype.createIndex;
  const counts = { guards: 0, rowReads: 0, rowWrites: 0, schemaWrites: 0 };
  const terminals: string[] = [];
  let upgrade: IDBTransaction | undefined;
  vi.spyOn(IDBObjectStore.prototype, "getKey").mockImplementation(function (this: IDBObjectStore, ...args) {
    if (this.name === "meta" && args[0] === UNCERTAINTY_KEY) {
      counts.guards++;
      if (this.transaction.mode === "versionchange" && !upgrade) {
        upgrade = this.transaction;
        upgrade.addEventListener("abort", () => terminals.push("abort"));
        upgrade.addEventListener("complete", () => terminals.push("complete"));
      }
    }
    return getKey.call(this, ...args);
  });
  vi.spyOn(IDBObjectStore.prototype, "getAll").mockImplementation(function (this: IDBObjectStore, ...args) { counts.rowReads++; return getAll.call(this, ...args); });
  vi.spyOn(IDBObjectStore.prototype, "openCursor").mockImplementation(function (this: IDBObjectStore, ...args) { counts.rowReads++; return cursor.call(this, ...args); });
  vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) { counts.rowWrites++; return put.call(this, ...args); });
  vi.spyOn(IDBObjectStore.prototype, "clear").mockImplementation(function (this: IDBObjectStore, ...args) { counts.rowWrites++; return clear.call(this, ...args); });
  vi.spyOn(IDBDatabase.prototype, "createObjectStore").mockImplementation(function (this: IDBDatabase, ...args) { counts.schemaWrites++; return create.call(this, ...args); });
  vi.spyOn(IDBObjectStore.prototype, "createIndex").mockImplementation(function (this: IDBObjectStore, ...args) { counts.schemaWrites++; return createIndex.call(this, ...args); });
  return { counts, terminals };
}

for (const version of [1, 2, 4, 6, 8, 9, 10]) {
  it.each([
    { label: "dirty", marker: { version: 1 } },
    { label: "present undefined", marker: undefined },
    { label: "unknown", marker: { version: 999 } },
  ])(`refuses a $label v${version} admission sentinel before any migration and retains version/rows`, async ({ marker }) => {
    const factory = new IDBFactory(), name = crypto.randomUUID();
    let raw: IDBDatabase | undefined = await sentinel(factory, name, version, marker), exposed: IdbMailStore | undefined;
    try {
      const before = legacyImage(await image(raw), 9); raw.close(); raw = undefined;
      const observation = observeAdmission();
      const error = await IdbMailStore.open({ factory, name, instantSearch: true, platform }).then((store) => { exposed = store; return null; }, (failure: unknown) => failure);
      expect(observation.counts).toEqual({ guards: 1, rowReads: 0, rowWrites: 0, schemaWrites: 0 });
      expect(observation.terminals).toEqual(["abort"]);
      expect(exposed !== undefined).toBe(false);
      expect(error).toBeInstanceOf(UncertainWriteError);
      expect(error).toMatchObject({ reason: "dirty", code: "IDB_UNCERTAIN_WRITE" });
      vi.restoreAllMocks();
      raw = await request(factory.open(databaseName(name)));
      expect(raw.version).toBe(version); expect(await image(raw)).toEqual(before);
    } finally { vi.restoreAllMocks(); raw?.close(); await exposed?.close(); }
  });
}

it("latches dirty upgrade refusal even when abort is refused and the open actually succeeds", async () => {
  const factory = new IDBFactory(), name = crypto.randomUUID();
  let raw: IDBDatabase | undefined = await sentinel(factory, name, 1, undefined), exposed: IdbMailStore | undefined, acquired: IDBDatabase | undefined;
  try {
    const before = legacyImage(await image(raw), 9); raw.close(); raw = undefined;
    const open = factory.open.bind(factory), abort = IDBTransaction.prototype.abort, close = IDBDatabase.prototype.close;
    let successes = 0, refused = 0, closes = 0;
    vi.spyOn(factory, "open").mockImplementation((...args) => {
      const result = open(...args);
      result.addEventListener("success", () => { successes++; acquired = result.result; });
      return result;
    });
    vi.spyOn(IDBTransaction.prototype, "abort").mockImplementation(function (this: IDBTransaction) {
      if (this.mode === "versionchange") { refused++; throw new Error("injected abort refusal"); }
      return abort.call(this);
    });
    vi.spyOn(IDBDatabase.prototype, "close").mockImplementation(function (this: IDBDatabase) { if (this === acquired) closes++; return close.call(this); });
    const observation = observeAdmission();
    const error = await IdbMailStore.open({ factory, name, instantSearch: true, platform }).then((store) => { exposed = store; return null; }, (failure: unknown) => failure);
    expect({ successes, refused, closes, ...observation.counts }).toEqual({ successes: 1, refused: 1, closes: 1, guards: 1, rowReads: 0, rowWrites: 0, schemaWrites: 0 });
    expect(observation.terminals).toEqual(["complete"]);
    expect(exposed !== undefined).toBe(false);
    expect(error).toBeInstanceOf(UncertainWriteError); expect(error).toMatchObject({ reason: "dirty" });
    expect(() => acquired!.transaction("meta")).toThrow(expect.objectContaining({ name: "InvalidStateError" }));
    vi.restoreAllMocks();
    raw = await request(factory.open(databaseName(name)));
    // The injected refused abort really committed the version bump; it did not authorize row migration.
    expect(raw.version).toBe(IDB_VERSION); expect(await image(raw)).toEqual(before);
  } finally { vi.restoreAllMocks(); acquired?.close(); raw?.close(); await exposed?.close(); }
});

it.each([false, true])("retains an unreadable upgrade cause across abort refusal=%s", async (refuseAbort) => {
  const factory = new IDBFactory(), name = crypto.randomUUID();
  let raw: IDBDatabase | undefined = await sentinel(factory, name, 2, { version: 1 }), exposed: IdbMailStore | undefined;
  try {
    const before = legacyImage(await image(raw), 9); raw.close(); raw = undefined;
    const getKey = IDBObjectStore.prototype.getKey, abort = IDBTransaction.prototype.abort;
    const injected = new Error("upgrade guard could not enqueue");
    let hits = 0, refused = 0, terminal: string | undefined;
    const observation = observeAdmission();
    // Keep the admission observer outside this failure: count the attempted seam explicitly.
    vi.spyOn(IDBObjectStore.prototype, "getKey").mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.transaction.mode === "versionchange" && this.name === "meta" && args[0] === UNCERTAINTY_KEY) {
        hits++;
        this.transaction.addEventListener("abort", () => { terminal = "abort"; });
        this.transaction.addEventListener("complete", () => { terminal = "complete"; });
        throw injected;
      }
      return getKey.call(this, ...args);
    });
    if (refuseAbort) vi.spyOn(IDBTransaction.prototype, "abort").mockImplementation(function (this: IDBTransaction) {
      if (this.mode === "versionchange") { refused++; throw new Error("injected abort refusal"); } return abort.call(this);
    });
    const error = await IdbMailStore.open({ factory, name, instantSearch: true, platform }).then((store) => { exposed = store; return null; }, (failure: unknown) => failure);
    expect({ hits, refused, terminal, ...observation.counts }).toEqual({ hits: 1, refused: refuseAbort ? 1 : 0, terminal: refuseAbort ? "complete" : "abort", guards: 0, rowReads: 0, rowWrites: 0, schemaWrites: 0 });
    expect(exposed !== undefined).toBe(false); expect(error).toBeInstanceOf(UncertainWriteError);
    expect(error).toMatchObject({ reason: "unreadable", cause: injected }); expect((error as Error).cause).toBe(injected);
    vi.restoreAllMocks(); raw = await request(factory.open(databaseName(name)));
    expect(raw.version).toBe(refuseAbort ? IDB_VERSION : 2); expect(await image(raw)).toEqual(before);
  } finally { vi.restoreAllMocks(); raw?.close(); await exposed?.close(); }
});

it.each(["transaction", "enqueue", "request"] as const)("closes the acquired handle before exposing memory/search when startup marker %s fails", async (boundary) => {
  const factory = new IDBFactory(), name = crypto.randomUUID();
  const seed = await IdbMailStore.open({ factory, name, instantSearch: false, platform });
  let exposed: IdbMailStore | undefined, acquired: IDBDatabase | undefined;
  try {
    await seed.settings.set("retained", "exact startup control"); await seed.close();
    const open = factory.open.bind(factory), transaction = IDBDatabase.prototype.transaction, close = IDBDatabase.prototype.close, getKey = IDBObjectStore.prototype.getKey, getAll = IDBObjectStore.prototype.getAll;
    const injected = new Error(`startup marker ${boundary}`), files = memoryFiles();
    const readFile = vi.spyOn(files, "read");
    let hits = 0, closes = 0, earlyReads = 0, requestErrors = 0, original: unknown, terminal: string | undefined;
    let target: IDBTransaction | undefined;
    vi.spyOn(factory, "open").mockImplementation((...args) => { const result = open(...args); result.addEventListener("success", () => { acquired = result.result; }); return result; });
    vi.spyOn(IDBDatabase.prototype, "close").mockImplementation(function (this: IDBDatabase) { if (this === acquired) closes++; return close.call(this); });
    vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args) {
      const names = typeof args[0] === "string" ? [args[0]] : Array.from(args[0]);
      if (this === acquired && args[1] === "readonly" && names.length === 1 && names[0] === "meta") {
        if (boundary === "transaction") { hits++; throw injected; }
        const tx = transaction.call(this, ...args); target = tx;
        tx.addEventListener("complete", () => { terminal = "complete"; });
        tx.addEventListener("abort", () => { terminal = "abort"; });
        return tx;
      }
      return transaction.call(this, ...args);
    });
    vi.spyOn(IDBObjectStore.prototype, "getKey").mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.transaction !== target) return getKey.call(this, ...args);
      hits++;
      if (boundary === "enqueue") throw injected;
      // Abort in an earlier real request callback, so the queued real guard fails with AbortError.
      const predecessor = this.get("logicalSchema");
      predecessor.addEventListener("success", () => this.transaction.abort());
      const result = getKey.call(this, ...args);
      result.addEventListener("error", () => { requestErrors++; original = result.error; });
      return result;
    });
    vi.spyOn(IDBObjectStore.prototype, "getAll").mockImplementation(function (this: IDBObjectStore, ...args) { earlyReads++; return getAll.call(this, ...args); });
    const error = await IdbMailStore.open({ factory, name, instantSearch: true, platform: { ...platform, files } }).then((store) => { exposed = store; return null; }, (failure: unknown) => failure);
    expect({ hits, closes, earlyReads, requestErrors, terminal }).toEqual({ hits: 1, closes: 1, earlyReads: 0, requestErrors: boundary === "request" ? 1 : 0, terminal: boundary === "transaction" ? undefined : "abort" });
    expect(readFile).not.toHaveBeenCalled(); expect(exposed !== undefined).toBe(false);
    expect(error).toBeInstanceOf(UncertainWriteError); expect(error).toMatchObject({ reason: "unreadable" });
    expect((error as Error).cause).toBe(boundary === "request" ? original : injected);
    if (boundary === "request") expect(original).toMatchObject({ name: "AbortError" });
    expect(() => acquired!.transaction("settings")).toThrow(expect.objectContaining({ name: "InvalidStateError" }));
    vi.restoreAllMocks();
    exposed = await IdbMailStore.open({ factory, name, instantSearch: false, platform });
    expect(await exposed.settings.get("retained", null)).toBe("exact startup control");
  } finally { vi.restoreAllMocks(); await exposed?.close(); acquired?.close(); await seed.close(); }
});

it("closes its admitted connection on versionchange so a subsequent version is not blocked", async () => {
  const factory = new IDBFactory(), name = crypto.randomUUID();
  const store = await IdbMailStore.open({ factory, name, instantSearch: false, platform });
  let newer: IDBDatabase | undefined;
  try {
    await store.whenLoaded();
    const close = IDBDatabase.prototype.close;
    let closes = 0, upgrades = 0, blocked = 0;
    vi.spyOn(IDBDatabase.prototype, "close").mockImplementation(function (this: IDBDatabase) { closes++; return close.call(this); });
    const open = factory.open(databaseName(name), IDB_VERSION + 1);
    open.addEventListener("blocked", () => { blocked++; });
    open.addEventListener("upgradeneeded", () => { upgrades++; });
    newer = await request(open);
    expect({ closes, upgrades, blocked, version: newer.version }).toEqual({ closes: 1, upgrades: 1, blocked: 0, version: IDB_VERSION + 1 });
  } finally { vi.restoreAllMocks(); newer?.close(); await store.close(); }
});

it("adds empty Sent recovery stores to physical12 while preserving Plan68 folder membership and counts", async () => {
  const factory = new IDBFactory(), sourceName = crypto.randomUUID(), name = crypto.randomUUID();
  const seed = await IdbMailStore.open({ factory, name: sourceName, instantSearch: false, platform });
  let store: IdbMailStore | undefined, raw: IDBDatabase | undefined;
  try {
    const [account] = await withAccounts(seed, 1);
    await ingest(seed, [msg({ accountId: account!, providerMsgId: "folder-preserved", gmailLabels: ["Label_1", "UNREAD"] })]);
    await seed.folders.replace(account!, [{ key: "Label_1", path: ["Clients"], selectable: true }]);
    const shape = async (s: IdbMailStore) => ({ folders: await s.folders.list(), members: (await s.threads.list({ view: "all", accountId: account!, folder: "Label_1", limit: 100, now: 0 })).items.map((t) => t.id), counts: await s.threads.counts(0) });
    const before = await shape(seed);
    await seed.close(); raw = await request(factory.open(databaseName(sourceName)));
    const source = (await image(raw)).filter((r) => !["send_copies", "send_copy_bytes", "recipient_receipts", "recipient_receipt_parts"].includes(r.name)); raw.close(); raw = undefined;
    const legacy = factory.open(databaseName(name), 12);
    legacy.onupgradeneeded = () => {
      for (const saved of source) {
        const target = legacy.result.createObjectStore(saved.name, { keyPath: saved.keyPath, autoIncrement: saved.autoIncrement });
        for (const index of saved.indexes) target.createIndex(index.name, index.keyPath, { unique: index.unique, multiEntry: index.multiEntry });
        saved.values.forEach((value, i) => target.put(saved.name === "meta" && saved.keys[i] === "logicalSchema" ? 24 : value, saved.keys[i]!));
      }
    };
    raw = await request(legacy); raw.close(); raw = undefined;
    store = await IdbMailStore.open({ factory, name, instantSearch: false, platform });
    expect(await shape(store)).toEqual(before);
    expect(await store.sendCopies.list(account!)).toEqual([]);
    await store.close(); raw = await request(factory.open(databaseName(name)));
    const upgraded = await image(raw);
    expect(raw.version).toBe(IDB_VERSION);
    for (const table of ["folders", "thread_folders", "folder_rebuilds"]) expect(upgraded.find((r) => r.name === table)).toEqual(source.find((r) => r.name === table));
    for (const table of ["send_copies", "send_copy_bytes", "recipient_receipts", "recipient_receipt_parts"]) expect(upgraded.find((r) => r.name === table)).toMatchObject({ keys: [], values: [] });
  } finally { raw?.close(); if (store?.isOpen) await store.close(); if (seed.isOpen) await seed.close(); }
});

it("upgrades populated physical14 reply context and folders without inventing recipient receipts", async () => {
  const factory = new IDBFactory(), sourceName = crypto.randomUUID(), name = crypto.randomUUID();
  const seed = await IdbMailStore.open({ factory, name: sourceName, instantSearch: false, platform });
  let store: IdbMailStore | undefined, raw: IDBDatabase | undefined;
  try {
    const [account] = await withAccounts(seed, 1);
    const message = (await ingest(seed, [msg({ accountId: account!, providerMsgId: "v14-message", gmailLabels: ["Label_1"] })])).inserted[0]!;
    await seed.folders.replace(account!, [{ key: "Label_1", path: ["Clients"], selectable: true }]);
    const draft = (await seed.drafts.save({ accountId: account!, to: [], cc: [], subject: "Re: v14", bodyText: "preserved", mode: "reply", inReplyToMessageId: message, replyContext: { subject: "v14", sourceId: message, sourceAccountId: account! } }, 17))!;
    const before = { folders: await seed.folders.list(), draft };
    await seed.close(); raw = await request(factory.open(databaseName(sourceName)));
    const source = (await image(raw)).filter((r) => !["recipient_receipts", "recipient_receipt_parts"].includes(r.name)); raw.close(); raw = undefined;
    const legacy = factory.open(databaseName(name), 14);
    legacy.onupgradeneeded = () => { for (const saved of source) { const target = legacy.result.createObjectStore(saved.name, { keyPath: saved.keyPath, autoIncrement: saved.autoIncrement }); for (const index of saved.indexes) target.createIndex(index.name, index.keyPath, { unique: index.unique, multiEntry: index.multiEntry }); saved.values.forEach((value, i) => target.put(saved.name === "meta" && saved.keys[i] === "logicalSchema" ? 26 : value, saved.keys[i]!)); } };
    raw = await request(legacy); raw.close(); raw = undefined;
    store = await IdbMailStore.open({ factory, name, instantSearch: false, platform });
    expect(await store.folders.list()).toEqual(before.folders);
    expect((await store.drafts.list()).find((row) => row.id === draft.id)).toEqual(before.draft);
    expect(await store.recipientReceipts.list(account!)).toEqual([]);
  } finally { raw?.close(); if (store?.isOpen) await store.close(); if (seed.isOpen) await seed.close(); }
});

it("upgrades physical15 recipient evidence and copy ownership without losing its parts", async () => {
  const factory = new IDBFactory(), sourceName = crypto.randomUUID(), name = crypto.randomUUID();
  const seed = await IdbMailStore.open({ factory, name: sourceName, instantSearch: false, platform });
  let store: IdbMailStore | undefined, raw: IDBDatabase | undefined;
  try {
    const { account } = await seed.accounts.create({ kind: "imap", email: "synthetic@example.test", displayName: "Synthetic", color: "indigo", providerConfig: { appendToSent: true }, now: 1 });
    const queued = await seed.compose.queueSend({ accountId: account.id, to: [{ name: "", email: "yes@example.test" }, { name: "", email: "no@example.test" }], cc: [], bcc: [], subject: "Synthetic", bodyText: "Exact", recordReply: false, now: 2 });
    await seed.ops.claimReady(2, 1); await seed.sendCopies.startWire(queued.opId, 1); await seed.sendCopies.appendWire(queued.opId, 0, "YQ=="); await seed.sendCopies.sealWire(queued.opId); await seed.sendCopies.accepted(queued.opId, null);
    await seed.ops.markUnknown(queued.opId, "Synthetic", 3, { warning: null, outcomes: [{ email: "yes@example.test", outcome: "accepted" }, { email: "no@example.test", outcome: "rejected" }] });
    await seed.close(); raw = await request(factory.open(databaseName(sourceName))); const source = await image(raw); raw.close(); raw = undefined;
    const legacy = factory.open(databaseName(name), 15);
    legacy.onupgradeneeded = () => { for (const saved of source) { const target = legacy.result.createObjectStore(saved.name, { keyPath: saved.keyPath, autoIncrement: saved.autoIncrement }); for (const index of saved.indexes) target.createIndex(index.name, index.keyPath, { unique: index.unique, multiEntry: index.multiEntry }); saved.values.forEach((value, i) => { let row = value; if (saved.name === "meta" && saved.keys[i] === "logicalSchema") row = 27; if (saved.name === "recipient_receipts") { const { hasRejected: _r, wireOwnerId: _w, ...prior } = value as Record<string, unknown>; row = prior; } if (saved.name === "send_copies") { const { copyRequested: _c, ...prior } = value as Record<string, unknown>; row = prior; } target.put(row, saved.keys[i]!); }); } };
    raw = await request(legacy); raw.close(); raw = undefined;
    store = await IdbMailStore.open({ factory, name, instantSearch: false, platform });
    expect(await store.recipientReceipts.get(queued.opId)).toMatchObject({ state: "accepted", hasRejected: true, wireOwnerId: null });
    expect(await store.sendCopies.get(queued.opId)).toMatchObject({ ready: true, copyRequested: true });
    expect(await store.recipientReceipts.readPart(queued.opId, "outcomes", 0)).toBe('["accepted","rejected"]');
  } finally { raw?.close(); if (store?.isOpen) await store.close(); if (seed.isOpen) await seed.close(); }
});
