import { sqlAssets } from "../../../../packages/db/src/attachments";
import { createAsset, appendAsset, sealAsset } from "@terno/store";
/// <reference lib="webworker" />
import init from "@sqlite.org/sqlite-wasm";
import { Db, MIGRATIONS, createAccount, ingestMessages, registerFunctions, wasmSqliteDriver } from "@terno/db/wasm";
import { IdbMailStore, databaseName } from "@terno/idb";
import { TABLES } from "../../../../packages/idb/src/schema";
import { OP_PART_STORES } from "../../../../packages/idb/src/op-storage";
import { msg } from "../../../../packages/store/src/conformance/fixtures";
import { OpfsSqliteAdapter } from "../../src/web/worker/stores";
import { BrowserBodyUpgrades } from "../../src/web/worker/body-upgrade";
import { webPlatform } from "../../src/web/worker/platform";

const text = `${"alpha e\u0301 😀\r\n".repeat(90000)} boundaryneedle acrossboundary `;
const html = `<p>${"Exact &amp; complete. ".repeat(90000)}</p>`;
const yieldTo = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
function fixture(db: Db): number {
  registerFunctions(db);
  for (const migration of MIGRATIONS) if (migration.version <= 37) db.tx(() => { db.exec(migration.sql); db.exec(`PRAGMA user_version=${migration.version}`); });
  const account = createAccount(db, { kind: "gmail", email: "synthetic@example.test", displayName: "Synthetic", color: "indigo" }, 1);
  const assets = sqlAssets(db);
  const asset = db.tx(() => { const asset = createAsset(assets, () => crypto.randomUUID(), { accountId: account.id, filename: "exact.bin", mime: "application/octet-stream", size: 3, now: 1 }); appendAsset(assets, account.id, asset.assetId!, 0, "AP+A"); sealAsset(assets, account.id, asset.assetId!); return asset; });
  return [...ingestMessages(db, [msg({ accountId: account.id, providerMsgId: "old", bodyText: text, bodyHtml: html, bodyState: "full", isStarred: true, attachments: [{ filename: "exact.bin", mime: "application/octet-stream", size: 3, assetId: asset.assetId! }] })], 1).touchedThreads][0]!;
}
async function idbFixture(name: string, db: Db): Promise<void> {
  const open = indexedDB.open(databaseName(name), 22);
  open.onupgradeneeded = () => {
    for (const table of TABLES) if (!table.memoryOnly && !table.name.startsWith("body_")) open.result.createObjectStore(table.name);
    open.result.createObjectStore("meta");
    for (const part of OP_PART_STORES) open.result.createObjectStore(part);
    open.transaction!.objectStore("capture_repairs").createIndex("discovery", ["account_id", "key"]);
    open.transaction!.objectStore("capture_repairs").createIndex("state", ["account_id", "state", "key"]);
    open.transaction!.objectStore("messages").createIndex("cached_provider", ["account_id", "provider_msg_id"]);
    open.transaction!.objectStore("ops").createIndex("flag_account_seq", ["account_id", "seq", "id"]);
    open.transaction!.objectStore("message_flag_intents").createIndex("flag_snapshots", ["snapshot_account_id", "message_id"]);
  };
  const idb = await new Promise<IDBDatabase>((resolve, reject) => { open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
  try {
    for (const table of TABLES) {
      if (table.memoryOnly || table.name.startsWith("body_")) continue;
      const rows = db.all<Record<string, unknown>>(`SELECT * FROM ${table.name}`);
      const tx = idb.transaction(table.name, "readwrite");
      for (const row of rows) { const key = table.key.map((column) => row[column]) as IDBValidKey[]; tx.objectStore(table.name).put(row, key.length === 1 ? key[0]! : key); }
      await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
    }
  } finally { idb.close(); }
}

self.onmessage = (event: MessageEvent<{ kind: "opfs" | "idb"; cancel?: boolean }>) => {
  void (async () => {
    const kind = event.data.kind, name = `legacy-${crypto.randomUUID()}`, sqlite = await init();
    let upgrades = new BrowserBodyUpgrades();
    let adapter = new OpfsSqliteAdapter(sqlite, upgrades);
    const pool = kind === "opfs" ? await adapter.install() : undefined;
    const driver = wasmSqliteDriver(sqlite, { pool });
    const old = new Db(driver, kind === "opfs" ? `/${name}.db` : ":memory:");
    let thread: number;
    try { thread = fixture(old); if (kind === "idb") await idbFixture(name, old); }
    finally { old.close(); }
    // The fixture above is a pre-existing mailbox. Every real conversion operation is below this monitor.
    const openingBegan = performance.now();
    let largest = 0, maxStall = 0, ticks = 0, last = performance.now();
    const timer = setInterval(() => { const now = performance.now(); maxStall = Math.max(maxStall, now - last); last = now; ticks++; }, 1);
    const visit = (value: unknown): void => { if (typeof value === "string") largest = Math.max(largest, value.length); else if (value && typeof value === "object" && !ArrayBuffer.isView(value) && !(value instanceof ArrayBuffer)) for (const child of Object.values(value)) visit(child); };
    const statementPrototype = sqlite.oo1.Stmt.prototype, statementGet = statementPrototype.get;
    statementPrototype.get = function (...args) { const result = statementGet.apply(this, args); visit(result); return result; };
    // Observe native-IDB record clones on this host, never the isolated upgrade actor.
    const originalGet = IDBObjectStore.prototype.get, originalAll = IDBObjectStore.prototype.getAll;
    IDBObjectStore.prototype.get = function (...args) { const request = originalGet.apply(this, args); request.addEventListener("success", () => visit(request.result)); return request; };
    IDBObjectStore.prototype.getAll = function (...args) { const request = originalAll.apply(this, args); request.addEventListener("success", () => visit(request.result)); return request; };
    let cancelledAtPrepared = false;
    if (event.data.cancel) {
      if (pool) pool.pauseVfs();
      let close: Promise<void> | undefined;
      try { await upgrades.run(kind, name, async (value) => { if (value.phase === "prepared") { cancelledAtPrepared = true; close = upgrades.close(); } }); throw new Error("Cancelled upgrade was admitted"); }
      catch (error) { if (!(error instanceof DOMException) || error.name !== "AbortError") throw error; }
      await close;
      if (pool) { await pool.unpauseVfs(); const probe = new Db(driver, `/${name}.db`); try { if (probe.get<{ n: number }>("SELECT count(*) n FROM body_heads")!.n !== 0) throw new Error("Cancelled body was published"); } finally { probe.close(); pool.pauseVfs(); } }
      else { const opening = indexedDB.open(databaseName(name)); const native = await new Promise<IDBDatabase>((resolve, reject) => { opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error); }); try { const count = native.transaction("body_heads").objectStore("body_heads").count(); const n = await new Promise<number>((resolve, reject) => { count.onsuccess = () => resolve(count.result); count.onerror = () => reject(count.error); }); if (n !== 0) throw new Error("Cancelled body was published"); } finally { native.close(); } }
      upgrades = new BrowserBodyUpgrades(); adapter = new OpfsSqliteAdapter(sqlite, upgrades);
    }
    const platform = webPlatform(undefined), began = performance.now();
    let store, outcome: unknown;
    try {
      if (kind === "opfs") {
        store = await adapter.open({ name, platform, instantSearch: false });
      } else store = await IdbMailStore.open({ name, factory: indexedDB, platform, instantSearch: false, signal: upgrades.signal, legacyUpgrade: (name) => upgrades.run("idb", name) });
      const upgradeWall = performance.now() - began;
      clearInterval(timer); await yieldTo();
      const detail = (await store.threads.get(thread!, { bodyFormat: "parts" }))!, message = detail.messages[0]!, reference = message.bodyReference!;
      const fields: string[] = [];
      for (const field of ["text", "html"] as const) {
        const chunks: string[] = [];
        for (let ordinal = 0; ordinal < (field === "text" ? reference.textParts! : reference.htmlParts!); ordinal++) chunks.push(await store.threads.bodyPart!({ accountId: message.accountId, messageId: message.id, version: reference.version, field, ordinal }));
        fields.push(chunks.join("")); // Test oracle only; outside measured application upgrade/transport.
      }
      const search = await store.threads.searchText({ query: '"boundaryneedle acrossboundary"', now: 1, limit: 10 });
      const filter = await store.filters.preview({ match: "all", conditions: [{ field: "body", op: "endsWith", value: "boundaryneedle acrossboundary" }], actions: [{ type: "star" }] }, 1, 10);
      const assetExact = await store.attachments.read(message.accountId, message.attachments[0]!.assetId!, 0) === "AP+A";
      outcome = { ok: true, kind, cancelledAtPrepared, assetExact, exact: fields[0] === text && fields[1] === html, starred: message.isStarred, search: search.items.length, filter: filter.count, largest, upgradeWall, entireOpeningWall: performance.now() - openingBegan, maxStall, ticks };
    } finally {
      clearInterval(timer); await store?.close(); await adapter.release();
      if (pool) { await pool.unpauseVfs(); pool.unlink(`/${name}.db`); pool.pauseVfs(); }
      else indexedDB.deleteDatabase(databaseName(name));
    }
    self.postMessage(outcome);
  })().catch((error) => self.postMessage({ ok: false, message: String(error), stack: error.stack }));
};
