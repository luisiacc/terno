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

it("Google pin and credential admission is conditional and durable across reopen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-google-pin-")), path = join(dir, "test.db");
  let store = new SqlMailStore(openDatabase(path));
  cleanup.push(async () => { await store.close(); rmSync(dir, { recursive: true, force: true }); });
  const { googleIdentityAdmission } = await import("../../store/src/conformance/google-identity");
  const { stamp, name } = await googleIdentityAdmission(store);
  await store.close(); store = new SqlMailStore(openDatabase(path));
  expect((await store.accounts.config<Record<string, unknown>>(stamp.id))!.config.googleSubject).toBe("first");
  expect(await store.secrets.get(name)).toEqual(Uint8Array.of(2));
  store.db.onBeforeCommit(() => { throw new Error("synthetic rollback"); });
  await expect(store.secrets.commit({ kind: "replace", name, expectedBlob: Uint8Array.of(2), blob: Uint8Array.of(3), google: { expectedSubject: "first", subject: "first" } }, stamp)).rejects.toThrow();
  expect(await store.secrets.get(name)).toEqual(Uint8Array.of(2));
});

it("a first Google pin and credential roll back together and survive an uncertain acknowledged commit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-first-pin-")), path = join(dir, "test.db");
  let store = new SqlMailStore(openDatabase(path));
  cleanup.push(async () => { await store.close(); rmSync(dir, { recursive: true, force: true }); });
  const { account } = await store.accounts.create({ kind: "gmail", email: "legacy@example.test", displayName: "Legacy", color: "indigo", providerConfig: { cursor: "keep" }, secret: { key: "refreshToken", blob: Uint8Array.of(1) }, now: 1 });
  const stamp = (await store.accounts.stamp(account.id))!, name = `account:${account.id}:refreshToken`;
  const intent = { kind: "replace" as const, name, expectedBlob: Uint8Array.of(1), blob: Uint8Array.of(2), google: { expectedSubject: null, subject: "first" } };
  let fail = true;
  store.db.onBeforeCommit(() => { if (fail) throw new Error("synthetic rollback"); });
  await expect(store.secrets.commit(intent, stamp)).rejects.toThrow();
  expect((await store.accounts.config(account.id))!.config).toEqual({ cursor: "keep" });
  expect(await store.secrets.get(name)).toEqual(Uint8Array.of(1));
  fail = false;
  store.db.onCommit(() => { throw new Error("synthetic lost acknowledgement"); });
  await expect(store.secrets.commit(intent, stamp)).rejects.toThrow();
  await store.close(); store = new SqlMailStore(openDatabase(path));
  expect((await store.accounts.config<Record<string, unknown>>(account.id))!.config.googleSubject).toBe("first");
  expect(await store.secrets.get(name)).toEqual(Uint8Array.of(2));
});
