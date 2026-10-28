import "fake-indexeddb/auto";
import { Buffer } from "node:buffer";
import { createHash, type Hash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { IDBFactory } from "fake-indexeddb";
import { expect, it } from "vitest";
import { IdbMailStore } from "@terno/idb";
import { UNCERTAINTY_KEY, UncertainWriteError } from "@terno/idb/uncertainty";
import { ingest, msg } from "@terno/store/conformance";
import { MIGRATION_JOURNAL, migrateLegacyIdb } from "./legacy-storage";

const N = 32, MiB = 1024 * 1024, ERROR = "e".repeat(16 * 1024);
const PARTS = ["op_control", "op_target", "op_error"];
const OPS = ["ops", ...PARTS];
const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setImmediate(resolve)) };
type Op = NonNullable<Awaited<ReturnType<IdbMailStore["ops"]["get"]>>>;
type Manifest = { version: number; stores: { name: string; keyPath: string | string[] | null; autoIncrement: boolean; indexes: { name: string; keyPath: string | string[]; unique: boolean; multiEntry: boolean }[] }[] };
const request = <T,>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.addEventListener("success", () => resolve(r.result)); r.addEventListener("error", () => reject(r.error)); });
const terminal = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => { tx.addEventListener("complete", () => resolve()); tx.addEventListener("abort", () => reject(tx.error)); });

function feed(hash: Hash, value: unknown): void {
  if (value === null || value === undefined) { hash.update(String(value) + ";"); return; }
  if (typeof value === "string") { hash.update(`s${Buffer.byteLength(value)}:`); hash.update(value); return; }
  if (typeof value === "number" || typeof value === "boolean") { hash.update(typeof value + ":" + String(value) + ";"); return; }
  if (value instanceof Uint8Array) { hash.update(`b${value.byteLength}:`); hash.update(value); return; }
  if (Array.isArray(value)) { hash.update(`a${value.length}:`); for (const item of value) feed(hash, item); return; }
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) throw new Error("Unexpected synthetic fixture value");
  const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  hash.update(`o${entries.length}:`);
  for (const [key, item] of entries) { feed(hash, key); feed(hash, item); }
}
function digest(value: unknown): string { const hash = createHash("sha256"); feed(hash, value); return hash.digest("hex"); }
function matchingBytes(value: unknown, expected: string | null): number {
  if (typeof value === "string") return expected !== null && value === expected ? Buffer.byteLength(value) : 0;
  if (!value || typeof value !== "object") return 0;
  return Object.values(value).reduce<number>((sum, item) => sum + matchingBytes(item, expected), 0);
}
const counts = () => ({ baseRequests: 0, baseRows: 0, baseBytes: 0, pointRequests: 0, pointValues: 0,
  keyRequests: 0, keyRows: 0, orphanChecks: 0, helpers: 0, markers: 0, baseEnds: 0, keyEnds: 0,
  getAll: 0, partGetAll: 0, freshBaseRows: 0, freshBaseBytes: 0, maxBatch: 0, active: 0, violations: 0 });
type Counts = ReturnType<typeof counts>;
function overrides() {
  const undo: (() => void)[] = [];
  let installed = 0, restored = 0;
  return {
    add(target: object, key: string, replacement: unknown): void {
      const own = Object.getOwnPropertyDescriptor(target, key);
      let cursor: object | null = target, descriptor = own;
      while (!descriptor && cursor) { cursor = Object.getPrototypeOf(cursor); if (cursor) descriptor = Object.getOwnPropertyDescriptor(cursor, key); }
      if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function" || typeof replacement !== "function") throw new Error("Expected replaceable method: " + key);
      Object.defineProperty(target, key, { ...descriptor, value: replacement });
      installed++;
      undo.push(() => {
        if (Object.getOwnPropertyDescriptor(target, key)?.value !== replacement) throw new Error("Owned wrapper identity changed: " + key);
        if (own) Object.defineProperty(target, key, own);
        else if (!Reflect.deleteProperty(target, key)) throw new Error("Cannot restore inherited method: " + key);
        const after = Object.getOwnPropertyDescriptor(target, key);
        if (own ? !after || after.value !== own.value || after.configurable !== own.configurable || after.enumerable !== own.enumerable || after.writable !== own.writable : after !== undefined) throw new Error("Method descriptor not restored: " + key);
        restored++;
      });
    },
    restore(): void {
      let failed = false, first: unknown;
      while (undo.length) { try { undo.pop()!(); } catch (error) { if (!failed) { failed = true; first = error; } } }
      if (failed) throw first;
    },
    summary: () => ({ installed, restored, active: undo.length }),
  };
}

