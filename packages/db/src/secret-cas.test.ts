import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openDatabase, SqlMailStore } from "./index";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });

it("secret CAS rolls back precommit failure, preserves an ambiguous committed result, and equal assertions do not write", async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-secret-cas-"));
  const path = join(dir, "synthetic.db");
  let store = new SqlMailStore(openDatabase(path));
  cleanup.push(async () => { await store.close(); rmSync(dir, { recursive: true, force: true }); });
  await store.secrets.put("synthetic", Uint8Array.of(1));
  let fail = true;
  store.db.onBeforeCommit(() => { if (fail) throw new Error("synthetic precommit"); });
  await expect(store.secrets.replace("synthetic", Uint8Array.of(1), Uint8Array.of(2))).rejects.toThrow("synthetic precommit");
  expect(await store.secrets.get("synthetic")).toEqual(Uint8Array.of(1));
  fail = false;
  await store.close();
  store = new SqlMailStore(openDatabase(path));
  expect(await store.secrets.get("synthetic")).toEqual(Uint8Array.of(1));
  let ambiguous = true;
  store.db.onCommit(() => { if (ambiguous) throw new Error("synthetic aftercommit"); });
  await expect(store.secrets.replace("synthetic", Uint8Array.of(1), Uint8Array.of(2))).rejects.toThrow("synthetic aftercommit");
  ambiguous = false;
  await store.close();
  store = new SqlMailStore(openDatabase(path));
  expect(await store.secrets.get("synthetic")).toEqual(Uint8Array.of(2));
  store.db.exec("CREATE TEMP TRIGGER no_secret_rewrite BEFORE UPDATE ON secrets BEGIN SELECT RAISE(ABORT, 'unexpected rewrite'); END");
  expect(await store.secrets.replace("synthetic", Uint8Array.of(2), Uint8Array.of(2))).toBe(true);
  expect(await store.secrets.replace("synthetic", Uint8Array.of(1), Uint8Array.of(1))).toBe(false);
});
