import init from "@sqlite.org/sqlite-wasm";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openDatabase, sqliteDriver, useSqliteDriver } from "./index";
import { getSetting, setSetting } from "./repos";
import { SqlMailStore } from "./sql-store";
import { COMPACT_KEY, footprint } from "./storage";
import { filledAndEmptied } from "./test/storage";
import { wasmSqliteDriver } from "./wasm-driver";

const sqlite3 = await init();
const stores: SqlMailStore[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) if (store.isOpen) await store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "terno-storage-images-"));
  dirs.push(dir);
  const path = join(dir, "mail.db");
  // The same whole-image persistence contract as db-wasm's setup; no OPFS claim.
  const driver = wasmSqliteDriver(sqlite3, { images: {
    read: (file) => existsSync(file) ? new Uint8Array(readFileSync(file)) : null,
    write: (file, bytes) => writeFileSync(file, bytes),
  } });
  const open = (file: string) => {
    const previous = sqliteDriver();
    useSqliteDriver(driver);
    try { return openDatabase(file); } finally { useSqliteDriver(previous); }
  };
  const reopen = () => { const store = new SqlMailStore(open(path)); stores.push(store); return store; };
  return { path, open, reopen };
}

it("WASM new images reclaim removed mail's pages and persist the smaller incremental database on close", async () => {
  const { path, open, reopen } = fixture();
  let populatedBytes = 0;
  const store = await filledAndEmptied(path, open, async (populated) => {
    stores.push(populated);
    await populated.close();
    populatedBytes = statSync(path).size;
    return reopen();
  }); stores.push(store);
  expect(store.db.get("PRAGMA auto_vacuum")).toEqual({ auto_vacuum: 2 });
  const before = footprint(store.db);
  expect(before.free).toBeGreaterThan(0);
  // The image host writes only on close; a simultaneous native reader is not live.
  expect(statSync(path).size).toBe(populatedBytes);
  while ((await store.storage.compact(100)).more);
  const after = footprint(store.db);
  expect(after.free).toBe(0);
  expect(after.bytes).toBeLessThan(before.bytes);
  expect(await store.storage.compactPending()).toBe(false);
  await store.close();
  expect(statSync(path).size).toBe(after.bytes);
  expect(statSync(path).size).toBeLessThan(populatedBytes);
  const reopened = reopen();
  expect(footprint(reopened.db)).toEqual(after);
  expect(reopened.db.get("PRAGMA auto_vacuum")).toEqual({ auto_vacuum: 2 });
  expect(await reopened.storage.threads(0, 100)).toEqual([]);
});

it("WASM legacy images retain reusable pages across reopen without scheduling desktop VACUUM", async () => {
  const { path, open, reopen } = fixture();
  const legacy = new DatabaseSync(path);
  legacy.exec("PRAGMA journal_mode = WAL; CREATE TABLE placeholder(x)");
  legacy.close();
  const store = await filledAndEmptied(path, open); stores.push(store);
  expect(store.db.get("PRAGMA auto_vacuum")).toEqual({ auto_vacuum: 0 });
  const before = footprint(store.db);
  expect(before.free).toBeGreaterThan(0);
  expect(await store.storage.compact(100)).toEqual({ more: false, onRestart: false });
  expect(await store.storage.compactPending()).toBe(false);
  await store.close();
  expect(statSync(path).size).toBe(before.bytes);
  const reopened = reopen();
  expect(footprint(reopened.db)).toEqual(before);
  expect(reopened.db.get("PRAGMA auto_vacuum")).toEqual({ auto_vacuum: 0 });
  // A desktop's already-persisted request is retained, but this host never executes it.
  setSetting(reopened.db, COMPACT_KEY, { state: "pending" });
  await reopened.close();
  const pending = reopen();
  expect(await pending.storage.compactPending()).toBe(true);
  expect(getSetting(pending.db, COMPACT_KEY, {})).toEqual({ state: "pending" });
  expect(pending.db.get("PRAGMA auto_vacuum")).toEqual({ auto_vacuum: 0 });
  expect(footprint(pending.db).free).toBeGreaterThan(0);
});
