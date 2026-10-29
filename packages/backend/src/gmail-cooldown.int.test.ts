import { exchangeGmailRefresh } from "../../mail/src/gmail-refresh";
import "fake-indexeddb/auto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IdbMailStore } from "@terno/idb";
import { IDBFactory } from "fake-indexeddb";
import { createGmailProvider, ProviderCooldownError, type ProviderRegistry, type ProviderContext } from "@terno/mail";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
function latch() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }

async function setup(kind: "SQL" | "IndexedDB") {
  const requests: string[] = [];
  let answer: ((req: IncomingMessage, res: ServerResponse) => boolean) | undefined;
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* Synthetic payload only. */ }
    requests.push(req.url!);
    res.sendDate = false;
    if (answer?.(req, res)) return;
    res.writeHead(req.url === "/token" ? 200 : 429, { "content-type": "application/json", "retry-after": "120" });
    res.end(JSON.stringify(req.url === "/token" ? { access_token: "synthetic", token_type: "Bearer", expires_in: 3600 } : {}));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No synthetic port");
  const dir = mkdtempSync(join(tmpdir(), "terno-gmail-cooldown-"));
  const factory = new IDBFactory(), name = crypto.randomUUID();
  const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setImmediate(resolve)) };
  const origin = `http://127.0.0.1:${address.port}`;
  const contexts = new Map<number, ProviderContext>();
  const providers: ProviderRegistry = {
    create: (ctx) => { contexts.set(ctx.account.id, ctx); return createGmailProvider(ctx, { endpoints: { token: `${origin}/token`, api: `${origin}/gmail` } }); },
    async verifyImap() {}, async connectGmail() { throw new Error("Unused consent"); },
  };
  const open = async () => new Backend({ dbPath: join(dir, "mail.db"), store: kind === "IndexedDB" ? await IdbMailStore.open({ name, factory, platform, instantSearch: false }) : undefined, platform, providers, cipher: plaintextCipher, version: "test", autoSync: false, instantSearch: false, iconTransport: null });
  let backend = await open();
  const { account } = await backend.store.accounts.create({ kind: "gmail", email: "synthetic@example.test", displayName: "Synthetic", color: "indigo", providerConfig: {}, now: 1 });
  await backend.store.settings.set("app", { gmailClientId: "synthetic" });
  await backend.setSecret(`account:${account.id}:refreshToken`, "synthetic-refresh");
  cleanup.push(async () => {
    try { await backend.stop(); }
    finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
  });
  return { contexts, origin, answer(fn: typeof answer) { answer = fn; }, get backend() { return backend; }, account, requests, async reopen() { await backend.stop(); backend = await open(); } };
}

function healthyProfile(_req: IncomingMessage, res: ServerResponse) {
  if (_req.url !== "/gmail/profile") return false;
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ emailAddress: "synthetic@example.test", historyId: "1" }));
  return true;
}

