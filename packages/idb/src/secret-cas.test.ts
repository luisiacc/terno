import "fake-indexeddb/auto";
import { IDBDatabase } from "fake-indexeddb";
import { afterEach, expect, it, vi } from "vitest";
import { IdbMailStore } from "./store";

const opened: IdbMailStore[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const s of opened.splice(0)) await s.close(); });
const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setTimeout(resolve, 0)) };
const open = async (name: string = crypto.randomUUID()) => { const s = await IdbMailStore.open({ name, factory: indexedDB, platform, instantSearch: false }); opened.push(s); return s; };

it("secret CAS rolls memory and disk back on abort, persists on reopen, and ownership assertions issue no write", async () => {
  let store = await open();
  await store.secrets.put("synthetic", Uint8Array.of(1));
  const transaction = IDBDatabase.prototype.transaction;
  const txs = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args) {
    const tx = transaction.call(this, ...args);
    if (args[1] === "readwrite") queueMicrotask(() => tx.abort());
    return tx;
  });
  await expect(store.secrets.replace("synthetic", Uint8Array.of(1), Uint8Array.of(2))).rejects.toThrow();
  expect(await store.secrets.get("synthetic")).toEqual(Uint8Array.of(1));
  txs.mockRestore();
  await store.close();
  store = await open(store.name);
  expect(await store.secrets.get("synthetic")).toEqual(Uint8Array.of(1));
  expect(await store.secrets.replace("synthetic", Uint8Array.of(1), Uint8Array.of(2))).toBe(true);
  await store.close();
  store = await open(store.name);
  const writes = vi.spyOn(IDBDatabase.prototype, "transaction");
  expect(await store.secrets.replace("synthetic", Uint8Array.of(2), Uint8Array.of(2))).toBe(true);
  expect(await store.secrets.replace("synthetic", Uint8Array.of(1), Uint8Array.of(1))).toBe(false);
  expect(writes.mock.calls.filter((args) => args[1] === "readwrite")).toEqual([]);
});

it("Google pin and credential admission is conditional and durable across reopen", async () => {
  let store = await open();
  const { googleIdentityAdmission } = await import("../../store/src/conformance/google-identity");
  const { stamp, name } = await googleIdentityAdmission(store);
  await store.close(); store = await open(store.name);
  expect((await store.accounts.config<Record<string, unknown>>(stamp.id))!.config.googleSubject).toBe("first");
  expect(await store.secrets.get(name)).toEqual(Uint8Array.of(2));
  const transaction = IDBDatabase.prototype.transaction;
  const spy = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args) {
    const tx = transaction.call(this, ...args);
    if (args[1] === "readwrite") queueMicrotask(() => tx.abort());
    return tx;
  });
  await expect(store.secrets.commit({ kind: "replace", name, expectedBlob: Uint8Array.of(2), blob: Uint8Array.of(3), google: { expectedSubject: "first", subject: "first" } }, stamp)).rejects.toThrow();
  spy.mockRestore();
  expect(await store.secrets.get(name)).toEqual(Uint8Array.of(2));
});

it("a Google first pin superseded during persistence preparation rolls back both memory and disk", async () => {
  let store = await open();
  const { account } = await store.accounts.create({ kind: "gmail", email: "legacy@example.test", displayName: "Legacy", color: "indigo", providerConfig: { cursor: "keep" }, secret: { key: "refreshToken", blob: Uint8Array.of(1) }, now: 1 });
  const stamp = (await store.accounts.stamp(account.id))!, name = `account:${account.id}:refreshToken`;
  let eligible = true;
  const take = store["db"].takeCommit.bind(store["db"]);
  const spy = vi.spyOn(store["db"], "takeCommit").mockImplementationOnce(() => { const commit = take(); queueMicrotask(() => { eligible = false; }); return commit; });
  expect(await store.secrets.commit({ kind: "replace", name, expectedBlob: Uint8Array.of(1), blob: Uint8Array.of(2), google: { expectedSubject: null, subject: "first", eligible: () => eligible } }, stamp)).toBe(false);
  spy.mockRestore();
  expect((await store.accounts.config(account.id))!.config).toEqual({ cursor: "keep" });
  expect(await store.secrets.get(name)).toEqual(Uint8Array.of(1));
  await store.close(); store = await open(store.name);
  expect((await store.accounts.config(account.id))!.config).toEqual({ cursor: "keep" });
  expect(await store.secrets.get(name)).toEqual(Uint8Array.of(1));
});

it("owner proof expiry during persistence preparation rolls back pin, credential and owner history", async () => {
  let store = await open();
  const claim = { displayName: "Reader", provider: "gmail" as const, verifiedBy: "google_oauth" as const, evidence: { googleSub: "first", emailVerified: true } };
  await store.accounts.create({ kind: "gmail", email: "owner@example.test", displayName: "Owner", color: "indigo", ownerClaim: claim, now: 1 });
  const { account } = await store.accounts.create({ kind: "gmail", email: "target@example.test", displayName: "Target", color: "indigo", providerConfig: { cursor: "keep" }, secret: { key: "refreshToken", blob: Uint8Array.of(1) }, now: 2 });
  const stamp = (await store.accounts.stamp(account.id))!, name = `account:${account.id}:refreshToken`, owner = await store.owner.get();
  let now = 1;
  const take = store["db"].takeCommit.bind(store["db"]);
  const spy = vi.spyOn(store["db"], "takeCommit").mockImplementationOnce(() => { const commit = take(); queueMicrotask(() => { now = 3; }); return commit; });
  expect(await store.owner.change({ claim: { ...claim, accountId: account.id, email: account.email }, stamp, secret: { kind: "replace", name, expectedBlob: Uint8Array.of(1), blob: Uint8Array.of(2), google: { expectedSubject: null, subject: "first", eligible: () => true } }, eligible: () => now < 2, reason: "synthetic", now: 3 })).toBe(false);
  spy.mockRestore();
  await store.close(); store = await open(store.name);
  expect(await store.owner.get()).toEqual(owner);
  expect((await store.accounts.config(account.id))!.config).toEqual({ cursor: "keep" });
  expect(await store.secrets.get(name)).toEqual(Uint8Array.of(1));
  const request = indexedDB.open(`terno-${store.name}`);
  const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result as unknown as IDBDatabase); request.onerror = () => reject(request.error); });
  try {
    const rows = db.transaction("owner_history").objectStore("owner_history").getAll();
    expect(await new Promise((resolve, reject) => { rows.onsuccess = () => resolve(rows.result); rows.onerror = () => reject(rows.error); })).toEqual([]);
  } finally { db.close(); }
});
