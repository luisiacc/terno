import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IdbMailStore } from "@terno/idb";
import { SqlMailStore } from "@terno/db";
import type { MemDb } from "../../idb/src/mem";
import { IDBFactory } from "fake-indexeddb";
import { ProviderAuthError, ProviderError, type ProviderContext, type ProviderRegistry } from "@terno/mail";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as schema from "../../idb/src/schema";
import { Backend, plaintextCipher, type SecretCipher } from "./backend";
import { blobFingerprint, KEYCHAIN_STATE_KEY, SecretUnreadableError } from "./keychain";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.restoreAllMocks(); });
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  cleanup.push(async () => release());
  return { promise, release };
}
async function setup(kind: "SQL" | "IndexedDB") {
  const dir = mkdtempSync(join(tmpdir(), "terno-provider-secret-"));
  const factory = new IDBFactory();
  const platform = { uuid: () => crypto.randomUUID(), yield: turn };
  const store = kind === "IndexedDB" ? await IdbMailStore.open({ name: crypto.randomUUID(), factory, platform, instantSearch: false }) : undefined;
  const cipher: SecretCipher = { ...plaintextCipher };
  const logs: unknown[] = [];
  let ctx!: ProviderContext;
  const registry: ProviderRegistry = {
    create(context) { ctx = context; return { async verify() {}, async sync() {}, async execute() {}, async close() {} }; },
    async verifyImap() {}, async connectGmail() { throw new Error("unused"); },
  };
  const options = { dbPath: join(dir, "synthetic.db"), store, platform, version: "test", providers: registry, cipher, autoSync: false, instantSearch: false, iconTransport: null, log: (...args: unknown[]) => logs.push(args) };
  let backend = new Backend(options);
  const { account } = await backend.store.accounts.create({ kind: "imap", email: "synthetic@example.test", displayName: "Synthetic", color: "indigo", providerConfig: {}, now: 1 });
  const name = `account:${account.id}:password`;
  await backend.setSecret(name, "old");
  await backend.provider(account.id);
  cleanup.push(async () => { await backend.stop(); rmSync(dir, { recursive: true, force: true }); });
  return {
    get backend() { return backend; }, get ctx() { return ctx; }, cipher, name, account, logs,
    async reopen(blockLate = false) {
      await backend.stop();
      let late: ReturnType<typeof gate> | undefined;
      if (blockLate) {
        late = gate();
        const load = schema.loadAll;
        vi.spyOn(schema, "loadAll").mockImplementation(async (...args) => {
          if (args[3]?.includes("messages")) await late!.promise;
          return load(...args);
        });
      }
      const reopened = kind === "IndexedDB" ? await IdbMailStore.open({ name: store!.name, factory, platform, instantSearch: false }) : undefined;
      backend = new Backend({ ...options, store: reopened });
      await backend.provider(account.id);
      return { late, store: reopened };
    },
  };
}

