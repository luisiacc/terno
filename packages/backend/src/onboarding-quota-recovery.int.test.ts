import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { connectGmail, inspectGmailToken, type ProviderRegistry } from "@terno/mail";
import { decodeCooldown, mailboxDigest } from "@terno/store";
import { afterEach, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { ProviderCooldown, ProviderCooldownError } from "./provider-cooldown";

const profile = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
const userinfo = "https://openidconnect.googleapis.com/v1/userinfo";
const email = "onboarding@example.test";
const marker = "PRIVATE_provider_detail_synthetic";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  try { for (const close of cleanups.splice(0).reverse()) await close(); }
  finally { vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});

async function setup() {
  let status = 200, who = email, reason = "insufficientPermissions", failAt = profile;
  let clock = 1_800_000_000_000, elapsed = 1000;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  const nativeFetch = globalThis.fetch;
  const tokenUrl = "https://oauth2.googleapis.com/token";
  const popups: string[] = [];
  const routes: string[] = [], frames: unknown[] = [];
  const nativeBodies = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const finish = (body: ReadableStreamDefaultController<Uint8Array>) => { body.close(); nativeBodies.delete(body); };
  // Install before Backend captures fetch; no request can reach a native network transport.
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    expect(input).toBeInstanceOf(Request);
    routes.push(request.url);
    if (request.url === "https://gmail.googleapis.com/held") {
      return new Response(new ReadableStream<Uint8Array>({ start(c) { nativeBodies.add(c); } }));
    }
    expect([profile, userinfo, tokenUrl]).toContain(request.url);
    expect(request.method).toBe(request.url === tokenUrl ? "POST" : "GET");
    if (request.url !== tokenUrl) expect(request.headers.get("authorization")).toMatch(/^Bearer synthetic-/);
    if (status !== 200 && request.url === failAt) return new Response(reason === "malformed" ? "{broken" : JSON.stringify({ error: { message: marker, errors: [{ reason }] } }), { status, headers: { "retry-after": "120" } });
    if (request.url === tokenUrl) return Response.json({ access_token: "synthetic-desktop", refresh_token: "synthetic-refresh", token_type: "Bearer", expires_in: 3600, scope: "openid email profile https://www.googleapis.com/auth/gmail.modify" });
    return Response.json(request.url === profile ? { emailAddress: who } : { sub: who, email: who, email_verified: true });
  }));
  const installed = vi.fn();
  const providers: ProviderRegistry = {
    create: () => ({ async verify() {}, async sync() {}, async execute() {}, async close() {} }),
    async verifyImap() {},
    connectGmail: (options) => connectGmail({ ...options, openExternal: async (url) => {
      popups.push(url);
      const auth = new URL(url), callback = new URL(auth.searchParams.get("redirect_uri")!);
      expect(callback.hostname).toBe("127.0.0.1");
      expect(callback.pathname).toBe("/callback");
      callback.searchParams.set("state", auth.searchParams.get("state")!);
      callback.searchParams.set("code", "synthetic-code");
      await nativeFetch(callback).then((response) => response.text());
    } }),
    gmailTokens: { inspect: inspectGmailToken, set: installed },
  };
  const dir = mkdtempSync(join(tmpdir(), "terno-b41-"));
  const open = () => new Backend({ dbPath: join(dir, "test.db"), version: "test", providers, cipher: plaintextCipher, autoSync: false, instantSearch: false, iconTransport: null, now: () => clock, openExternal: async () => {} });
  let backend = open();
  const attach = () => {
    const [local, remote] = createMemoryTransportPair();
    local.onMessage((frame) => frames.push(frame));
    backend.connect(remote, { clientId: "b41-synthetic", origin: "renderer" });
    return new RpcClient(local);
  };
  let client = attach();
  cleanups.push(async () => {
    for (const body of nativeBodies) finish(body);
    client.close();
    await backend.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  await client.call("settings.update", { gmailClientId: "synthetic-client" });
  const expire = async () => {
    const rows = decodeCooldown(await backend.store.providerCooldown.read()).rows;
    const wait = Math.max(0, ...rows.flatMap((row) => [Number(row.replay), row.minimum === null ? 0 : Number(row.minimum) - clock])) + 1;
    clock += wait; elapsed += wait;
  };
  const reopen = async () => {
    client.close(); await backend.stop(); backend = open(); client = attach();
    await client.call("app.bootstrap", {});
  };
  const connect = (token: string, accountId?: number) => client.call("accounts.connectGmailToken", { accessToken: token, expiresIn: 3600, ...(accountId !== undefined && { accountId }) });
  return { get backend() { return backend; }, get client() { return client; }, routes, installed, frames, nativeBodies, finish, connect, expire, reopen, popups, refuse: (code: number, at = profile, why = "insufficientPermissions") => { status = code; failAt = at; reason = why; }, identity: (value: string) => { who = value; } };
}

it.each([429, 403])("initial HTTP%s refusal saves nothing; only another explicit RPC connects", async (status) => {
  const t = await setup();
  t.refuse(status);
  await expect(t.connect("synthetic-refused")).rejects.toMatchObject({ code: "BAD_REQUEST", i18n: { key: status === 429 ? "errors.google.quota" : "errors.google.signInFailed" } });
  expect(t.routes).toEqual([profile]);
  expect(t.installed).not.toHaveBeenCalled();
  expect(await t.client.call("app.bootstrap", {})).toMatchObject({ accounts: [], owner: null });
  expect(JSON.stringify(t.frames)).not.toContain(marker);
  expect(JSON.stringify(t.frames)).not.toContain("synthetic-refused");
  // A local RPC turn must not restart provider work or reuse the refused token.
  await t.client.call("drafts.list", {});
  expect(t.routes).toEqual([profile]);
  t.refuse(200);
  if (status === 429) {
    await expect(t.connect("synthetic-too-early")).rejects.toMatchObject({ i18n: { key: "errors.gmail.paused" } });
    expect(t.routes).toEqual([profile]);
    await t.expire();
  }
  const account = await t.connect("synthetic-later");
  expect(t.installed).toHaveBeenCalledExactlyOnceWith(account.id, "synthetic-later", expect.any(Number));
  expect(t.routes).toEqual([profile, profile, userinfo]);
  expect((await t.client.call("app.bootstrap", {})).accounts.map((a) => a.id)).toEqual([account.id]);
});

it("quota and wrong-account verification leave the saved account and exact draft intact", async () => {
  const t = await setup();
  const account = await t.connect("synthetic-first");
  const draft = await t.client.call("drafts.save", { accountId: account.id, subject: "Saved subject", bodyText: "Exact authored text", bodyHtml: "<p>Exact authored text</p>" });
  await t.backend.syncAccount(account.id);
  const before = await t.client.call("app.bootstrap", {});
  const config = await t.backend.store.accounts.config(account.id);
  t.installed.mockClear();
  t.refuse(429);
  await expect(t.connect("synthetic-quota", account.id)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await t.expire();
  t.refuse(200); t.identity("other@example.test");
  await expect(t.connect("synthetic-wrong", account.id)).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("Choose that account") });
  expect(t.installed).not.toHaveBeenCalled();
  expect(await t.client.call("drafts.list", {})).toEqual([draft]);
  expect(await t.backend.store.accounts.config(account.id)).toEqual(config);
  expect(await t.client.call("app.bootstrap", {})).toMatchObject({ accounts: before.accounts, owner: before.owner });
  t.identity(email);
  await t.connect("synthetic-correct", account.id);
  expect(t.installed).toHaveBeenCalledExactlyOnceWith(account.id, "synthetic-correct", expect.any(Number));
  expect(await t.client.call("drafts.list", {})).toEqual([draft]);
  expect(t.routes).toEqual([profile, userinfo, profile, profile, userinfo, profile, userinfo]);
});

