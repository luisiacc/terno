import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { defineVisibleStore } from "../../mail/src/test/visible-store";
import { openDatabase, sqliteDriver } from "./index";
import { sqlDb, SqlMailStore } from "./sql-store";

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
defineVisibleStore(`SQL (${sqliteDriver().id})`, {
  open: async () => { const dir = mkdtempSync(join(tmpdir(), "terno-visible-")); dirs.push(dir); return new SqlMailStore(openDatabase(join(dir, "mail.db"))); },
  reopen: async (store) => { const path = sqlDb(store).path; await store.close(); return new SqlMailStore(openDatabase(path)); },
});
