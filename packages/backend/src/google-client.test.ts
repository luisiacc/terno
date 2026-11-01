import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import type { GmailAccountConfig, GmailConnectResult, ProviderRegistry } from "@terno/mail";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { googleClientFor, parseGoogleClients, rememberLegacyGoogleClients, type GoogleClients } from "./google-client";

// Plan 99: Terno's own Google client, so Connect Google goes straight to Google.
const identity = { email: "reader@example.com", name: "Reader", sub: "google-subject", emailVerified: true, grantedScopes: ["https://www.googleapis.com/auth/gmail.modify"], refreshToken: "synthetic-refresh" };
const BUILT: GoogleClients = { preferred: "terno-prod", clients: [{ clientId: "terno-prod", clientSecret: "prod-secret" }, { clientId: "terno-dev", clientSecret: "dev-secret" }] };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup(googleClients: GoogleClients | null) {
  const connect = vi.fn<ProviderRegistry["connectGmail"]>(async () => identity as GmailConnectResult);
  const providers: ProviderRegistry = { create: () => ({ async verify() {}, async sync() {}, async execute() {}, async close() {} }), async verifyImap() {}, connectGmail: connect };
  const dir = mkdtempSync(join(tmpdir(), "terno-google-client-"));
  const backend = new Backend({ dbPath: join(dir, "test.db"), version: "test", cipher: plaintextCipher, providers, openExternal: async () => {}, autoSync: false, googleClients });
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "google-client", origin: "renderer" });
  cleanups.push(async () => { await backend.stop(); rmSync(dir, { recursive: true, force: true }); });
  const config = async (id: number) => (await backend.store.accounts.config<GmailAccountConfig>(id))!.config;
  return { backend, client: new RpcClient(c), connect, config };
}

describe("plan 99: Terno's Google client", () => {
  it("with nothing in Settings, connecting uses the build's client and the account remembers it", async () => {
    const t = await setup(BUILT);
    const account = await t.client.call("accounts.connectGmail", {});
    expect(t.connect.mock.calls[0]![0]).toMatchObject({ clientId: "terno-prod", clientSecret: "prod-secret" });
    expect(await t.config(account.id)).toMatchObject({ googleClientId: "terno-prod" });
  });

  it("without a build client or one in Settings, it still asks for a client ID", async () => {
    const t = await setup(null);
    await expect(t.client.call("accounts.connectGmail", {})).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("client ID") });
    expect(t.connect).not.toHaveBeenCalled();
  });

  it("a client in Settings is used for new connections, with its own secret", async () => {
    const t = await setup(BUILT);
    await t.client.call("settings.update", { gmailClientId: "own-client" });
    await t.client.call("settings.setSecret", { name: "gmailClientSecret", value: "own-secret" });
    const account = await t.client.call("accounts.connectGmail", {});
    expect(t.connect.mock.calls[0]![0]).toMatchObject({ clientId: "own-client", clientSecret: "own-secret" });
    expect(await t.config(account.id)).toMatchObject({ googleClientId: "own-client" });
  });

  it("an account keeps its client: a baked one gets its own secret, a changed Settings client never lends its secret", async () => {
    const t = await setup(BUILT);
    await t.client.call("settings.update", { gmailClientId: "client-b" });
    await t.client.call("settings.setSecret", { name: "gmailClientSecret", value: "secret-b" });
    // made in dev, refreshing in a release (dev and release share a profile)
    expect(await googleClientFor(t.backend, "terno-dev")).toEqual({ clientId: "terno-dev", clientSecret: "dev-secret" });
    expect(await googleClientFor(t.backend, "client-b")).toEqual({ clientId: "client-b", clientSecret: "secret-b" });
    // connected with client A, Settings now says B: A's grant can't be paired with B's secret
    expect(await googleClientFor(t.backend, "client-a")).toBeNull();
  });

  it("accounts from before plan 99 keep the Settings client, so clearing it later doesn't move them", async () => {
    const t = await setup(BUILT);
    await t.client.call("settings.update", { gmailClientId: "legacy-client" });
    const { account } = await t.backend.store.accounts.create({ kind: "gmail", email: "old@example.com", displayName: "old", color: "indigo", providerConfig: { senderName: "Old", googleSubject: "s" }, now: 1 });
    const { account: imap } = await t.backend.store.accounts.create({ kind: "imap", email: "imap@example.com", displayName: "imap", color: "indigo", providerConfig: { senderName: "Imap" }, now: 1 });
    await t.backend.start();
    expect(await t.config(account.id)).toMatchObject({ googleClientId: "legacy-client", googleSubject: "s" });
    expect(await t.config(imap.id)).not.toHaveProperty("googleClientId");
    await t.client.call("settings.update", { gmailClientId: "" });
    expect(await googleClientFor(t.backend, await t.config(account.id).then((c) => c.googleClientId))).toBeNull();
  });

  it("an account the backfill couldn't bind stays on the build's client when a Settings client comes later (Codex review)", async () => {
    const t = await setup(BUILT);
    // the Settings client was cleared before this version first ran: nothing to bind the account to
    const { account } = await t.backend.store.accounts.create({ kind: "gmail", email: "old@example.com", displayName: "old", color: "indigo", providerConfig: { senderName: "Old" }, now: 1 });
    await t.backend.start();
    expect(await t.config(account.id)).not.toHaveProperty("googleClientId");
    // reconnected with the build's client, then the user adds their own for new connections
    await t.client.call("settings.update", { gmailClientId: "own-client" });
    expect(await googleClientFor(t.backend, undefined, true)).toEqual({ clientId: "terno-prod", clientSecret: "prod-secret" });
    expect((await googleClientFor(t.backend))?.clientId).toBe("own-client");
    // a later start doesn't bind it to a client it never signed in with
    await rememberLegacyGoogleClients(t.backend);
    expect(await t.config(account.id)).not.toHaveProperty("googleClientId");
  });

  it("the build's clients parse only when well formed", () => {
    expect(parseGoogleClients(JSON.stringify(BUILT))).toEqual(BUILT);
    for (const bad of ["", undefined, "{", JSON.stringify({ preferred: "x", clients: [] }), JSON.stringify({ preferred: 1, clients: BUILT.clients })]) expect(parseGoogleClients(bad)).toBeNull();
  });
});
