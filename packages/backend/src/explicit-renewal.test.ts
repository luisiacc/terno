import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { IdbMailStore } from "@terno/idb";
import { IDBFactory } from "fake-indexeddb";
import { ProviderAuthError, type GmailConnectResult, type GmailRenewalProof, type ProviderRegistry } from "@terno/mail";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { setGooglePhotoState } from "./settings";

const MAIL = "https://www.googleapis.com/auth/gmail.modify";
const PHOTO = "https://www.googleapis.com/auth/contacts.readonly";
const who = { email: "reader@example.test", name: "Reader", sub: "reader-sub", emailVerified: true, grantedScopes: [MAIL, PHOTO] };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const fn of cleanups.splice(0).reverse()) await fn(); });
function gate() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }
const outcome = <T,>(p: Promise<T>) => p.then((value) => ({ value }), (error: unknown) => ({ error }));
async function setup(kind: "SQL" | "IndexedDB") {
  const gates: ReturnType<typeof gate>[] = [];
  const logs: unknown[] = [];
  let answer: GmailConnectResult = { ...who, refreshToken: "old-refresh" };
  const inspect = vi.fn(async () => ({ ...who }));
  const photos = vi.fn(async (scopes: readonly string[]) => [...scopes]);
  let proofToken = "old-refresh";
  const begin = vi.fn<NonNullable<ProviderRegistry["beginGmailRenewal"]>>(async (): Promise<GmailRenewalProof> => ({ scopeSource: "resource-proof", refreshToken: proofToken, expiresAt: Date.now() + 3600_000, inspect, provePhotos: photos }));
  const connect = vi.fn<ProviderRegistry["connectGmail"]>(async () => answer);
  const instances: { closes: number; syncs: number }[] = [];
  const registry: ProviderRegistry = {
    connectGmail: connect, beginGmailRenewal: begin, async verifyImap() {},
    create() { const p = { closes: 0, syncs: 0 }; instances.push(p); return { async verify() {}, async execute() {}, async sync() { p.syncs++; }, async close() { p.closes++; }, async photos() { return { own: null, contacts: [], connections: "ok", otherContacts: "skipped" }; } }; },
  };
  const dir = mkdtempSync(join(tmpdir(), "terno-explicit-renewal-"));
  const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((r) => setImmediate(r)) };
  const store = kind === "IndexedDB" ? await IdbMailStore.open({ name: "synthetic-renewal", factory: new IDBFactory(), platform }) : undefined;
  const encrypt = vi.fn(plaintextCipher.encrypt), decrypt = vi.fn(plaintextCipher.decrypt);
  const backend = new Backend({ dbPath: join(dir, "test.db"), store, platform: store ? platform : undefined, version: "test", log: (...args) => { logs.push(args); }, cipher: { encrypt, decrypt }, providers: registry, autoSync: false, iconTransport: null, openExternal: async () => {} });
  const [c, s] = createMemoryTransportPair(); backend.connect(s, { clientId: "renewal", origin: "renderer" }); const client = new RpcClient(c);
  cleanups.push(async () => { for (const g of gates) g.release(); client.close(); await backend.stop(); rmSync(dir, { recursive: true, force: true }); });
  await client.call("settings.update", { gmailClientId: "synthetic-client" });
  answer = { ...who, email: "owner@example.test", sub: "owner-sub", refreshToken: "owner-refresh" };
  await client.call("accounts.connectGmail", {});
  answer = { ...who, refreshToken: "old-refresh" };
  const account = await client.call("accounts.connectGmail", {});
  await backend.syncAccount(account.id);
  const name = `account:${account.id}:refreshToken`;
  return { backend, client, account, name, logs, registry, connect, begin, inspect, photos, encrypt, decrypt, instances,
    answer(value: Partial<GmailConnectResult>) { answer = { ...who, refreshToken: null, ...value }; }, rotate(value: string) { proofToken = value; },
    gate() { const g = gate(); gates.push(g); return g; },
    async mark() { await new Promise<void>((r) => setImmediate(r)); await backend.syncAccount(account.id); await backend.store.accounts.setSyncState(account.id, { status: "error", authRequired: true, lastError: "preserved failure", authScope: null }); },
  };
}

