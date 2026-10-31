import "fake-indexeddb/auto";
import { IdbMailStore } from "@terno/idb";
import { IDBFactory } from "fake-indexeddb";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { createGmailProvider, ProviderAuthError, ProviderError, type ProviderContext, type ProviderRegistry } from "@terno/mail";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";

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
  const open = async () => new Backend({ store: await openStore(), dbPath: join(dir, "test.db"), providers, cipher: plaintextCipher, version: "test", autoSync, instantSearch: false, iconTransport: null });
  let backend = await open();
  cleanups.push(async () => { await backend.stop(); rmSync(dir, { recursive: true, force: true }); expect(unexpected).toEqual([]); });
  await backend.ready;
  const { account } = await backend.store.accounts.create({ kind: "gmail", email: "synthetic@example.test", displayName: "Synthetic", color: "indigo", providerConfig: {}, now: 1 });
  await backend.store.settings.set("app", { gmailClientId: "synthetic-client" });
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

for (const kind of ["SQL", "IDB"] as const) describe(`${kind} W05 saved-account reason-aware recovery boundaries`, () => {
  it.each([
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

  it("disabled Gmail suppresses ordinary periodic HTTP", async () => {
    const intervals = vi.spyOn(globalThis, "setInterval");
    const h = await setup(true, kind);
    h.answer((r) => new URL(r.url).pathname === "/gmail/profile" ? failure(403, "SERVICE_DISABLED") : undefined);
    const syncing = vi.spyOn(h.backend, "syncAccount");
    await h.backend.start();
    await vi.waitFor(() => expect(syncing).toHaveBeenCalled());
    await syncing.mock.results[0]!.value;
    expect(h.paths()).toEqual(["/token", "/gmail/profile"]);
    const poll = intervals.mock.calls.find((call) => call[1] === 120_000)?.[0];
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
    const other = await h.backend.store.accounts.create({ kind: "gmail", email: "other@example.test", displayName: "Other", color: "indigo", providerConfig: {}, now: 2 });
    await h.backend.setSecret(`account:${other.account.id}:refreshToken`, "synthetic-other");
    h.answer((r) => new URL(r.url).pathname === "/gmail/profile" ? Response.json({ emailAddress: "other@example.test", historyId: "10" }) : undefined);
    const next = await h.rpc.call("compose.send", { accountId: other.account.id, to: [{ email: "recipient@example.test", name: "" }], subject: "Other", bodyText: "Other" });
    expect(await h.backend.runWorker()).toBe(1);
    expect(await h.backend.store.ops.get(next.opId)).toMatchObject({ state: "succeeded", attempts: 1 });
    expect(await h.backend.store.ops.get(opId)).toEqual(queued);
  });

  it("credential replacement retires the policy pause on a retained provider", async () => {
    const h = await setup(false, kind);
    h.answer((r) => new URL(r.url).pathname === "/gmail/profile" ? failure(403, "insufficientPermissions") : undefined);
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

  it.each(["SERVICE_DISABLED", "userRateLimitExceeded"])("stale %s body cannot publish after credential replacement", async (reason) => {
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

  it.each(["SERVICE_DISABLED", "userRateLimitExceeded"])("labels %s stays nonidle and never advances through a policy error", async (reason) => {
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

  it("optional userinfo permission failure does not pause Gmail mail", async () => {
    const h = await setup(false, kind);
    const provider = (await h.backend.provider(h.account.id))!;
    await provider.verify();
    h.answer((r) => new URL(r.url).pathname.includes("userinfo") ? failure(403, "insufficientPermissions") : undefined);
    await provider.photos!({ connections: false, otherContacts: false });
    const { opId } = await h.send();
    expect(await h.backend.runWorker()).toBe(1);
    expect(await h.backend.store.ops.get(opId)).toMatchObject({ state: "succeeded", attempts: 1 });
  });

  it("contradictory disabled-service reason in a503 remains transient and does not pause admission", async () => {
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

  it("a policy rejection first discovered by Send projects actionable account recovery", async () => {
    const h = await setup(false, kind);
    await (await h.backend.provider(h.account.id))!.verify();
    h.answer((r) => new URL(r.url).pathname === "/gmail/messages/send" ? failure(403, "SERVICE_DISABLED") : undefined);
    const { opId } = await h.send();
    await h.backend.runWorker();
    expect(await h.backend.store.ops.get(opId)).toMatchObject({ state: "failed", attempts: 1 });
    expect((await h.rpc.call("app.bootstrap", {})).accounts[0]!.syncState).toMatchObject({ status: "error", lastErrorI18n: { key: "errors.gmail.serviceDisabled" }, connection: null });
  });

  it("an older policy body cannot relatch after explicit recovery in the same credential generation", async () => {
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

  it("header-only nonquota403 never creates a cooldown or policy pause", async () => {
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

  it("explicit user recovery resumes a disabled saved account without changing its credential", async () => {
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

  it("local physical capacity costs no attempt or remote cooldown and terminal EOF restores admission", async () => {
    const h = await setup(false, kind);
    await (await h.backend.provider(h.account.id))!.verify();
    const responses: Response[] = [];
    try {
      for (let i = 0; i < 64; i++) responses.push(await h.context.google!.request({ request: { endpoint: "gmail-api", purpose: "mail" } }, "https://synthetic.invalid/hold"));
      const { opId } = await h.send();
      const original = await h.backend.store.ops.get(opId);
      const ledger = await h.backend.store.providerCooldown.read();
      await expect(h.context.google!.request({ request: { endpoint: "gmail-api", purpose: "mail" } }, "https://synthetic.invalid/hold")).rejects.toMatchObject({ cooldown: { kind: "capacity" } });
      expect(await h.backend.runWorker()).toBe(0);
      expect(await h.backend.store.ops.get(opId)).toEqual(original);
      expect(await h.backend.store.providerCooldown.read()).toBe(ledger);
      expect(h.requests).toHaveLength(66);
      expect(await responses.shift()!.text()).toBe("held");
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
  const net = createNetworkPolicy({ localMode: () => true, fetch: async (input) => {
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
