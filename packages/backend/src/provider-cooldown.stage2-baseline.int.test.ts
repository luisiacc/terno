import "fake-indexeddb/auto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as nativeTimeout, clearTimeout as clearNativeTimeout } from "node:timers";
import { IdbMailStore } from "@terno/idb";
import { IDBFactory } from "fake-indexeddb";
import { mailboxDigest } from "@terno/store";
import { createGmailProvider, ProviderError, ProviderCooldownError, type ProviderRegistry } from "@terno/mail";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { fixtureCleanup } from "./provider-cooldown.test-utils";

const cleanup = fixtureCleanup();
beforeEach(() => cleanup.assertAvailable());
afterEach(() => cleanup.finish());
type Mode = "SQL" | "IDB off" | "IDB on";

async function fixture(mode: Mode, status: 200 | 429) {
  const dir = mkdtempSync(join(tmpdir(), "terno-stage2-current-public-"));
  cleanup.remove(() => rmSync(dir, { recursive: true, force: true }));
  const abort = new AbortController(), sockets = new Set<Socket>();
  let profileRequests = 0, tokenRequests = 0;
  const server = createServer(async (request, response) => {
    try {
      for await (const _chunk of request) { /* Synthetic request body is consumed. */ }
      if (request.url === "/token") {
        tokenRequests++;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ access_token: "synthetic-access", token_type: "Bearer", expires_in: 3600 }));
        return;
      }
      if (request.url === "/mail/profile") {
        profileRequests++;
        response.writeHead(status, { "content-type": "application/json", ...(status === 429 ? { "retry-after": "120" } : {}) });
        response.end(JSON.stringify(status === 200 ? { historyId: "1", emailAddress: "synthetic@example.test" } : { error: { message: "Synthetic remote refusal" } }));
        return;
      }
      response.writeHead(404).end();
    } catch (error) {
      cleanup.fault(error);
      response.destroy();
    }
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  let setupDone!: () => void;
  const setupTerminal = new Promise<void>((resolve) => { setupDone = resolve; });
  let setupError: Error | undefined;
  let listening = false;
  let closeResult: Promise<void> | undefined;
  const watchdog = nativeTimeout(() => { const error = new Error("Synthetic stage2 watchdog"); cleanup.fault(error); abort.abort(error); }, 8000);
  cleanup.release(() => abort.abort());
  cleanup.independent("stage2/wire-terminal", () => closeResult ??= (async () => {
    clearNativeTimeout(watchdog);
    abort.abort();
    await setupTerminal;
    const peers = [...sockets].map((socket) => new Promise<void>((resolve) => { socket.once("close", resolve); socket.destroy(); }));
    if (listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await Promise.all(peers);
    expect(sockets.size).toBe(0);
    if (setupError) throw setupError;
  })());
  server.once("error", (error) => { setupError = error; setupDone(); });
  try { server.listen(0, "127.0.0.1", () => { listening = true; setupDone(); }); }
  catch (error) { setupError = error instanceof Error ? error : new Error("Synthetic listen failed"); setupDone(); }
  await setupTerminal;
  if (setupError) throw setupError;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Synthetic listener did not bind");
  const origin = `http://127.0.0.1:${address.port}`;
  const endpoints = { token: `${origin}/token`, api: `${origin}/mail`, userinfo: `${origin}/userinfo` };
  const providers: ProviderRegistry = {
    create(ctx) {
      return createGmailProvider({ ...ctx, fetch: (input, init) => ctx.fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, abort.signal]) : abort.signal }) }, { endpoints });
    },
    async verifyImap() {},
    async connectGmail() { throw new Error("Baseline never opens consent"); },
  };
  const factory = new IDBFactory(), name = crypto.randomUUID();
  const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setImmediate(resolve)) };
  let backend: Backend | undefined;
  cleanup.push(async () => { await backend?.stop(); });
  const open = async () => {
    backend = new Backend({ dbPath: join(dir, "synthetic.db"), store: mode === "SQL" ? undefined : await IdbMailStore.open({ name, factory, platform, instantSearch: mode === "IDB on" }), platform, providers, cipher: plaintextCipher, version: "test", autoSync: false, instantSearch: false, iconTransport: null });
    await backend.ready;
    return backend;
  };
  const seed = await open();
  const { account } = await seed.store.accounts.create({ kind: "gmail", email: "synthetic@example.test", displayName: "Synthetic", color: "indigo", providerConfig: {}, now: 1 });
  await seed.store.settings.set("app", { gmailClientId: "synthetic-client" });
  await seed.setSecret(`account:${account.id}:refreshToken`, "synthetic-refresh");
  const stamp = await seed.store.accounts.stamp(account.id);
  if (!stamp) throw new Error("Synthetic account stamp missing");
  const digest = await mailboxDigest(stamp.email, (bytes) => crypto.subtle.digest("SHA-256", bytes));
  expect(await seed.store.providerCooldown.bind(stamp, digest)).toBe(true);
  // This is explicit private fixture seeding, NOT production identity-proof qualification.
  await seed.stop(); backend = undefined;
  await open();
  return {
    backend: () => backend!, accountId: account.id,
    profileRequests: () => profileRequests, tokenRequests: () => tokenRequests,
    reopen: async () => { await backend!.stop(); backend = undefined; await open(); },
  };
}
async function refused(work: Promise<unknown>): Promise<unknown> {
  try { return await work; } catch (error) { if (error instanceof ProviderError || error instanceof ProviderCooldownError) return error; throw error; }
}

for (const mode of ["SQL", "IDB off", "IDB on"] as const) {
  describe(`shipped Gmail activation ${mode}`, () => {
    it("01 second verify cannot dispatch during observed remote cooldown", async () => {
      const f = await fixture(mode, 429), provider = await f.backend().provider(f.accountId);
      if (!provider) throw new Error("Synthetic real Gmail provider missing");
      const first = await refused(provider.verify());
      expect(first).toBeInstanceOf(ProviderError);
      expect(first).toMatchObject({ status: 429 });
      expect(f.profileRequests()).toBe(1);
      const second = await refused(provider.verify());
      expect(f.profileRequests()).toBe(1);
      expect(second).toBeInstanceOf(ProviderCooldownError);
      expect(f.tokenRequests()).toBe(1);
    });
    it("02 actual Backend and store reopen cannot bypass remote cooldown", async () => {
      const f = await fixture(mode, 429), provider = await f.backend().provider(f.accountId);
      if (!provider) throw new Error("Synthetic real Gmail provider missing");
      expect(await refused(provider.verify())).toMatchObject({ status: 429 });
      expect(f.profileRequests()).toBe(1);
      await f.reopen();
      const second = await refused((async () => { const next = await f.backend().provider(f.accountId); if (!next) throw new Error("Synthetic reopened provider missing"); await next.verify(); })());
      expect(f.profileRequests()).toBe(1);
      expect(second).toBeInstanceOf(ProviderCooldownError);
      expect(f.tokenRequests()).toBe(1);
    });
    it("03 ordinary successful verifies remain eligible", async () => {
      const f = await fixture(mode, 200), provider = await f.backend().provider(f.accountId);
      if (!provider) throw new Error("Synthetic real Gmail provider missing");
      await provider.verify(); await provider.verify();
      expect(f.profileRequests()).toBe(2);
      expect(f.tokenRequests()).toBe(1);
    });
  });
}
