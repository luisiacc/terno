import { createServer } from "node:http";
import { connectGmail, inspectGmailToken } from "@terno/mail";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import type { GmailConnectResult, ProviderRegistry } from "@terno/mail";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";

const identity = { email: "reader@example.com", name: "Reader", sub: "google-subject", emailVerified: true, grantedScopes: ["https://www.googleapis.com/auth/gmail.modify"] };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup(web = true) {
  let result: unknown = { ...identity, refreshToken: "synthetic-refresh" };
  let clock = 1_000_000;
  const installed = vi.fn();
  const inspect = vi.fn<NonNullable<ProviderRegistry["gmailTokens"]>["inspect"]>(async () => result as GmailConnectResult);
  const connect = vi.fn<ProviderRegistry["connectGmail"]>(async () => result as GmailConnectResult);
  const providers: ProviderRegistry = {
    create: () => ({ async verify() {}, async sync() {}, async execute() {}, async close() {} }),
    async verifyImap() {}, connectGmail: connect,
    ...(web && { gmailTokens: { inspect, set: installed } }),
  };
  const dir = mkdtempSync(join(tmpdir(), "terno-google-validation-"));
  const encrypt = vi.fn(plaintextCipher.encrypt);
  const backend = new Backend({ dbPath: join(dir, "test.db"), version: "test", cipher: { ...plaintextCipher, encrypt }, providers, openExternal: async () => {}, now: () => clock, autoSync: false });
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "google-validation", origin: "renderer" });
  const client = new RpcClient(c);
  cleanups.push(async () => { await backend.stop(); rmSync(dir, { recursive: true, force: true }); });
  await client.call("settings.update", { gmailClientId: "synthetic-client" });
  return { backend, client, providers, connect, inspect, installed, encrypt, answer: (value: unknown) => { result = value; }, advance: (ms: number) => { clock += ms; } };
}

