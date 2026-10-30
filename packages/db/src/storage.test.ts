import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { ingest, msg, withAccounts } from "@terno/store/conformance";
import { compactOnOpen, openDatabase } from "./index";
import { getSetting } from "./repos";
import { SqlMailStore } from "./sql-store";
import { COMPACT_KEY, footprint } from "./storage";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tempPath = () => {
  const d = mkdtempSync(join(tmpdir(), "terno-storage-"));
  dirs.push(d);
  return join(d, "s.db");
};

const autoVacuum = (path: string) => {
  const raw = new DatabaseSync(path, { readOnly: true });
  try {
    return Number((raw.prepare("PRAGMA auto_vacuum").get() as { auto_vacuum: number }).auto_vacuum);
  } finally {
    raw.close();
  }
};

/** A file as installs before plan 69 have it: no auto_vacuum, so pages a removal frees stay in the file. */
function legacyFile(): string {
  const path = tempPath();
  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA journal_mode = WAL");
  raw.exec("CREATE TABLE placeholder (x)");
  raw.close();
  expect(autoVacuum(path)).toBe(0);
  return path;
}

/** Fills the store with mail and removes it through the storage commands; returns the store, still open. */
async function filledAndEmptied(path: string) {
  const store = new SqlMailStore(openDatabase(path));
  const [a] = await withAccounts(store, 1);
  await store.accounts.setSyncState(a!, { lastSyncAt: 1 });
  await ingest(store, Array.from({ length: 400 }, (_, i) => msg({ accountId: a!, providerMsgId: `m${i}`, inInbox: false, isTrash: true, date: 1, bodyText: "x".repeat(3000) })));
  const ids: number[] = [];
  for (let after = 0; ; ) {
    const rows = await store.storage.threads(after, 100);
    if (!rows.length) break;
    ids.push(...rows.map((r) => r.id));
    after = rows.at(-1)!.id;
  }
  for (;;) if (!(await store.storage.remove({ threadIds: ids, buckets: ["trash"], cutoff: Date.now(), maxMessages: 500 })).remaining) break;
  return store;
}

describe("storage on disk (plan 69)", () => {
  it("a new file is incremental: removed mail's pages leave the file once the checkpoint runs", async () => {
    const path = tempPath();
    const store = await filledAndEmptied(path);
    expect(autoVacuum(path)).toBe(2);
    expect(footprint(store.db).free).toBeGreaterThan(0);
    while ((await store.storage.compact(100)).more);
    expect(footprint(store.db).free).toBe(0);
    expect(await store.storage.compactPending()).toBe(false);
    store.db.get("PRAGMA wal_checkpoint(TRUNCATE)");
    // physically smaller, not only in SQLite's own count (Codex R9)
    expect(statSync(path).size).toBe(footprint(store.db).bytes);
    await store.close();
  });

  it("an older file asks for a VACUUM on its next open, which runs once and leaves it incremental", async () => {
    const path = legacyFile();
    const store = await filledAndEmptied(path);
    expect(autoVacuum(path)).toBe(0);
    const before = footprint(store.db);
    expect(before.free).toBeGreaterThan(0);
    expect(await store.storage.compact(100)).toEqual({ more: false, onRestart: true });
    expect(await store.storage.compactPending()).toBe(true);
    await store.close();
    const sizeBefore = statSync(path).size;

    const reopened = new SqlMailStore(openDatabase(path));
    expect(autoVacuum(path)).toBe(2);
    expect(footprint(reopened.db).free).toBe(0);
    expect(statSync(path).size).toBeLessThan(sizeBefore / 2);
    expect(await reopened.storage.compactPending()).toBe(false);
    expect(getSetting<{ state?: string }>(reopened.db, COMPACT_KEY, {}).state).toBe("done");
    await reopened.close();
  });

  it("waits for room on the disk, and a failed VACUUM opens the file as it was and isn't tried again", async () => {
    const path = legacyFile();
    const store = await filledAndEmptied(path);
    await store.storage.compact(100);
    expect(compactOnOpen(store.db, { freeDisk: () => 1024 })).toBe("noRoom");
    expect(await store.storage.compactPending()).toBe(true);
    // the disk fills up under it, or another process holds the file
    const exec = store.db.exec.bind(store.db);
    const spy = vi.spyOn(store.db, "exec").mockImplementation((sql: string) => {
      if (sql === "VACUUM") throw new Error("database or disk is full");
      exec(sql);
    });
    expect(compactOnOpen(store.db, { freeDisk: () => Number.MAX_SAFE_INTEGER })).toBe("failed");
    spy.mockRestore();
    expect(getSetting<{ state?: string }>(store.db, COMPACT_KEY, {}).state).toBe("failed");
    expect(compactOnOpen(store.db)).toBeNull();
    expect(autoVacuum(path)).toBe(0);
    await store.close();
    // the next open is an ordinary one
    const reopened = new SqlMailStore(openDatabase(path));
    expect(footprint(reopened.db).free).toBeGreaterThan(0);
    await reopened.close();
  });
});