function audit(factory: IDBFactory, installed: ReturnType<typeof overrides>) {
  const phases: Record<string, { commands: number; tx: number; complete: number; abort: number; active: number; requests: number; successes: number; errors: number;
    basePuts: number; controlPuts: number; targetPuts: number; errorPuts: number; wireSubmitted: number; targetSubmitted: number; errorSubmitted: number; seedWire: number;
    deletes: number; deleteSuccesses: number; journalWrites: number; violations: number; wallMs: number; processCpuMs: number; db: Record<string, Counts> }> = {};
  let current = "setup", probe: Op | undefined, prefixDeleted = false;
  const stats = () => phases[current] ??= { commands: 0, tx: 0, complete: 0, abort: 0, active: 0, requests: 0, successes: 0, errors: 0,
    basePuts: 0, controlPuts: 0, targetPuts: 0, errorPuts: 0, wireSubmitted: 0, targetSubmitted: 0, errorSubmitted: 0, seedWire: 0,
    deletes: 0, deleteSuccesses: 0, journalWrites: 0, violations: 0, wallMs: 0, processCpuMs: 0, db: {} };
  type Tx = { s: ReturnType<typeof stats>; d: Counts; helper: boolean; keyOnly: boolean; baseKey?: IDBValidKey; keyName?: string; partKey?: IDBValidKey; baseRows: number; baseEnd: boolean; keyEnd: boolean; accepted: number; succeeded: number; markers: number; dirty: boolean };
  const transactions = new WeakMap<IDBTransaction, Tx>();
  const cursors = new WeakMap<IDBCursor, Tx>();
  const progress = new WeakMap<Counts, { base?: IDBValidKey; parts: Record<string, IDBValidKey> }>();
  const ordered = (query: unknown, previous?: IDBValidKey) => previous === undefined ? query === undefined
    : query instanceof IDBKeyRange && query.lowerOpen && query.upper === undefined && factory.cmp(query.lower, previous) === 0;
  const samples: { phase: string; method: string; store: string }[] = [], last: typeof samples = [];
  let sampled = 0;
  const transaction = IDBDatabase.prototype.transaction;
  installed.add(IDBDatabase.prototype, "transaction", function (this: IDBDatabase, ...args: Parameters<IDBDatabase["transaction"]>) {
    const tx = Reflect.apply(transaction, this, args) as IDBTransaction, s = stats(), d = s.db[this.name] ??= counts();
    s.tx++; s.active++; d.active++;
    if (!progress.has(d)) progress.set(d, { parts: {} });
    const entry: Tx = { s, d, helper: false, keyOnly: false, baseRows: 0, baseEnd: false, keyEnd: false, accepted: 0, succeeded: 0, markers: 0, dirty: false };
    transactions.set(tx, entry);
    const ended = (complete: boolean) => {
      s.active--; d.active--;
      if (complete) s.complete++;
      else s.abort++;
      if (entry.helper) {
        d.helpers++; d.markers += entry.markers;
        if (!complete || tx.mode !== "readonly" || entry.accepted !== entry.succeeded || entry.markers !== 1 || entry.dirty || entry.baseRows > 1) d.violations++;
        if (entry.baseKey !== undefined) progress.get(d)!.base = entry.baseKey;
        if (entry.keyName && entry.partKey !== undefined) progress.get(d)!.parts[entry.keyName] = entry.partKey;
        if (entry.baseEnd) d.baseEnds++;
        if (entry.keyEnd) d.keyEnds++;
      }
    };
    tx.addEventListener("complete", () => ended(true), { once: true }); tx.addEventListener("abort", () => ended(false), { once: true });
    return tx;
  });
  for (const method of ["getAll", "getAllKeys", "getKey", "get", "openCursor", "openKeyCursor", "put", "delete", "count"] as const) {
    const delegate = IDBObjectStore.prototype[method];
    installed.add(IDBObjectStore.prototype, method, function (this: IDBObjectStore, ...args: unknown[]) {
      const result = Reflect.apply(delegate, this, args) as IDBRequest, entry = transactions.get(this.transaction);
      if (!entry) return result;
      const { s, d } = entry, store = this.name, query = args[0];
      s.requests++; entry.accepted++;
      const sample = { phase: current, method, store }; sampled++;
      if (samples.length < 128) samples.push(sample); else { last.push(sample); if (last.length > 128) last.shift(); }
      if (store === "ops" && method === "openCursor") { entry.helper = true; d.baseRequests++; if (!ordered(query, progress.get(d)!.base)) d.violations++; }
      if (PARTS.includes(store) && method === "openKeyCursor") { entry.helper = true; entry.keyOnly = true; entry.keyName = store; d.keyRequests++; if (!d.baseEnds || !ordered(query, progress.get(d)!.parts[store])) d.violations++; }
      if (entry.helper && PARTS.includes(store) && method === "openCursor") {
        d.pointRequests++;
        if (!(query instanceof IDBKeyRange) || query.lower !== entry.baseKey || query.upper !== entry.baseKey || query.lowerOpen || query.upperOpen) d.violations++;
      }
      if (entry.keyOnly && store === "ops" && method === "getKey") d.orphanChecks++;
      if (method === "getAll" && store === "ops") { d.getAll++; if (current === "copying" && !prefixDeleted) d.violations++; }
      if (method === "getAll" && PARTS.includes(store)) d.partGetAll++;
      if (store === "copies" && ["put", "delete"].includes(method)) s.journalWrites++;
      if (method === "put" && OPS.includes(store)) {
        if (store === "ops") { s.basePuts++; const row = args[0] as Record<string, unknown>; if (typeof row.payload_json === "string") s.seedWire += Buffer.byteLength(row.payload_json); }
        if (store === "op_control") { s.controlPuts++; if (current.startsWith("locality-") && Object.keys(args[0] as object).sort().join() !== "attempts,next_attempt_at,state,updated_at") s.violations++; }
        if (store === "op_target") s.targetPuts++;
        if (store === "op_error") s.errorPuts++;
        if (probe) { s.wireSubmitted += matchingBytes(args[0], probe.payload_json); s.targetSubmitted += matchingBytes(args[0], probe.target_json); s.errorSubmitted += matchingBytes(args[0], probe.last_error); }
      }
      result.addEventListener("error", () => { s.errors++; }, { once: true });
      result.addEventListener("success", () => {
        s.successes++; entry.succeeded++;
        const value: unknown = result.result;
        if (store === "meta" && method === "getKey" && args[0] === UNCERTAINTY_KEY) { entry.markers++; if (value !== undefined) entry.dirty = true; }
        if (method === "openCursor" && store === "ops") {
          const cursor = value as IDBCursorWithValue | null;
          if (!cursor) entry.baseEnd = true;
          else { cursors.set(cursor, entry); entry.baseRows++; entry.baseKey = cursor.primaryKey; d.baseRows++; d.baseBytes += Buffer.byteLength((cursor.value as { payload_json: string }).payload_json); }
        }
        if (entry.helper && method === "openCursor" && PARTS.includes(store) && value !== null) d.pointValues++;
        if (method === "openKeyCursor" && PARTS.includes(store)) {
          if (value === null) entry.keyEnd = true;
          else { entry.partKey = (value as IDBCursor).primaryKey; d.keyRows++; if (typeof entry.partKey !== "string" || "value" in (value as object)) d.violations++; }
        }
        if (method === "getAll" && store === "ops") {
          const rows = value as { payload_json: string }[]; d.maxBatch = Math.max(d.maxBatch, rows.length); d.freshBaseRows += rows.length;
          for (const row of rows) d.freshBaseBytes += Buffer.byteLength(row.payload_json);
        }
      }, { once: true });
      return result;
    });
  }
  for (const method of ["continue", "advance", "continuePrimaryKey"] as const) {
    const delegate = IDBCursor.prototype[method];
    installed.add(IDBCursor.prototype, method, function (this: IDBCursor, ...args: unknown[]) {
      const entry = cursors.get(this); if (entry?.helper) entry.d.violations++;
      return Reflect.apply(delegate, this, args);
    });
  }
  const remove = factory.deleteDatabase;
  installed.add(factory, "deleteDatabase", function (...args: Parameters<IDBFactory["deleteDatabase"]>) {
    const s = stats(), name = args[0];
    if (current === "copied" || current === "copying") {
      const required = current === "copied" ? ["unica-case", "terno-case"] : ["unica-case"];
      if (name === (current === "copied" ? "unica-case" : "terno-case")) {
        for (const db of required) { const d = s.db[db]; if (!d || d.baseRows !== N || d.baseEnds !== 1 || d.keyEnds !== 3 || d.active || d.violations) s.violations++; }
      }
    }
    s.deletes++;
    const result = remove.apply(factory, args);
    result.addEventListener("success", () => { s.deleteSuccesses++; if (current === "copying" && name === "terno-case") prefixDeleted = true; });
    return result;
  });
  return { phases, samples, last, get sampled() { return sampled; }, setProbe: (op?: Op) => { probe = op; },
    command: async <T,>(run: () => Promise<T>) => { stats().commands++; return run(); },
    phase: async <T,>(name: string, run: () => Promise<T>) => {
      current = name; const s = stats(), wall = performance.now(), cpu = process.cpuUsage();
      try { return await run(); } finally { const used = process.cpuUsage(cpu); s.wallMs += performance.now() - wall; s.processCpuMs += (used.user + used.system) / 1000; }
    },
    observerKind: "direct bounded wrappers" as const };
}

