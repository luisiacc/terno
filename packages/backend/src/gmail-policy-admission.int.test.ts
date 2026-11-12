import "fake-indexeddb/auto";
import { IdbMailStore } from "@terno/idb";
import { IDBFactory } from "fake-indexeddb";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { createGmailProvider, inspectGmailToken, ProviderAuthError, ProviderError, type ProviderContext, type ProviderRegistry } from "@terno/mail";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { SYNC_INTERVAL_MS } from "./core";
import { onSqlite } from "./test/store-axis";

// plan 123: only Terno's own Google clients exist; tests carry a synthetic one
const TEST_GOOGLE = { preferred: "synthetic-client", clients: [{ clientId: "synthetic-client", clientSecret: "" }] };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  try { for (const close of cleanups.splice(0).reverse()) await close(); }
  finally { vi.restoreAllMocks(); }
});
const privateMarker = "PRIVATE_PROVIDER_synthetic@example.test";
const failure = (status: number, reason: string) => Response.json({ error: { code: status, message: privateMarker, errors: [{ reason }], details: [{ reason }] } }, { status, headers: { "retry-after": "120" } });

function healthySync(r: Request): Response | undefined {
  const path = new URL(r.url).pathname;
  if (path === "/gmail/messages") return Response.json({});
  if (path === "/gmail/history") return Response.json({ historyId: "10" });
  if (path === "/gmail/labels") return Response.json({ labels: [] });
}

function heldJson(status: number, value: unknown) {
  let controller!: ReadableStreamDefaultController<Uint8Array>, entered = false, released = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(c) { controller = c; }, pull() { entered = true; }, cancel() { released = true; },
  }, { highWaterMark: 0 }), { status, headers: { "content-type": "application/json" } });
  return { response, get entered() { return entered; }, release() {
    if (released) return;
    released = true;
    controller.enqueue(new TextEncoder().encode(JSON.stringify(value))); controller.close();
  } };
}

async function setup(autoSync = false, kind: "SQL" | "IDB" = "SQL") {
  const requests: Request[] = [], unexpected: string[] = [];
  let answer: ((request: Request) => Response | undefined) | undefined;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (!(input instanceof Request)) throw new Error("Expected managed native Request");
    requests.push(input);
    if (new URL(input.url).origin !== "https://synthetic.invalid") { unexpected.push(input.url); throw new Error("Unexpected origin"); }
    const response = answer?.(input);
    if (response) return response;
    const path = new URL(input.url).pathname;
    if (path === "/token") return Response.json({ access_token: "synthetic-access", token_type: "Bearer", expires_in: 3600 });
    if (path === "/gmail/profile") return Response.json({ emailAddress: "synthetic@example.test", historyId: "10" });
    if (path === "/gmail/messages/send") return Response.json({ id: "sent", threadId: "sent-thread" });
    if (path === "/hold") return new Response("held");
    unexpected.push(input.url); throw new Error("Unexpected route");
  });
  let context!: ProviderContext;
  const providers: ProviderRegistry = {
    create(ctx) { context = ctx; return createGmailProvider(ctx, { endpoints: { token: "https://synthetic.invalid/token", api: "https://synthetic.invalid/gmail", userinfo: "https://synthetic.invalid/userinfo" } }); },
    async verifyImap() {}, async connectGmail() { throw new Error("Unexpected OAuth flow"); },
  };
  const dir = mkdtempSync(join(tmpdir(), "terno-policy-recovery-"));
  const name = crypto.randomUUID(), factory = new IDBFactory();
  const openStore = async () => kind === "IDB" ? await IdbMailStore.open({ name, factory, platform: { uuid: () => crypto.randomUUID(), yield: async () => {} }, instantSearch: false }) : undefined;
  const open = async () => new Backend({ googleClients: TEST_GOOGLE, store: await openStore(), dbPath: join(dir, "test.db"), providers, cipher: plaintextCipher, version: "test", autoSync, instantSearch: false, iconTransport: null });
  let backend = await open();
  cleanups.push(async () => { await backend.stop(); rmSync(dir, { recursive: true, force: true }); expect(unexpected).toEqual([]); });
  await backend.ready;
  const { account } = await backend.store.accounts.create({ kind: "gmail", email: "synthetic@example.test", displayName: "Synthetic", color: "brown", providerConfig: {}, now: 1 });
  await backend.setSecret(`account:${account.id}:refreshToken`, "synthetic-refresh");
  const connect = () => {
    const [local, remote] = createMemoryTransportPair();
    backend.connect(remote, { clientId: "synthetic", origin: "renderer" });
    return new RpcClient(local);
  };
  let rpc = connect(); cleanups.push(async () => rpc.close());
  const send = () => rpc.call("compose.send", { accountId: account.id, to: [{ email: "recipient@example.test", name: "" }], subject: "Exact subject", bodyText: "Exact body" });
  return { get backend() { return backend; }, account, get rpc() { return rpc; }, send, requests, async reopen() { rpc.close(); await backend.stop(); backend = await open(); await backend.ready; rpc = connect(); }, get context() { return context; }, answer(fn: typeof answer) { answer = fn; }, paths: () => requests.map((r) => new URL(r.url).pathname) };
}

function followupHealthy(request: Request): Response | undefined {
  if (new URL(request.url).pathname === "/gmail/messages/sent") return Response.json({ id: "sent", threadId: "sent-thread", labelIds: ["SENT"] });
  if (new URL(request.url).pathname === "/userinfo") return Response.json({ sub: "synthetic-sub", email: "synthetic@example.test", email_verified: true, name: "Synthetic" });
  return healthySync(request);
}

function followupReconnect(h: Awaited<ReturnType<typeof setup>>, proof?: () => void) {
  h.backend.options.openExternal = async () => {};
  return vi.spyOn(h.backend.options.providers, "connectGmail").mockImplementation(async (options) => {
    const google = await h.backend.initialGoogleRequests(false, h.account.id);
    try {
      const who = await inspectGmailToken("synthetic-proof-access", options.fetch, {
        signal: options.signal, google,
        endpoints: { api: "https://synthetic.invalid/gmail", userinfo: "https://synthetic.invalid/userinfo" },
      });
      proof?.();
      return { ...who, refreshToken: "synthetic-reconnected", grantedScopes: ["https://www.googleapis.com/auth/gmail.modify"] };
    } finally { google.close(); }
  });
}