it("managed local capacity refuses dispatch until actual native EOF, then admits one explicit verification", async () => {
  const t = await setup();
  let raw: string | null = null;
  const gate = await ProviderCooldown.open({ read: async () => raw, update: async (fn) => { const next = fn(raw); raw = next.encoded; return next.result; } }, { wallNow: () => 1000, elapsedNow: () => 10, random: () => 0.5 });
  cleanups.push(() => gate.close());
  const managed = t.backend.net.fetchGoogle(gate.requestsFor("a".repeat(64)), { request: { endpoint: "gmail-api", purpose: "identity-proof" } });
  const held: Response[] = [];
  // Fill the real bounded pool, deriving its limit from refusal rather than a guessed UI cap.
  for (let count = 0; count < 1000; count++) {
    try { held.push(await managed("https://gmail.googleapis.com/held")); }
    catch (error) { expect(error).toBeInstanceOf(ProviderCooldownError); break; }
  }
  expect(held.length).toBeGreaterThan(0);
  expect(t.backend.net.googlePending()).toBe(held.length);
  const count = t.routes.length;
  await expect(inspectGmailToken("synthetic-capacity", managed)).rejects.toMatchObject({ message: expect.stringContaining("paused") });
  expect(t.routes).toHaveLength(count);
  // initial public auth must share this same host capacity.
  await expect(t.connect("synthetic-public-capacity")).rejects.toMatchObject({ i18n: { key: "errors.google.capacity" } });
  await expect(t.client.call("accounts.connectGmail", {})).rejects.toMatchObject({ i18n: { key: "errors.google.capacity" } });
  expect(t.popups).toEqual([]);
  expect(t.installed).not.toHaveBeenCalled();
  expect((await t.client.call("app.bootstrap", {})).accounts).toEqual([]);
  expect(decodeCooldown(await t.backend.store.providerCooldown.read()).rows).toEqual([]);
  expect(t.routes).toHaveLength(count);
  // EOF, rather than cancel/abort, supplies physical completion evidence.
  t.finish([...t.nativeBodies][0]!);
  await held[0]!.arrayBuffer();
  expect(t.backend.net.googlePending()).toBe(held.length - 1);
  expect(await t.connect("synthetic-released")).toMatchObject({ email });
  expect(t.backend.net.googlePending()).toBe(held.length - 1);
  expect(t.routes.slice(count)).toEqual([profile, userinfo]);
  for (const body of t.nativeBodies) t.finish(body);
  await Promise.all(held.slice(1).map((response) => response.arrayBuffer()));
  expect(t.backend.net.googlePending()).toBe(0);
});