async function manifest(factory: IDBFactory, name: string): Promise<Manifest> {
  const db = await request(factory.open(name));
  try {
    const tx = db.transaction([...db.objectStoreNames]), done = terminal(tx);
    const stores = [...db.objectStoreNames].map((name) => {
      const s = tx.objectStore(name);
      return { name, keyPath: s.keyPath, autoIncrement: s.autoIncrement, indexes: [...s.indexNames].map((name) => { const i = s.index(name); return { name, keyPath: i.keyPath, unique: i.unique, multiEntry: i.multiEntry }; }) };
    });
    await done; return { version: db.version, stores };
  } finally { db.close(); }
}
async function create(factory: IDBFactory, name: string, spec: Manifest, cell?: { key: string; value: unknown }) {
  const open = factory.open(name, spec.version);
  open.addEventListener("upgradeneeded", () => {
    for (const s of spec.stores) {
      const store = open.result.createObjectStore(s.name, { keyPath: s.keyPath, autoIncrement: s.autoIncrement });
      for (const i of s.indexes) store.createIndex(i.name, i.keyPath, { unique: i.unique, multiEntry: i.multiEntry });
      if (cell && s.name === "op_control") store.put(cell.value, cell.key);
    }
  });
  (await request(open)).close();
}
async function batch(db: IDBDatabase, name: string, after?: IDBValidKey) {
  const tx = db.transaction(name), done = terminal(tx), s = tx.objectStore(name), range = after === undefined ? undefined : IDBKeyRange.lowerBound(after, true);
  const [keys, values] = await Promise.all([request(s.getAllKeys(range, 256)), request(s.getAll(range, 256)), done]);
  return { keys, values };
}
async function clone(factory: IDBFactory, from: string, to: string) {
  const spec = await manifest(factory, from); await create(factory, to, spec);
  const source = await request(factory.open(from)), target = await request(factory.open(to));
  try {
    for (const s of spec.stores) {
      let after: IDBValidKey | undefined;
      for (;;) {
        const next = await (async () => {
          const saved = await batch(source, s.name, after);
          if (!saved.keys.length) return undefined;
          const tx = target.transaction(s.name, "readwrite"), done = terminal(tx);
          const writes = saved.values.map((value, i) => request(tx.objectStore(s.name).put(value, s.keyPath === null ? saved.keys[i] : undefined)));
          await Promise.all([...writes, done]);
          return saved.keys[saved.keys.length - 1];
        })();
        if (next === undefined) break;
        after = next; await platform.yield();
      }
    }
  } finally { source.close(); target.close(); }
}
async function journal(factory: IDBFactory, state: "copying" | "copied") {
  const open = factory.open(MIGRATION_JOURNAL, 1); open.onupgradeneeded = () => open.result.createObjectStore("copies");
  const db = await request(open);
  try { const tx = db.transaction("copies", "readwrite"), done = terminal(tx); await Promise.all([request(tx.objectStore("copies").put({ from: "unica-case", state }, "terno-case")), done]); }
  finally { db.close(); }
}
async function physicalDigest(factory: IDBFactory) {
  const hash = createHash("sha256");
  for (const { name } of (await factory.databases()).sort((a, b) => a.name!.localeCompare(b.name!))) {
    if (!name) throw new Error("Missing synthetic database name");
    feed(hash, name); const spec = await manifest(factory, name); feed(hash, spec);
    const db = await request(factory.open(name));
    try {
      for (const s of spec.stores) {
        feed(hash, s.name);
        let after: IDBValidKey | undefined;
        for (;;) {
          const next = await (async () => { const saved = await batch(db, s.name, after); if (!saved.keys.length) return undefined; saved.keys.forEach((key, i) => { feed(hash, key); feed(hash, saved.values[i]); }); return saved.keys[saved.keys.length - 1]; })();
          if (next === undefined) break;
          after = next; await platform.yield();
        }
      }
    } finally { db.close(); }
  }
  return hash.digest("hex");
}