for (const kind of ["SQL", "IndexedDB"] as const) describe(`${kind} saved Gmail cooldown`, () => {
  it("denies repeated actual resource requests and remains paused after reopening", async () => {
    const h = await setup(kind);
    const provider = (await h.backend.provider(h.account.id))!;
    const first = await provider.verify().catch((error: unknown) => error);
    expect(first).toMatchObject({ status: 429, httpResponse: { status: 429, retryAfter: { kind: "value", value: "120" } } });
    const durable = await h.backend.store.providerCooldown.read();
    await expect(provider.verify()).rejects.toBeInstanceOf(ProviderCooldownError);
    expect(await h.backend.store.providerCooldown.read()).toBe(durable);
    expect(h.requests).toEqual(["/token", "/gmail/profile"]);
    await h.reopen();
    await expect((await h.backend.provider(h.account.id))!.verify()).rejects.toBeInstanceOf(ProviderCooldownError);
    expect(h.requests).toEqual(["/token", "/gmail/profile"]);
  });

  it("does not charge remote operation attempts or spin the worker while locally denied", async () => {
    const h = await setup(kind);
    await (await h.backend.provider(h.account.id))!.verify().catch(() => {});
    const [local, remote] = createMemoryTransportPair();
    h.backend.connect(remote, { clientId: "synthetic", origin: "renderer" });
    const rpc = new RpcClient(local); cleanup.push(async () => rpc.close());
    const { opId } = await rpc.call("compose.send", { accountId: h.account.id, to: [{ email: "recipient@example.test", name: "" }], subject: "Synthetic", bodyText: "Synthetic" });
    expect(await h.backend.runWorker()).toBe(0);
    expect(await h.backend.store.ops.get(opId)).toMatchObject({ state: "queued", attempts: 0 });
    expect(await h.backend.runWorker()).toBe(0);
    expect(h.requests).toEqual(["/token", "/gmail/profile"]);
  });

  it("retains an actual429 and its evidence when reset wins a deferred durable write", async () => {
    const h = await setup(kind); h.answer(healthyProfile);
    const provider = (await h.backend.provider(h.account.id))!;
    await provider.verify();
    const entered = latch(), write = latch();
    cleanup.push(async () => write.resolve());
    const update = h.backend.store.providerCooldown.update;
    h.backend.store.providerCooldown.update = async (fn) => { entered.resolve(); await write.promise; return update(fn); };
    h.answer(undefined);
    const result = provider.verify().catch((error: unknown) => error);
    await entered.promise;
    provider.reset!();
    expect(await result).toMatchObject({ status: 429, ambiguous: false, network: false, httpResponse: { status: 429, retryAfter: { kind: "value", value: "120" } } });
    await expect(provider.verify()).rejects.toBeInstanceOf(ProviderCooldownError);
    expect(h.requests).toEqual(["/token", "/gmail/profile", "/gmail/profile"]);
    write.resolve();
  });

  it("latches a failed bind before releasing its starter, until explicit drop/reconnect", async () => {
    const h = await setup(kind); h.answer(healthyProfile);
    const bind = vi.spyOn(h.backend.store.providerCooldown, "bind").mockRejectedValueOnce(new Error("Synthetic binding write failure"));
    const provider = (await h.backend.provider(h.account.id))!;
    const attempts = await Promise.allSettled([provider.verify(), provider.verify()]);
    expect(attempts.every((result) => result.status === "rejected" && result.reason instanceof ProviderCooldownError)).toBe(true);
    provider.reset!();
    await expect(provider.verify()).rejects.toBeInstanceOf(ProviderCooldownError);
    expect(h.requests).toEqual(["/token", "/gmail/profile"]);
    expect(bind).toHaveBeenCalledTimes(1);
    await h.backend.dropAccount(h.account.id);
    await h.backend.signedIn(h.account.id);
    await (await h.backend.provider(h.account.id))!.verify();
    expect(bind).toHaveBeenCalledTimes(2);
    expect(h.requests).toEqual(["/token", "/gmail/profile", "/token", "/gmail/profile"]);
  });

  it("fences a queued bind against a newer credential generation inside its transaction", async () => {
    const h = await setup(kind); h.answer(healthyProfile);
    const entered = latch(), write = latch();
    cleanup.push(async () => write.resolve());
    const bind = h.backend.store.providerCooldown.bind;
    vi.spyOn(h.backend.store.providerCooldown, "bind").mockImplementation(async (...args) => { entered.resolve(); await write.promise; return bind(...args); });
    const provider = (await h.backend.provider(h.account.id))!;
    const result = provider.verify().catch((error: unknown) => error);
    await entered.promise;
    await h.backend.signedIn(h.account.id);
    write.resolve();
    expect(await result).toBeInstanceOf(ProviderCooldownError);
    expect(JSON.parse((await h.backend.store.providerCooldown.read()) ?? "{}").bindings ?? []).toEqual([]);
    await expect(provider.verify()).rejects.toBeInstanceOf(ProviderCooldownError);
    expect(h.requests).toEqual(["/token", "/gmail/profile"]);
  });

  it("charges an operation that actually refreshed/proved, then blocks later local attempts", async () => {
    const h = await setup(kind);
    const [local, remote] = createMemoryTransportPair();
    h.backend.connect(remote, { clientId: "synthetic", origin: "renderer" });
    const rpc = new RpcClient(local); cleanup.push(async () => rpc.close());
    const { opId } = await rpc.call("compose.send", { accountId: h.account.id, to: [{ email: "recipient@example.test", name: "" }], subject: "Synthetic", bodyText: "Synthetic" });
    expect(await h.backend.runWorker()).toBe(1);
    expect(await h.backend.store.ops.get(opId)).toMatchObject({ state: "queued", attempts: 1 });
    expect(await h.backend.runWorker()).toBe(0);
    expect(h.requests).toEqual(["/token", "/gmail/profile"]);
    expect((await h.backend.store.accounts.get(h.account.id))?.syncState.authRequired).not.toBe(true);
  });


  it("shares a proved mailbox cooldown across saved accounts while keeping services distinct", async () => {
    const h = await setup(kind); h.answer(healthyProfile);
    const second = (await h.backend.store.accounts.create({ kind: "gmail", email: "SYNTHETIC@example.test", displayName: "Synthetic second", color: "indigo", providerConfig: {}, now: 2 })).account;
    await h.backend.setSecret(`account:${second.id}:refreshToken`, "synthetic-second-refresh");
    const firstProvider = (await h.backend.provider(h.account.id))!, secondProvider = (await h.backend.provider(second.id))!;
    await firstProvider.verify(); await secondProvider.verify();
    h.answer(undefined);
    await expect(firstProvider.verify()).rejects.toMatchObject({ status: 429 });
    const before = h.requests.length;
    await expect(secondProvider.verify()).rejects.toBeInstanceOf(ProviderCooldownError);
    expect(h.requests).toHaveLength(before);
    const service = h.contexts.get(second.id)!.google!;
    const other = await service.request({ request: { endpoint: "google-userinfo", purpose: "photos" } }, `${h.origin}/userinfo`);
    expect(other.status).toBe(429); await other.text();
    expect(h.requests.at(-1)).toBe("/userinfo");
    await expect(service.request({ request: { endpoint: "google-userinfo", purpose: "photos" } }, `${h.origin}/userinfo`)).rejects.toBeInstanceOf(ProviderCooldownError);
    expect(h.requests.filter((path) => path === "/userinfo")).toHaveLength(1);
    const complete = [...h.requests];
    await h.reopen();
    await expect((await h.backend.provider(second.id))!.verify()).rejects.toBeInstanceOf(ProviderCooldownError);
    expect(h.requests).toEqual(complete);
  });


  it("preserves native token429 evidence when the exchange caller aborts during persistence", async () => {
    const h = await setup(kind);
    h.answer((req, res) => {
      if (req.url !== "/token") return false;
      res.writeHead(429, { "content-type": "application/json", "retry-after": "120" }).end("{}"); return true;
    });
    await h.backend.provider(h.account.id);
    const ctx = h.contexts.get(h.account.id)!;
    const entered = latch(), write = latch(), abort = new AbortController();
    cleanup.push(async () => write.resolve());
    const update = h.backend.store.providerCooldown.update;
    h.backend.store.providerCooldown.update = async (fn) => { entered.resolve(); await write.promise; return update(fn); };
    const result = exchangeGmailRefresh({ fetch: ctx.fetch, google: ctx.google, url: `${h.origin}/token`, clientId: "synthetic", clientSecret: null, refreshToken: "synthetic", signal: abort.signal }).catch((error: unknown) => error);
    await entered.promise;
    abort.abort();
    expect(await result).toMatchObject({ status: 429, retryable: true, network: false, httpResponse: { request: { endpoint: "oauth-token", purpose: "refresh" }, status: 429 } });
    await expect((await h.backend.provider(h.account.id))!.verify()).rejects.toBeInstanceOf(ProviderCooldownError);
    expect(h.requests).toEqual(["/token"]);
    write.resolve();
  });

});
