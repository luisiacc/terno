import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import type { GmailAccountConfig, GmailConnectResult, ProviderRegistry } from "@terno/mail";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { googleClientFor, parseGoogleClients, type GoogleClients } from "./google-client";

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
  it("connecting uses the build's client and the account remembers it", async () => {
    const t = await setup(BUILT);
    const account = await t.client.call("accounts.connectGmail", {});
    expect(t.connect.mock.calls[0]![0]).toMatchObject({ clientId: "terno-prod", clientSecret: "prod-secret" });
    expect(await t.config(account.id)).toMatchObject({ googleClientId: "terno-prod" });
  });

  it("without a build client, connecting says this copy can't connect Google", async () => {
    const t = await setup(null);
    await expect(t.client.call("accounts.connectGmail", {})).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("can’t connect Google accounts") });
    expect(t.connect).not.toHaveBeenCalled();
  });

  it("plan 123: a client ID left in Settings is never used, for new connections or accounts", async () => {
    const t = await setup(BUILT);
    await t.backend.store.settings.set("app", { gmailClientId: "own-client" });
    const account = await t.client.call("accounts.connectGmail", {});
    expect(t.connect.mock.calls[0]![0]).toMatchObject({ clientId: "terno-prod", clientSecret: "prod-secret" });
    expect(await t.config(account.id)).toMatchObject({ googleClientId: "terno-prod" });
    expect(await googleClientFor(t.backend, "own-client")).toBeNull();
    expect((await t.client.call("app.bootstrap", {})).settings).not.toHaveProperty("gmailClientId");
  });

  it("an account keeps its client: a baked one gets its own secret, any other is gone", async () => {
    const t = await setup(BUILT);
    // made in dev, refreshing in a release (dev and release share a profile)
    expect(await googleClientFor(t.backend, "terno-dev")).toEqual({ clientId: "terno-dev", clientSecret: "dev-secret" });
    expect(await googleClientFor(t.backend, "client-a")).toBeNull();
    // remembering none (before plan 99): the build's preferred one
    expect(await googleClientFor(t.backend)).toEqual({ clientId: "terno-prod", clientSecret: "prod-secret" });
  });

  it("no build clients: none for anything", async () => {
    const t = await setup(null);
    expect(await googleClientFor(t.backend)).toBeNull();
    expect(await googleClientFor(t.backend, "terno-prod")).toBeNull();
  });

  it("start() forgets a client secret saved for a client of the user's own", async () => {
    const t = await setup(BUILT);
    await t.backend.setSecret("gmailClientSecret", "own-secret");
    await t.backend.start();
    expect(await t.backend.store.secrets.has("gmailClientSecret")).toBe(false);
  });

  it("the build's clients parse only when well formed", () => {
    expect(parseGoogleClients(JSON.stringify(BUILT))).toEqual(BUILT);
    for (const bad of ["", undefined, "{", JSON.stringify({ preferred: "x", clients: [] }), JSON.stringify({ preferred: 1, clients: BUILT.clients })]) expect(parseGoogleClients(bad)).toBeNull();
  });
});