describe.each(["SQL", "IndexedDB"] as const)("%s deliberate credential renewal", (kind) => {
  it("initial omission and malformed present values save no new account", async () => {
    const t = await setup(kind); const before = (await t.client.call("app.bootstrap", {})).accounts.map((a) => ({ id: a.id, email: a.email }));
    for (const refreshToken of [null, undefined, "", 123]) {
      t.answer({ refreshToken } as Partial<GmailConnectResult>);
      await expect(t.client.call("accounts.connectGmail", {})).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect((await t.client.call("app.bootstrap", {})).accounts.map((a) => ({ id: a.id, email: a.email }))).toEqual(before);
  });

  it.each(["accounts.reconnect", "identity.changeOwner", "icons.googlePhotos"] as const)("%s retains exact old blob only after cold proof", async (method) => {
    const t = await setup(kind); await t.mark(); const before = await t.backend.store.secrets.get(t.name);
    t.answer({ refreshToken: null });
    if (method === "accounts.reconnect") await t.client.call(method, { id: t.account.id });
    if (method === "identity.changeOwner") await t.client.call(method, { accountId: t.account.id });
    if (method === "icons.googlePhotos") await t.client.call(method, { accountId: t.account.id, on: true });
    expect(t.begin).toHaveBeenCalledOnce(); expect(t.begin.mock.calls[0]![0]).toMatchObject({ refreshToken: "old-refresh" });
    expect(t.inspect).toHaveBeenCalledOnce(); expect(await t.backend.store.secrets.get(t.name)).toEqual(before);
    expect((await t.backend.store.accounts.get(t.account.id))?.syncState.authRequired).toBe(false);
    if (method === "icons.googlePhotos") expect(t.photos).toHaveBeenCalledWith([PHOTO], expect.any(AbortSignal));
  });

  it.each(["missing", "unreadable", "refused", "wrong mailbox", "wrong subject", "unsupported"] as const)("omission fails safely for %s old grant", async (scenario) => {
    const t = await setup(kind); await t.mark(); t.answer({ refreshToken: null });
    if (scenario === "missing") await t.backend.store.secrets.delete(t.name);
    if (scenario === "unreadable") t.decrypt.mockRejectedValue(new Error("PRIVATE_REFRESH_ADDRESS_SUBJECT"));
    if (scenario === "refused") t.begin.mockRejectedValue(new ProviderAuthError("synthetic refusal"));
    if (scenario === "wrong mailbox") t.inspect.mockResolvedValue({ ...who, email: "other@example.test" });
    if (scenario === "wrong subject") t.inspect.mockResolvedValue({ ...who, sub: "other-sub" });
    if (scenario === "unsupported") delete t.registry.beginGmailRenewal;
    const result = await outcome(t.client.call("accounts.reconnect", { id: t.account.id }));
    expect(result).toHaveProperty("error"); expect(String("error" in result ? result.error : result)).not.toContain("PRIVATE_REFRESH_ADDRESS_SUBJECT");
    expect((await t.backend.store.accounts.get(t.account.id))?.syncState).toMatchObject({ authRequired: true, lastError: "preserved failure" });
    expect(await t.backend.provider(t.account.id)).not.toBeNull();
  });

  it("returned rotation commits before reconnect success", async () => {
    const t = await setup(kind); t.answer({ refreshToken: null }); t.rotate("rotated-refresh");
    await t.client.call("accounts.reconnect", { id: t.account.id });
    expect(await t.backend.getSecret(t.name)).toBe("rotated-refresh");
    expect(t.begin).toHaveBeenCalledOnce();
  });

  it("mail-proven rotation survives denied optional photo proof, without enabling or clearing auth", async () => {
    const t = await setup(kind); await t.mark(); t.answer({ refreshToken: null }); t.rotate("rotated-refresh");
    t.photos.mockRejectedValue(new Error("PRIVATE_PHOTO_TOKEN"));
    const result = await outcome(t.client.call("icons.googlePhotos", { accountId: t.account.id, on: true }));
    expect(result).toHaveProperty("error"); expect(String("error" in result ? result.error : result)).not.toContain("PRIVATE_PHOTO_TOKEN");
    expect(await t.backend.getSecret(t.name)).toBe("rotated-refresh");
    expect((await t.client.call("app.bootstrap", {})).settings.googlePhotos).toEqual({});
    expect((await t.backend.store.accounts.get(t.account.id))?.syncState.authRequired).toBe(true);
    expect(await t.backend.provider(t.account.id)).not.toBeNull();
  });

  it.each(["before", "after"] as const)("failed %s-commit persistence retries one candidate without spending old refresh again", async (stage) => {
    const t = await setup(kind); t.answer({ refreshToken: null }); t.rotate("rotated-refresh");
    const original = t.backend.store.secrets.commit.bind(t.backend.store.secrets);
    vi.spyOn(t.backend.store.secrets, "commit").mockImplementationOnce(async (...args) => { if (stage === "after") await original(...args); throw new Error("PRIVATE_STORAGE_TOKEN"); });
    await expect(t.client.call("accounts.reconnect", { id: t.account.id })).rejects.toThrow();
    await t.client.call("accounts.reconnect", { id: t.account.id });
    expect(t.begin).toHaveBeenCalledOnce(); expect(await t.backend.getSecret(t.name)).toBe("rotated-refresh");
  });

  it.each(["reconnect", "owner", "photo-on", "photo-off", "removal"] as const)("a blocked photo consent loses to newer %s", async (newer) => {
    const t = await setup(kind); const entered = t.gate(), blocked = t.gate();
    t.connect.mockImplementationOnce(async () => { entered.release(); await blocked.promise; return { ...who, refreshToken: "stale-photo" }; });
    const old = outcome(t.client.call("icons.googlePhotos", { accountId: t.account.id, on: true })); await entered.promise;
    t.answer({ refreshToken: "newer-refresh" });
    if (newer === "reconnect") await t.client.call("accounts.reconnect", { id: t.account.id });
    if (newer === "owner") await t.client.call("identity.changeOwner", { accountId: t.account.id });
    if (newer === "photo-on") await t.client.call("icons.googlePhotos", { accountId: t.account.id, on: true });
    if (newer === "photo-off") await t.client.call("icons.googlePhotos", { accountId: t.account.id, on: false });
    if (newer === "removal") await t.client.call("accounts.remove", { id: t.account.id });
    blocked.release(); expect(await old).toHaveProperty("error");
    expect(await t.backend.getSecret(t.name)).toBe(newer === "removal" ? null : newer === "photo-off" ? "old-refresh" : "newer-refresh");
    if (newer === "photo-off") expect((await t.client.call("app.bootstrap", {})).settings.googlePhotos).toEqual({});
  });

  it.each(["reconnect", "owner", "photo-on"] as const)("newer %s wins while older reconnect encrypts", async (newer) => {
    const t = await setup(kind); const entered = t.gate(), blocked = t.gate();
    t.encrypt.mockImplementationOnce(async (value) => { entered.release(); await blocked.promise; return plaintextCipher.encrypt(value); });
    t.answer({ refreshToken: "stale-refresh" }); const old = outcome(t.client.call("accounts.reconnect", { id: t.account.id })); await entered.promise;
    t.answer({ refreshToken: "newer-refresh" });
    if (newer === "reconnect") await t.client.call("accounts.reconnect", { id: t.account.id });
    if (newer === "owner") await t.client.call("identity.changeOwner", { accountId: t.account.id });
    if (newer === "photo-on") await t.client.call("icons.googlePhotos", { accountId: t.account.id, on: true });
    blocked.release(); expect(await old).toHaveProperty("error"); expect(await t.backend.getSecret(t.name)).toBe("newer-refresh");
  });

  it.each(["commit", "signedIn lookup"] as const)("a newer reconnect owns finalization during old %s", async (stage) => {
    const t = await setup(kind); const entered = t.gate(), blocked = t.gate(), newerAnswered = t.gate();
    if (stage === "commit") {
      const commit = t.backend.store.secrets.commit.bind(t.backend.store.secrets);
      vi.spyOn(t.backend.store.secrets, "commit").mockImplementationOnce(async (...args) => { entered.release(); await blocked.promise; return commit(...args); });
    } else {
      const signedIn = t.backend.signedIn.bind(t.backend);
      vi.spyOn(t.backend, "signedIn").mockImplementationOnce(async (...args) => {
        const get = t.backend.store.accounts.get.bind(t.backend.store.accounts);
        vi.spyOn(t.backend.store.accounts, "get").mockImplementationOnce(async (id) => { const value = await get(id); entered.release(); await blocked.promise; return value; });
        return signedIn(...args);
      });
    }
    t.answer({ refreshToken: "stale-refresh" }); const old = outcome(t.client.call("accounts.reconnect", { id: t.account.id })); await entered.promise;
    t.connect.mockImplementationOnce(async () => { newerAnswered.release(); return { ...who, refreshToken: "newer-refresh" }; });
    const newer = outcome(t.client.call("accounts.reconnect", { id: t.account.id })); await newerAnswered.promise;
    blocked.release(); expect(await old).toHaveProperty("error"); expect(await newer).toHaveProperty("value");
    expect(await t.backend.getSecret(t.name)).toBe("newer-refresh");
    expect((await t.backend.store.accounts.get(t.account.id))?.syncState.authRequired).toBe(false);
  });

  it("old photo-on cannot enable after off during admitted settings persistence", async () => {
    const t = await setup(kind), entered = t.gate(), blocked = t.gate();
    const update = t.backend.store.settings.update.bind(t.backend.store.settings);
    vi.spyOn(t.backend.store.settings, "update").mockImplementationOnce(async (...args) => { entered.release(); await blocked.promise; return update(...args); });
    t.answer({ refreshToken: "photo-refresh" });
    const old = outcome(t.client.call("icons.googlePhotos", { accountId: t.account.id, on: true })); await entered.promise;
    const off = outcome(t.client.call("icons.googlePhotos", { accountId: t.account.id, on: false }));
    await new Promise<void>((r) => setImmediate(r)); blocked.release();
    expect(await old).toHaveProperty("error"); expect(await off).toHaveProperty("value");
    expect((await t.client.call("app.bootstrap", {})).settings.googlePhotos).toEqual({});
  });

  it("stamp change during proof never saves rotation or claims owner", async () => {
    const t = await setup(kind); t.answer({ refreshToken: null }); t.rotate("rotated-refresh");
    t.inspect.mockImplementationOnce(async () => { await t.backend.store.accounts.remove(t.account.id); return { ...who }; });
    const before = await t.backend.store.owner.get();
    await expect(t.client.call("identity.changeOwner", { accountId: t.account.id })).rejects.toThrow();
    expect(await t.backend.store.secrets.get(t.name)).toBeNull(); expect(await t.backend.store.owner.get()).toEqual(before);
  });

  it("persistence failure after drop restores the existing provider generation without false sign-in", async () => {
    const t = await setup(kind); await t.mark(); t.answer({ refreshToken: "new-refresh" });
    vi.spyOn(t.backend.store.secrets, "commit").mockRejectedValueOnce(new Error("PRIVATE_DISK_SECRET"));
    const result = await outcome(t.client.call("accounts.reconnect", { id: t.account.id }));
    expect(result).toHaveProperty("error"); expect(String("error" in result ? result.error : result)).not.toContain("PRIVATE_DISK_SECRET");
    expect((await t.backend.store.accounts.get(t.account.id))?.syncState).toMatchObject({ authRequired: true, lastError: "preserved failure" });
    expect(await t.backend.provider(t.account.id)).not.toBeNull(); expect(await t.backend.getSecret(t.name)).toBe("old-refresh");
  });

  it("a malformed renewed registry credential cannot bypass normalization", async () => {
    const t = await setup(kind);
    for (const refreshToken of [undefined, "", 12]) {
      t.answer({ refreshToken } as Partial<GmailConnectResult>);
      await expect(t.client.call("accounts.reconnect", { id: t.account.id })).rejects.toThrow();
    }
    expect(await t.backend.getSecret(t.name)).toBe("old-refresh"); expect(t.begin).not.toHaveBeenCalled();
  });

  it("a verified pending candidate cannot bless a different renewed subject", async () => {
    const t = await setup(kind); t.answer({ refreshToken: null }); t.rotate("rotated-refresh");
    vi.spyOn(t.backend.store.secrets, "commit").mockRejectedValueOnce(new Error("synthetic disk failure"));
    await expect(t.client.call("accounts.reconnect", { id: t.account.id })).rejects.toThrow();
    t.answer({ refreshToken: null, sub: "different-subject" });
    await expect(t.client.call("accounts.reconnect", { id: t.account.id })).rejects.toThrow();
    expect(await t.backend.getSecret(t.name)).toBe("old-refresh");
  });

  it("an expired known candidate may recover its credential but cannot partially claim owner", async () => {
    const t = await setup(kind); t.answer({ refreshToken: null }); t.rotate("rotated-refresh");
    const proof: GmailRenewalProof = { scopeSource: "resource-proof", refreshToken: "rotated-refresh", expiresAt: Date.now() + 3600_000, inspect: t.inspect, provePhotos: t.photos };
    t.begin.mockResolvedValueOnce(proof);
    vi.spyOn(t.backend.store.secrets, "commit").mockRejectedValueOnce(new Error("synthetic disk failure"));
    await expect(t.client.call("accounts.reconnect", { id: t.account.id })).rejects.toThrow();
    Object.assign(proof, { expiresAt: 0 }); const owner = await t.backend.store.owner.get();
    await expect(t.client.call("identity.changeOwner", { accountId: t.account.id })).rejects.toThrow();
    expect(await t.backend.store.owner.get()).toEqual(owner); expect(await t.backend.getSecret(t.name)).toBe("rotated-refresh");
    await t.client.call("accounts.reconnect", { id: t.account.id });
    expect(t.begin).toHaveBeenCalledTimes(2);
  });

  it.each(["reconnect", "owner", "photo"] as const)("%s never returns private encryption exception text", async (method) => {
    const t = await setup(kind); t.answer({ refreshToken: "new-refresh" });
    t.encrypt.mockRejectedValueOnce(new Error("PRIVATE_REFRESH_ADDRESS_SUBJECT"));
    const result = await outcome<unknown>(method === "reconnect" ? t.client.call("accounts.reconnect", { id: t.account.id }) : method === "owner" ? t.client.call("identity.changeOwner", { accountId: t.account.id }) : t.client.call("icons.googlePhotos", { accountId: t.account.id, on: true }));
    expect(result).toHaveProperty("error"); expect(String("error" in result ? result.error : result)).not.toContain("PRIVATE_REFRESH_ADDRESS_SUBJECT");
    expect(await t.backend.getSecret(t.name)).toBe("old-refresh");
    expect(JSON.stringify(t.logs)).not.toContain("PRIVATE_REFRESH_ADDRESS_SUBJECT");
  });

  it("photo renewal requires explicit effective mail scope", async () => {
    const t = await setup(kind); t.answer({ refreshToken: "new-refresh", grantedScopes: undefined });
    await expect(t.client.call("icons.googlePhotos", { accountId: t.account.id, on: true })).rejects.toThrow();
    expect(await t.backend.getSecret(t.name)).toBe("old-refresh");
  });

  it("raw credential snapshot failures never expose private store text", async () => {
    const t = await setup(kind); t.answer({ refreshToken: null });
    const get = t.backend.store.secrets.get.bind(t.backend.store.secrets);
    vi.spyOn(t.backend.store.secrets, "get").mockImplementation(async (name) => { if (name === t.name) throw new Error("PRIVATE_STORE_REFRESH"); return get(name); });
    const result = await outcome(t.client.call("accounts.reconnect", { id: t.account.id }));
    expect(result).toHaveProperty("error"); expect(String("error" in result ? result.error : result)).not.toContain("PRIVATE_STORE_REFRESH");
  });

  it("a known exchange retries failed identity proof without spending the old grant twice", async () => {
    const t = await setup(kind); t.answer({ refreshToken: null }); t.rotate("rotated-refresh");
    t.inspect.mockRejectedValueOnce(new Error("PRIVATE_PROFILE_TOKEN"));
    const first = await outcome(t.client.call("accounts.reconnect", { id: t.account.id }));
    expect(first).toHaveProperty("error"); expect(String("error" in first ? first.error : first)).not.toContain("PRIVATE_PROFILE_TOKEN");
    expect(await t.backend.getSecret(t.name)).toBe("old-refresh");
    await t.client.call("accounts.reconnect", { id: t.account.id });
    expect(t.begin).toHaveBeenCalledOnce(); expect(t.inspect).toHaveBeenCalledTimes(2); expect(await t.backend.getSecret(t.name)).toBe("rotated-refresh");
    expect(JSON.stringify(t.logs)).not.toContain("PRIVATE_PROFILE_TOKEN");
  });

  it("photo failure plus storage failure keeps one mail-proven candidate for an explicit reconnect", async () => {
    const t = await setup(kind); t.answer({ refreshToken: null }); t.rotate("rotated-refresh");
    t.photos.mockRejectedValueOnce(new Error("synthetic photo denied"));
    vi.spyOn(t.backend.store.secrets, "commit").mockRejectedValueOnce(new Error("synthetic disk failure"));
    await expect(t.client.call("icons.googlePhotos", { accountId: t.account.id, on: true })).rejects.toThrow();
    await t.client.call("accounts.reconnect", { id: t.account.id });
    expect(t.begin).toHaveBeenCalledOnce(); expect(t.photos).toHaveBeenCalledOnce(); expect(await t.backend.getSecret(t.name)).toBe("rotated-refresh");
    expect((await t.client.call("app.bootstrap", {})).settings.googlePhotos).toEqual({});
  });

  it("removal drains an admitted explicit commit and never leaves an orphan credential", async () => {
    const t = await setup(kind); t.answer({ refreshToken: "new-refresh" });
    const entered = t.gate(), blocked = t.gate();
    const commit = t.backend.store.secrets.commit.bind(t.backend.store.secrets);
    vi.spyOn(t.backend.store.secrets, "commit").mockImplementationOnce(async (...args) => { entered.release(); await blocked.promise; return commit(...args); });
    const old = outcome(t.client.call("accounts.reconnect", { id: t.account.id })); await entered.promise;
    const removing = outcome(t.client.call("accounts.remove", { id: t.account.id }));
    await new Promise<void>((r) => setImmediate(r));
    expect(await t.backend.store.accounts.get(t.account.id)).not.toBeNull();
    blocked.release(); expect(await old).toHaveProperty("error"); expect(await removing).toHaveProperty("value");
    expect(await t.backend.store.accounts.get(t.account.id)).toBeNull(); expect(await t.backend.store.secrets.get(t.name)).toBeNull();
  });

  it("a public owner change that loses its secret CAS cannot claim owner", async () => {
    const t = await setup(kind); t.answer({ refreshToken: "owner-replacement" }); const owner = await t.backend.store.owner.get();
    const change = t.backend.store.owner.change.bind(t.backend.store.owner);
    vi.spyOn(t.backend.store.owner, "change").mockImplementationOnce(async (request) => { await t.backend.store.secrets.put(t.name, await plaintextCipher.encrypt("newer-secret")); return change(request); });
    await expect(t.client.call("identity.changeOwner", { accountId: t.account.id })).rejects.toThrow();
    expect(await t.backend.store.owner.get()).toEqual(owner); expect(await t.backend.getSecret(t.name)).toBe("newer-secret");
  });

  it("photo-off cancels a pending final listing before waiting for old finalization", async () => {
    const t = await setup(kind); t.answer({ refreshToken: "photo-refresh" }); const entered = t.gate();
    let photoSignal: AbortSignal | undefined;
    const create = t.registry.create.bind(t.registry);
    vi.spyOn(t.registry, "create").mockImplementation((ctx) => ({ ...create(ctx), photos: async (_want, signal) => {
      photoSignal = signal; entered.release();
      await new Promise<void>((resolve) => { if (signal?.aborted) resolve(); else signal?.addEventListener("abort", () => resolve(), { once: true }); });
      return { own: null, contacts: [], connections: "ok", otherContacts: "skipped" };
    } }));
    const old = outcome(t.client.call("icons.googlePhotos", { accountId: t.account.id, on: true })); await entered.promise;
    const off = outcome(t.client.call("icons.googlePhotos", { accountId: t.account.id, on: false }));
    await new Promise<void>((r) => setImmediate(r));
    const cancelled = photoSignal!.aborted;
    // Release even the pre-fix implementation so the regression fails without a stuck test/process.
    if (!cancelled) await t.backend.icons.dropPhotos(t.account.id);
    expect(await old).toHaveProperty("error"); expect(await off).toHaveProperty("value");
    expect(cancelled).toBe(true); expect((await t.client.call("app.bootstrap", {})).settings.googlePhotos).toEqual({});
  });

  it.each(["photo-off", "removal"] as const)("%s finishes while the old provider ignores listing cancellation", async (intent) => {
    const t = await setup(kind); t.answer({ refreshToken: "photo-refresh" }); const entered = t.gate(), blocked = t.gate();
    const create = t.registry.create.bind(t.registry);
    vi.spyOn(t.registry, "create").mockImplementation((ctx) => ({ ...create(ctx), photos: async () => {
      entered.release(); await blocked.promise;
      return { own: null, contacts: [], connections: "denied", otherContacts: "skipped" };
    } }));
    const old = outcome(t.client.call("icons.googlePhotos", { accountId: t.account.id, on: true })); await entered.promise;
    let settled = false;
    const newer = outcome<unknown>(intent === "photo-off" ? t.client.call("icons.googlePhotos", { accountId: t.account.id, on: false }) : t.client.call("accounts.remove", { id: t.account.id })).then((value) => { settled = true; return value; });
    for (let i = 0; i < 30 && !settled; i++) await new Promise<void>((r) => setImmediate(r));
    const finishedBeforeNetwork = settled;
    blocked.release(); expect(await old).toHaveProperty("error"); expect(await newer).toHaveProperty("value");
    expect(finishedBeforeNetwork).toBe(true); expect((await t.client.call("app.bootstrap", {})).settings.googlePhotos).toEqual({});
  });

  it("old photo completion and cleanup preserve a newer coalesced listing", async () => {
    const t = await setup(kind), firstEntered = t.gate(), secondEntered = t.gate(), firstBlocked = t.gate(), secondBlocked = t.gate();
    const state = { connections: true, otherContacts: false, apiDisabled: false };
    await setGooglePhotoState(t.backend.store, t.account.id, state);
    const provider = (await t.backend.provider(t.account.id))!;
    let calls = 0, newerSignal: AbortSignal | undefined;
    provider.photos = async (_want, signal) => {
      if (++calls === 1) { firstEntered.release(); await firstBlocked.promise; }
      else { newerSignal = signal; secondEntered.release(); await secondBlocked.promise; }
      return { own: null, contacts: [], connections: "ok", otherContacts: "skipped" };
    };
    const sibling = (await t.backend.store.accounts.list()).find((account) => account.id !== t.account.id)!;
    await setGooglePhotoState(t.backend.store, sibling.id, state);
    const siblingEntered = t.gate(), siblingBlocked = t.gate();
    const siblingProvider = (await t.backend.provider(sibling.id))!;
    let siblingSignal: AbortSignal | undefined;
    siblingProvider.photos = async (_want, signal) => {
      siblingSignal = signal; siblingEntered.release(); await siblingBlocked.promise;
      return { own: null, contacts: [], connections: "ok", otherContacts: "skipped" };
    };
    const siblingRun = t.backend.icons.syncPeople(sibling.id, state, new AbortController().signal); await siblingEntered.promise;
    const firstController = new AbortController(), secondController = new AbortController();
    const old = t.backend.icons.syncPeople(t.account.id, state, firstController.signal); await firstEntered.promise;
    const newer = t.backend.icons.syncPeople(t.account.id, state, secondController.signal); await secondEntered.promise;
    await old; firstController.abort(); firstBlocked.release(); await new Promise<void>((r) => setImmediate(r));
    expect(newerSignal!.aborted).toBe(false); expect(t.backend.icons.syncPeople(t.account.id, state)).toBe(newer);
    expect(siblingSignal!.aborted).toBe(false);
    expect(t.backend.icons.syncPeople(sibling.id, state)).toBe(siblingRun);
    secondBlocked.release(); siblingBlocked.release(); await Promise.all([newer, siblingRun]);
  });

  it("stale owner secret expectation leaves owner, history and credential unchanged", async () => {
    const t = await setup(kind); const before = await t.backend.store.owner.get(), stamp = (await t.backend.store.accounts.stamp(t.account.id))!;
    const result = await t.backend.store.owner.change({ claim: { accountId: t.account.id, email: t.account.email, displayName: "Reader", provider: "gmail", verifiedBy: "google_oauth", evidence: { googleSub: who.sub, emailVerified: true } }, stamp, secret: { kind: "replace", name: t.name, expectedBlob: new TextEncoder().encode("stale"), blob: new TextEncoder().encode("newer") }, reason: "synthetic", now: 2 });
    expect(result).toBe(false); expect(await t.backend.store.owner.get()).toEqual(before); expect(await t.backend.getSecret(t.name)).toBe("old-refresh");
  });
});
