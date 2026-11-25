// Plan 259 stage 1: an Outlook account through the real backend against a synthetic Microsoft (sign-in, token and
// Graph /me moved, as Gmail's tests move Google's): the account, its secret, the owner, signing in again, removal.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { sqlDb } from "@terno/db";
import { createRegistry, type ProviderRegistry } from "@terno/mail";
import { afterEach, describe, expect, it } from "vitest";
import { SyntheticMicrosoft } from "../../mail/src/test/microsoft.fixture";
import { Backend, plaintextCipher } from "./backend";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup(options: { clients?: boolean; openExternal?: boolean; providers?: ProviderRegistry; quiet?: boolean } = {}) {
  const ms = await new SyntheticMicrosoft().start();
  cleanups.push(() => ms.stop());
  let browser = ms.browser();
  const dir = mkdtempSync(join(tmpdir(), "terno-outlook-"));
  const registry = createRegistry({ microsoft: { endpoints: ms.endpoints() } });
  const backend = new Backend({
    dbPath: join(dir, "u.db"), version: "t", cipher: plaintextCipher, autoSync: false,
    // quiet: the account's provider (stage 2a's Graph provider) reads nothing, so its refresh token rotates only by a sign-in
    providers: options.providers ?? (options.quiet ? { ...registry, create: () => ({ async verify() {}, async sync() {}, async execute() {}, async close() {} }) } : registry),
    ...(options.openExternal !== false && { openExternal: (url: string) => browser(url) }),
    // the build's Microsoft app registration: a public client (no secret)
    microsoftClients: options.clients === false ? null : { preferred: ms.clientId, clients: [{ clientId: ms.clientId, clientSecret: "" }] },
  });
  cleanups.push(async () => { await backend.stop(); rmSync(dir, { recursive: true, force: true }); });
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "r", origin: "renderer" });
  const client = new RpcClient(c, { defaultTimeoutMs: 20_000 });
  const config = (id: number) => backend.store.accounts.config<Record<string, unknown>>(id).then((r) => r!.config);
  return { ms, backend, client, config, browse: (behaviour: Parameters<SyntheticMicrosoft["browser"]>[0]) => { browser = ms.browser(behaviour); } };
}

