import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGmailProvider, ProviderCooldownError, type ProviderRegistry } from "@terno/mail";
import { decodeCooldown } from "@terno/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import type { ProviderCooldown } from "./provider-cooldown";

// plan 264: a Gmail account's admission never latches shut on a local hiccup
const TEST_GOOGLE = { preferred: "synthetic", clients: [{ clientId: "synthetic", clientSecret: "" }] };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

async function setup(emails: string[]) {
  const requests: string[] = [];
  let tokenStatus = 200;
  // each account's refresh token is its address; its access token names it, and /profile answers with it
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += String(chunk);
    requests.push(req.url!);
    res.sendDate = false;
    if (req.url === "/token") {
      if (tokenStatus !== 200) { res.writeHead(tokenStatus, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid_grant" })); return; }
      const who = new URLSearchParams(body).get("refresh_token");
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: `at-${who}`, token_type: "Bearer", expires_in: 3600 }));
      return;
    }
    if (req.url === "/gmail/profile") {
      const who = String(req.headers.authorization).replace(/^Bearer at-/, "");
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ emailAddress: who, historyId: "1" }));
      return;
    }
    res.writeHead(404).end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No synthetic port");
  const origin = `http://127.0.0.1:${address.port}`;
  const dir = mkdtempSync(join(tmpdir(), "terno-admission-"));
  let unreadable = false;
  const cipher = { encrypt: plaintextCipher.encrypt, decrypt: async (blob: Uint8Array) => { if (unreadable) throw new Error("Synthetic keychain refusal"); return plaintextCipher.decrypt(blob); } };
  const providers: ProviderRegistry = {
    create: (ctx) => createGmailProvider(ctx, { endpoints: { token: `${origin}/token`, api: `${origin}/gmail` } }),
    async verifyImap() {}, async connectGmail() { throw new Error("Unused consent"); },
  };
  const backend = new Backend({ googleClients: TEST_GOOGLE, dbPath: join(dir, "mail.db"), providers, cipher, version: "test", autoSync: false, instantSearch: false, iconTransport: null });
  await backend.ready;
  const accounts = [];
  for (const [i, email] of emails.entries()) {
    const { account } = await backend.store.accounts.create({ kind: "gmail", email, displayName: "Synthetic", color: "brown", providerConfig: {}, now: i + 1 });
    await backend.setSecret(`account:${account.id}:refreshToken`, email);
    accounts.push(account);
  }
  cleanup.push(async () => {
    try { await backend.stop(); }
    finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
  });
  return { backend, accounts, requests, unreadable(value: boolean) { unreadable = value; }, tokenStatus(value: number) { tokenStatus = value; } };
}
const google = (b: Backend, id: number) => (b as unknown as { requests: Map<number, { paused: boolean }> }).requests.get(id);

