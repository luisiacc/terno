import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { inspectGmailToken, type ProviderRegistry } from "@terno/mail";
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
  finally { vi.unstubAllGlobals(); }
});

async function setup() {
  let status = 200, who = email;
  const routes: string[] = [], frames: unknown[] = [];
  const nativeBodies = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const finish = (body: ReadableStreamDefaultController<Uint8Array>) => { body.close(); nativeBodies.delete(body); };
  // Install before Backend captures fetch; no request can reach a native network transport.
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    expect(request.method).toBe("GET");
    routes.push(request.url);
    if (request.url === "https://gmail.googleapis.com/held") {
      return new Response(new ReadableStream<Uint8Array>({ start(c) { nativeBodies.add(c); } }));
    }
    expect([profile, userinfo]).toContain(request.url);
    expect(request.headers.get("authorization")).toMatch(/^Bearer synthetic-/);
    if (status !== 200) return new Response(JSON.stringify({ error: { message: marker, errors: [{ reason: status === 429 ? "rateLimitExceeded" : "insufficientPermissions" }] } }), { status, headers: { "retry-after": "120" } });
    return Response.json(request.url === profile ? { emailAddress: who } : { sub: who, email: who, email_verified: true });
  }));
  const installed = vi.fn();
  const providers: ProviderRegistry = {
    create: () => ({ async verify() {}, async sync() {}, async execute() {}, async close() {} }),
    async verifyImap() {}, async connectGmail() { throw new Error("Unused native OAuth host"); },
    gmailTokens: { inspect: inspectGmailToken, set: installed },
  };
  const dir = mkdtempSync(join(tmpdir(), "terno-b41-"));
  const backend = new Backend({ dbPath: join(dir, "test.db"), version: "test", providers, cipher: plaintextCipher, autoSync: false, instantSearch: false, iconTransport: null });
  const [local, remote] = createMemoryTransportPair();
  local.onMessage((frame) => frames.push(frame));
  backend.connect(remote, { clientId: "b41-synthetic", origin: "renderer" });
  const client = new RpcClient(local);
  cleanups.push(async () => {
    for (const body of nativeBodies) finish(body);
    client.close();
    await backend.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  await client.call("app.bootstrap", {});
  const connect = (token: string, accountId?: number) => client.call("accounts.connectGmailToken", { accessToken: token, expiresIn: 3600, ...(accountId !== undefined && { accountId }) });
  return { backend, client, routes, installed, frames, nativeBodies, finish, connect, refuse: (code: number) => { status = code; }, identity: (value: string) => { who = value; } };
}

it.each([429, 403])("initial HTTP%s refusal saves nothing; only another explicit RPC connects", async (status) => {
  const t = await setup();
  t.refuse(status);
  await expect(t.connect("synthetic-refused")).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining(String(status)) });
  expect(t.routes).toEqual([profile]);
  expect(t.installed).not.toHaveBeenCalled();
  expect(await t.client.call("app.bootstrap", {})).toMatchObject({ accounts: [], owner: null });
  expect(JSON.stringify(t.frames)).not.toContain(marker);
  expect(JSON.stringify(t.frames)).not.toContain("synthetic-refused");
  // A local RPC turn must not restart provider work or reuse the refused token.
  await t.client.call("drafts.list", {});
  expect(t.routes).toEqual([profile]);
  t.refuse(200);
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
  // EOF, rather than cancel/abort, supplies physical completion evidence.
  t.finish([...t.nativeBodies][0]!);
  await held[0]!.arrayBuffer();
  expect(t.backend.net.googlePending()).toBe(held.length - 1);
  expect(await inspectGmailToken("synthetic-released", managed)).toMatchObject({ email });
  expect(t.backend.net.googlePending()).toBe(held.length - 1);
  expect(t.routes.slice(count)).toEqual([profile, userinfo]);
  for (const body of t.nativeBodies) t.finish(body);
  await Promise.all(held.slice(1).map((response) => response.arrayBuffer()));
  expect(t.backend.net.googlePending()).toBe(0);
});

it("public HTTP429 preserves the safe localized error reference", async () => {
  const t = await setup();
  t.refuse(429);
  await expect(t.connect("synthetic-quota-reference")).rejects.toMatchObject({ i18n: { key: "errors.google.signInFailed", params: { detail: 429 } } });
});