describe("accounts.connectMicrosoft (plan 259)", () => {
  it("connects an Outlook account: its config, its refresh token, and the owner with Microsoft's subject as evidence", async () => {
    const { ms, backend, client, config } = await setup();
    const account = await client.call("accounts.connectMicrosoft", { syncWindowDays: 365 });
    expect(account).toMatchObject({ kind: "outlook", email: "ana@contoso.com", syncWindowDays: 365 });
    expect(await config(account.id)).toEqual({ senderName: "Ana Ruiz", microsoftSubject: `${ms.tid}:${ms.oid}`, microsoftClientId: ms.clientId, tenant: "organizations", syncWindowDays: 365 });
    expect(await backend.getSecret(`account:${account.id}:refreshToken`)).toBe([...ms.refreshTokens][0]);
    expect(ms.authorizations[0]!.has("login_hint")).toBe(false);
    expect(await client.call("identity.get", {})).toMatchObject({ email: "ana@contoso.com", displayName: "Ana Ruiz", provider: "outlook", verifiedBy: "microsoft_oauth", accountId: account.id });
    expect(JSON.parse(sqlDb(backend.store).get<{ e: string }>("SELECT evidence_json AS e FROM owner")!.e)).toEqual({ microsoftSubject: `${ms.tid}:${ms.oid}`, tenant: "organizations" });
  });

  it("a personal account is the consumer tenant, named by its user principal name", async () => {
    const { ms, client, config } = await setup();
    ms.personal("ana@outlook.com");
    const account = await client.call("accounts.connectMicrosoft", {});
    expect(account).toMatchObject({ kind: "outlook", email: "ana@outlook.com" });
    expect(await config(account.id)).toMatchObject({ tenant: "consumers", microsoftSubject: `9188040d-6c67-4c5b-b112-36a304b66dad:${ms.oid}` });
  });

  it("refuses what it can't keep: an address already here, a denied consent, an administrator's refusal, a grant without mail", async () => {
    const { ms, backend, client, browse } = await setup();
    await client.call("accounts.connectMicrosoft", {});
    await expect(client.call("accounts.connectMicrosoft", {})).rejects.toMatchObject({ code: "BAD_REQUEST", i18n: { key: "errors.alreadyConnected" } });
    ms.mail = ms.userPrincipalName = "other@contoso.com";
    browse("deny");
    await expect(client.call("accounts.connectMicrosoft", {})).rejects.toMatchObject({ i18n: { key: "errors.microsoft.denied" } });
    browse({ error: "consent_required" });
    await expect(client.call("accounts.connectMicrosoft", {})).rejects.toMatchObject({ i18n: { key: "errors.microsoft.consentRequired" } });
    browse({ error: "access_denied", description: "AADSTS90094: The grant requires admin permission." });
    await expect(client.call("accounts.connectMicrosoft", {})).rejects.toMatchObject({ i18n: { key: "errors.microsoft.adminConsent" } });
    browse("approve");
    ms.mailbox = false;
    await expect(client.call("accounts.connectMicrosoft", {})).rejects.toMatchObject({ i18n: { key: "errors.microsoft.noMailbox" } });
    ms.mailbox = true;
    ms.grantedScope = "openid https://graph.microsoft.com/Mail.ReadWrite";
    await expect(client.call("accounts.connectMicrosoft", {})).rejects.toMatchObject({ i18n: { key: "errors.microsoft.mailScopeRequired" } });
    expect((await backend.store.accounts.list()).map((a) => a.email)).toEqual(["ana@contoso.com"]);
  });

  it("a build without Microsoft's app registration, or a host without a browser, can't connect Microsoft", async () => {
    const none = await setup({ clients: false });
    await expect(none.client.call("accounts.connectMicrosoft", {})).rejects.toMatchObject({ code: "BAD_REQUEST", i18n: { key: "errors.microsoft.noClient" } });
    const headless = await setup({ openExternal: false });
    await expect(headless.client.call("accounts.connectMicrosoft", {})).rejects.toMatchObject({ code: "UNAVAILABLE", i18n: { key: "errors.microsoft.needsDesktop" } });
  });

  it("a malformed identity from a registry never becomes an account", async () => {
    const identity = { email: "x@contoso.com", name: "X", refreshToken: "r", subject: `${"a".repeat(8)}-aaaa-aaaa-aaaa-${"a".repeat(12)}:${"b".repeat(8)}-bbbb-bbbb-bbbb-${"b".repeat(12)}`, tenant: "organizations" as const, grantedScopes: ["Mail.ReadWrite", "Mail.Send"] };
    let answer: unknown = identity;
    const t = await setup({ providers: { ...createRegistry(), connectMicrosoft: async () => answer as never } });
    for (const bad of [{ subject: "not-a-subject" }, { tenant: "common" }, { refreshToken: "" }, { email: "not an address" }, { grantedScopes: "Mail.Send" }]) {
      answer = { ...identity, ...bad };
      await expect(t.client.call("accounts.connectMicrosoft", {})).rejects.toMatchObject({ i18n: { key: "errors.microsoft.invalidResponse" } });
    }
    answer = { ...identity, grantedScopes: ["Mail.ReadWrite"] };
    await expect(t.client.call("accounts.connectMicrosoft", {})).rejects.toMatchObject({ i18n: { key: "errors.microsoft.mailScopeRequired" } });
    expect(await t.backend.store.accounts.list()).toEqual([]);
    answer = identity;
    await expect(t.client.call("accounts.connectMicrosoft", {})).resolves.toMatchObject({ kind: "outlook", email: "x@contoso.com" });
  });
});

