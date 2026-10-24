import { generateDataset } from "@terno/mock-data";
import { defineStoreConformance } from "@terno/store/conformance";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { openDatabase, sqliteDriver } from "./index";
import { writeLegacyCopy } from "./test/legacy";
import { sqlDb, SqlMailStore } from "./sql-store";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "unica-conf-"));
  dirs.push(d);
  return d;
};

// node:sqlite here; SQLite-WASM in the db-wasm project
defineStoreConformance(`SqlMailStore (${sqliteDriver().id})`, {
  strategies: true,
  open: async () => new SqlMailStore(openDatabase(join(tempDir(), "s.db"))),
  reopen: async (store) => {
    const path = sqlDb(store).path;
    await store.close();
    return new SqlMailStore(openDatabase(path));
  },
  upgraded: async () => {
    // a mailbox written by today's code, copied row by row into a database with the v5 schema (what installs have)
    const source = new SqlMailStore(openDatabase(join(tempDir(), "source.db")));
    await source.dev.seed(generateDataset({ threads: 300, accounts: 2, seed: 4, now: Date.UTC(2026, 9, 22) }), { now: Date.UTC(2026, 9, 22) });
    const before = await source.debug.snapshot();
    const legacy = join(tempDir(), "v5.db");
    writeLegacyCopy(source.db, legacy, 5);
    await source.close();
    return { store: new SqlMailStore(openDatabase(legacy)), before };
  },
});
