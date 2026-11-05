import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { defineVisibleStore } from "../../mail/src/test/visible-store";
import { openDatabase, sqliteDriver } from "./index";
import { copyMigrated } from "./test/helpers";
import { sqlDb, SqlMailStore } from "./sql-store";

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
// the whole matrix on one engine; SQLite-WASM runs the same SQL, so it keeps what its FTS5 build can decide
defineVisibleStore(`SQL (${sqliteDriver().id})`, {
  cases: sqliteDriver().id === "node-sqlite" ? "all" : "store-facing",
  open: async () => { const dir = mkdtempSync(join(tmpdir(), "terno-visible-")); dirs.push(dir); return new SqlMailStore(openDatabase(copyMigrated(join(dir, "mail.db")))); },
  reopen: async (store) => { const path = sqlDb(store).path; await store.close(); return new SqlMailStore(openDatabase(path)); },
});
