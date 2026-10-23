/**
 * Project db-wasm: every database the suites open by path runs on
 * SQLite-WASM (the web's engine) instead of node:sqlite. Files are whole
 * images read on open and written back on close, so fixtures written with
 * node:sqlite (legacy schemas) open on WASM and reopen tests see their data.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import init from "@sqlite.org/sqlite-wasm";
import { useSqliteDriver, wasmSqliteDriver } from "../index";

const sqlite3 = await init();
useSqliteDriver(
  wasmSqliteDriver(sqlite3, {
    images: {
      read: (path) => (existsSync(path) ? new Uint8Array(readFileSync(path)) : null),
      write: (path, bytes) => writeFileSync(path, bytes),
    },
  }),
);