describe("plan 264: binding a mailbox", () => {
  it("accounts proving at the same time all bind, and none is paused", async () => {
    const emails = ["one@example.test", "two@example.test", "three@example.test"];
    const h = await setup(emails);
    const providers = await Promise.all(h.accounts.map(async (a) => (await h.backend.provider(a.id))!));
    await Promise.all(providers.map((p) => p.verify()));
    const ledger = decodeCooldown(await h.backend.store.providerCooldown.read());
    expect(ledger.bindings.map((b) => b.id).sort()).toEqual(h.accounts.map((a) => a.id).sort());
    for (const a of h.accounts) expect(google(h.backend, a.id)?.paused).toBe(false);
  });

  it("a cooldown write in flight when the bind is confirmed is waited for, not a reason to pause", async () => {
    const h = await setup(["one@example.test"]);
    const [account] = h.accounts;
    const store = h.backend.store.providerCooldown, update = store.update.bind(store), bind = store.bind.bind(store);
    const gate = (h.backend as unknown as { cooldown: ProviderCooldown }).cooldown;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let holding = false;
    vi.spyOn(store, "update").mockImplementation(async (fn) => { if (holding) { holding = false; await held; } return update(fn); });
    // right after the bind's own write: another scope's 429 (sign-in info, so mail stays admitted) starts writing
    vi.spyOn(store, "bind").mockImplementation(async (...args) => {
      const bound = await bind(...args);
      holding = true;
      const ticket = gate.requestsFor("installation").reserve({ request: { endpoint: "google-userinfo", purpose: "identity-proof" } });
      await ticket.dispatch(async () => new Response(null, { status: 429 }));
      void ticket.headers429({ received: { source: "date-now", kind: "wall", wallMs: Date.now() }, minimum: { kind: "none", reason: "not-visible" } });
      ticket.release();
      setTimeout(release, 20);
      return bound;
    });
    await (await h.backend.provider(account!.id))!.verify();
    expect(google(h.backend, account!.id)?.paused).toBe(false);
    expect(decodeCooldown(await store.read()).bindings).toEqual([expect.objectContaining({ id: account!.id })]);
  });

  it("a bind the store couldn't write is tried again without asking Google again, and latches nothing", async () => {
    const h = await setup(["one@example.test"]);
    const [account] = h.accounts;
    const bind = h.backend.store.providerCooldown.bind;
    vi.spyOn(h.backend.store.providerCooldown, "bind").mockImplementationOnce(async () => { throw new Error("Synthetic SQLITE_BUSY"); }).mockImplementation(bind);
    const provider = (await h.backend.provider(account!.id))!;
    const failed = await provider.verify().catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(ProviderCooldownError);
    expect((failed as ProviderCooldownError).cooldown.kind).toBe("storage");
    // deferred for a moment (no op claimed and refunded in a loop); Retry Now ends it
    expect(google(h.backend, account!.id)?.paused).toBe(true);
    await h.backend.retryNow(account!.id, "user");
    expect(google(h.backend, account!.id)?.paused).toBe(false);
    await provider.verify();
    expect(decodeCooldown(await h.backend.store.providerCooldown.read()).bindings).toEqual([expect.objectContaining({ id: account!.id })]);
    // the proof the first attempt made stands: the retry asked Google only for verify's own /profile
    expect(h.requests.filter((r) => r === "/gmail/profile")).toHaveLength(2);
  });

  it("a mailbox that isn't the saved address still pauses the account", async () => {
    const h = await setup(["one@example.test"]);
    const [account] = h.accounts;
    await h.backend.setSecret(`account:${account!.id}:refreshToken`, "someone-else@example.test");
    const provider = (await h.backend.provider(account!.id))!;
    await expect(provider.verify()).rejects.toBeInstanceOf(ProviderCooldownError);
    await h.backend.retryNow(account!.id, "user");
    expect(google(h.backend, account!.id)?.paused).toBe(true);
  });
});

describe("plan 264: a Gmail session the keychain wouldn't open", () => {
  it("is opened again at Retry Now, and the account syncs without a sign-in", async () => {
    const h = await setup(["one@example.test"]);
    const [account] = h.accounts;
    h.unreadable(true);
    await h.backend.syncAccount(account!.id);
    let state = (await h.backend.store.accounts.get(account!.id))!.syncState;
    expect(state).toMatchObject({ authRequired: true, lastErrorI18n: { key: "errors.secret.unavailable" }, lastErrorSecret: "keychain" });
    h.unreadable(false);
    await h.backend.retryNow(account!.id, "user");
    await vi.waitFor(async () => expect((await h.backend.store.accounts.get(account!.id))!.syncState.authRequired).toBe(false));
    state = (await h.backend.store.accounts.get(account!.id))!.syncState;
    expect(state.lastErrorI18n?.key).not.toBe("errors.secret.unavailable");
    expect(state.lastErrorSecret ?? null).toBeNull();
  });

  it("Google refusing the grant is not rechecked: only a sign-in answers it", async () => {
    const h = await setup(["one@example.test"]);
    const [account] = h.accounts;
    h.tokenStatus(400);
    await h.backend.syncAccount(account!.id);
    expect((await h.backend.store.accounts.get(account!.id))!.syncState.authRequired).toBe(true);
    const tokens = h.requests.filter((r) => r === "/token").length;
    h.tokenStatus(200);
    await h.backend.retryNow(account!.id, "user");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await h.backend.store.accounts.get(account!.id))!.syncState.authRequired).toBe(true);
    expect(h.requests.filter((r) => r === "/token")).toHaveLength(tokens);
  });
});
