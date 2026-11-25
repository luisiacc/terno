// Plan 259 stage 1: an Outlook account through the real backend against a synthetic Microsoft (sign-in, token and
// Graph /me moved, as Gmail's tests move Google's): the account, its secret, the owner, signing in again, removal.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { sqlDb } from "@terno/db";
import { createRegistry, type ProviderRegistry } from "@terno/mail";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    expect(await config(account.id)).toEqual({ senderName: "Ana Ruiz", microsoftSubject: `${ms.tid}:${ms.oid}`, microsoftClientId: ms.clientId, tenant: "organizations", microsoftUsername: "ana@contoso.com", syncWindowDays: 365 });
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

  it("review round 3: a sign-in goes through the request ledger: a throttled code exchange pauses Microsoft's token service, and the next sign-in waits on it", async () => {
    const { ms, client } = await setup();
    ms.tokenFailure = { status: 429, body: { error: "temporarily_unavailable" } };
    await expect(client.call("accounts.connectMicrosoft", {})).rejects.toBeDefined();
    const exchanges = ms.tokenRequests.length, opened = ms.authorizations.length;
    await expect(client.call("accounts.connectMicrosoft", {})).rejects.toBeDefined();
    // refused before the browser opened or Microsoft was asked again
    expect(ms.tokenRequests).toHaveLength(exchanges);
    expect(ms.authorizations).toHaveLength(opened);
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

  it("review round 4 #9: signing in again goes through the request ledger: a throttled code exchange holds the next sign-in, which never opens the browser", async () => {
    const { ms, client } = await setup({ quiet: true });
    const account = await client.call("accounts.connectMicrosoft", {});
    ms.tokenFailure = { status: 429, body: { error: "temporarily_unavailable" } };
    await expect(client.call("accounts.reconnect", { id: account.id })).rejects.toBeDefined();
    const exchanges = ms.tokenRequests.length, opened = ms.authorizations.length;
    await expect(client.call("accounts.reconnect", { id: account.id })).rejects.toBeDefined();
    expect(ms.tokenRequests).toHaveLength(exchanges);
    expect(ms.authorizations).toHaveLength(opened);
  });

  it("stage 2b (stage 1's open note): a work account whose sign-in name isn't its address is pre-filled with the name Microsoft gave", async () => {
    const { ms, client, config } = await setup({ quiet: true });
    ms.userPrincipalName = "ana.ruiz@contoso.onmicrosoft.com";
    const account = await client.call("accounts.connectMicrosoft", {});
    expect(account.email).toBe("ana@contoso.com");
    expect(await config(account.id)).toMatchObject({ microsoftUsername: "ana.ruiz@contoso.onmicrosoft.com" });
    await client.call("accounts.reconnect", { id: account.id });
    expect(ms.authorizations.at(-1)!.get("login_hint")).toBe("ana.ruiz@contoso.onmicrosoft.com");
    // Codex code review #11: a sign-in name that changed is learned when signing in again, for the next time
    ms.userPrincipalName = "ana.r@contoso.onmicrosoft.com";
    await client.call("accounts.reconnect", { id: account.id });
    expect(await config(account.id)).toMatchObject({ microsoftUsername: "ana.r@contoso.onmicrosoft.com", microsoftSubject: `${ms.tid}:${ms.oid}` });
    await client.call("accounts.reconnect", { id: account.id });
    expect(ms.authorizations.at(-1)!.get("login_hint")).toBe("ana.r@contoso.onmicrosoft.com");
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

  it("stage 2a (Codex code review #12): Graph's 503 with a Retry-After waits on the ledger's pause, never a connectivity retry", async () => {
    const { ms, backend, client } = await setup();
    ms.deliver("inbox-id");
    const account = await client.call("accounts.connectMicrosoft", {});
    await backend.syncAccount(account.id);
    ms.throttle = { status: 503, retryAfter: "120", match: /\/mailFolders\/inbox-id\/messages\/delta/, times: 1 };
    await backend.syncAccount(account.id);
    expect(ms.throttle.times).toBe(0);
    // the ledger holds it (its error is the pause's, no retry of its own is scheduled), as a 429's would
    const [view] = await backend.accountViews([(await backend.store.accounts.get(account.id))!]);
    expect(view!.syncState).toMatchObject({ status: "error", connection: null });
    expect(backend.connectivity.failures(account.id)).toBe(0);
  });

  it("stage 2b: through the backend's ops: a folder made, a thread filed into it and back (undo), archived, read; the move's answer written at once", async () => {
    const { ms, backend, client } = await setup();
    const a = ms.deliver("inbox-id", { subject: "Contract" }), b = ms.deliver("inbox-id", { subject: "Lunch" });
    const account = await client.call("accounts.connectMicrosoft", {});
    await backend.syncAccount(account.id);
    const db = sqlDb(backend.store);
    const row = (id: string) => db.get<{ thread_id: number; in_inbox: number; is_read: number }>("SELECT thread_id, in_inbox, is_read FROM messages WHERE provider_msg_id = ?", id)!;
    const folderOf = (id: string) => db.get<{ folder: string }>("SELECT f.folder FROM message_folders f JOIN messages m ON m.id = f.message_id WHERE m.provider_msg_id = ?", id)?.folder ?? null;
    const created = await client.call("folders.create", { accountId: account.id, parent: null, name: "Clients" });
    expect(ms.folders.get(created.key)?.displayName).toBe("Clients");
    const filed = await client.call("folders.moveThreads", { accountId: account.id, folder: created.key, from: null, threadIds: [row(a).thread_id] });
    expect(filed).toMatchObject({ affected: 1, kept: 0 });
    await backend.runWorker();
    expect(ms.messages.get(a)!.folder).toBe(created.key);
    expect(folderOf(a)).toBe(created.key);
    expect(row(a).in_inbox).toBe(0);
    // one move: the archive after it found nothing left in the Inbox
    expect(ms.batches.flat().filter((r) => r.url.endsWith("/move"))).toHaveLength(1);
    await client.call("threads.undo", { undoId: filed.undoId! });
    await backend.runWorker();
    expect(ms.messages.get(a)!.folder).toBe("inbox-id");
    expect(folderOf(a)).toBeNull();
    expect(row(a).in_inbox).toBe(1);
    await client.call("threads.act", { threadIds: [row(b).thread_id], action: "archive" });
    await client.call("threads.act", { threadIds: [row(a).thread_id], action: "markRead" });
    await backend.runWorker();
    expect(ms.messages.get(b)!.folder).toBe("archive-id");
    expect(ms.messages.get(a)!.isRead).toBe(true);
    // a later read agrees with what was written
    await backend.syncAccount(account.id);
    expect(row(b).in_inbox).toBe(0);
    expect(row(a)).toMatchObject({ in_inbox: 1, is_read: 1 });
    await client.call("folders.rename", { accountId: account.id, key: created.key, name: "Customers" });
    expect(ms.folders.get(created.key)?.displayName).toBe("Customers");
    expect((await client.call("folders.delete", { accountId: account.id, key: created.key })).deleted).toEqual([created.key]);
    expect(ms.folders.has(created.key)).toBe(false);
  });

  it("exact undo: Move to Inbox out of a folder, then Undo, puts it back in the folder on Graph; a filing back that fails (the folder deleted meanwhile) asks for a read at once", async () => {
    const { ms, backend, client } = await setup();
    const projects = ms.folder("Projects");
    const a = ms.deliver(projects, { subject: "Plans" });
    const account = await client.call("accounts.connectMicrosoft", {});
    await backend.syncAccount(account.id);
    const db = sqlDb(backend.store);
    const thread = db.get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE provider_msg_id = ?", a)!.thread_id;
    const out = await client.call("threads.act", { threadIds: [thread], action: "moveToInbox" });
    await backend.runWorker();
    expect(ms.messages.get(a)!.folder).toBe("inbox-id");
    await client.call("threads.undo", { undoId: out.undoId! });
    await backend.runWorker();
    expect(ms.messages.get(a)!.folder).toBe(projects);
    // trashed, and a sync reads it there; then its undo fails (the folder gone on the server meanwhile): the failure wakes
    // a read, and that read finds it in Deleted Items again (nothing else would ask: the trash's own read is done)
    const trashed = await client.call("threads.act", { threadIds: [thread], action: "trash" });
    await backend.runWorker();
    await backend.syncAccount(account.id);
    expect(ms.messages.get(a)!.folder).toBe("trash-id");
    ms.deleteFolder(projects);
    await client.call("threads.undo", { undoId: trashed.undoId! });
    expect(db.get<{ is_trash: number }>("SELECT is_trash FROM messages WHERE provider_msg_id = ?", a)!.is_trash).toBe(0);
    // the undo's own command may ask too; what counts is the op's failure asking
    const reads = vi.spyOn(backend, "reconcileFlags");
    await backend.runWorker();
    await vi.waitFor(() => expect(reads).toHaveBeenCalledWith([account.id]));
    expect(ms.messages.get(a)!.folder).toBe("trash-id");
    await backend.syncAccount(account.id);
    expect(db.get<{ is_trash: number }>("SELECT is_trash FROM messages WHERE provider_msg_id = ?", a)!.is_trash).toBe(1);
  });

  it("stage 2b: a throttled request inside a batch pauses the mailbox as a 429 does: the action waits, and the next sync asks Graph nothing", async () => {
    const { ms, backend, client } = await setup();
    const a = ms.deliver("inbox-id");
    const account = await client.call("accounts.connectMicrosoft", {});
    await backend.syncAccount(account.id);
    const thread = sqlDb(backend.store).get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE provider_msg_id = ?", a)!.thread_id;
    ms.batchThrottle = { status: 429, retryAfter: "120", match: /^PATCH /, times: 1 };
    await client.call("threads.act", { threadIds: [thread], action: "markRead" });
    await backend.runWorker();
    expect(ms.batchThrottle.times).toBe(0);
    expect(ms.messages.get(a)!.isRead).toBe(false);
    const [op] = (await backend.store.ops.recent(5)).filter((o) => o.kind === "markRead");
    expect(op!.state).toBe("queued");
    const asked = ms.graphRequests.length;
    await backend.syncAccount(account.id);
    expect(ms.graphRequests.length).toBe(asked);
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