it("public HTTP429 preserves the safe localized error reference", async () => {
  const t = await setup();
  t.refuse(429);
  await expect(t.connect("synthetic-quota-reference")).rejects.toMatchObject({ i18n: { key: "errors.google.quota" } });
});

it("initial public HTTP429 records a durable admission constraint", async () => {
  const t = await setup();
  t.refuse(429);
  await expect(t.connect("synthetic-quota-durable")).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect(decodeCooldown(await t.backend.store.providerCooldown.read()).rows.length).toBeGreaterThan(0);
});

it.each([false, true])("durable initial quota survives explicit retry and restart (desktop=%s)", async (desktop) => {
  const t = await setup();
  const at = desktop ? "https://oauth2.googleapis.com/token" : userinfo;
  const connect = () => desktop ? t.client.call("accounts.connectGmail", {}) : t.connect("synthetic-restart");
  t.refuse(429, at);
  await expect(connect()).rejects.toMatchObject({ i18n: { key: "errors.google.quota" } });
  const expected = desktop ? [at] : [profile, userinfo];
  expect(t.routes).toEqual(expected);
  const ledger = decodeCooldown(await t.backend.store.providerCooldown.read());
  expect(ledger.rows).toHaveLength(1);
  expect(ledger.rows[0]).toMatchObject({ owner: "installation", service: desktop ? "oauth-token" : "google-userinfo" });
  expect(ledger.bindings).toEqual([]);
  expect(Number(ledger.rows[0]!.minimum)).toBeGreaterThanOrEqual(Date.now() + 120_000);
  expect(t.installed).not.toHaveBeenCalled();
  expect((await t.client.call("app.bootstrap", {})).accounts).toEqual([]);
  expect(await t.backend.store.secrets.get("account:1:refreshToken")).toBeNull();
  t.refuse(200);
  await expect(connect()).rejects.toMatchObject({ i18n: { key: "errors.gmail.paused" } });
  await t.reopen();
  await expect(connect()).rejects.toMatchObject({ i18n: { key: "errors.gmail.paused" } });
  expect(t.routes).toEqual(expected);
  expect(t.popups).toHaveLength(desktop ? 1 : 0);
  await t.expire();
  const account = await connect();
  expect(account.email).toBe(email);
  expect(t.routes).toEqual([...expected, ...(desktop ? ["https://oauth2.googleapis.com/token"] : []), profile, userinfo]);
  if (desktop) expect(await t.backend.getSecret(`account:${account.id}:refreshToken`)).toBe("synthetic-refresh");
  else expect(t.installed).toHaveBeenCalledExactlyOnceWith(account.id, "synthetic-restart", expect.any(Number));
  expect(JSON.stringify(t.frames)).not.toContain(marker);
  expect(JSON.stringify(t.frames)).not.toContain("synthetic-refresh");
});

