import { expect, it } from "vitest";
import type { SqliteDriver } from "./connection";
import { nodeSqliteDriver } from "./node-driver";
import { Db } from "./sqlite";

it("finalizes statements evicted from the LRU and every cached one on close", () => {
  const db = new Db(nodeSqliteDriver, ":memory:", { statementCacheSize: 2 });
  const first = db.prepare("SELECT 1 AS v");
  db.prepare("SELECT 2 AS v");
  expect(first.get()).toEqual({ v: 1 });
  db.prepare("SELECT 3 AS v");
  expect(() => first.get()).toThrow(/finalize/);
  // a fresh prepare of the evicted SQL gets a live statement
  expect(db.get("SELECT 1 AS v")).toEqual({ v: 1 });
  const cached = db.prepare("SELECT 3 AS v");
  db.close();
  expect(() => cached.get()).toThrow(/finalize/);
});

it("applies the driver's pragmas: WAL and fsync settings for files, none of them in memory", () => {
  const opened: { readonly: boolean; memory: boolean }[] = [];
  const spy: SqliteDriver = { ...nodeSqliteDriver, pragmas: (o) => (opened.push(o), nodeSqliteDriver.pragmas(o)) };
  new Db(spy, ":memory:").close();
  expect(opened).toEqual([{ readonly: false, memory: true }]);
  expect(nodeSqliteDriver.pragmas({ readonly: false, memory: false })).toEqual([
    "journal_mode = WAL",
    "busy_timeout = 2000",
    "temp_store = MEMORY",
    "cache_size = -65536",
    "mmap_size = 268435456",
    "foreign_keys = ON",
    "synchronous = NORMAL",
    "checkpoint_fullfsync = ON",
    "journal_size_limit = 67108864",
  ]);
  expect(nodeSqliteDriver.pragmas({ readonly: true, memory: false })).not.toContain("journal_mode = WAL");
});
