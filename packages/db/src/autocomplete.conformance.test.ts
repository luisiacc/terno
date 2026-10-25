import { defineAutocompleteConformance } from "@terno/store/conformance";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { openDatabase, sqliteDriver } from "./index";
import { sqlDb, SqlMailStore } from "./sql-store";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// node:sqlite here; SQLite-WASM in the db-wasm project
defineAutocompleteConformance(`SqlMailStore (${sqliteDriver().id})`, {
  open: async () => {
    const d = mkdtempSync(join(tmpdir(), "terno-ac-"));
    dirs.push(d);
    return new SqlMailStore(openDatabase(join(d, "s.db")));
  },
  reopen: async (store) => {
    const path = sqlDb(store).path;
    await store.close();
    return new SqlMailStore(openDatabase(path));
  },
});