it("P0 resource model: 32 public operations", async () => {
  const factory = new IDBFactory(), installed = overrides(), stores = new Set<IdbMailStore>();
  let observed: ReturnType<typeof audit>;
  try {
    // Same fixed public recent-history clock; no mock call history.
    installed.add(Date, "now", () => 21);
    observed = audit(factory, installed);
  } catch (error) {
    try { installed.restore(); } catch (restoreError) { throw new AggregateError([error, restoreError], "Observer installation and restoration failed"); }
    throw error;
  }
  const expected = new Map<string, string>(), probes = new Map<string, Op>(), locality: string[] = [];
  let outlier = "", small = "", wire = 0, p = 0, spec: Manifest, cell: { key: string; value: unknown };
  let cleanupFailure: PromiseRejectedResult | undefined;
  let finalizationFailed = false, finalizationFailure: unknown;
  const rememberFinalization = (error: unknown) => { if (!finalizationFailed) { finalizationFailed = true; finalizationFailure = error; } };
  const command = observed.command;
  const open = async (name: string, instantSearch = false) => { const store = await IdbMailStore.open({ factory, name, instantSearch, platform }); stores.add(store); await store.whenLoaded(); return store; };
  const close = async (store: IdbMailStore) => { await store.close(); stores.delete(store); };
  const verify = async (store: IdbMailStore) => {
    const rows = await store.ops.recent(N + 1); expect(rows).toHaveLength(N); expect(new Set(rows.map((op) => op.id)).size).toBe(N);
    for (const [id, hash] of expected) { const op = await store.ops.get(id); expect(digest(op)).toBe(hash); if (probes.has(id)) expect(op).toEqual(probes.get(id)); }
    await store.debug.verify();
  };
  try {
    await observed.phase("seed", async () => {
      const store = await open("resource-seed");
      const a = (await command(() => store.accounts.create({ kind: "gmail", email: "a@example.com", displayName: "A", color: "indigo", now: 1 }))).account.id;
      const b = (await command(() => store.accounts.create({ kind: "gmail", email: "b@example.com", displayName: "B", color: "indigo", now: 1 }))).account.id;
      await command(() => ingest(store, Array.from({ length: 130 }, (_, i) => msg({ accountId: a, providerMsgId: `r${i}`, providerThreadId: `rt${i}`, bodyText: "fixture" }))));
      const threads = new Map((await store.debug.snapshot()).messages.map((m) => [m.providerMsgId, m.threadId]));
      const flagThreads = Array.from({ length: 129 }, (_, i) => threads.get(`r${i + 1}`)!);
      const flags = await command(() => store.threads.act({ threadIds: flagThreads, action: "markRead", signal: null, now: 2 })); expect(flags.opIds).toHaveLength(1);
      expect((await command(() => store.ops.claimReady(3, 1))).map((op) => op.id)).toEqual(flags.opIds);
      await command(() => store.ops.awaitAuth(flags.opIds[0]!, ERROR, 4));
      const newer = await command(() => store.threads.act({ threadIds: [flagThreads[0]!], action: "markUnread", signal: null, now: 5 })); expect(newer.opIds).toHaveLength(1);
      expect((await command(() => store.ops.claimReady(6, 1))).map((op) => op.id)).toEqual(newer.opIds);
      await command(() => store.ops.awaitAuth(newer.opIds[0]!, "new flag", 7));
      const sendIds: string[] = [];
      for (let i = 0; i < 12; i++) sendIds.push((await command(() => store.compose.queueSend({ accountId: b, to: [{ name: "", email: "r@example.com" }], cc: [], bcc: [], subject: "R", bodyText: i ? "s".repeat(64) : "~".repeat(MiB), recordReply: false, now: 8 }))).opId);
      expect((await command(() => store.ops.claimReady(9, 12))).map((op) => op.id)).toEqual(sendIds);
      outlier = sendIds[0]!; small = sendIds[1]!;
      await command(() => store.ops.awaitAuth(outlier, ERROR, 10)); expect(await command(() => store.ops.resumeAuth(b, 11))).toEqual([outlier]);
      expect((await command(() => store.ops.claimReady(12, 1))).map((op) => op.id)).toEqual([outlier]);
      await command(() => store.ops.release(sendIds[2]!, 13)); await command(() => store.ops.awaitAuth(sendIds[3]!, ERROR, 13));
      expect(await command(() => store.ops.fail(sendIds[4]!, "retry", true, 13))).toBe("queued");
      expect(await command(() => store.ops.fail(sendIds[5]!, "network", true, 13, { network: true, keepAttempt: false }))).toBe("queued");
      expect(await command(() => store.ops.fail(sendIds[6]!, "failed", false, 13))).toBe("failed");
      await command(() => store.ops.markUnknown(sendIds[7]!, "unknown", 13)); await command(() => store.ops.complete(sendIds[8]!, undefined, 13));
      await command(() => store.ops.markUnknown(sendIds[9]!, "unknown retry", 13)); await command(() => store.ops.resolveUnknown(sendIds[9]!, "retry", 14));
      await command(() => store.ops.complete(sendIds[10]!, { warning: "warning" }, 13));
      for (const id of [...flags.opIds, ...newer.opIds, ...sendIds]) { const op = (await store.ops.get(id))!; probes.set(id, op); expected.set(id, digest(op)); }
      expect([...new Set([...probes.values()].map((op) => op.state))].sort()).toEqual(["failed", "queued", "running", "succeeded", "unknown"]);
      expect(probes.get(sendIds[3]!)!.next_attempt_at).toBe(8_640_000_000_000_000);
      expect(probes.get(sendIds[5]!)!.next_attempt_at).toBe(8_639_999_999_999_999);
      expect(probes.get(sendIds[9]!)!.last_error).toBeNull(); expect(probes.get(outlier)!.last_error).toBe(ERROR);
      expect(JSON.parse(probes.get(flags.opIds[0]!)!.target_json).messageIds).toHaveLength(128); expect(probes.get(flags.opIds[0]!)!.target_json.length).toBeGreaterThan(400);
      for (let i = 0; i < N - 14; i++) {
        const action = await command(() => store.threads.act({ threadIds: [threads.get("r0")!], action: i % 2 ? "moveToInbox" : "archive", signal: null, now: 15 }));
        expect(action.opIds).toHaveLength(1); const op = (await store.ops.get(action.opIds[0]!))!; expect(op.payload_json).toBe("{}"); expected.set(op.id, digest(op)); await platform.yield();
      }
      expect(expected.size).toBe(N); await verify(store); await close(store);
    });
    for (const instant of [false, true]) {
      let store = await observed.phase(`open-${instant}`, () => open("resource-seed", instant));
      await observed.phase(`public-${instant}`, () => verify(store));
      for (const id of [outlier, small]) {
        const before = (await store.ops.get(id))!; observed.setProbe(before);
        const releaseName = `locality-release-${instant}-${id === outlier ? "large" : "small"}`; locality.push(releaseName);
        await observed.phase(releaseName, () => command(() => store.ops.release(id, 20)));
        const released = (await store.ops.get(id))!; expect(released).toEqual({ ...before, state: "queued", attempts: before.attempts - 1 });
        const claimName = `locality-claim-${instant}-${id === outlier ? "large" : "small"}`; locality.push(claimName);
        const claimed = await observed.phase(claimName, () => command(() => store.ops.claimReady(21, 1))); expect(claimed.map((op) => op.id)).toEqual([id]);
        expect(claimed[0]).toEqual(before); probes.set(id, claimed[0]!); expected.set(id, digest(claimed[0])); observed.setProbe();
      }
      await close(store); store = await observed.phase(`reopen-${instant}`, () => open("resource-seed", instant));
      await observed.phase(`reopen-public-${instant}`, () => verify(store)); await close(store);
    }
    await observed.phase("fixture-pair", async () => {
      const db = await request(factory.open("terno-resource-seed"));
      try {
        const tx = db.transaction(PARTS), done = terminal(tx);
        const [totals, value] = await Promise.all([Promise.all(PARTS.map((name) => request(tx.objectStore(name).count()))), request<unknown>(tx.objectStore("op_control").get(outlier)), done]);
        p = totals.reduce((sum, count) => sum + count, 0); expect(totals[1]).toBeGreaterThan(0); cell = { key: outlier, value };
      } finally { db.close(); }
      spec = await manifest(factory, "terno-resource-seed"); await clone(factory, "terno-resource-seed", "unica-case"); await clone(factory, "terno-resource-seed", "terno-case");
      await journal(factory, "copied"); await request(factory.deleteDatabase("terno-resource-seed"));
    });
    await observed.phase("copied", () => command(() => migrateLegacyIdb(factory, "case")));
    expect((await factory.databases()).map((d) => d.name)).toEqual(["terno-case"]);
    await observed.phase("copied-public", async () => { const store = await open("case"); await verify(store); await close(store); });
    await observed.phase("fixture-prefix", async () => { await clone(factory, "terno-case", "unica-case"); await request(factory.deleteDatabase("terno-case")); await create(factory, "terno-case", spec, cell); await journal(factory, "copying"); });
    await observed.phase("copying", () => command(() => migrateLegacyIdb(factory, "case")));
    expect((await factory.databases()).map((d) => d.name)).toEqual(["terno-case"]);
    await observed.phase("copying-public", async () => { const store = await open("case"); await verify(store); await close(store); });
    await observed.phase("fixture-donor", () => clone(factory, "terno-case", "terno-donor"));
    for (const fault of ["orphan", "dirty"] as const) {
      await observed.phase(`fixture-${fault}`, async () => {
        await clone(factory, "terno-donor", "unica-case"); await request(factory.deleteDatabase("terno-case")); await create(factory, "terno-case", spec, cell); await journal(factory, "copying");
        const db = await request(factory.open("unica-case"));
        try {
          const name = fault === "orphan" ? "op_error" : "meta", tx = db.transaction(name, "readwrite"), done = terminal(tx);
          let succeeded = 0, completed = 0;
          tx.addEventListener("complete", () => { completed++; }, { once: true });
          const injected = tx.objectStore(name).put(fault === "orphan" ? { last_error: null } : undefined, fault === "orphan" ? "zz-orphan" : UNCERTAINTY_KEY);
          await Promise.all([request(injected).then(() => { succeeded++; }), done]);
          expect({ succeeded, completed }).toEqual({ succeeded: 1, completed: 1 });
        }
        finally { db.close(); }
      });
      const before = await observed.phase(`snapshot-before-${fault}`, () => physicalDigest(factory));
      await observed.phase(`refuse-${fault}`, () => expect(command(() => migrateLegacyIdb(factory, "case"))).rejects.toBeInstanceOf(UncertainWriteError));
      expect(await observed.phase(`snapshot-after-${fault}`, () => physicalDigest(factory))).toBe(before);
      expect(observed.phases[`refuse-${fault}`]!.deletes).toBe(0); expect(observed.phases[`refuse-${fault}`]!.journalWrites).toBe(0);
      await observed.phase(`fixture-reset-${fault}`, async () => { for (const name of ["unica-case", "terno-case", MIGRATION_JOURNAL]) await request(factory.deleteDatabase(name)); if (fault === "orphan") await clone(factory, "terno-donor", "terno-case"); });
    }
    // Resource assertions follow public data/reopen/debug, disposal ordering and refusal witnesses.
    wire = observed.phases.seed!.seedWire; expect(wire).toBeGreaterThan(MiB); expect(wire).toBeLessThanOrEqual(8 * MiB); expect(p).toBeLessThanOrEqual(42);
    for (const name of locality) {
      const s = observed.phases[name]!; expect(s.complete).toBeGreaterThan(0); expect(s.requests).toBe(s.successes); expect(s.abort).toBe(0);
      expect([s.basePuts, s.controlPuts, s.targetPuts, s.errorPuts, s.wireSubmitted, s.targetSubmitted, s.errorSubmitted, s.violations]).toEqual([0, 1, 0, 0, 0, 0, 0, 0]);
    }
    for (const [phase, dbs] of [["copied", ["unica-case", "terno-case"]], ["copying", ["unica-case"]]] as const) {
      const s = observed.phases[phase]!; expect(s.violations).toBe(0); expect(s.deleteSuccesses).toBe(s.deletes);
      for (const name of dbs) { const d = s.db[name]!; expect([d.baseRequests, d.baseRows, d.baseBytes, d.pointRequests, d.pointValues, d.keyRequests, d.keyRows, d.orphanChecks, d.helpers, d.markers, d.baseEnds, d.keyEnds, d.active, d.violations]).toEqual([N + 1, N, wire, 3 * N, p, p + 3, p, p, N + p + 4, N + p + 4, 1, 3, 0, 0]); }
    }
    for (const d of Object.values(observed.phases.copied!.db)) expect([d.getAll, d.partGetAll]).toEqual([0, 0]);
    const fresh = observed.phases.copying!.db["unica-case"]!; expect(fresh.getAll).toBe(1); expect(fresh.partGetAll).toBe(3); expect(fresh.freshBaseRows).toBe(N); expect(fresh.freshBaseBytes).toBe(wire); expect(fresh.maxBatch).toBeLessThanOrEqual(500);
    expect(observed.phases.copying!.db["terno-case"]!.getAll).toBe(0);
  } finally {
    try {
      observed.setProbe();
      const closed = await Promise.allSettled([...stores].map((store) => store.close()));
      const removed = await Promise.allSettled((await factory.databases()).map(({ name }) => { if (!name) throw new Error("Missing owned name"); return request(factory.deleteDatabase(name)); }));
      cleanupFailure = [...closed, ...removed].find((result) => result.status === "rejected");
    } catch (error) { rememberFinalization(error); }
    try { installed.restore(); } catch (error) { rememberFinalization(error); }
    try {
      const report = { n: N, probeRows: probes.size, wire, parts: p, phases: observed.phases, commandCounter: "wrapped public mutations and migrateLegacyIdb; public get/recent/debug/open are separate phase work", tracePolicy: "first128/last128; scalar totals cover intercepted methods only", sampled: observed.sampled, first: observed.samples, last: observed.last, cleanupRejected: !!cleanupFailure, observerKind: observed.observerKind, restoration: installed.summary(), finalizationFailed };
      const output = process.env.TERNO_RESOURCE32_REPORT;
      if (output) writeFileSync(output, JSON.stringify(report));
      console.info("RESOURCE32", JSON.stringify({ n: N, probeRows: probes.size, wire, parts: p, phases: Object.entries(observed.phases).map(([name, s]) => ({ name, commands: s.commands, tx: s.tx, complete: s.complete, abort: s.abort, wallMs: s.wallMs, processCpuMs: s.processCpuMs })) }));
    } catch (error) { rememberFinalization(error); }
  }
  if (finalizationFailed) throw finalizationFailure;
  if (cleanupFailure) throw cleanupFailure.reason;
}, 60_000);