for (const kind of ["SQL", "IDB"] as const) describe(`${kind} W05 saved-account reason-aware recovery boundaries`, () => {
  const sqlite = onSqlite(kind);
  sqlite.each([
    [403, "SERVICE_DISABLED", false, "SERVICE_DISABLED"],
    [403, "accessNotConfigured", false, "SERVICE_DISABLED"],
    [400, "failedPrecondition", false, undefined],
    [400, "badRequest", false, undefined],
    [403, "domainPolicy", false, "DOMAIN_POLICY"],
    [403, "userRateLimitExceeded", true, undefined],
    [403, "rateLimitExceeded", true, undefined],
    [503, "backendError", true, undefined],
    [404, "notFound", false, undefined],
  ] as const)("unbound proof %i/%s preserves identity and uses retryability=%s", async (status, reason, retryable, mapped) => {
    const h = await setup(false, kind);
    h.answer((r) => new URL(r.url).pathname === "/gmail/profile" ? failure(status, reason) : undefined);
    await h.backend.ingestSliced([{
      accountId: h.account.id, providerMsgId: "cached", providerThreadId: "cached", rfcMessageId: "cached@example.test", inReplyTo: null, references: [],
      from: { name: "Sender", email: "sender@example.test" }, to: [], cc: [], bcc: [], subject: "Cached subject", date: 1,
      snippet: "Cached body", bodyText: "Cached body", bodyHtml: null, bodyState: "full", listId: null,
      isRead: true, isStarred: true, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 11,
    }]);
    await h.backend.store.accounts.setCursor(h.account.id, { historyId: "9" });
    const mailBefore = await h.rpc.call("threads.list", { view: "inbox", limit: 100 });
    const configBefore = await h.backend.store.accounts.config(h.account.id);
    const stamp = await h.backend.store.accounts.stamp(h.account.id);
    const secret = await h.backend.store.secrets.get(`account:${h.account.id}:refreshToken`);
    const draft = await h.rpc.call("drafts.save", { accountId: h.account.id, subject: "Keep draft", bodyText: "Keep draft body" });
    const provider = (await h.backend.provider(h.account.id))!;
    let error: unknown;
    const originalSync = provider.sync.bind(provider);
    vi.spyOn(provider, "sync").mockImplementation(async (sink) => { try { await originalSync(sink); } catch (caught) { error = caught; throw caught; } });
    const failed = vi.spyOn(h.backend.connectivity, "failed");
    await h.backend.syncAccount(h.account.id);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).not.toBeInstanceOf(ProviderAuthError);
    expect(error).toMatchObject({ status, retryable, ambiguous: false, network: false });
    expect((error as { reason?: string }).reason).toBe(mapped);
    expect(failed).toHaveBeenCalledTimes(status === 503 ? 1 : 0);
    const projection = await h.rpc.call("app.bootstrap", {});
    expect(projection.accounts[0]!.syncState.authRequired).not.toBe(true);
    expect(projection.accounts[0]!.syncState.lastErrorI18n).toEqual(mapped ? { key: mapped === "DOMAIN_POLICY" ? "errors.gmail.adminPolicy" : "errors.gmail.serviceDisabled" } : { key: "errors.gmail.requestFailed", params: { status } });
    if (mapped === "SERVICE_DISABLED") expect(projection.accounts[0]!.syncState.lastError).toMatch(/enable|administrator/i);
    expect(JSON.stringify(projection)).not.toContain(privateMarker);
    expect(await h.rpc.call("threads.list", { view: "inbox", limit: 100 })).toEqual(mailBefore);
    expect(await h.backend.store.accounts.config(h.account.id)).toEqual(configBefore);
    expect(await h.backend.store.accounts.stamp(h.account.id)).toEqual(stamp);
    expect(await h.backend.store.secrets.get(`account:${h.account.id}:refreshToken`)).toEqual(secret);
    expect(await h.rpc.call("drafts.list", {})).toEqual([draft]);
    expect(h.paths()).toEqual(["/token", "/gmail/profile"]);
    expect(JSON.parse((await h.backend.store.providerCooldown.read()) ?? "{}").bindings ?? []).toEqual([]);
  });

  it.each([[403, "domainPolicy", "failed"], [403, "userRateLimitExceeded", "queued"], [503, "backendError", "unknown"]] as const)("bound send %i/%s retains payload and settles %s without OAuth replacement", async (status, reason, state) => {
    const h = await setup(false, kind);
    await (await h.backend.provider(h.account.id))!.verify();
    h.answer((r) => new URL(r.url).pathname === "/gmail/messages/send" ? failure(status, reason) : undefined);
    const { opId } = await h.send();
    const original = (await h.backend.store.ops.get(opId))!;
    expect(await h.backend.runWorker()).toBe(1);
    const after = (await h.backend.store.ops.get(opId))!;
    expect(after).toMatchObject({ state, attempts: 1, payload_json: original.payload_json, target_json: original.target_json });
    expect(await h.backend.runWorker()).toBe(0);
    expect(h.paths()).toEqual(["/token", "/gmail/profile", "/gmail/messages/send"]);
    expect((await h.rpc.call("app.bootstrap", {})).accounts[0]!.syncState.authRequired).not.toBe(true);
    expect(await h.backend.getSecret(`account:${h.account.id}:refreshToken`)).toBe("synthetic-refresh");
    if (state !== "queued") expect(JSON.parse((await h.backend.store.providerCooldown.read()) ?? "{}").rows ?? []).toEqual([]);
    if (state === "queued") {
      expect(after.next_attempt_at).toBeGreaterThanOrEqual(Date.now() + 119_000);
      const now = vi.spyOn(h.backend.options, "now").mockReturnValue(after.next_attempt_at + 120_000);
      vi.spyOn(performance, "now").mockReturnValue(performance.now() + 240_000);
      h.answer(healthySync);
      await h.backend.retryNow(h.account.id, "user");
      await h.backend.syncAccount(h.account.id);
      expect(await h.backend.runWorker()).toBe(1);
      expect(await h.backend.store.ops.get(opId)).toMatchObject({ state: "succeeded", attempts: 2, payload_json: original.payload_json });
      expect(h.paths().filter((path) => path === "/gmail/messages/send")).toHaveLength(2);
      now.mockRestore();
    }
  });

  sqlite("disabled Gmail suppresses ordinary periodic HTTP", async () => {
    const intervals = vi.spyOn(globalThis, "setInterval");
    const h = await setup(true, kind);
    h.answer((r) => new URL(r.url).pathname === "/gmail/profile" ? failure(403, "SERVICE_DISABLED") : undefined);
    const syncing = vi.spyOn(h.backend, "syncAccount");
    await h.backend.start();
    await vi.waitFor(() => expect(syncing).toHaveBeenCalled());
    await syncing.mock.results[0]!.value;
    expect(h.paths()).toEqual(["/token", "/gmail/profile"]);
    // (plan 191: the ordinary poll is SYNC_INTERVAL_MS, 40 s now, not the 2 minutes it was)
    const poll = intervals.mock.calls.find((call) => call[1] === SYNC_INTERVAL_MS)?.[0];
    expect(poll).toBeTypeOf("function");
    if (typeof poll !== "function") throw new Error("Missing ordinary poll callback");
    poll();
    await vi.waitFor(() => expect(syncing).toHaveBeenCalledTimes(2));
    await syncing.mock.results[1]!.value;
    expect(h.paths()).toEqual(["/token", "/gmail/profile"]);
    expect((await h.rpc.call("app.bootstrap", {})).accounts[0]!.syncState).toMatchObject({ status: "error", connection: null });
  });

  it("quota403 survives reopen, preserves the exact queued work and admits an independent account", async () => {
    const h = await setup(false, kind);
    await (await h.backend.provider(h.account.id))!.verify();
    h.answer((r) => new URL(r.url).pathname === "/gmail/messages/send" ? failure(403, "rateLimitExceeded") : undefined);
    const { opId } = await h.send();
    await h.backend.runWorker();
    const queued = await h.backend.store.ops.get(opId);
    const ledger = await h.backend.store.providerCooldown.read();
    expect(JSON.parse(ledger!).rows).toHaveLength(1);
    await h.reopen();
    const paths = h.paths().slice();
    expect(await h.backend.runWorker()).toBe(0);
    expect(await h.backend.store.ops.get(opId)).toEqual(queued);
    expect(await h.backend.store.providerCooldown.read()).toBe(ledger);
    expect(h.paths()).toEqual(paths);
    const other = await h.backend.store.accounts.create({ kind: "gmail", email: "other@example.test", displayName: "Other", color: "brown", providerConfig: {}, now: 2 });
    await h.backend.setSecret(`account:${other.account.id}:refreshToken`, "synthetic-other");
    h.answer((r) => new URL(r.url).pathname === "/gmail/profile" ? Response.json({ emailAddress: "other@example.test", historyId: "10" }) : undefined);
    const next = await h.rpc.call("compose.send", { accountId: other.account.id, to: [{ email: "recipient@example.test", name: "" }], subject: "Other", bodyText: "Other" });
    expect(await h.backend.runWorker()).toBe(1);
    expect(await h.backend.store.ops.get(next.opId)).toMatchObject({ state: "succeeded", attempts: 1 });
    expect(await h.backend.store.ops.get(opId)).toEqual(queued);
  });

  sqlite("credential replacement retires the policy pause on a retained provider", async () => {
    const h = await setup(false, kind);
    h.answer((r) => new URL(r.url).pathname === "/gmail/profile" ? failure(403, "SERVICE_DISABLED") : undefined);
    await h.backend.syncAccount(h.account.id);
    const provider = await h.backend.provider(h.account.id);
    const { opId } = await h.send();
    expect(await h.backend.runWorker()).toBe(0);
    await h.backend.signedIn(h.account.id);
    expect(await h.backend.provider(h.account.id)).toBe(provider);
    h.answer(healthySync);
    expect(await h.backend.runWorker()).toBe(1);
    expect(await h.backend.store.ops.get(opId)).toMatchObject({ state: "succeeded", attempts: 1 });
  });

  sqlite.each(["SERVICE_DISABLED", "userRateLimitExceeded", "insufficientPermissions"])("stale %s body cannot publish after credential replacement", async (reason) => {
    const h = await setup(false, kind);
    await (await h.backend.provider(h.account.id))!.verify();
    let release!: () => void, entered!: () => void;
    const ready = new Promise<void>((r) => { entered = r; });
    h.answer((r) => new URL(r.url).pathname === "/gmail/history" ? new Response(new ReadableStream({ start(controller) { release = () => { controller.enqueue(new TextEncoder().encode(JSON.stringify({ error: { errors: [{ reason }] } }))); controller.close(); }; entered(); } }), { status: 403, headers: { "retry-after": "120" } }) : undefined);
    await h.backend.store.accounts.setCursor(h.account.id, { historyId: "9" });
    const syncing = h.backend.syncAccount(h.account.id);
    await ready;
    await h.backend.signedIn(h.account.id);
    h.answer(healthySync);
    release();
    await syncing;
    expect(JSON.parse((await h.backend.store.providerCooldown.read())!).rows).toEqual([]);
    const { opId } = await h.send();
    expect(await h.backend.runWorker()).toBe(1);
    expect(await h.backend.store.ops.get(opId)).toMatchObject({ state: "succeeded", attempts: 1 });
  });

  sqlite.each(["SERVICE_DISABLED", "userRateLimitExceeded"])("labels %s stays nonidle and never advances through a policy error", async (reason) => {
    const h = await setup(false, kind);
    h.answer((r) => new URL(r.url).pathname === "/gmail/labels" ? failure(403, reason) : healthySync(r));
    await h.backend.syncAccount(h.account.id);
    const state = (await h.rpc.call("app.bootstrap", {})).accounts[0]!.syncState;
    expect(state).toMatchObject({ status: "error", connection: null });
    expect(state.lastErrorI18n).toEqual(reason === "SERVICE_DISABLED" ? { key: "errors.gmail.serviceDisabled" } : { key: "errors.gmail.requestFailed", params: { status: 403 } });
    const calls = h.paths().slice();
    const writes = vi.spyOn(h.backend.store.accounts, "setSyncState");
    await h.backend.syncAccount(h.account.id);
    expect(h.paths()).toEqual(calls);
    if (reason === "SERVICE_DISABLED") expect(writes).not.toHaveBeenCalled();
  });

  sqlite("optional userinfo permission failure does not pause Gmail mail", async () => {
    const h = await setup(false, kind);
    const provider = (await h.backend.provider(h.account.id))!;
    await provider.verify();
    h.answer((r) => new URL(r.url).pathname.includes("userinfo") ? failure(403, "insufficientPermissions") : undefined);
    await provider.photos!({ connections: false, otherContacts: false });
    const { opId } = await h.send();
    expect(await h.backend.runWorker()).toBe(1);
    expect(await h.backend.store.ops.get(opId)).toMatchObject({ state: "succeeded", attempts: 1 });
  });

  sqlite.each(["insufficientPermissions", "ACCESS_TOKEN_SCOPE_INSUFFICIENT"])("plan 184: a mail 403 %s asks for a sign-in, not Retry now: nothing more goes, sends wait, signing in again sends", async (reason) => {
    const h = await setup(false, kind);
    await (await h.backend.provider(h.account.id))!.verify();
    await h.backend.store.accounts.setCursor(h.account.id, { historyId: "9" });
    h.answer((r) => new URL(r.url).pathname === "/gmail/history" ? failure(403, reason) : healthySync(r));
    await h.backend.syncAccount(h.account.id);
    const state = (await h.rpc.call("app.bootstrap", {})).accounts[0]!.syncState;
    expect(state).toMatchObject({ status: "error", authRequired: true, authScope: null, lastErrorI18n: { key: "errors.gmail.permissionRequired" } });
    expect(JSON.stringify(state)).not.toContain(privateMarker);
    // a sign-in, not a pause: Retry now's policy recovery can't lift it, nothing else knocks
    const calls = h.paths().slice();
    const { opId } = await h.send();
    await h.backend.runWorker();
    await h.backend.retryNow(h.account.id, "user");
    await h.backend.syncAccount(h.account.id);
    expect(h.paths()).toEqual(calls);
    expect(await h.backend.store.ops.get(opId)).toMatchObject({ state: "queued", attempts: 0 });
    expect((await h.rpc.call("app.bootstrap", {})).accounts[0]!.syncState).toMatchObject({ authRequired: true });
    h.answer(healthySync);
    await h.backend.signedIn(h.account.id);
    await h.backend.runWorker();
    expect(await h.backend.store.ops.get(opId)).toMatchObject({ state: "succeeded", attempts: 1 });
    expect(h.paths().filter((path) => path === "/gmail/messages/send")).toHaveLength(1);
  });

  sqlite("plan 184: quota keeps precedence over a missing scope in one 403 (a wait, never a sign-in)", async () => {
    const h = await setup(false, kind);
    await (await h.backend.provider(h.account.id))!.verify();
    await h.backend.store.accounts.setCursor(h.account.id, { historyId: "9" });
    const both = { error: { code: 403, message: privateMarker, errors: [{ reason: "insufficientPermissions" }, { reason: "rateLimitExceeded" }], details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } };
    h.answer((r) => new URL(r.url).pathname === "/gmail/history" ? Response.json(both, { status: 403, headers: { "retry-after": "120" } }) : healthySync(r));
    await h.backend.syncAccount(h.account.id);
    expect((await h.rpc.call("app.bootstrap", {})).accounts[0]!.syncState.authRequired).not.toBe(true);
  });

  sqlite("plan 184: a missing scope refusal holds the account before its ticket admits a sibling request", async () => {
    const h = await setup(false, kind);
    await (await h.backend.provider(h.account.id))!.verify();
    await h.backend.store.accounts.setCursor(h.account.id, { historyId: "9" });
    const scope = heldJson(403, { error: { code: 403, errors: [{ reason: "insufficientPermissions" }] } });
    h.answer((r) => new URL(r.url).pathname === "/gmail/history" ? scope.response : healthySync(r));
    const syncing = h.backend.syncAccount(h.account.id);
    try {
      await vi.waitFor(() => expect(scope.entered).toBe(true));
      const { opId } = await h.send();
      const sending = h.backend.runWorker();
      scope.release();
      await syncing;
      await sending;
      await h.backend.runWorker();
      expect(h.paths()).not.toContain("/gmail/messages/send");
      expect(await h.backend.store.ops.get(opId)).toMatchObject({ state: "queued", attempts: 0 });
    } finally { scope.release(); await syncing; }
  });

  sqlite("contradictory disabled-service reason in a503 remains transient and does not pause admission", async () => {
    const h = await setup(false, kind);
    await (await h.backend.provider(h.account.id))!.verify();
    h.answer((r) => new URL(r.url).pathname === "/gmail/messages/send" ? failure(503, "SERVICE_DISABLED") : undefined);
    const first = await h.send();
    await h.backend.runWorker();
    expect(await h.backend.store.ops.get(first.opId)).toMatchObject({ state: "unknown", attempts: 1 });
    h.answer(undefined);
    const next = await h.send();
    expect(await h.backend.runWorker()).toBe(1);
    expect(await h.backend.store.ops.get(next.opId)).toMatchObject({ state: "succeeded", attempts: 1 });
  });

  it("known quota403 remains definitively rejected when the send deadline expires during persistence", async () => {
    const h = await setup(false, kind);
    await (await h.backend.provider(h.account.id))!.verify();
    h.answer((r) => new URL(r.url).pathname === "/gmail/messages/send" ? failure(403, "userRateLimitExceeded") : undefined);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const update = h.backend.store.providerCooldown.update.bind(h.backend.store.providerCooldown);
    const pending = vi.spyOn(h.backend.store.providerCooldown, "update").mockImplementation(async (fn) => { await gate; return update(fn); });
    const timers = vi.spyOn(globalThis, "setTimeout");
    const { opId } = await h.send();
    const worker = h.backend.runWorker();
    try {
      await vi.waitFor(() => expect(pending).toHaveBeenCalled());
      const deadline = timers.mock.calls.find((call) => call[1] === 15 * 60_000)?.[0];
      expect(deadline).toBeTypeOf("function");
      if (typeof deadline !== "function") throw new Error("Missing send deadline");
      deadline();
    } finally { release(); await worker; }
    expect(await h.backend.store.ops.get(opId)).toMatchObject({ state: "queued", attempts: 1 });
    expect(await h.backend.runWorker()).toBe(0);
    expect(h.paths().filter((path) => path === "/gmail/messages/send")).toHaveLength(1);
  });

  sqlite("a policy rejection first discovered by Send projects actionable account recovery", async () => {
    const h = await setup(false, kind);
    await (await h.backend.provider(h.account.id))!.verify();
    h.answer((r) => new URL(r.url).pathname === "/gmail/messages/send" ? failure(403, "SERVICE_DISABLED") : undefined);
    const { opId } = await h.send();
    await h.backend.runWorker();
    expect(await h.backend.store.ops.get(opId)).toMatchObject({ state: "failed", attempts: 1 });
    expect((await h.rpc.call("app.bootstrap", {})).accounts[0]!.syncState).toMatchObject({ status: "error", lastErrorI18n: { key: "errors.gmail.serviceDisabled" }, connection: null });
  });

  sqlite.each(["final account read", "next provider request"])("a concurrent Send policy refusal survives a sync waiting on its %s", async (boundary) => {
    const h = await setup(false, kind);
    await (await h.backend.provider(h.account.id))!.verify();
    await h.backend.store.accounts.setCursor(h.account.id, { historyId: "9" });
    const first = await h.send();
    let finalRead = false, entered = false, release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const get = h.backend.store.accounts.get.bind(h.backend.store.accounts);
    vi.spyOn(h.backend.store.accounts, "get").mockImplementation(async (id) => {
      const result = await get(id);
      if (boundary === "final account read" && id === h.account.id && finalRead && !entered) {
        entered = true;
        await held;
      }
      return result;
    });
    h.answer((request) => {
      const path = new URL(request.url).pathname;
      if (path === "/gmail/messages/send") return failure(403, "SERVICE_DISABLED");
      if (path === "/gmail/history" && boundary === "next provider request") return new Response(new ReadableStream({
        start(controller) {
          entered = true;
          let released = false;
          release = () => {
            if (released) return;
            released = true;
            controller.enqueue(new TextEncoder().encode('{"historyId":"10"}'));
            controller.close();
          };
        },
      }));
      if (path === "/gmail/labels") finalRead = true;
      return healthySync(request);
    });
    const syncing = h.backend.syncAccount(h.account.id);
    try {
      await vi.waitFor(() => expect(entered).toBe(true));
      expect(await h.backend.runWorker()).toBe(1);
      expect(await h.backend.store.ops.get(first.opId)).toMatchObject({ state: "failed", attempts: 1 });
      const sibling = await h.send();
      const queued = await h.backend.store.ops.get(sibling.opId);
      const refusal = (await h.rpc.call("app.bootstrap", {})).accounts[0]!.syncState;
      expect(refusal).toMatchObject({ status: "error", lastErrorI18n: { key: "errors.gmail.serviceDisabled" }, connection: null });
      release();
      await syncing;
      expect((await h.rpc.call("app.bootstrap", {})).accounts[0]!.syncState).toEqual(refusal);
      const calls = h.paths().slice();
      await h.backend.syncAccount(h.account.id);
      expect(await h.backend.runWorker()).toBe(0);
      expect(h.paths()).toEqual(calls);
      expect(await h.backend.store.ops.get(sibling.opId)).toEqual(queued);
      h.answer(healthySync);
      await h.rpc.call("sync.now", { accountId: h.account.id, reason: "user" });
      await h.backend.syncAccount(h.account.id);
      expect((await h.rpc.call("app.bootstrap", {})).accounts[0]!.syncState).toMatchObject({ status: "idle", lastError: null, lastErrorI18n: null });
      expect(await h.backend.runWorker()).toBe(1);
      expect(await h.backend.store.ops.get(sibling.opId)).toMatchObject({ state: "succeeded", attempts: 1, payload_json: queued!.payload_json });
      expect(await h.backend.store.ops.get(first.opId)).toMatchObject({ state: "failed", attempts: 1 });
      expect(h.paths().filter((path) => path === "/gmail/messages/send")).toHaveLength(2);
    } finally { release(); await syncing; }
  });

  sqlite.each(["SERVICE_DISABLED", "domainPolicy", "insufficientPermissions", "badRequest"])("projects a later %s after the first parallel raw download fails400", async (reason) => {
    const h = await setup(false, kind);
    const provider = (await h.backend.provider(h.account.id))!;
    await provider.verify();
    let retained: unknown;
    const sync = provider.sync.bind(provider);
    vi.spyOn(provider, "sync").mockImplementation(async (sink) => {
      try { await sync(sink); } catch (error) { retained = error; throw error; }
    });
    const held = (status: number, body: unknown) => {
      let controller!: ReadableStreamDefaultController<Uint8Array>, entered = false, released = false;
      const response = new Response(new ReadableStream<Uint8Array>({
        start(c) { controller = c; }, pull() { entered = true; },
      }, { highWaterMark: 0 }), { status });
      return { response, get entered() { return entered; }, release() {
        if (released) return;
        released = true;
        controller.enqueue(new TextEncoder().encode(JSON.stringify(body))); controller.close();
      } };
    };
    const first = held(400, { error: { message: privateMarker } });
    const later = held(reason === "badRequest" ? 400 : 403, { error: { message: privateMarker, errors: [{ reason }] } });
    h.answer((request) => {
      const path = new URL(request.url).pathname;
      if (path === "/gmail/messages") return Response.json({ messages: [{ id: "first", threadId: "first" }, { id: "later", threadId: "later" }] });
      if (path === "/gmail/messages/first") return first.response;
      if (path === "/gmail/messages/later") return later.response;
      return healthySync(request);
    });
    const syncing = h.backend.syncAccount(h.account.id);
    try {
      await vi.waitFor(() => { expect(first.entered).toBe(true); expect(later.entered).toBe(true); });
      first.release();
      // Let the first download's rejection reach the preparation cancellation before the later body settles.
      await new Promise<void>((resolve) => setImmediate(resolve));
      later.release();
      await syncing;
      expect(retained).toMatchObject({ status: 400, i18n: { key: "errors.gmail.requestFailed", params: { status: 400 } } });
      const key = reason === "SERVICE_DISABLED" ? "errors.gmail.serviceDisabled" : reason === "domainPolicy" ? "errors.gmail.adminPolicy" : reason === "insufficientPermissions" ? "errors.gmail.permissionRequired" : "errors.gmail.requestFailed";
      const state = (await h.rpc.call("app.bootstrap", {})).accounts[0]!.syncState;
      expect(state).toMatchObject({ status: "error", connection: null, lastErrorI18n: { key, ...(reason === "badRequest" && { params: { status: 400 } }) } });
      // plan 184: a grant without mail's scope asks for a sign-in; the others are a pause, never a sign-in
      if (reason === "insufficientPermissions") expect(state).toMatchObject({ authRequired: true, authScope: null });
      else expect(state.authRequired).not.toBe(true);
      expect(JSON.stringify(state)).not.toContain(privateMarker);
      expect(h.paths().filter((path) => path.startsWith("/gmail/messages/"))).toEqual(["/gmail/messages/first", "/gmail/messages/later"]);
      const sibling = await h.send();
      const queued = await h.backend.store.ops.get(sibling.opId);
      const calls = h.paths().slice();
      const ledger = await h.backend.store.providerCooldown.read();
      if (reason !== "badRequest") {
        await h.backend.syncAccount(h.account.id);
        await h.backend.retryNow(h.account.id, "focus");
        // a pause leaves the send unclaimed; a sign-in parks it until one (attempt given back)
        if (reason === "insufficientPermissions") {
          await h.backend.runWorker();
          expect(await h.backend.store.ops.get(sibling.opId)).toMatchObject({ state: "queued", attempts: 0, payload_json: queued!.payload_json });
        } else {
          expect(await h.backend.runWorker()).toBe(0);
          expect(await h.backend.store.ops.get(sibling.opId)).toEqual(queued);
        }
        expect(h.paths()).toEqual(calls);
        expect(await h.backend.store.providerCooldown.read()).toBe(ledger);
        expect((await h.rpc.call("app.bootstrap", {})).accounts[0]!.syncState).toEqual(state);
      }
      h.answer(healthySync);
      if (reason === "insufficientPermissions") await h.backend.signedIn(h.account.id);
      else if (reason !== "badRequest") await h.rpc.call("sync.now", { accountId: h.account.id, reason: "user" });
      await h.backend.syncAccount(h.account.id);
      expect((await h.rpc.call("app.bootstrap", {})).accounts[0]!.syncState).toMatchObject({ status: "idle", lastError: null, lastErrorI18n: null });
      expect(await h.backend.runWorker()).toBe(1);
      expect(await h.backend.store.ops.get(sibling.opId)).toMatchObject({ state: "succeeded", attempts: 1, payload_json: queued!.payload_json });
      expect(h.paths().filter((path) => path === "/gmail/messages/send")).toHaveLength(1);
    } finally { first.release(); later.release(); await syncing; }
  });

  sqlite("review follow-up keeps another unbound refresh dependency out of cached-token status", async () => {
    let wall = Date.now(), elapsed = performance.now();
    vi.spyOn(Date, "now").mockImplementation(() => wall);
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    const h = await setup(false, kind);
    await (await h.backend.provider(h.account.id))!.verify();
    h.answer((request) => new URL(request.url).pathname === "/gmail/messages/send" ? failure(429, "rateLimitExceeded") : followupHealthy(request));
    await h.send(); await h.backend.runWorker();
    wall += 120_001; elapsed += 120_001;
    const other = await h.backend.store.accounts.create({ kind: "gmail", email: "unbound@example.test", displayName: "Unbound", color: "brown", providerConfig: {}, now: 2 });
    await h.backend.setSecret(`account:${other.account.id}:refreshToken`, "synthetic-unbound");
    h.answer((request) => new URL(request.url).pathname === "/token" ? failure(429, "rateLimitExceeded") : followupHealthy(request));
    await h.backend.syncAccount(other.account.id);
    const tokens = h.paths().filter((path) => path === "/token").length;
    await h.backend.syncAccount(h.account.id);
    expect(h.paths().filter((path) => path === "/token")).toHaveLength(tokens);
    const accounts = (await h.rpc.call("app.bootstrap", {})).accounts;
    expect(accounts.find((account) => account.id === other.account.id)!.syncState.status).toBe("error");
    expect(accounts.find((account) => account.id === h.account.id)!.syncState).toMatchObject({ status: "idle", lastError: null, lastSyncAt: wall });
  });

  sqlite("review follow-up deletion fences a pending status initialization", async () => {
    const h = await setup(false, kind);
    let release!: () => void, entered = false;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const get = h.backend.store.accounts.get.bind(h.backend.store.accounts);
    vi.spyOn(h.backend.store.accounts, "get").mockImplementationOnce(async (id) => {
      const account = await get(id); entered = true; await held; return account;
    });
    const bootstrap = h.rpc.call("app.bootstrap", {}).then((value) => ({ value }), (error: unknown) => ({ error }));
    try {
      await vi.waitFor(() => expect(entered).toBe(true));
      await h.rpc.call("accounts.remove", { id: h.account.id });
      expect(await h.backend.store.accounts.get(h.account.id)).toBeNull();
      release();
      expect(await bootstrap).toHaveProperty("error");
      expect((await h.rpc.call("app.bootstrap", {})).accounts).toEqual([]);
    } finally { release(); await bootstrap; }
  });

  sqlite("review follow-up verified reconnect survives a shared pending status initialization", async () => {
    const h = await setup(false, kind);
    h.answer(followupHealthy); followupReconnect(h);
    let release!: () => void, entered = false, signing = false;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const get = h.backend.store.accounts.get.bind(h.backend.store.accounts);
    vi.spyOn(h.backend.store.accounts, "get").mockImplementationOnce(async (id) => {
      const account = await get(id); entered = true; await held; return account;
    });
    const bootstrap = h.rpc.call("app.bootstrap", {}).then((value) => ({ value }), (error: unknown) => ({ error }));
    let reconnect: Promise<unknown> | undefined;
    try {
      await vi.waitFor(() => expect(entered).toBe(true));
      const signedIn = h.backend.signedIn.bind(h.backend);
      vi.spyOn(h.backend, "signedIn").mockImplementation(async (...args) => { const work = signedIn(...args); signing = true; return work; });
      reconnect = h.rpc.call("accounts.reconnect", { id: h.account.id }).then((value) => ({ value }), (error: unknown) => ({ error }));
      await vi.waitFor(() => expect(signing).toBe(true));
      expect(await h.backend.getSecret(`account:${h.account.id}:refreshToken`)).toBe("synthetic-reconnected");
      release();
      expect(await reconnect).toHaveProperty("value.id", h.account.id);
      expect(await bootstrap).toHaveProperty("value.accounts");
      await h.backend.syncAccount(h.account.id);
      expect((await h.rpc.call("app.bootstrap", {})).accounts[0]!.syncState).toMatchObject({ status: "idle", authRequired: false, lastError: null });
    } finally { release(); await Promise.allSettled([bootstrap, ...(reconnect ? [reconnect] : [])]); }
  });

  it("follow-up reopen cannot retain syncing without a live run or clear durable auth", async () => {
    const h = await setup(false, kind);
    await (await h.backend.provider(h.account.id))!.verify();
    await h.backend.store.accounts.setCursor(h.account.id, { historyId: "9" });
    const other = await h.backend.store.accounts.create({ kind: "gmail", email: "held@example.test", displayName: "Held", color: "brown", providerConfig: {}, now: 2 });
    await h.backend.store.accounts.setSyncState(other.account.id, { status: "error", connection: null, authRequired: true, authScope: null, lastError: "Sign in again", lastErrorI18n: { key: "errors.gmail.revoked" } });
    const durableAuth = (await h.backend.store.accounts.get(other.account.id))!.syncState;
    const history = heldJson(200, { historyId: "10" });
    h.answer((request) => new URL(request.url).pathname === "/gmail/history" ? history.response : followupHealthy(request));
    const syncing = h.backend.syncAccount(h.account.id);
    try {
      await vi.waitFor(() => expect(history.entered).toBe(true));
      expect((await h.backend.store.accounts.get(h.account.id))!.syncState.status).toBe("syncing");
      const retiring = h.backend.dropAccount(h.account.id);
      history.release(); await Promise.all([retiring, syncing]);
      const calls = h.paths().slice(), create = vi.spyOn(h.backend.options.providers, "create");
      await h.reopen();
      const accounts = (await h.rpc.call("app.bootstrap", {})).accounts;
      expect(accounts.find((account) => account.id === other.account.id)!.syncState).toEqual(durableAuth);
      expect(create).not.toHaveBeenCalled();
      expect(h.paths()).toEqual(calls);
      expect(accounts.find((account) => account.id === h.account.id)!.syncState).toMatchObject({ status: "idle", lastSyncAt: null });
    } finally { history.release(); await Promise.allSettled([syncing]); }
  });

  it("follow-up confirmed credential generation cannot retire policy after failed recovery", async () => {
    const h = await setup(false, kind);
    await (await h.backend.provider(h.account.id))!.verify();
    h.answer((request) => new URL(request.url).pathname === "/gmail/messages/send" ? failure(403, "SERVICE_DISABLED") : followupHealthy(request));
    const original = await h.send(); await h.backend.runWorker();
    expect(await h.backend.store.ops.get(original.opId)).toMatchObject({ state: "failed", attempts: 1 });
    const sibling = await h.send(), queued = await h.backend.store.ops.get(sibling.opId);
    const generation = h.backend.credentialsOf(h.account.id);
    let proofCalls: string[] | undefined;
    h.answer(followupHealthy);
    followupReconnect(h, () => { proofCalls = h.paths().slice(); });
    const commit = h.backend.store.secrets.commit.bind(h.backend.store.secrets);
    vi.spyOn(h.backend.store.secrets, "commit").mockImplementationOnce(async (...args) => {
      await commit(...args); throw new Error("Synthetic committed credential acknowledgement lost");
    });
    await expect(h.rpc.call("accounts.reconnect", { id: h.account.id })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(proofCalls?.slice(-2)).toEqual(["/gmail/profile", "/userinfo"]);
    expect(h.backend.credentialsOf(h.account.id)).toBeGreaterThan(generation);
    expect(await h.backend.getSecret(`account:${h.account.id}:refreshToken`)).toBe("synthetic-reconnected");
    await h.backend.syncAccount(h.account.id);
    await h.backend.retryNow(h.account.id, "focus");
    await h.backend.syncAccount(h.account.id);
    expect.soft(await h.backend.runWorker()).toBe(0);
    expect.soft(await h.backend.store.ops.get(sibling.opId)).toEqual(queued);
    expect(await h.backend.store.ops.get(original.opId)).toMatchObject({ state: "failed", attempts: 1 });
    expect.soft(h.paths()).toEqual(proofCalls);
    expect.soft((await h.rpc.call("app.bootstrap", {})).accounts[0]!.syncState).toMatchObject({ status: "error", lastErrorI18n: { key: "errors.gmail.serviceDisabled" } });
    await h.rpc.call("accounts.reconnect", { id: h.account.id });
    await h.backend.syncAccount(h.account.id);
    expect(await h.backend.runWorker()).toBe(1);
    expect(await h.backend.store.ops.get(sibling.opId)).toMatchObject({ state: "succeeded", attempts: 1, payload_json: queued!.payload_json });
    expect(await h.backend.store.ops.get(original.opId)).toMatchObject({ state: "failed", attempts: 1 });
    expect((await h.rpc.call("app.bootstrap", {})).accounts[0]!.syncState).toMatchObject({ status: "idle", authRequired: false, lastError: null });
  });

  it.each(["reconnect", "remove"] as const)("follow-up one failed auth persistence write permits later %s", async (action) => {
    const h = await setup(false, kind);
    const provider = (await h.backend.provider(h.account.id))!;
    await provider.verify();
    const queued = await h.send(), intent = await h.backend.store.ops.get(queued.opId);
    const auth = new ProviderAuthError("Synthetic refused credential");
    const sync = vi.spyOn(provider, "sync").mockRejectedValueOnce(auth);
    const storageFailure = new Error("Synthetic one-shot status write failure");
    let failed = false;
    const write = h.backend.store.accounts.setSyncState.bind(h.backend.store.accounts);
    const persistence = vi.spyOn(h.backend.store.accounts, "setSyncState").mockImplementation(async (id, patch) => {
      if (!failed && patch.authRequired) { failed = true; throw storageFailure; }
      return write(id, patch);
    });
    try {
      await expect(h.backend.syncAccount(h.account.id)).rejects.toBe(storageFailure);
      expect(failed).toBe(true);
      expect((await h.rpc.call("app.bootstrap", {})).accounts[0]!.syncState).toMatchObject({ authRequired: true, lastError: auth.message });
      h.answer(followupHealthy);
      if (action === "reconnect") {
        const proof = followupReconnect(h);
        const result = await h.rpc.call("accounts.reconnect", { id: h.account.id }).then((value) => ({ value }), (error: unknown) => ({ error }));
        expect(proof).toHaveBeenCalledOnce();
        expect(h.paths().slice(-2)).toEqual(["/gmail/profile", "/userinfo"]);
        expect(await h.backend.store.ops.get(queued.opId)).toEqual(intent);
        expect(result).toHaveProperty("value.id", h.account.id);
        await h.backend.syncAccount(h.account.id);
        expect((await h.rpc.call("app.bootstrap", {})).accounts[0]!.syncState.authRequired).toBe(false);
        expect(await h.backend.runWorker()).toBe(1);
        expect(await h.backend.store.ops.get(queued.opId)).toMatchObject({ state: "succeeded", attempts: 1, payload_json: intent!.payload_json });
      } else {
        await expect(h.rpc.call("accounts.remove", { id: h.account.id })).resolves.toBeDefined();
        expect((await h.rpc.call("app.bootstrap", {})).accounts).toEqual([]);
        expect(await h.backend.store.accounts.get(h.account.id)).toBeNull();
      }
    } finally { persistence.mockRestore(); sync.mockRestore(); }
  });

  sqlite("follow-up notification completion must deliver a later classified native auth fact", async () => {
    const h = await setup(false, kind);
    await (await h.backend.provider(h.account.id))!.verify();
    await h.backend.store.accounts.setCursor(h.account.id, { historyId: "9" });
    const policy = heldJson(403, { error: { errors: [{ reason: "SERVICE_DISABLED" }] } });
    let deliver!: () => void, delivered!: () => void, finishAuth!: () => void, classified = false, published = false;
    const authDone = new Promise<void>((resolve) => { delivered = resolve; });
    const tokenResult = h.context.tokenResult!;
    h.context.tokenResult = (generation, error) => {
      if (!error) return tokenResult(generation);
      classified = true;
      return new Promise<void>((resolve, reject) => {
        finishAuth = resolve;
        deliver = () => {
          if (published) return;
          published = true;
          Promise.resolve(tokenResult(generation, error)).then(delivered, reject);
        };
      });
    };
    h.answer((request) => {
      const path = new URL(request.url).pathname;
      if (path === "/gmail/messages/send") return policy.response;
      if (path === "/gmail/history") return Response.json({ error: { code: 401 } }, { status: 401 });
      if (path === "/token") return Response.json({ error: "invalid_grant" }, { status: 400 });
      return followupHealthy(request);
    });
    const notifications: import("@terno/core").Account[][] = [];
    h.rpc.on("accounts", (accounts) => notifications.push(accounts));
    const sent = await h.send(), sending = h.backend.runWorker();
    let syncing: Promise<void> | undefined, finishEmission!: () => void, emissionEntered = false;
    const emission = new Promise<void>((resolve) => { finishEmission = resolve; });
    try {
      await vi.waitFor(() => expect(policy.entered).toBe(true));
      syncing = h.backend.syncAccount(h.account.id);
      await vi.waitFor(() => expect(classified).toBe(true));
      await new Promise<void>((resolve) => setImmediate(resolve));
      const emit = h.backend.emitAccounts.bind(h.backend);
      vi.spyOn(h.backend, "emitAccounts").mockImplementationOnce(async () => {
        await emit(); emissionEntered = true;
        await emission;
        // Let the drain observe no dirty fact before the classified refusal reaches its finalizer.
        queueMicrotask(() => queueMicrotask(deliver));
      });
      policy.release(); await sending;
      expect(emissionEntered).toBe(true);
      expect(notifications.at(-1)![0]!.syncState.lastErrorI18n).toEqual({ key: "errors.gmail.serviceDisabled" });
      finishEmission(); await authDone;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(await h.backend.store.ops.get(sent.opId)).toMatchObject({ state: "failed", attempts: 1 });
      const current = (await h.rpc.call("app.bootstrap", {})).accounts[0]!.syncState;
      expect(current).toMatchObject({ authRequired: true, lastErrorI18n: { key: "errors.gmail.revoked" } });
      expect((await h.backend.store.accounts.get(h.account.id))!.syncState).toMatchObject({ authRequired: true, lastErrorI18n: { key: "errors.gmail.revoked" } });
      expect(notifications.at(-1)![0]!.syncState).toEqual(current);
    } finally {
      policy.release(); finishEmission(); deliver?.(); finishAuth?.();
      await Promise.allSettled([sending, ...(syncing ? [syncing] : [])]);
    }
  });

  sqlite("follow-up Send-first token429 projects its durable dependency hold without sync", async () => {
    const h = await setup(false, kind);
    await (await h.backend.provider(h.account.id))!.verify();
    h.answer((request) => {
      const path = new URL(request.url).pathname;
      if (path === "/gmail/messages/send") return Response.json({ error: { code: 401 } }, { status: 401 });
      if (path === "/token") return failure(429, "rateLimitExceeded");
      return followupHealthy(request);
    });
    const sent = await h.send();
    await h.backend.runWorker();
    const original = await h.backend.store.ops.get(sent.opId);
    expect(original).toMatchObject({ state: "queued", attempts: 1 });
    expect(JSON.parse((await h.backend.store.providerCooldown.read())!).rows).toEqual(expect.arrayContaining([expect.objectContaining({ service: "oauth-token" })]));
    const sibling = await h.send(), queued = await h.backend.store.ops.get(sibling.opId);
    const calls = h.paths().slice(), ledger = await h.backend.store.providerCooldown.read();
    expect(await h.backend.runWorker()).toBe(0);
    expect(h.paths()).toEqual(calls);
    expect(await h.backend.store.ops.get(sent.opId)).toEqual(original);
    expect(await h.backend.store.ops.get(sibling.opId)).toMatchObject({ state: "queued", attempts: 0, payload_json: queued!.payload_json, target_json: queued!.target_json });
    expect(await h.backend.store.providerCooldown.read()).toBe(ledger);
    expect((await h.rpc.call("app.bootstrap", {})).accounts[0]!.syncState).toMatchObject({ status: "error", lastErrorI18n: { key: "errors.gmail.paused" }, connection: null });
  });

  sqlite("follow-up cached-token control remains usable during a real token endpoint hold", async () => {
    const h = await setup(false, kind);
    await (await h.backend.provider(h.account.id))!.verify();
    h.answer((request) => new URL(request.url).pathname === "/token" ? failure(429, "rateLimitExceeded") : followupHealthy(request));
    const response = await h.context.google!.request({ request: { endpoint: "oauth-token", purpose: "refresh" } }, "https://synthetic.invalid/token", { method: "POST" });
    expect(response.status).toBe(429);
    await response.text();
    expect(JSON.parse((await h.backend.store.providerCooldown.read())!).rows).toEqual(expect.arrayContaining([expect.objectContaining({ service: "oauth-token" })]));
    const sent = await h.send();
    expect(await h.backend.runWorker()).toBe(1);
    expect(await h.backend.store.ops.get(sent.opId)).toMatchObject({ state: "succeeded", attempts: 1 });
    expect(h.paths().filter((path) => path === "/token")).toHaveLength(2);
    expect((await h.rpc.call("app.bootstrap", {})).accounts[0]!.syncState.status).not.toBe("error");
  });

  sqlite("follow-up retired quota handles cannot outlive actual expiry and verified reconnect", async () => {
    let wall = Date.now(), elapsed = performance.now();
    vi.spyOn(Date, "now").mockImplementation(() => wall);
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    const h = await setup(false, kind);
    await (await h.backend.provider(h.account.id))!.verify();
    h.answer((request) => new URL(request.url).pathname === "/gmail/messages/send" ? failure(429, "userRateLimitExceeded") : followupHealthy(request));
    const sent = await h.send();
    await h.backend.runWorker();
    const queued = await h.backend.store.ops.get(sent.opId);
    expect(queued).toMatchObject({ state: "queued", attempts: 1 });
    const row = JSON.parse((await h.backend.store.providerCooldown.read())!).rows.find((r: { service: string }) => r.service === "gmail-api");
    const calls = h.paths().slice();
    wall += 120_001;
    expect(await h.backend.runWorker()).toBe(0);
    expect(h.paths()).toEqual(calls);
    expect(await h.backend.store.ops.get(sent.opId)).toEqual(queued);
    expect(JSON.parse((await h.backend.store.providerCooldown.read())!).rows).toEqual(expect.arrayContaining([expect.objectContaining({ service: "gmail-api", minimum: row.minimum })]));
    elapsed += 120_001;
    h.answer(followupHealthy);
    const reconnect = followupReconnect(h);
    await h.rpc.call("accounts.reconnect", { id: h.account.id });
    expect(reconnect).toHaveBeenCalledOnce();
    await h.backend.syncAccount(h.account.id);
    expect(await h.backend.runWorker()).toBe(1);
    expect(await h.backend.store.ops.get(sent.opId)).toMatchObject({ state: "succeeded", attempts: 2, payload_json: queued!.payload_json });
    expect(h.paths().filter((path) => path === "/gmail/profile").length).toBeGreaterThanOrEqual(3);
    expect((await h.rpc.call("app.bootstrap", {})).accounts[0]!.syncState).toMatchObject({ status: "idle", lastError: null, lastErrorI18n: null, lastSyncAt: wall });
  });

  sqlite.each([429, 403])("R1 Send-first quota%i projects the existing admission hold without a sync", async (status) => {
    const h = await setup(false, kind);
    await (await h.backend.provider(h.account.id))!.verify();
    h.answer((request) => new URL(request.url).pathname === "/gmail/messages/send" ? failure(status, "userRateLimitExceeded") : healthySync(request));
    const original = await h.send();
    await h.backend.runWorker();
    expect(await h.backend.store.ops.get(original.opId)).toMatchObject({ state: "queued", attempts: 1 });
    expect((await h.rpc.call("app.bootstrap", {})).accounts[0]!.syncState).toMatchObject({ status: "error", lastErrorI18n: { key: "errors.gmail.paused" }, connection: null });
    const sibling = await h.send(), queued = await h.backend.store.ops.get(sibling.opId);
    const calls = h.paths().slice(), ledger = await h.backend.store.providerCooldown.read();
    expect(await h.backend.runWorker()).toBe(0);
    expect(h.paths()).toEqual(calls);
    expect(await h.backend.store.ops.get(sibling.opId)).toEqual(queued);
    expect(await h.backend.store.providerCooldown.read()).toBe(ledger);
  });

  it("owner status persistence cannot turn a definitive native policy rejection into retryable Send", async () => {
    const h = await setup(false, kind);
    await (await h.backend.provider(h.account.id))!.verify();
    let failed = false;
    const write = h.backend.store.accounts.setSyncState.bind(h.backend.store.accounts);
    vi.spyOn(h.backend.store.accounts, "setSyncState").mockImplementation(async (id, patch) => {
      if (!failed && patch.lastErrorI18n?.key === "errors.gmail.serviceDisabled") { failed = true; throw new Error("Synthetic status persistence failure"); }
      return write(id, patch);
    });
    h.answer((request) => new URL(request.url).pathname === "/gmail/messages/send" ? failure(403, "SERVICE_DISABLED") : healthySync(request));
    const sent = await h.send();
    await h.backend.runWorker();
    expect(failed).toBe(true);
    expect(await h.backend.store.ops.get(sent.opId)).toMatchObject({ state: "failed", attempts: 1 });
    h.answer(healthySync);
    await h.rpc.call("sync.now", { accountId: h.account.id, reason: "user" });
    await h.backend.syncAccount(h.account.id);
    expect(await h.backend.runWorker()).toBe(0);
    expect(h.paths().filter((path) => path === "/gmail/messages/send")).toHaveLength(1);
  });

  sqlite.each(["copy", "recovery"] as const)("redesign retains sign-in after raw400, Send invalid_grant and late raw403: %s", async (witness) => {
    const h = await setup(false, kind);
    const provider = (await h.backend.provider(h.account.id))!;
    await provider.verify();
    let retained: unknown;
    const sync = provider.sync.bind(provider);
    vi.spyOn(provider, "sync").mockImplementation(async (sink) => {
      try { await sync(sink); } catch (error) { retained = error; throw error; }
    });
    const first = heldJson(400, { error: { message: privateMarker } });
    const later = heldJson(403, { error: { errors: [{ reason: "SERVICE_DISABLED" }] } });
    const auth = heldJson(400, { error: "invalid_grant" });
    h.answer((request) => {
      const path = new URL(request.url).pathname;
      if (path === "/gmail/messages") return Response.json({ messages: [{ id: "first", threadId: "first" }, { id: "later", threadId: "later" }] });
      if (path === "/gmail/messages/first") return first.response;
      if (path === "/gmail/messages/later") return later.response;
      if (path === "/gmail/messages/send") return Response.json({ error: { code: 401 } }, { status: 401 });
      if (path === "/token") return auth.response;
      return healthySync(request);
    });
    const original = await h.send();
    const syncing = h.backend.syncAccount(h.account.id);
    let sending: Promise<number> | undefined;
    try {
      await vi.waitFor(() => { expect(first.entered).toBe(true); expect(later.entered).toBe(true); });
      sending = h.backend.runWorker();
      await vi.waitFor(() => expect(auth.entered).toBe(true));
      first.release();
      await new Promise<void>((resolve) => setImmediate(resolve));
      auth.release();
      await sending;
      const revoked = (await h.rpc.call("app.bootstrap", {})).accounts[0]!.syncState;
      expect(revoked).toMatchObject({ status: "error", authRequired: true, authScope: null, lastErrorI18n: { key: "errors.gmail.revoked" } });
      expect(await h.backend.store.ops.get(original.opId)).toMatchObject({ state: "queued", attempts: 0 });
      later.release();
      await syncing;
      expect(retained).toMatchObject({ status: 400, i18n: { key: "errors.gmail.requestFailed", params: { status: 400 } } });
      const finalState = (await h.rpc.call("app.bootstrap", {})).accounts[0]!.syncState;
      expect(JSON.stringify(finalState)).not.toContain(privateMarker);
      if (witness === "copy") {
        expect(finalState).toMatchObject({ status: "error", authRequired: true, authScope: null, lastErrorI18n: { key: "errors.gmail.revoked" } });
        expect(finalState.lastError).toEqual(revoked.lastError);
      } else {
        const sibling = await h.send();
        const queued = await h.backend.store.ops.get(sibling.opId);
        const before = await h.backend.store.ops.get(original.opId);
        const calls = h.paths().slice();
        const ledger = await h.backend.store.providerCooldown.read();
        h.answer((request) => new URL(request.url).pathname === "/token" ? Response.json({ error: "invalid_grant" }, { status: 400 }) : healthySync(request));
        await h.rpc.call("sync.now", { accountId: h.account.id, reason: "user" });
        await h.backend.syncAccount(h.account.id);
        await h.backend.runWorker();
        expect(await h.backend.store.ops.get(original.opId)).toMatchObject({ state: "queued", attempts: 0, payload_json: before!.payload_json, target_json: before!.target_json });
        expect(await h.backend.store.ops.get(sibling.opId)).toMatchObject({ state: "queued", attempts: 0, payload_json: queued!.payload_json, target_json: queued!.target_json });
        expect(await h.backend.store.providerCooldown.read()).toBe(ledger);
        expect(h.paths()).toEqual(calls);
      }
    } finally {
      first.release(); auth.release(); later.release();
      await Promise.allSettled([syncing, ...(sending ? [sending] : [])]);
    }
  });

  sqlite("redesign preserves policy when an already-admitted idle status write completes late", async () => {
    const h = await setup(false, kind);
    await (await h.backend.provider(h.account.id))!.verify();
    let entered = false, release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const write = h.backend.store.accounts.setSyncState.bind(h.backend.store.accounts);
    vi.spyOn(h.backend.store.accounts, "setSyncState").mockImplementation(async (id, patch) => {
      if (id === h.account.id && patch.status === "idle" && !entered) { entered = true; await held; }
      return write(id, patch);
    });
    h.answer((request) => new URL(request.url).pathname === "/gmail/messages/send" ? failure(403, "SERVICE_DISABLED") : healthySync(request));
    const original = await h.send();
    const syncing = h.backend.syncAccount(h.account.id);
    let sending: Promise<number> | undefined;
    try {
      await vi.waitFor(() => expect(entered).toBe(true));
      sending = h.backend.runWorker();
      await vi.waitFor(async () => expect((await h.rpc.call("app.bootstrap", {})).accounts[0]!.syncState).toMatchObject({ status: "error", lastErrorI18n: { key: "errors.gmail.serviceDisabled" } }));
      const updated = await h.rpc.call("accounts.update", { id: h.account.id, displayName: "Updated synthetic" });
      expect(updated.syncState).toMatchObject({ status: "error", lastErrorI18n: { key: "errors.gmail.serviceDisabled" } });
      release();
      await Promise.all([syncing, sending]);
      expect(await h.backend.store.ops.get(original.opId)).toMatchObject({ state: "failed", attempts: 1 });
      expect((await h.rpc.call("app.bootstrap", {})).accounts[0]!.syncState).toMatchObject({ status: "error", lastErrorI18n: { key: "errors.gmail.serviceDisabled" }, connection: null });
      const sibling = await h.send();
      const queued = await h.backend.store.ops.get(sibling.opId);
      const calls = h.paths().slice();
      await h.backend.syncAccount(h.account.id);
      expect(await h.backend.runWorker()).toBe(0);
      expect(h.paths()).toEqual(calls);
      expect(await h.backend.store.ops.get(sibling.opId)).toEqual(queued);
    } finally { release(); await Promise.allSettled([syncing, ...(sending ? [sending] : [])]); }
  });

  sqlite.each([["send", "policy first"], ["send", "auth first"], ["sync", "policy first"], ["sync", "auth first"]] as const)("surfaces invalid_grant despite concurrent policy refusal from %s: %s", async (policySource, order) => {
    const h = await setup(false, kind);
    const provider = (await h.backend.provider(h.account.id))!;
    await provider.verify();
    await h.backend.store.accounts.setCursor(h.account.id, { historyId: "9" });
    const held = (status: number, value: unknown) => {
      let controller!: ReadableStreamDefaultController<Uint8Array>, entered = false, released = false;
      const response = new Response(new ReadableStream<Uint8Array>({
        start(c) { controller = c; },
        pull() { entered = true; },
      }, { highWaterMark: 0 }), { status, headers: { "content-type": "application/json" } });
      return { response, get entered() { return entered; }, release() {
        if (released) return;
        released = true;
        controller.enqueue(new TextEncoder().encode(JSON.stringify(value)));
        controller.close();
      } };
    };
    const policy = held(403, { error: { errors: [{ reason: "SERVICE_DISABLED" }] } });
    const auth = held(400, { error: "invalid_grant" });
    let history = 0, sends = 0;
    const fromSend = policySource === "send";
    h.answer((request) => {
      const path = new URL(request.url).pathname;
      if (path === "/gmail/messages/send") return fromSend ? policy.response : sends++ === 0 ? Response.json({ error: { code: 401 } }, { status: 401 }) : undefined;
      if (path === "/token") return auth.response;
      if (path === "/gmail/history") return !fromSend ? policy.response : history++ === 0 ? Response.json({ error: { code: 401 } }, { status: 401 }) : healthySync(request);
      return healthySync(request);
    });
    const first = await h.send();
    let sending: Promise<number> | undefined, syncing: Promise<void> | undefined;
    if (fromSend) sending = h.backend.runWorker();
    else syncing = h.backend.syncAccount(h.account.id);
    try {
      await vi.waitFor(() => expect(policy.entered).toBe(true));
      if (fromSend) syncing = h.backend.syncAccount(h.account.id);
      else sending = h.backend.runWorker();
      await vi.waitFor(() => expect(auth.entered).toBe(true));
      const policyRun = fromSend ? sending : syncing;
      const authRun = fromSend ? syncing : sending;
      if (order === "policy first") {
        policy.release();
        await policyRun;
        expect((await h.rpc.call("app.bootstrap", {})).accounts[0]!.syncState).toMatchObject({ status: "error", lastErrorI18n: { key: "errors.gmail.serviceDisabled" } });
        auth.release();
        await authRun;
      } else {
        auth.release();
        await authRun;
        expect((await h.rpc.call("app.bootstrap", {})).accounts[0]!.syncState).toMatchObject({ authRequired: true, lastErrorI18n: { key: "errors.gmail.revoked" } });
        policy.release();
        await policyRun;
      }
      expect((await h.rpc.call("app.bootstrap", {})).accounts[0]!.syncState).toMatchObject({ status: "error", authRequired: true, authScope: null, lastErrorI18n: { key: "errors.gmail.revoked" } });
      expect(await h.backend.store.ops.get(first.opId)).toMatchObject({ state: fromSend ? "failed" : "queued", attempts: fromSend ? 1 : 0 });
      const sibling = await h.send();
      const queued = await h.backend.store.ops.get(sibling.opId);
      const calls = h.paths().slice();
      await h.rpc.call("sync.now", { accountId: h.account.id, reason: "user" });
      expect(await h.backend.runWorker()).toBe(1);
      expect(h.paths()).toEqual(calls);
      expect(await h.backend.store.ops.get(sibling.opId)).toMatchObject({ state: "queued", attempts: 0, payload_json: queued!.payload_json, target_json: queued!.target_json });
      expect(await h.backend.runWorker()).toBe(0);
      let accepted = 0;
      h.answer((request) => new URL(request.url).pathname === "/gmail/messages/send" ? Response.json({ id: `recovered-${++accepted}`, threadId: `recovered-thread-${accepted}` }) : healthySync(request));
      await h.backend.setSecret(`account:${h.account.id}:refreshToken`, "synthetic-reconnected-refresh");
      await h.backend.signedIn(h.account.id);
      await provider.verify();
      await h.backend.syncAccount(h.account.id);
      expect((await h.rpc.call("app.bootstrap", {})).accounts[0]!.syncState).toMatchObject({ authRequired: false, lastError: null, lastErrorI18n: null });
      expect(await h.backend.runWorker()).toBe(fromSend ? 1 : 2);
      expect(await h.backend.store.ops.get(sibling.opId)).toMatchObject({ state: "succeeded", attempts: 1, payload_json: queued!.payload_json });
      expect(await h.backend.store.ops.get(first.opId)).toMatchObject({ state: fromSend ? "failed" : "succeeded", attempts: 1 });
      expect(h.paths().filter((path) => path === "/gmail/messages/send")).toHaveLength(fromSend ? 2 : 3);
    } finally {
      policy.release(); auth.release();
      await Promise.allSettled([...(sending ? [sending] : []), ...(syncing ? [syncing] : [])]);
    }
  });

  sqlite("an older policy body cannot relatch after explicit recovery in the same credential generation", async () => {
    const h = await setup(false, kind);
    await (await h.backend.provider(h.account.id))!.verify();
    let release!: () => void, entered!: () => void;
    const ready = new Promise<void>((r) => { entered = r; });
    h.answer((r) => new URL(r.url).pathname === "/gmail/history" ? new Response(new ReadableStream({ start(controller) { release = () => { controller.enqueue(new TextEncoder().encode(JSON.stringify({ error: { errors: [{ reason: "SERVICE_DISABLED" }] } }))); controller.close(); }; entered(); } }), { status: 403 }) : undefined);
    await h.backend.store.accounts.setCursor(h.account.id, { historyId: "9" });
    const syncing = h.backend.syncAccount(h.account.id);
    await ready;
    h.answer(healthySync);
    await h.backend.retryNow(h.account.id, "user");
    release();
    await syncing;
    await h.backend.syncAccount(h.account.id);
    const { opId } = await h.send();
    expect(await h.backend.runWorker()).toBe(1);
    expect(await h.backend.store.ops.get(opId)).toMatchObject({ state: "succeeded", attempts: 1 });
  });

  sqlite("header-only nonquota403 never creates a cooldown or policy pause", async () => {
    const h = await setup(false, kind);
    await (await h.backend.provider(h.account.id))!.verify();
    h.answer((r) => new URL(r.url).pathname === "/gmail/messages/send" ? failure(403, "forbidden") : undefined);
    const { opId } = await h.send();
    await h.backend.runWorker();
    expect(await h.backend.store.ops.get(opId)).toMatchObject({ state: "failed", attempts: 1 });
    expect(JSON.parse((await h.backend.store.providerCooldown.read())!).rows).toEqual([]);
    h.answer(undefined);
    const next = await h.send();
    expect(await h.backend.runWorker()).toBe(1);
    expect(await h.backend.store.ops.get(next.opId)).toMatchObject({ state: "succeeded", attempts: 1 });
  });

  sqlite("explicit user recovery resumes a disabled saved account without changing its credential", async () => {
    const h = await setup(false, kind);
    h.answer((r) => new URL(r.url).pathname === "/gmail/profile" ? failure(403, "SERVICE_DISABLED") : undefined);
    await h.backend.syncAccount(h.account.id);
    const { opId } = await h.send();
    const before = await h.backend.store.ops.get(opId);
    expect(await h.backend.runWorker()).toBe(0);
    await h.backend.retryNow(h.account.id, "focus");
    await h.backend.syncAccount(h.account.id);
    expect(h.paths()).toEqual(["/token", "/gmail/profile"]);
    expect(await h.backend.store.ops.get(opId)).toEqual(before);
    h.answer((r) => {
      const path = new URL(r.url).pathname;
      if (path === "/gmail/messages") return Response.json({});
      if (path === "/gmail/history") return Response.json({ historyId: "10" });
      if (path === "/gmail/labels") return Response.json({ labels: [] });
    });
    await h.backend.retryNow(h.account.id, "user");
    await h.backend.syncAccount(h.account.id);
    expect(await h.backend.runWorker()).toBe(1);
    expect(await h.backend.store.ops.get(opId)).toMatchObject({ state: "succeeded", attempts: 1, payload_json: before!.payload_json, target_json: JSON.stringify({ ...JSON.parse(before!.target_json), submissionAccepted: true }) });
    expect(await h.backend.getSecret(`account:${h.account.id}:refreshToken`)).toBe("synthetic-refresh");
  });

  sqlite("local physical capacity costs no attempt or remote cooldown and terminal EOF restores admission", async () => {
    const h = await setup(false, kind);
    await (await h.backend.provider(h.account.id))!.verify();
    const responses: Response[] = [];
    try {
      for (let i = 0; i < 64; i++) responses.push(await h.context.google!.request({ admission: i < 62 ? "background" : "send", request: { endpoint: "gmail-api", purpose: "mail" } }, "https://synthetic.invalid/hold"));
      const { opId } = await h.send();
      const original = await h.backend.store.ops.get(opId);
      const ledger = await h.backend.store.providerCooldown.read();
      await expect(h.context.google!.request({ request: { endpoint: "gmail-api", purpose: "mail" } }, "https://synthetic.invalid/hold")).rejects.toMatchObject({ cooldown: { kind: "capacity" } });
      expect(await h.backend.runWorker()).toBe(0);
      expect(await h.backend.store.ops.get(opId)).toEqual(original);
      expect(await h.backend.store.providerCooldown.read()).toBe(ledger);
      expect(h.requests).toHaveLength(66);
      expect(await responses.pop()!.text()).toBe("held");
      expect(await h.backend.runWorker()).toBe(1);
      expect(await h.backend.store.ops.get(opId)).toMatchObject({ state: "succeeded", attempts: 1, payload_json: original!.payload_json });
    } finally { await Promise.all(responses.map((r) => r.text())); }
  });
});