describe("an Outlook account signs in again (plan 259)", () => {
  it("reconnect: the same person replaces the refresh token, with the address pre-filled and the remembered client", async () => {
    const { ms, backend, client } = await setup();
    const account = await client.call("accounts.connectMicrosoft", {});
    const first = await backend.getSecret(`account:${account.id}:refreshToken`);
    await client.call("accounts.reconnect", { id: account.id });
    expect(ms.authorizations.at(-1)!.get("login_hint")).toBe("ana@contoso.com");
    expect(ms.authorizations.at(-1)!.has("prompt")).toBe(false);
    expect(ms.tokenRequests.at(-1)!.get("client_id")).toBe(ms.clientId);
    const second = await backend.getSecret(`account:${account.id}:refreshToken`);
    expect(second).not.toBe(first);
    expect(ms.refreshTokens.has(second!)).toBe(true);
  });

  it("Codex code review #9: reconnect uses the registration that connected the account, not the build's preferred one", async () => {
    const ms = await new SyntheticMicrosoft().start();
    cleanups.push(() => ms.stop());
    const dir = mkdtempSync(join(tmpdir(), "terno-outlook-clients-"));
    cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
    const older = ms.clientId, newer = "00000000-0000-0000-0000-0000000000b2";
    ms.clients.add(newer);
    const open = (preferred: string) => {
      const backend = new Backend({
        dbPath: join(dir, "u.db"), version: "t", cipher: plaintextCipher, autoSync: false, openExternal: ms.browser(),
        providers: createRegistry({ microsoft: { endpoints: ms.endpoints() } }),
        microsoftClients: { preferred, clients: [{ clientId: older, clientSecret: "" }, { clientId: newer, clientSecret: "" }] },
      });
      const [c, s] = createMemoryTransportPair();
      backend.connect(s, { clientId: "r", origin: "renderer" });
      return { backend, client: new RpcClient(c, { defaultTimeoutMs: 20_000 }) };
    };
    const first = open(older);
    const account = await first.client.call("accounts.connectMicrosoft", {});
    await first.backend.stop();
    const later = open(newer);
    cleanups.push(() => later.backend.stop());
    await later.client.call("accounts.reconnect", { id: account.id });
    expect(ms.authorizations.at(-1)!.get("client_id")).toBe(older);
    expect(ms.tokenRequests.at(-1)!.get("client_id")).toBe(older);
    expect((await later.backend.store.accounts.config<Record<string, unknown>>(account.id))!.config.microsoftClientId).toBe(older);
    ms.mail = ms.userPrincipalName = "bea@contoso.com";
    ms.oid = "22222222-2222-3333-4444-555555555555";
    await later.client.call("accounts.connectMicrosoft", {});
    expect(ms.tokenRequests.at(-1)!.get("client_id")).toBe(newer);
  });

  it("reconnect: another mailbox, or another person behind the same address, changes nothing", async () => {
    const { ms, backend, client, config } = await setup({ quiet: true });
    const account = await client.call("accounts.connectMicrosoft", {});
    const before = { secret: await backend.getSecret(`account:${account.id}:refreshToken`), config: await config(account.id) };
    ms.mail = ms.userPrincipalName = "someone@contoso.com";
    await expect(client.call("accounts.reconnect", { id: account.id })).rejects.toMatchObject({ code: "BAD_REQUEST", i18n: { key: "errors.microsoft.connectedOther" } });
    ms.mail = ms.userPrincipalName = "ana@contoso.com";
    // the address was given to someone else in the tenant: a new object id
    ms.oid = "99999999-2222-3333-4444-555555555555";
    await expect(client.call("accounts.reconnect", { id: account.id })).rejects.toMatchObject({ code: "BAD_REQUEST", i18n: { key: "errors.microsoft.invalidResponse" } });
    expect(await backend.getSecret(`account:${account.id}:refreshToken`)).toBe(before.secret);
    expect(await config(account.id)).toEqual(before.config);
  });

  it("changing the owner to an Outlook account signs it in again; a different person leaves the owner unchanged", async () => {
    const { ms, client } = await setup();
    await client.call("accounts.connectMicrosoft", {});
    const owner = await client.call("identity.get", {});
    ms.mail = ms.userPrincipalName = "bea@contoso.com";
    ms.oid = "22222222-2222-3333-4444-555555555555";
    const second = await client.call("accounts.connectMicrosoft", {});
    ms.oid = "33333333-2222-3333-4444-555555555555";
    await expect(client.call("identity.changeOwner", { accountId: second.id })).rejects.toMatchObject({ i18n: { key: "errors.microsoft.invalidResponse" } });
    expect(await client.call("identity.get", {})).toEqual(owner);
    ms.oid = "22222222-2222-3333-4444-555555555555";
    await expect(client.call("identity.changeOwner", { accountId: second.id })).resolves.toMatchObject({ userId: owner!.userId, email: "bea@contoso.com", provider: "outlook", verifiedBy: "microsoft_oauth", accountId: second.id });
  });

  it("stage 2a: an Outlook account syncs through the backend's request policy: its mailbox proven by /me, its mail and folders stored, a move another app made followed", async () => {
    const { ms, backend, client } = await setup();
    const clients = ms.folder("Clients");
    const first = ms.deliver("inbox-id", { subject: "Welcome to Contoso" });
    const filed = ms.deliver(clients, { subject: "The contract" });
    const account = await client.call("accounts.connectMicrosoft", {});
    // the sign-in's own reads (/me, the mailbox probe) carry no message ids
    const signIn = ms.missingPrefer.length, calls = ms.graphRequests.length;
    await backend.syncAccount(account.id);
    const rows = () => sqlDb(backend.store).all<{ provider_msg_id: string; subject: string; in_inbox: number }>("SELECT provider_msg_id, subject, in_inbox FROM messages WHERE account_id = ? ORDER BY provider_msg_id", account.id);
    const folderOf = (id: string) => sqlDb(backend.store).get<{ folder: string }>("SELECT f.folder FROM message_folders f JOIN messages m ON m.id = f.message_id WHERE m.provider_msg_id = ?", id)?.folder ?? null;
    expect(rows()).toEqual([{ provider_msg_id: first, subject: "Welcome to Contoso", in_inbox: 1 }, { provider_msg_id: filed, subject: "The contract", in_inbox: 0 }]);
    expect(folderOf(filed)).toBe(clients);
    expect((await backend.store.folders.list()).filter((f) => f.accountId === account.id).map((f) => [f.key, f.path])).toEqual([[clients, ["Clients"]]]);
    // every Graph call went out with immutable ids, after /me proved whose mailbox the token opens
    expect(ms.missingPrefer.slice(signIn)).toEqual([]);
    const synced = ms.graphRequests.slice(calls);
    expect(synced.indexOf("/v1.0/me")).toBeGreaterThanOrEqual(0);
    expect(synced.indexOf("/v1.0/me")).toBeLessThan(synced.findIndex((p) => p.includes("/messages")));
    ms.move(first, clients);
    await backend.syncAccount(account.id);
    expect(rows().find((r) => r.provider_msg_id === first)).toMatchObject({ in_inbox: 0 });
    expect(folderOf(first)).toBe(clients);
  });

  it("removing it deletes its refresh token here; there is no grant at Microsoft to revoke", async () => {
    const { ms, backend, client } = await setup();
    const account = await client.call("accounts.connectMicrosoft", {});
    const requests = ms.tokenRequests.length;
    expect(await client.call("accounts.remove", { id: account.id })).toEqual({ ok: true });
    expect(await backend.getSecret(`account:${account.id}:refreshToken`)).toBeNull();
    expect(ms.tokenRequests.length).toBe(requests);
  });
});
