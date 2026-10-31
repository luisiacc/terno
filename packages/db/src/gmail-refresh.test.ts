import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { defineGmailRefreshConformance } from "../../store/src/conformance/gmail-refresh";
import { openDatabase } from "./index";
import { SqlMailStore } from "./sql-store";
const dir = mkdtempSync(join(tmpdir(), "terno-refresh-writer-"));
let count = 0;
const paths = new WeakMap<SqlMailStore, string>();
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const open = (path: string) => { const store = new SqlMailStore(openDatabase(path)); paths.set(store, path); return store; };
defineGmailRefreshConformance("SQL", {
  async open() { return open(join(dir, `${count++}.db`)); },
  async reopen(store) { const path = paths.get(store as SqlMailStore)!; await store.close(); return open(path); },
});