it.each([
  [403, "rateLimitExceeded", true], [403, "userRateLimitExceeded", true],
  [403, "insufficientPermissions", false], [403, "domainPolicy", false],
  [403, "accessNotConfigured", false], [403, "malformed", false],
  [503, "rateLimitExceeded", false],
] as const)("initial HTTP%s reason %s cools only qualified quota=%s", async (status, reason, quota) => {
  const t = await setup();
  t.refuse(status, profile, reason);
  await expect(t.connect("synthetic-reason")).rejects.toMatchObject({ i18n: { key: quota ? "errors.google.quota" : "errors.google.signInFailed" } });
  expect(t.routes).toEqual([profile]);
  expect(t.installed).not.toHaveBeenCalled();
  expect((await t.client.call("app.bootstrap", {})).accounts).toEqual([]);
  const rows = decodeCooldown(await t.backend.store.providerCooldown.read()).rows;
  expect(rows).toHaveLength(quota ? 1 : 0);
  if (quota) {
    expect(rows[0]).toMatchObject({ owner: "installation", service: "gmail-api" });
    t.refuse(200);
    await expect(t.connect("synthetic-gated")).rejects.toMatchObject({ i18n: { key: "errors.gmail.paused" } });
    expect(t.routes).toEqual([profile]);
    await t.expire();
  }
  t.refuse(200);
  expect(await t.connect("synthetic-recovered")).toMatchObject({ email });
  expect(t.routes).toEqual([profile, profile, userinfo]);
  expect(t.installed).toHaveBeenCalledOnce();
  expect(JSON.stringify(t.frames)).not.toContain(marker);
});

it("desktop identity quota stops before userinfo and never stores its exchanged refresh token", async () => {
  const t = await setup();
  t.refuse(429);
  await expect(t.client.call("accounts.connectGmail", {})).rejects.toMatchObject({ i18n: { key: "errors.google.quota" } });
  expect(t.routes).toEqual(["https://oauth2.googleapis.com/token", profile]);
  expect((await t.client.call("app.bootstrap", {})).accounts).toEqual([]);
  expect(await t.backend.store.secrets.get("account:1:refreshToken")).toBeNull();
  expect(t.installed).not.toHaveBeenCalled();
  expect(decodeCooldown(await t.backend.store.providerCooldown.read()).rows[0]).toMatchObject({ service: "gmail-api", owner: "installation" });
  expect(t.backend.net.googlePending()).toBe(0);
});

it("targeted sign-in and rediscovered Add Account cannot publish access through a verified mailbox quota", async () => {
  const t = await setup();
  const account = await t.connect("synthetic-verified");
  await t.backend.syncAccount(account.id);
  const stamp = (await t.backend.store.accounts.stamp(account.id))!;
  // This mailbox has completed the real two-endpoint proof above; seed its durable saved binding.
  const key = await mailboxDigest(account.email, (bytes) => crypto.subtle.digest("SHA-256", bytes));
  expect(await t.backend.store.providerCooldown.bind(stamp, key)).toBe(true);
  const gate = await ProviderCooldown.open(t.backend.store.providerCooldown, { wallNow: Date.now, elapsedNow: () => performance.now(), random: () => 0.5 });
  try {
    const managed = t.backend.net.fetchGoogle(await gate.requestsForAccount(stamp, () => true), { request: { endpoint: "gmail-api", purpose: "identity-proof" } });
    t.refuse(429);
    await expect(inspectGmailToken("synthetic-saved-quota", managed)).rejects.toMatchObject({ i18n: { key: "errors.google.quota" } });
  } finally { await gate.close(); }
  t.refuse(200);
  await t.reopen();
  t.installed.mockClear();
  const count = t.routes.length;
  await expect(t.connect("synthetic-target-retry", account.id)).rejects.toMatchObject({ i18n: { key: "errors.gmail.paused" } });
  expect(t.routes).toHaveLength(count);
  await expect(t.connect("synthetic-rediscovered")).rejects.toMatchObject({ i18n: { key: "errors.gmail.paused" } });
  expect(t.routes.slice(count)).toEqual([profile, userinfo]);
  expect(t.installed).not.toHaveBeenCalled();
  expect((await t.client.call("app.bootstrap", {})).accounts.map((entry) => entry.id)).toEqual([account.id]);
  await t.expire();
  await t.connect("synthetic-target-recovered", account.id);
  expect(t.installed).toHaveBeenCalledExactlyOnceWith(account.id, "synthetic-target-recovered", expect.any(Number));
});
