import { ProviderCooldown } from "./provider-cooldown";
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

async function setup(kind: "SQL" | "IndexedDB", autoSync = false) {
  let offset = 0;
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
  const open = async () => new Backend({ dbPath: join(dir, "mail.db"), store: kind === "IndexedDB" ? await IdbMailStore.open({ name, factory, platform, instantSearch: false }) : undefined, platform, providers, cipher: plaintextCipher, version: "test", autoSync, now: () => Date.now() + offset, instantSearch: false, iconTransport: null });
  let backend = await open();
  const { account } = await backend.store.accounts.create({ kind: "gmail", email: "synthetic@example.test", displayName: "Synthetic", color: "indigo", providerConfig: {}, now: 1 });
  await backend.store.settings.set("app", { gmailClientId: "synthetic" });
  await backend.setSecret(`account:${account.id}:refreshToken`, "synthetic-refresh");
  cleanup.push(async () => {
    try { await backend.stop(); }
    finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
  });
  return { time(value: number) { offset = value - Date.now(); }, contexts, origin, answer(fn: typeof answer) { answer = fn; }, get backend() { return backend; }, account, requests, async reopen() { await backend.stop(); backend = await open(); } };
}

function healthyProfile(_req: IncomingMessage, res: ServerResponse) {
  if (_req.url !== "/gmail/profile") return false;
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ emailAddress: "synthetic@example.test", historyId: "1" }));
  return true;
}