it("R1 late403 after cancellation releases its logical ticket but retains physical response capacity", async () => {
  const { ProviderCooldown } = await import("./provider-cooldown");
  const { createNetworkPolicy } = await import("./net-policy");
  const { createGmailApiProvider } = await import("../../mail/src/gmail-api");
  let encoded: string | null = null;
  const gate = await ProviderCooldown.open({ read: async () => encoded, update: async (fn) => { const next = fn(encoded); encoded = next.encoded; return next.result; } }, { wallNow: Date.now, elapsedNow: () => performance.now(), random: () => 0.5 });
  const policy = gate.requestsFor("installation");
  let respond!: (response: Response) => void;
  const requests: Request[] = [];
  const net = createNetworkPolicy({ fetch: async (input) => {
    if (!(input instanceof Request) || input.url !== "https://synthetic.invalid/gmail/profile") throw new Error("Unexpected managed request");
    requests.push(input);
    return new Promise<Response>((resolve) => { respond = resolve; });
  } });
  const google = { generation: () => 0, check: (request: Parameters<typeof policy.check>[0]["request"]) => policy.check({ request }), request: (descriptor: Parameters<typeof net.fetchGoogle>[1], input: Parameters<typeof fetch>[0], init?: RequestInit) => net.fetchGoogle(policy, descriptor)(input, init), prove: async () => {}, tokenUnavailable() {}, accessAvailable() {} };
  const provider = createGmailApiProvider({ google, account: { id: 1 }, store: {} } as unknown as ProviderContext, { tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw: async () => new Uint8Array(), endpoints: { api: "https://synthetic.invalid/gmail" } });
  try {
    const verifying = provider.verify().catch((error: unknown) => error);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    provider.reset!();
    expect(await verifying).toBeInstanceOf(ProviderError);
    respond(failure(403, "userRateLimitExceeded"));
    await vi.waitFor(() => expect(gate.resources().tickets).toBe(0));
    expect(net.googlePending()).toBe(1);
    expect(encoded).toBeNull();
  } finally { await provider.close(); await gate.close(); }
});