describe("Google connection RPC validation", () => {
  it.each([
    ["null", null], ["missing address", { ...identity, email: undefined }],
    ["missing subject", { ...identity, sub: null }], ["invalid name", { ...identity, name: {} }],
    ["invalid verified evidence", { ...identity, emailVerified: "true" }],
    ["empty refresh", { ...identity, refreshToken: "" }], ["invalid scope", { ...identity, grantedScopes: 42 }],
  ])("desktop refuses malformed registry results: %s", async (_name, value) => {
    const t = await setup();
    t.answer(value);
    await expect(t.client.call("accounts.connectGmail", {})).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(t.encrypt).not.toHaveBeenCalled();
    expect(await t.client.call("app.bootstrap", {})).toMatchObject({ accounts: [], owner: null });
  });

  it("plan 22: a new desktop sign-in asks for the contacts scopes too, and photos come on with what Google granted", async () => {
    const t = await setup(false);
    const contacts = "https://www.googleapis.com/auth/contacts.readonly";
    t.answer({ ...identity, grantedScopes: [...identity.grantedScopes, contacts], refreshToken: "synthetic-refresh" });
    const account = await t.client.call("accounts.connectGmail", {});
    expect(t.connect.mock.calls[0]![0].scopes).toEqual(expect.arrayContaining([contacts, "https://www.googleapis.com/auth/contacts.other.readonly", "https://www.googleapis.com/auth/gmail.modify"]));
    expect((await t.client.call("app.bootstrap", {})).settings.googlePhotos[String(account.id)]).toEqual({ connections: true, otherContacts: false, apiDisabled: false });
  });

  it("plan 76: the days chosen when connecting are the new account's window, on desktop and the web; a reconnect keeps its own", async () => {
    const desktop = await setup(false);
    expect(await desktop.client.call("accounts.connectGmail", { syncWindowDays: 365 })).toMatchObject({ syncWindowDays: 365 });
    const web = await setup();
    expect(await web.client.call("accounts.connectGmailToken", { accessToken: "synthetic-access", expiresIn: 3600, syncWindowDays: 30 })).toMatchObject({ syncWindowDays: 30 });
    // the same address through Add account again: reconnected, its window unchanged
    expect(await web.client.call("accounts.connectGmailToken", { accessToken: "synthetic-access-2", expiresIn: 3600, syncWindowDays: 730 })).toMatchObject({ syncWindowDays: 30 });
    // none chosen: the General setting (now 180 by default)
    const plain = await setup(false);
    expect(await plain.client.call("accounts.connectGmail", {})).toMatchObject({ syncWindowDays: null });
    expect((await plain.client.call("app.bootstrap", {})).settings.syncWindowDays).toBe(180);
  });

  it("plan 22: a sign-in where the contacts boxes were unticked leaves photos off", async () => {
    const t = await setup(false);
    const account = await t.client.call("accounts.connectGmail", {});
    expect((await t.client.call("app.bootstrap", {})).settings.googlePhotos[String(account.id)]).toBeUndefined();
  });

  it("explicit reduced desktop consent is actionable and saves nothing", async () => {
    const t = await setup();
    t.answer({ ...identity, refreshToken: "synthetic-refresh", grantedScopes: ["openid", "https://www.googleapis.com/auth/gmail.readonly"] });
    await expect(t.client.call("accounts.connectGmail", {})).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("Allow Gmail access") });
    expect(t.encrypt).not.toHaveBeenCalled();
    expect(await t.client.call("app.bootstrap", {})).toMatchObject({ accounts: [], owner: null });
  });

  it("invalid reconnect evidence leaves the existing account, owner and credential unchanged", async () => {
    const t = await setup(false);
    const account = await t.client.call("accounts.connectGmail", {});
    await t.backend.syncAccount(account.id);
    const before = await t.client.call("app.bootstrap", {});
    t.answer({ ...identity, sub: null, refreshToken: "replacement" });
    t.encrypt.mockClear();
    await expect(t.client.call("accounts.reconnect", { id: account.id })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(t.encrypt).not.toHaveBeenCalled();
    expect(await t.backend.getSecret(`account:${account.id}:refreshToken`)).toBe("synthetic-refresh");
    expect(await t.client.call("app.bootstrap", {})).toMatchObject({ accounts: before.accounts, owner: before.owner });
  });

  it.each(["shutdown", "newer reconnect", "account removal"] as const)("a reconnect whose encryption overlaps %s cannot write stale credentials", async (scenario) => {
    const t = await setup(false);
    const account = await t.client.call("accounts.connectGmail", {});
    await t.backend.syncAccount(account.id);
    let release!: () => void;
    let entered!: () => void;
    const encrypting = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    t.encrypt.mockImplementationOnce(async (plain) => {
      entered();
      await gate;
      return plaintextCipher.encrypt(plain);
    });
    t.answer({ ...identity, refreshToken: "older-refresh" });
    const older = t.client.call("accounts.reconnect", { id: account.id }).then((value) => ({ value }), (error: unknown) => ({ error }));
    await encrypting;
    try {
      if (scenario === "shutdown") t.backend.abort.abort();
      if (scenario === "account removal") await t.client.call("accounts.remove", { id: account.id });
      if (scenario === "newer reconnect") {
        t.answer({ ...identity, refreshToken: "newer-refresh" });
        await t.client.call("accounts.reconnect", { id: account.id });
      }
    } finally {
      release();
    }
    expect(await older).toHaveProperty("error");
    expect(await t.backend.getSecret(`account:${account.id}:refreshToken`)).toBe(scenario === "account removal" ? null : scenario === "newer reconnect" ? "newer-refresh" : "synthetic-refresh");
  });

  it.each([false, true])("refuses a different subject for the same mailbox (browser=%s)", async (web) => {
    const t = await setup(web);
    const account = web ? await t.client.call("accounts.connectGmailToken", { accessToken: "first", expiresIn: 3600 }) : await t.client.call("accounts.connectGmail", {});
    await t.backend.syncAccount(account.id);
    const before = await t.client.call("app.bootstrap", {});
    const config = await t.backend.store.accounts.config(account.id);
    const secret = await t.backend.store.secrets.get(`account:${account.id}:refreshToken`);
    t.installed.mockClear();
    t.answer({ ...identity, sub: "different-subject", refreshToken: "replacement" });
    await expect(web ? t.client.call("accounts.connectGmailToken", { accessToken: "replacement", expiresIn: 3600, accountId: account.id }) : t.client.call("accounts.reconnect", { id: account.id })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(t.installed).not.toHaveBeenCalled();
    expect(await t.backend.store.accounts.config(account.id)).toEqual(config);
    expect(await t.backend.store.secrets.get(`account:${account.id}:refreshToken`)).toEqual(secret);
    expect(await t.client.call("app.bootstrap", {})).toMatchObject({ accounts: before.accounts, owner: before.owner });
  });

  it.each([false, true])("explicit same-mailbox consent pins legacy accounts (browser=%s)", async (web) => {
    const t = await setup(web);
    const account = web ? await t.client.call("accounts.connectGmailToken", { accessToken: "first", expiresIn: 3600 }) : await t.client.call("accounts.connectGmail", {});
    await t.backend.syncAccount(account.id);
    const config = (await t.backend.store.accounts.config<Record<string, unknown>>(account.id))!.config;
    expect(config.googleSubject).toBe(identity.sub);
    delete config.googleSubject;
    await t.backend.store.accounts.setProviderConfig(account.id, config);
    await t.backend.syncAccount(account.id);
    expect((await t.backend.store.accounts.config<Record<string, unknown>>(account.id))!.config.googleSubject).toBeUndefined();
    t.answer({ ...identity, refreshToken: "replacement" });
    if (web) await t.client.call("accounts.connectGmailToken", { accessToken: "replacement", expiresIn: 3600, accountId: account.id });
    else await t.client.call("accounts.reconnect", { id: account.id });
    expect((await t.backend.store.accounts.config<Record<string, unknown>>(account.id))!.config.googleSubject).toBe(identity.sub);
  });

  it.each(["changed mailbox with same subject", "provider refusal"])("desktop reconnect preserves stamp and ciphertext on %s", async (scenario) => {
    const t = await setup(false);
    const account = await t.client.call("accounts.connectGmail", {});
    await t.backend.syncAccount(account.id);
    const stamp = await t.backend.store.accounts.stamp(account.id);
    const secret = await t.backend.store.secrets.get(`account:${account.id}:refreshToken`);
    const before = await t.client.call("app.bootstrap", {});
    if (scenario === "provider refusal") t.connect.mockRejectedValueOnce(new Error("private provider refusal"));
    else t.answer({ ...identity, email: "renamed@example.com", refreshToken: "replacement" });
    await expect(t.client.call("accounts.reconnect", { id: account.id })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await t.backend.store.accounts.stamp(account.id)).toEqual(stamp);
    expect(await t.backend.store.secrets.get(`account:${account.id}:refreshToken`)).toEqual(secret);
    expect(await t.client.call("app.bootstrap", {})).toMatchObject({ accounts: before.accounts, owner: before.owner });
  });

  it("browser inspection refusal does not install a replacement token", async () => {
    const t = await setup();
    const account = await t.client.call("accounts.connectGmailToken", { accessToken: "first-token", expiresIn: 3600 });
    await t.backend.syncAccount(account.id);
    const stamp = await t.backend.store.accounts.stamp(account.id);
    const before = await t.client.call("app.bootstrap", {});
    t.installed.mockClear();
    t.inspect.mockRejectedValueOnce(new Error("synthetic refusal"));
    await expect(t.client.call("accounts.connectGmailToken", { accessToken: "replacement", expiresIn: 3600, accountId: account.id })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(t.installed).not.toHaveBeenCalled();
    expect(await t.backend.store.accounts.stamp(account.id)).toEqual(stamp);
    expect(await t.client.call("app.bootstrap", {})).toMatchObject({ accounts: before.accounts, owner: before.owner });
  });

  it("wrong-mailbox desktop reconnect preserves the target instead of adding the other mailbox", async () => {
    const t = await setup(false);
    const account = await t.client.call("accounts.connectGmail", {});
    t.answer({ ...identity, email: "other@example.com", refreshToken: "other-refresh" });
    await expect(t.client.call("accounts.reconnect", { id: account.id })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("Choose that account in the Google window") });
    expect(await t.backend.getSecret(`account:${account.id}:refreshToken`)).toBe("synthetic-refresh");
    expect((await t.client.call("app.bootstrap", {})).accounts.map((a) => a.email)).toEqual(["reader@example.com"]);
    expect(t.connect.mock.calls.at(-1)![0]).toMatchObject({ loginHint: "reader@example.com" });
  });

  it("wrong-mailbox browser reconnect neither installs its token nor adds the other account", async () => {
    const t = await setup();
    const account = await t.client.call("accounts.connectGmailToken", { accessToken: "first-token", expiresIn: 3600 });
    await t.backend.syncAccount(account.id);
    const before = await t.client.call("app.bootstrap", {});
    t.installed.mockClear();
    t.answer({ ...identity, email: "other@example.com" });
    await expect(t.client.call("accounts.connectGmailToken", { accessToken: "other-token", expiresIn: 3600, accountId: account.id })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(t.installed).not.toHaveBeenCalled();
    expect(await t.client.call("app.bootstrap", {})).toMatchObject({ accounts: before.accounts, owner: before.owner });
  });

  it.each(["identity lookup", "credential admission"] as const)("removal during browser reconnect's %s cannot reinstall its token or recreate its account", async (stage) => {
    const t = await setup();
    const account = await t.client.call("accounts.connectGmailToken", { accessToken: "first-token", expiresIn: 3600 });
    await t.backend.syncAccount(account.id);
    t.installed.mockClear();
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const get = t.backend.store.accounts.get.bind(t.backend.store.accounts);
    const signedIn = t.backend.signedIn.bind(t.backend);
    const spy = stage === "identity lookup" ? vi.spyOn(t.backend.store.accounts, "get").mockImplementationOnce(async (id) => {
      const value = await get(id);
      entered(); await gate;
      return value;
    }) : vi.spyOn(t.backend, "signedIn").mockImplementationOnce(async (...args) => {
      entered(); await gate;
      return signedIn(...args);
    });
    const reconnect = t.client.call("accounts.connectGmailToken", { accessToken: "replacement", expiresIn: 3600, accountId: account.id }).then((value) => ({ value }), (error: unknown) => ({ error }));
    await blocked;
    try {
      await t.client.call("accounts.remove", { id: account.id });
    } finally {
      release();
    }
    const result = await reconnect;
    spy.mockRestore();
    expect(result).toHaveProperty("error");
    expect(t.installed).not.toHaveBeenCalled();
    expect((await t.client.call("app.bootstrap", {})).accounts).toEqual([]);
  });

  it.each(["inspection", "admission"] as const)("browser reconnect superseded during %s cannot publish its token or pin", async (stage) => {
    const t = await setup();
    const account = await t.client.call("accounts.connectGmailToken", { accessToken: "first", expiresIn: 3600 });
    await t.backend.syncAccount(account.id);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; }), blocked = new Promise<void>((resolve) => { entered = resolve; });
    const admit = t.backend.store.accounts.admitGoogle.bind(t.backend.store.accounts);
    if (stage === "inspection") t.inspect.mockImplementationOnce(async () => { entered(); await gate; return { ...identity }; });
    else vi.spyOn(t.backend.store.accounts, "admitGoogle").mockImplementationOnce(async (...args) => { entered(); await gate; return admit(...args); });
    const older = t.client.call("accounts.connectGmailToken", { accessToken: "older", expiresIn: 3600, accountId: account.id }).then((value) => ({ value }), (error: unknown) => ({ error }));
    await blocked;
    const newer = t.client.call("accounts.connectGmailToken", { accessToken: "newer", expiresIn: 3600, accountId: account.id });
    // Admission serializes behind the old store call; release after the newer flow owns the account.
    await vi.waitFor(() => expect(t.inspect.mock.calls.length).toBeGreaterThanOrEqual(3));
    release();
    expect(await older).toHaveProperty("error"); await newer;
    expect(t.installed.mock.calls.map((call) => call[1])).toEqual(["first", "newer"]);
    expect((await t.backend.store.accounts.config<Record<string, unknown>>(account.id))!.config.googleSubject).toBe(identity.sub);
  });

  it("browser photo consent cannot extend expiry across account reads and admission", async () => {
    const t = await setup();
    const account = await t.client.call("accounts.connectGmailToken", { accessToken: "first", expiresIn: 3600 });
    await t.backend.syncAccount(account.id);
    await t.backend.store.accounts.setSyncState(account.id, { status: "error", authRequired: true });
    const before = await t.backend.store.accounts.get(account.id), config = await t.backend.store.accounts.config(account.id);
    const get = t.backend.store.accounts.get.bind(t.backend.store.accounts);
    vi.spyOn(t.backend.store.accounts, "get").mockImplementationOnce(async (id) => { t.advance(30_000); return get(id); });
    const admit = t.backend.store.accounts.admitGoogle.bind(t.backend.store.accounts);
    vi.spyOn(t.backend.store.accounts, "admitGoogle").mockImplementationOnce(async (...args) => { t.advance(31_000); return admit(...args); });
    t.installed.mockClear();
    await expect(t.client.call("icons.authorizeGoogle", { accountId: account.id, accessToken: "expired-photo-token", expiresIn: 60, scope: "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/contacts.readonly" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(t.installed).not.toHaveBeenCalled();
    expect(await t.backend.store.accounts.get(account.id)).toEqual(before);
    expect(await t.backend.store.accounts.config(account.id)).toEqual(config);
  });

  it("a browser token expired during inspection is never installed or saved", async () => {
    const t = await setup();
    t.inspect.mockImplementationOnce(async () => { t.advance(60_001); return { ...identity, refreshToken: "unused" }; });
    await expect(t.client.call("accounts.connectGmailToken", { accessToken: "synthetic-token", expiresIn: 60 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(t.installed).not.toHaveBeenCalled();
    expect(await t.client.call("app.bootstrap", {})).toMatchObject({ accounts: [], owner: null });
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("refuses invalid browser reconnect id %s before inspection", async (accountId) => {
    const t = await setup();
    await expect(t.client.call("accounts.connectGmailToken", { accessToken: "synthetic-token", expiresIn: 3600, accountId })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(t.inspect).not.toHaveBeenCalled();
    expect(t.installed).not.toHaveBeenCalled();
  });

  it("owner re-verification rejects invalid Google evidence and preserves the previous owner and target secret", async () => {
    const t = await setup(false);
    await t.client.call("accounts.connectGmail", {});
    t.answer({ ...identity, email: "work@example.com", sub: "work-subject", refreshToken: "work-secret" });
    const target = await t.client.call("accounts.connectGmail", {});
    const before = await t.client.call("app.bootstrap", {});
    t.encrypt.mockClear();
    t.answer({ ...identity, email: "work@example.com", sub: 123, refreshToken: "bad-secret" });
    await expect(t.client.call("identity.changeOwner", { accountId: target.id })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("invalid sign-in response") });
    expect(t.encrypt).not.toHaveBeenCalled();
    expect((await t.client.call("app.bootstrap", {})).owner).toEqual(before.owner);
    expect(await t.backend.getSecret(`account:${target.id}:refreshToken`)).toBe("work-secret");
  });

  it("refuses a malformed browser identity before installing any token or account", async () => {
    const t = await setup();
    t.answer({ ...identity, sub: 42 });
    await expect(t.client.call("accounts.connectGmailToken", { accessToken: "synthetic-token", expiresIn: 3600 })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("invalid sign-in response") });
    expect(t.installed).not.toHaveBeenCalled();
    expect(await t.client.call("app.bootstrap", {})).toMatchObject({ accounts: [], owner: null });
  });

  it("inspection consumes browser token lifetime rather than restarting it", async () => {
    const t = await setup();
    t.inspect.mockImplementationOnce(async () => { t.advance(20_000); return { ...identity, refreshToken: "unused" }; });
    const account = await t.client.call("accounts.connectGmailToken", { accessToken: "synthetic-token", expiresIn: 3600 });
    expect(t.installed).toHaveBeenCalledWith(account.id, "synthetic-token", 4_600_000);
  });

  it("refuses an invalid provider mailbox before encrypting credentials or persisting an owner/account", async () => {
    const t = await setup();
    t.answer({ ...identity, email: "not-a-mailbox", refreshToken: "synthetic-refresh" });
    await expect(t.client.call("accounts.connectGmail", {})).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("invalid sign-in response") });
    expect(t.encrypt).not.toHaveBeenCalled();
    expect(await t.client.call("app.bootstrap", {})).toMatchObject({ accounts: [], owner: null });
  });
});

describe("finite native identity requests through public admission", () => {
  it.each([false, true])("inspected subject continuity and timeout preserve the account (browser=%s)", async (web) => {
    const t = await setup(web);
    let subject = identity.sub, delay = 0;
    const server = createServer(async (req, res) => {
      for await (const _chunk of req) { /* Drain synthetic token exchange. */ }
      if (req.url === "/userinfo") {
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
        res.end(JSON.stringify({ sub: subject, email: identity.email, email_verified: true }));
      } else if (req.url === "/profile") res.end(JSON.stringify({ emailAddress: identity.email }));
      else res.end(JSON.stringify({ access_token: "synthetic-access", refresh_token: "synthetic-refresh", token_type: "Bearer", expires_in: 3600 }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing fixture address");
    const origin = `http://127.0.0.1:${address.port}`;
    const endpoints = { token: origin + "/token", api: origin, userinfo: origin + "/userinfo" };
    t.inspect.mockImplementation(async (token, netFetch, options) => inspectGmailToken(token, netFetch, { ...options, endpoints, timeoutMs: 100 }));
    t.connect.mockImplementation(async (options) => connectGmail({ ...options, endpoints, timeoutMs: 100, openExternal: async (url) => {
      const auth = new URL(url), callback = new URL(auth.searchParams.get("redirect_uri")!);
      callback.searchParams.set("state", auth.searchParams.get("state")!); callback.searchParams.set("code", "synthetic-code");
      await fetch(callback).then((r) => r.text());
    } }));
    const account = web ? await t.client.call("accounts.connectGmailToken", { accessToken: "first", expiresIn: 3600 }) : await t.client.call("accounts.connectGmail", {});
    await t.backend.syncAccount(account.id);
    const config = await t.backend.store.accounts.config(account.id), secret = await t.backend.store.secrets.get(`account:${account.id}:refreshToken`);
    const reconnect = () => web ? t.client.call("accounts.connectGmailToken", { accountId: account.id, accessToken: "replacement", expiresIn: 3600 }) : t.client.call("accounts.reconnect", { id: account.id });
    subject = "different";
    await expect(reconnect()).rejects.toMatchObject({ code: "BAD_REQUEST" });
    subject = identity.sub; delay = 200;
    t.installed.mockClear();
    await expect(reconnect()).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(t.installed).not.toHaveBeenCalled();
    expect(await t.backend.store.accounts.config(account.id)).toEqual(config);
    expect(await t.backend.store.secrets.get(`account:${account.id}:refreshToken`)).toEqual(secret);
  });
});