for (const kind of ["SQL", "IndexedDB"] as const) describe(`${kind} saved Gmail cooldown`, () => {
  it("W05 automatically retries token503 through the existing worker timer", async () => {
    const h = await setup(kind, true);
    let tokens = 0;
    h.answer((req, res) => {
      if (req.url === "/token" && ++tokens === 1) { res.writeHead(503).end("{}"); return true; }
      if (req.url === "/gmail/messages/send") { res.writeHead(200).end(JSON.stringify({ id: "sent", threadId: "sent-thread" })); return true; }
      return healthyProfile(req, res);
    });
    const [local, remote] = createMemoryTransportPair();
    h.backend.connect(remote, { clientId: "synthetic", origin: "renderer" });
    const rpc = new RpcClient(local); cleanup.push(async () => rpc.close());
    const { opId } = await rpc.call("compose.send", { accountId: h.account.id, to: [{ email: "recipient@example.test", name: "" }], subject: "Synthetic", bodyText: "Synthetic" });
    await vi.waitFor(async () => expect(await h.backend.store.ops.get(opId)).toMatchObject({ state: "succeeded", attempts: 2 }), { timeout: 8000 });
    expect(h.requests).toEqual(["/token", "/token", "/gmail/profile", "/gmail/messages/send"]);
  });

  for (const status of [200, 503]) it(`W05 keeps optional malformed/503 labels failure optional (${status})`, async () => {
    const h = await setup(kind);
    h.answer((req, res) => {
      if (healthyProfile(req, res)) return true;
      if (req.url?.startsWith("/gmail/messages?") || req.url?.startsWith("/gmail/history?")) { res.writeHead(200).end(JSON.stringify({ messages: [], historyId: "1" })); return true; }
      if (req.url === "/gmail/labels") { res.writeHead(status).end("{}"); return true; }
      return false;
    });
    await h.backend.syncAccount(h.account.id);
    expect(h.requests.at(-1)).toBe("/gmail/labels");
    expect((await h.backend.store.accounts.get(h.account.id))!.syncState.status).toBe("idle");
    expect(JSON.parse((await h.backend.store.providerCooldown.read()) ?? "{}").rows ?? []).toEqual([]);
  });

  for (const status of [400, 429]) it(`W05 retains real unverified OAuth constraints (${status})`, async () => {
    const h = await setup(kind);
    h.answer((req, res) => {
      if (req.url !== "/token") return false;
      res.writeHead(status, { "retry-after": "120" }).end(JSON.stringify({ error: "invalid_grant" })); return true;
    });
    const [local, remote] = createMemoryTransportPair();
    h.backend.connect(remote, { clientId: "synthetic", origin: "renderer" });
    const rpc = new RpcClient(local); cleanup.push(async () => rpc.close());
    const { opId } = await rpc.call("compose.send", { accountId: h.account.id, to: [{ email: "recipient@example.test", name: "" }], subject: "Synthetic", bodyText: "Synthetic" });
    expect(await h.backend.runWorker()).toBe(1);
    const before = await h.backend.store.ops.get(opId);
    const ledger = await h.backend.store.providerCooldown.read();
    expect(await h.backend.runWorker()).toBe(0);
    expect(await h.backend.store.ops.get(opId)).toEqual(before);
    expect(await h.backend.store.providerCooldown.read()).toBe(ledger);
    expect(h.requests).toEqual(["/token"]);
    expect((await h.backend.store.accounts.get(h.account.id))!.syncState.authRequired === true).toBe(status === 400);
  });

  it("W05 retries a token503 queued send on its existing backoff without an unrelated sync", async () => {
    const h = await setup(kind);
    let tokens = 0;
    h.answer((req, res) => {
      if (req.url === "/token" && ++tokens === 1) { res.writeHead(503).end("{}"); return true; }
      if (req.url === "/gmail/messages/send") { res.writeHead(200).end(JSON.stringify({ id: "sent", threadId: "sent-thread" })); return true; }
      return healthyProfile(req, res);
    });
    const [local, remote] = createMemoryTransportPair();
    h.backend.connect(remote, { clientId: "synthetic", origin: "renderer" });
    const rpc = new RpcClient(local); cleanup.push(async () => rpc.close());
    const { opId } = await rpc.call("compose.send", { accountId: h.account.id, to: [{ email: "recipient@example.test", name: "" }], subject: "Synthetic", bodyText: "Synthetic" });
    const original = (await h.backend.store.ops.get(opId))!;
    expect(await h.backend.runWorker()).toBe(1);
    const failed = (await h.backend.store.ops.get(opId))!;
    expect(failed).toMatchObject({ state: "queued", attempts: 1, payload_json: original.payload_json, target_json: original.target_json });
    expect(failed.next_attempt_at).toBeGreaterThan(original.next_attempt_at);
    expect((await h.backend.store.accounts.get(h.account.id))?.syncState.authRequired).not.toBe(true);
    expect(await h.backend.runWorker()).toBe(0);
    expect(h.requests).toEqual(["/token"]);
    h.time(failed.next_attempt_at);
    expect(await h.backend.runWorker()).toBe(1);
    expect(await h.backend.store.ops.get(opId)).toMatchObject({ state: "succeeded", attempts: 2, payload_json: original.payload_json });
    expect(JSON.parse((await h.backend.store.ops.get(opId))!.target_json)).toEqual({ ...JSON.parse(original.target_json), submissionAccepted: true });
    expect(h.requests).toEqual(["/token", "/token", "/gmail/profile", "/gmail/messages/send"]);
    expect(await h.backend.runWorker()).toBe(0);
  });

  it("W05 exposes labels429 as an account error while retaining its durable deadline", async () => {
    const h = await setup(kind);
    h.answer((req, res) => {
      if (healthyProfile(req, res)) return true;
      if (req.url?.startsWith("/gmail/messages?") || req.url?.startsWith("/gmail/history?")) { res.writeHead(200).end(JSON.stringify({ messages: [], historyId: "1" })); return true; }
      return false;
    });
    await h.backend.syncAccount(h.account.id);
    expect(h.requests.at(-1)).toBe("/gmail/labels");
    const state = (await h.backend.store.accounts.get(h.account.id))!.syncState;
    expect(state).toMatchObject({ status: "error", connection: null });
    expect(state.lastErrorI18n).toMatchObject({ key: "errors.gmail.requestFailed", params: { status: 429 } });
    expect(state.authRequired).not.toBe(true);
    const ledger = (await h.backend.store.providerCooldown.read())!;
    const row = JSON.parse(ledger).rows.find((r: { service: string }) => r.service === "gmail-api");
    expect(BigInt(row.minimum)).toBeGreaterThan(0n);
    const before = [...h.requests];
    await h.backend.syncAccount(h.account.id);
    expect(h.requests).toEqual(before);
    expect(await h.backend.store.providerCooldown.read()).toBe(ledger);
    expect((await h.backend.store.accounts.get(h.account.id))!.syncState.status).toBe("error");
    // Both clocks must satisfy the durable floor/replay. A new explicit sync is the recovery event.
    const elapsed = performance.now();
    h.time(Number(row.minimum) + 180_000);
    vi.spyOn(performance, "now").mockReturnValue(elapsed + 360_000);
    h.answer((req, res) => {
      if (req.url === "/gmail/labels") { res.writeHead(200).end(JSON.stringify({ labels: [] })); return true; }
      if (req.url?.startsWith("/gmail/history?")) { res.writeHead(200).end(JSON.stringify({ historyId: "1" })); return true; }
      return healthyProfile(req, res);
    });
    await h.backend.syncAccount(h.account.id);
    expect(h.requests.at(-1)).toBe("/gmail/labels");
    expect((await h.backend.store.accounts.get(h.account.id))!.syncState).toMatchObject({ status: "idle", lastError: null });
  });

  for (const retire of ["credentials", "lifetime"] as const) it(`W05 late labels429 cannot publish after retiring ${retire}`, async () => {
    const h = await setup(kind);
    const entered = latch(); let held: ServerResponse | undefined;
    cleanup.push(async () => { if (held && !held.writableEnded) held.end("{}"); });
    h.answer((req, res) => {
      if (healthyProfile(req, res)) return true;
      if (req.url?.startsWith("/gmail/messages?") || req.url?.startsWith("/gmail/history?")) { res.writeHead(200).end(JSON.stringify({ messages: [], historyId: "1" })); return true; }
      if (req.url === "/gmail/labels") { held = res; entered.resolve(); return true; }
      return false;
    });
    const syncing = h.backend.syncAccount(h.account.id);
    await entered.promise;
    if (retire === "credentials") await h.backend.signedIn(h.account.id);
    const dropping = retire === "lifetime" ? h.backend.dropAccount(h.account.id) : Promise.resolve();
    const before = (await h.backend.store.accounts.get(h.account.id))!.syncState;
    held!.writeHead(429, { "retry-after": "120" }).end("{}");
    await dropping;
    await syncing;
    expect((await h.backend.store.accounts.get(h.account.id))!.syncState).toEqual(before);
  });

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


  it("R1 does not cache a pre-dispatch OAuth denial after admission becomes ready", async () => {
    const h = await setup(kind); h.answer(healthyProfile);
    const provider = (await h.backend.provider(h.account.id))!;
    const google = h.contexts.get(h.account.id)!.google!;
    const check = google.check;
    let denied = true;
    vi.spyOn(google, "check").mockImplementation((request) => {
      if (denied && request.endpoint === "oauth-token") throw new ProviderCooldownError("oauth-token", "1", "timed");
      check(request);
    });
    await expect(provider.verify()).rejects.toBeInstanceOf(ProviderCooldownError);
    expect(h.requests).toEqual([]);
    denied = false;
    await provider.verify();
    expect(h.requests).toEqual(["/token", "/gmail/profile"]);
  });

  it("R1 installation OAuth pause blocks a token-dependent bound account without claim/refund loops", async () => {
    const h = await setup(kind); h.answer(healthyProfile);
    await (await h.backend.provider(h.account.id))!.verify();
    const second = (await h.backend.store.accounts.create({ kind: "gmail", email: "other@example.test", displayName: "Other", color: "indigo", now: 2 })).account;
    await h.backend.provider(second.id);
    h.answer((req, res) => {
      if (req.url !== "/installation-quota") return healthyProfile(req, res);
      res.writeHead(429, { "content-type": "application/json", "retry-after": "120" }).end("{}"); return true;
    });
    const quota = await h.contexts.get(second.id)!.google!.request({ request: { endpoint: "oauth-token", purpose: "refresh" } }, `${h.origin}/installation-quota`); await quota.text();
    await h.backend.dropAccount(h.account.id); await h.backend.signedIn(h.account.id);
    await expect((await h.backend.provider(h.account.id))!.verify()).rejects.toBeInstanceOf(ProviderCooldownError);
    const [local, remote] = createMemoryTransportPair();
    h.backend.connect(remote, { clientId: "synthetic", origin: "renderer" });
    const rpc = new RpcClient(local); cleanup.push(async () => rpc.close());
    const { opId } = await rpc.call("compose.send", { accountId: h.account.id, to: [{ email: "recipient@example.test", name: "" }], subject: "Synthetic", bodyText: "Synthetic" });
    const claim = h.backend.store.ops.claimReady;
    let claims = 0;
    vi.spyOn(h.backend.store.ops, "claimReady").mockImplementation(async (...args) => {
      if (++claims > 2) throw new Error("Synthetic claim-loop bound");
      return claim(...args);
    });
    expect(await h.backend.runWorker().catch((error: unknown) => error)).toBe(0);
    expect(claims).toBe(1);
    expect(await h.backend.store.ops.get(opId)).toMatchObject({ state: "queued", attempts: 0 });
    expect(h.requests).toEqual(["/token", "/gmail/profile", "/installation-quota"]);
  });

  it("R1 binding preserves a previously issued installation request's late429", async () => {
    const h = await setup(kind);
    const entered = latch(); let held: ServerResponse | undefined;
    cleanup.push(async () => { if (held && !held.writableEnded) held.end("{}"); });
    h.answer((req, res) => {
      if (req.url !== "/late-token") return healthyProfile(req, res);
      held = res; entered.resolve(); return true;
    });
    const provider = (await h.backend.provider(h.account.id))!;
    const google = h.contexts.get(h.account.id)!.google!;
    const late = google.request({ request: { endpoint: "oauth-token", purpose: "refresh" } }, `${h.origin}/late-token`).catch((error: unknown) => error);
    await entered.promise;
    await provider.verify();
    held!.writeHead(429, { "content-type": "application/json", "retry-after": "120" }).end("{}");
    const response = await late;
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(429); await (response as Response).text();
    await expect(google.request({ request: { endpoint: "oauth-token", purpose: "refresh" } }, `${h.origin}/token`)).rejects.toBeInstanceOf(ProviderCooldownError);
    expect(JSON.parse((await h.backend.store.providerCooldown.read())!).rows).toEqual(expect.arrayContaining([expect.objectContaining({ owner: "installation", service: "oauth-token" })]));
  });

  it("R1 public photos still reach a ready service during a Gmail-only cooldown", async () => {
    const original = globalThis.fetch;
    let userinfo = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== "https://openidconnect.googleapis.com/v1/userinfo") return original(input, init);
      userinfo++;
      return Promise.resolve(new Response(JSON.stringify({ picture: "https://lh3.googleusercontent.com/synthetic=s64" }), { headers: { "content-type": "application/json" } }));
    });
    const h = await setup(kind); h.answer(healthyProfile);
    const provider = (await h.backend.provider(h.account.id))!; await provider.verify();
    h.answer(undefined);
    await expect(provider.verify()).rejects.toMatchObject({ status: 429 });
    expect(await provider.photos!({ connections: false, otherContacts: false })).toMatchObject({ own: "https://lh3.googleusercontent.com/synthetic=s128" });
    expect(userinfo).toBe(1);
    expect(h.requests).toEqual(["/token", "/gmail/profile", "/gmail/profile"]);
  });

  it("R1 rejects stale proof publication across bound-policy preparation", async () => {
    const h = await setup(kind); h.answer(healthyProfile);
    const entered = latch(), publish = latch();
    cleanup.push(async () => publish.resolve());
    const original = ProviderCooldown.prototype.requestsForAccount;
    vi.spyOn(ProviderCooldown.prototype, "requestsForAccount").mockImplementationOnce(async function (this: ProviderCooldown, ...args) {
      const replacement = await original.call(this, ...args);
      entered.resolve(); await publish.promise; return replacement;
    });
    const provider = (await h.backend.provider(h.account.id))!;
    const result = provider.verify().catch((error: unknown) => error);
    await entered.promise;
    await h.backend.signedIn(h.account.id);
    publish.resolve();
    expect(await result).toBeInstanceOf(ProviderCooldownError);
    await expect(provider.verify()).rejects.toBeInstanceOf(ProviderCooldownError);
    expect(h.requests).toEqual(["/token", "/gmail/profile"]);
  });


  it("R2 stale initialization cannot replace a paused new lifetime and spin operation admission", async () => {
    const h = await setup(kind); h.answer(healthyProfile);
    const entered = latch(), factory = latch();
    cleanup.push(async () => factory.resolve());
    const bindingFor = ProviderCooldown.prototype.bindingFor;
    vi.spyOn(ProviderCooldown.prototype, "bindingFor").mockImplementationOnce(async function (this: ProviderCooldown, ...args) {
      const owner = await bindingFor.call(this, ...args);
      entered.resolve(); await factory.promise; return owner;
    });
    const stale = h.backend.provider(h.account.id);
    await entered.promise;
    await h.backend.dropAccount(h.account.id);
    await h.backend.signedIn(h.account.id);
    const provider = (await h.backend.provider(h.account.id))!;
    vi.spyOn(h.backend.store.providerCooldown, "bind").mockRejectedValueOnce(new Error("Synthetic binding failure"));
    await expect(provider.verify()).rejects.toBeInstanceOf(ProviderCooldownError);
    factory.resolve();
    expect(await stale).toBeNull();
    const [local, remote] = createMemoryTransportPair();
    h.backend.connect(remote, { clientId: "synthetic", origin: "renderer" });
    const rpc = new RpcClient(local); cleanup.push(async () => rpc.close());
    const { opId } = await rpc.call("compose.send", { accountId: h.account.id, to: [{ email: "recipient@example.test", name: "" }], subject: "Synthetic", bodyText: "Synthetic" });
    const claim = h.backend.store.ops.claimReady; let claims = 0;
    vi.spyOn(h.backend.store.ops, "claimReady").mockImplementation(async (...args) => {
      if (++claims > 2) throw new Error("Synthetic stale-lifetime claim-loop bound");
      return claim(...args);
    });
    expect(await h.backend.runWorker().catch((error: unknown) => error)).toBe(0);
    expect(claims).toBe(1);
    expect(await h.backend.store.ops.get(opId)).toMatchObject({ state: "queued", attempts: 0 });
    expect(h.requests).toEqual(["/token", "/gmail/profile"]);
  });

});