describe.each(["SQL", "IndexedDB"] as const)("%s public provider secret replacement", (kind) => {
  it("persists before a scripted consumer can dispatch, supports reopen and equal ownership without encryption or rewrite", async () => {
    const t = await setup(kind);
    const encrypt = vi.spyOn(t.cipher, "encrypt");
    const replace = vi.spyOn(t.backend.store.secrets, "replace");
    const before = await t.backend.store.secrets.get(t.name);
    expect(await t.ctx.replaceSecret("password", "old", "old")).toBe(true);
    expect(encrypt).not.toHaveBeenCalled();
    expect(await t.backend.store.secrets.get(t.name)).toEqual(before);
    expect(replace).toHaveBeenCalledTimes(1);
    const entered = gate(), blocked = gate();
    const real = t.backend.store.secrets.replace.bind(t.backend.store.secrets);
    replace.mockImplementationOnce(async (...args) => { entered.release(); await blocked.promise; return real(...args); });
    let requests = 0;
    const consumer = (async () => { if (await t.ctx.replaceSecret("password", "old", "next")) requests++; })();
    await entered.promise;
    expect(requests).toBe(0);
    expect(await t.backend.getSecret(t.name)).toBe("old");
    blocked.release(); await consumer;
    expect(requests).toBe(1);
    await t.reopen();
    expect(await t.ctx.getSecret("password")).toBe("next");
    expect(await t.ctx.replaceSecret("password", "old", "stale")).toBe(false);
    await t.backend.store.secrets.delete(t.name);
    expect(await t.ctx.replaceSecret("password", "next", "stale")).toBe(false);
    expect(await t.backend.store.secrets.has(t.name)).toBe(false);
  });

  it.each(["decrypt", "encrypt", "CAS"] as const)("a newer owner/photo-like writer during blocked %s wins", async (stage) => {
    const t = await setup(kind);
    const entered = gate(), blocked = gate();
    if (stage === "CAS") {
      const real = t.backend.store.secrets.replace.bind(t.backend.store.secrets);
      vi.spyOn(t.backend.store.secrets, "replace").mockImplementationOnce(async (...args) => { entered.release(); await blocked.promise; return real(...args); });
    } else {
      const real = t.cipher[stage].bind(t.cipher);
      if (stage === "decrypt") vi.spyOn(t.cipher, "decrypt").mockImplementationOnce(async (blob) => { entered.release(); await blocked.promise; return (real as SecretCipher["decrypt"])(blob); });
      else vi.spyOn(t.cipher, "encrypt").mockImplementationOnce(async (plain) => { entered.release(); await blocked.promise; return (real as SecretCipher["encrypt"])(plain); });
    }
    const replacing = t.ctx.replaceSecret("password", "old", "rotated");
    await entered.promise;
    await t.backend.setSecret(t.name, "newer-owner-photo");
    blocked.release();
    expect(await replacing).toBe(false);
    expect(await t.backend.getSecret(t.name)).toBe("newer-owner-photo");
  });

  it.each(["decrypt", "encrypt"] as const)("removal during %s cannot leave an orphan, and reconnect preserves its new generation", async (stage) => {
    const t = await setup(kind);
    const entered = gate(), blocked = gate();
    if (stage === "decrypt") vi.spyOn(t.cipher, "decrypt").mockImplementationOnce(async (blob) => { entered.release(); await blocked.promise; return plaintextCipher.decrypt(blob); });
    else vi.spyOn(t.cipher, "encrypt").mockImplementationOnce(async (plain) => { entered.release(); await blocked.promise; return plaintextCipher.encrypt(plain); });
    const old = t.ctx;
    const replacing = Promise.allSettled([old.replaceSecret("password", "old", "stale")]);
    await entered.promise;
    await t.backend.dropAccount(t.account.id, { remove: true });
    await t.backend.store.accounts.remove(t.account.id);
    t.backend.accountRemoved(t.account.id);
    blocked.release();
    expect((await replacing)[0]).toMatchObject({ status: "rejected" });
    expect(await t.backend.store.secrets.has(t.name)).toBe(false);
    const fresh = await t.backend.store.accounts.create({ kind: "imap", email: t.account.email, displayName: "Fresh", color: "indigo", providerConfig: {}, now: 2 });
    await t.backend.provider(fresh.account.id);
    await t.ctx.setSecret("password", "fresh");
    await expect(old.replaceSecret("password", "old", "stale")).rejects.toThrow();
    expect(await t.ctx.getSecret("password")).toBe("fresh");
  });

  it("drop drains admitted CAS before reconnect; old completion cannot publish success", async () => {
    const t = await setup(kind);
    const entered = gate(), blocked = gate();
    const real = t.backend.store.secrets.replace.bind(t.backend.store.secrets);
    vi.spyOn(t.backend.store.secrets, "replace").mockImplementationOnce(async (...args) => { entered.release(); await blocked.promise; return real(...args); });
    const old = t.ctx;
    const replacing = Promise.allSettled([old.replaceSecret("password", "old", "rotated")]);
    await entered.promise;
    let dropped = false;
    const drop = t.backend.dropAccount(t.account.id).then(() => { dropped = true; });
    await turn(); expect(dropped).toBe(false);
    blocked.release(); await drop;
    expect((await replacing)[0]).toMatchObject({ status: "rejected" });
    await t.backend.setSecret(t.name, "reconnected");
    await t.backend.signedIn(t.account.id);
    await t.backend.provider(t.account.id);
    expect(await t.ctx.getSecret("password")).toBe("reconnected");
    await expect(old.replaceSecret("password", "rotated", "stale")).rejects.toThrow();
    expect(await t.ctx.replaceSecret("password", "reconnected", "reconnected")).toBe(true);
  });

  it("compares the exact randomized ciphertext snapshot when another writer stores the same plaintext", async () => {
    const t = await setup(kind);
    let serial = 0;
    t.cipher.encrypt = async (plain) => new TextEncoder().encode(`${++serial}:${plain}`);
    t.cipher.decrypt = async (blob) => new TextDecoder().decode(blob).replace(/^\d+:/, "");
    await t.backend.setSecret(t.name, "old");
    const entered = gate(), blocked = gate();
    const encrypt = t.cipher.encrypt;
    vi.spyOn(t.cipher, "encrypt").mockImplementationOnce(async (plain) => { entered.release(); await blocked.promise; return encrypt(plain); });
    const replacing = t.ctx.replaceSecret("password", "old", "rotated");
    await entered.promise;
    await t.backend.setSecret(t.name, "old");
    const newer = await t.backend.store.secrets.get(t.name);
    blocked.release();
    expect(await replacing).toBe(false);
    expect(await t.backend.store.secrets.get(t.name)).toEqual(newer);
  });

  it("does constant indexed account/secret work with 50,000 mailbox rows and leaves the search feed untouched", async () => {
    const t = await setup(kind);
    await t.backend.ready;
    const store = t.backend.store;
    const head = await store.feed.head();
    if (store instanceof SqlMailStore) {
      const trace = vi.spyOn(store.db, "prepare");
      expect(await t.ctx.replaceSecret("password", "old", "next")).toBe(true);
      const small = trace.mock.calls.map(([sql]) => sql);
      trace.mockRestore();
      store.db.tx(() => {
        for (let id = 1; id <= 50000; id++) {
          store.db.run("INSERT INTO threads(id, account_id) VALUES (?, ?)", id, t.account.id);
          store.db.run("INSERT INTO messages(id, account_id, thread_id, date) VALUES (?, ?, ?, 0)", id, t.account.id, id);
        }
      });
      const before = await store.feed.head();
      const large = vi.spyOn(store.db, "prepare");
      expect(await t.ctx.replaceSecret("password", "next", "old")).toBe(true);
      expect(large.mock.calls.map(([sql]) => sql)).toEqual(small);
      expect(small.some((sql) => /(?:FROM|JOIN) (?:messages|threads)\b/i.test(sql))).toBe(false);
      const cas = small.find((sql) => sql.startsWith("UPDATE secrets"))!;
      const plan = store.db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${cas}`, Uint8Array.of(1), t.name, Uint8Array.of(2), t.account.id, t.account.email, 1);
      expect(plan.map((r) => r.detail).join(" ")).toMatch(/SEARCH secrets USING PRIMARY KEY/);
      expect(plan.map((r) => r.detail).join(" ")).toMatch(/SEARCH accounts USING INTEGER PRIMARY KEY/);
      large.mockRestore();
      expect(await store.feed.head()).toEqual(before);
    } else {
      const db = (store as unknown as { db: MemDb }).db;
      const secrets = db.table("secrets"), accounts = db.table("accounts");
      const secretReads = vi.spyOn(secrets, "get"), accountReads = vi.spyOn(accounts, "get");
      expect(await t.ctx.replaceSecret("password", "old", "next")).toBe(true);
      const small = [secretReads.mock.calls.length, accountReads.mock.calls.length];
      secretReads.mockClear(); accountReads.mockClear();
      for (let id = 1; id <= 50000; id++) {
        db.table("threads").load({ id, account_id: t.account.id });
        db.table("messages").load({ id, account_id: t.account.id, thread_id: id });
      }
      const noScans = ["accounts", "secrets", "messages", "threads", "search_outbox"].map((table) => vi.spyOn(db.table(table), "all").mockImplementation(() => { throw new Error("unexpected scan"); }));
      expect(await t.ctx.replaceSecret("password", "next", "old")).toBe(true);
      expect([secretReads.mock.calls.length, accountReads.mock.calls.length]).toEqual(small);
      expect(small).toEqual([2, 1]);
      for (const scan of noScans) { expect(scan).not.toHaveBeenCalled(); scan.mockRestore(); }
      secretReads.mockRestore(); accountReads.mockRestore();
      expect(await store.feed.head()).toEqual(head);
    }
  });

  it("pending fingerprints never decrypt, keychain failure is auth, and raw cipher/storage errors never escape or log", async () => {
    const t = await setup(kind);
    const marker = "synthetic-private-token-address-subject";
    const blob = (await t.backend.store.secrets.get(t.name))!;
    await t.backend.store.settings.set(KEYCHAIN_STATE_KEY, { generation: "terno", pending: { [t.name]: blobFingerprint(blob) } });
    const decrypt = vi.spyOn(t.cipher, "decrypt");
    await expect(t.ctx.replaceSecret("password", "old", "next")).rejects.toBeInstanceOf(ProviderAuthError);
    expect(decrypt).not.toHaveBeenCalled();
    await t.backend.store.settings.set(KEYCHAIN_STATE_KEY, null);
    decrypt.mockRejectedValueOnce(new Error(marker));
    const unreadable = await t.ctx.replaceSecret("password", "old", "next").catch((e: unknown) => e);
    expect(unreadable).toBeInstanceOf(ProviderAuthError);
    expect(String(unreadable)).not.toContain(marker);
    vi.spyOn(t.cipher, "encrypt").mockRejectedValueOnce(new Error(marker));
    const encrypted = await t.ctx.replaceSecret("password", "old", "next").catch((e: unknown) => e);
    expect(encrypted).toBeInstanceOf(ProviderError);
    expect(encrypted).not.toBeInstanceOf(ProviderAuthError);
    expect(String(encrypted)).not.toContain(marker);
    vi.spyOn(t.backend.store.secrets, "replace").mockRejectedValueOnce(new Error(marker));
    const persisted = await t.ctx.replaceSecret("password", "old", "next").catch((e: unknown) => e);
    expect(persisted).toBeInstanceOf(ProviderError);
    expect(String(persisted)).not.toContain(marker);
    expect(JSON.stringify(t.logs)).not.toContain(marker);
    expect(await t.backend.getSecret(t.name)).toBe("old");
  });

  it("getSecret and getAppSecret never log raw keychain token/address/subject detail and preserve pending auth behavior", async () => {
    const t = await setup(kind);
    const markers = ["synthetic-private-refresh", "private-address@example.test", "Synthetic private subject"];
    const detail = markers.join(" / ");
    const appName = "gmailClientSecret";
    await t.backend.setSecret(appName, "synthetic-app");
    const cipher = vi.spyOn(t.cipher, "decrypt").mockRejectedValue(new Error(detail));
    const accountError = await t.ctx.getSecret("password").catch((error: unknown) => error);
    const appError = await t.ctx.getAppSecret(appName).catch((error: unknown) => error);
    expect(accountError).toBeInstanceOf(ProviderAuthError);
    expect(String(accountError)).toContain("keychain");
    expect(appError).toBeInstanceOf(SecretUnreadableError);
    expect(String(appError)).toContain("keychain");
    const exposed = JSON.stringify({ logs: t.logs, accountError: String(accountError), appError: String(appError) });
    for (const marker of markers) expect(exposed).not.toContain(marker);
    expect(t.logs.some((entry) => JSON.stringify(entry).includes("decrypt"))).toBe(true);
    cipher.mockClear();
    await t.backend.store.settings.set(KEYCHAIN_STATE_KEY, { generation: "terno", pending: {
      [t.name]: blobFingerprint((await t.backend.store.secrets.get(t.name))!),
      [appName]: blobFingerprint((await t.backend.store.secrets.get(appName))!),
    } });
    const count = t.logs.length;
    await expect(t.ctx.getSecret("password")).rejects.toBeInstanceOf(ProviderAuthError);
    await expect(t.ctx.getAppSecret(appName)).rejects.toMatchObject({ name: "SecretUnreadableError", legacy: true });
    expect(cipher).not.toHaveBeenCalled();
    expect(t.logs).toHaveLength(count);
  });

  it("aftercommit failure is confirmable via new-to-new without restoring old bytes", async () => {
    const t = await setup(kind);
    const real = t.backend.store.secrets.replace.bind(t.backend.store.secrets);
    vi.spyOn(t.backend.store.secrets, "replace").mockImplementationOnce(async (...args) => { await real(...args); throw new Error("synthetic uncertain acknowledgement"); });
    await expect(t.ctx.replaceSecret("password", "old", "next")).rejects.toBeInstanceOf(ProviderError);
    await t.reopen();
    expect(await t.ctx.replaceSecret("password", "next", "next")).toBe(true);
    expect(await t.ctx.replaceSecret("password", "old", "next")).toBe(false);
    expect(await t.ctx.getSecret("password")).toBe("next");
  });
});

it("the complete IndexedDB provider wrapper asserts stamp and persists while late tables remain blocked", async () => {
  const t = await setup("IndexedDB");
  const { late, store } = await t.reopen(true);
  let loaded = false;
  void store!.whenLoaded().then(() => { loaded = true; });
  expect(await t.ctx.replaceSecret("password", "old", "next")).toBe(true);
  expect(await t.ctx.replaceSecret("password", "next", "next")).toBe(true);
  expect(await t.ctx.getSecret("password")).toBe("next");
  expect(loaded).toBe(false);
  late!.release(); await store!.whenLoaded();
});
