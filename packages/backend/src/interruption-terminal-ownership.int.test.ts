import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { parseRaw, type ProviderContext, type ProviderRegistry } from "@terno/mail";
import { buildRawPortable, createGmailApiProvider } from "@terno/mail/portable";
import { afterEach, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";

const cleanup: (() => Promise<void>)[] = [];
async function finish(tasks: (() => Promise<void>)[]) {
  const errors: unknown[] = [];
  for (const task of tasks) { try { await task(); } catch (error) { errors.push(error); } }
  if (errors.length) throw new AggregateError(errors, "Fixture cleanup failed");
}
async function joinRead(result: Promise<PromiseSettledResult<Response>[]>, started: () => boolean, terminal: Promise<void>) {
  for (const outcome of await result) if (outcome.status === "fulfilled") await outcome.value.arrayBuffer();
  await turn();
  if (started()) await terminal;
}
afterEach(async () => { try { await finish(cleanup.splice(0).reverse()); } finally { vi.unstubAllGlobals(); vi.restoreAllMocks(); } });
function gate() { let release!: () => void; const promise = new Promise<void>((r) => { release = r; }); return { promise, release }; }
const turn = () => new Promise<void>((r) => setImmediate(r));
const api = "https://gmail.googleapis.com/gmail/v1/users/me";

async function setup(answer: (request: Request) => Promise<Response>) {
  const unexpected: string[] = [], requests: Request[] = [], contexts = new Map<number, ProviderContext>();
  // Installed before Backend captures fetch. There is no fallback to a real socket.
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
    expect(input).toBeInstanceOf(Request);
    const request = input as Request;
    requests.push(request);
    if (request.url === `${api}/profile`) {
      expect(request.method).toBe("GET");
      const email = request.headers.get("authorization") === "Bearer sibling" ? "sibling@example.test" : "first@example.test";
      return Response.json({ emailAddress: email, historyId: "1" });
    }
    if ([`${api}/messages/send`, `${api}/messages/held`, `${api}/messages/sibling`].includes(request.url)) return answer(request);
    unexpected.push(`${request.method} ${request.url}`);
    throw new Error("Unexpected synthetic transport route");
  }));
  const dir = mkdtempSync(join(tmpdir(), "terno-s27-"));
  const providers: ProviderRegistry = {
    create(ctx) {
      contexts.set(ctx.account.id, ctx);
      return { ...createGmailApiProvider(ctx, { tokens: { get: async () => ctx.account.email.startsWith("sibling") ? "sibling" : "first", invalidate() {} }, buildRaw: buildRawPortable }), async sync() {}, async folders() {} };
    },
    async verifyImap() {},
    async connectGmail(o) { return { email: o.loginHint!, name: "Synthetic", sub: "synthetic-sub", emailVerified: true, refreshToken: "synthetic-refresh", grantedScopes: ["https://www.googleapis.com/auth/gmail.modify"] }; },
  };
  let backend: Backend, client: RpcClient;
  const open = async () => {
    backend = new Backend({ dbPath: join(dir, "mail.db"), providers, cipher: plaintextCipher, version: "test", autoSync: false, instantSearch: false, iconTransport: null, openExternal: async () => {} });
    await backend.ready;
    const [c, s] = createMemoryTransportPair(); backend.connect(s, { clientId: "s27", origin: "renderer" }); client = new RpcClient(c);
  };
  await open();
  cleanup.push(async () => { client.close(); await backend.stop(); rmSync(dir, { recursive: true, force: true }); });
  const ids: number[] = [];
  for (const name of ["first", "sibling"]) {
    const { account } = await backend!.store.accounts.create({ kind: "gmail", email: `${name}@example.test`, displayName: name, color: "indigo", providerConfig: {}, now: 1 });
    ids.push(account.id);
    await backend!.syncAccount(account.id);
  }
  await client!.call("settings.update", { gmailClientId: "synthetic-client" });
  return { get backend() { return backend!; }, get client() { return client!; }, ids, contexts, requests, unexpected,
    async reopen() { client.close(); await backend.stop(); await open(); },
  };
}

it.each(["EOF", "read error"] as const)("retired managed headers retain physical capacity until native %s; sibling read remains independent", async (terminal) => {
  const entered = gate(), headers = gate(), tail = gate(), reading = gate(), siblingEntered = gate(), siblingRelease = gate(), drained = gate();
  let reads = 0, cancels = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      reads++; reading.release(); await tail.promise;
      drained.release();
      if (terminal === "read error") controller.error(new TypeError("Synthetic interrupted read"));
      else controller.close();
    }, cancel() { cancels++; },
  }, { highWaterMark: 0 });
  cleanup.push(async () => { headers.release(); tail.release(); siblingRelease.release(); });
  const t = await setup(async (request) => {
    if (request.url.endsWith("/held")) { entered.release(); await headers.promise; return new Response(body); }
    expect(request.url).toBe(`${api}/messages/sibling`);
    siblingEntered.release(); await siblingRelease.promise;
    expect(request.signal.aborted).toBe(false);
    return new Response("sibling exact body");
  });
  const old = t.contexts.get(t.ids[0]!)!, sibling = t.contexts.get(t.ids[1]!)!;
  await old.google!.prove(async () => old.account.email);
  await sibling.google!.prove(async () => sibling.account.email);
  const read = (ctx: ProviderContext, id: string, signal?: AbortSignal) => ctx.google!.request({ request: { endpoint: "gmail-api", purpose: "mail" }, generation: ctx.google!.generation() }, `${api}/messages/${id}`, { signal });
  const controller = new AbortController();
  const result = Promise.allSettled([read(old, "held", controller.signal)]);
  cleanup.push(async () => { headers.release(); tail.release(); siblingRelease.release(); await joinRead(result, () => reads > 0, drained.promise); await turn(); });
  await entered.promise;
  const siblingResult = read(sibling, "sibling");
  cleanup.push(async () => { siblingRelease.release(); await siblingResult; });
  await siblingEntered.promise;
  expect(t.backend.net.googlePending()).toBe(2);
  await t.client.call("accounts.reconnect", { id: t.ids[0]! });
  expect(() => old.google!.check({ endpoint: "gmail-api", purpose: "mail" })).toThrow();
  expect(controller.signal.aborted).toBe(false);
  siblingRelease.release();
  expect(await (await siblingResult).text()).toBe("sibling exact body");
  expect(t.backend.net.googlePending()).toBe(1);
  headers.release(); await reading.promise;
  expect((await result)[0]).toMatchObject({ status: "rejected", reason: { name: "AbortError" } });
  expect(cancels).toBe(0);
  const assertHeld = () => expect(t.backend.net.googlePending()).toBe(1);
  assertHeld();
  await turn(); assertHeld();
  tail.release();
  await expect.poll(() => t.backend.net.googlePending()).toBe(0);
  expect(() => assertHeld()).toThrow();
  expect(reads).toBe(1); expect(cancels).toBe(0);
  expect(t.unexpected).toEqual([]);
  expect(t.requests.map((r) => r.url)).toEqual([`${api}/messages/held`, `${api}/messages/sibling`]);
});

it.each(["success", "late acceptance", "connection loss", "body loss", "portal HTML"] as const)("dispatched Gmail %s after lifetime replacement preserves its terminal outcome across SQL reopen with exact attachment and one POST", async (outcome) => {
  const entered = gate(), release = gate();
  let signal: AbortSignal | undefined, raw = "", sends = 0;
  cleanup.push(async () => release.release());
  const t = await setup(async (request) => {
    expect(request.url).toBe(`${api}/messages/send`); expect(request.method).toBe("POST");
    expect(request.headers.get("authorization")).toBe("Bearer first");
    sends++; signal = request.signal;
    const payload = await request.json() as { raw: string };
    raw = Buffer.from(payload.raw, "base64url").toString();
    entered.release(); await release.promise;
    if (outcome === "connection loss") throw new TypeError("Synthetic connection lost after dispatch");
    if (outcome === "body loss") return new Response(new ReadableStream({ start(c) { c.error(new TypeError("Synthetic response body lost")); } }));
    if (outcome === "portal HTML") return new Response("<html>synthetic login portal</html>", { status: 200, headers: { "content-type": "text/html" } });
    return Response.json({ id: "accepted-once", threadId: "accepted-thread" });
  });
  const accountId = t.ids[0]!;
  const attachment = await t.client.call("attachments.create", { accountId, filename: "exact.bin", mime: "application/octet-stream", size: 5 });
  await t.client.call("attachments.append", { accountId, assetId: attachment.assetId, index: 0, dataBase64: "AP+ADQo=" });
  await t.client.call("attachments.seal", { accountId, assetId: attachment.assetId });
  const { opId } = await t.client.call("compose.send", { accountId, to: [{ name: "Recipient", email: "recipient@example.test" }], subject: "Exact subject", bodyText: "Exact body", attachments: [attachment] });
  const original = (await t.backend.store.ops.get(opId))!.payload_json;
  const worker = t.backend.runWorker();
  cleanup.push(async () => { release.release(); await worker; });
  await Promise.race([entered.promise, worker.then(() => { throw new Error("Worker ended before dispatch"); })]);
  expect(t.backend.net.googlePending()).toBe(1);
  if (outcome !== "success") await t.client.call("accounts.reconnect", { id: accountId });
  expect(signal?.aborted).toBe(false);
  release.release(); await worker;
  await expect.poll(() => t.backend.net.googlePending()).toBe(0);
  const op = (await t.backend.store.ops.get(opId))!;
  expect(op).toMatchObject({ state: outcome === "success" ? "succeeded" : "unknown", attempts: 1, payload_json: original });
  const assertContent = async (wire: string) => {
    const message = await parseRaw(wire);
    expect(message.subject).toBe("Exact subject"); expect(message.text).toBe("Exact body");
    expect(message.to).toEqual([{ name: "Recipient", email: "recipient@example.test" }]);
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0]).toMatchObject({ filename: "exact.bin", mime: "application/octet-stream", size: 5 });
    expect(message.attachments[0]!.bytes).toEqual(new Uint8Array([0, 255, 128, 13, 10]));
  };
  await assertContent(raw);
  // Tests-only qualification: corrupt the same observed wire to prove the content oracle rejects it.
  await expect(assertContent(raw.replace("Exact subject", "Wrong subject"))).rejects.toThrow();
  await expect(assertContent(raw.replace("AP+ADQo=", "Af+ADQo="))).rejects.toThrow();
  await t.reopen();
  await t.backend.runWorker(); await turn();
  expect(await t.backend.store.ops.get(opId)).toMatchObject({ state: outcome === "success" ? "succeeded" : "unknown", attempts: 1, payload_json: original });
  expect(sends).toBe(1); expect(t.unexpected).toEqual([]);
  expect(t.requests.filter((r) => r.method === "POST")).toHaveLength(1);
});

it.each(["cancel", "abort then EOF"] as const)("managed read %s conservatively retains its slot without cancelling a sibling", async (event) => {
  let native!: ReadableStreamDefaultController<Uint8Array>, cancelled = 0;
  const body = new ReadableStream<Uint8Array>({ start(c) { native = c; }, cancel() { cancelled++; } }, { highWaterMark: 0 });
  const siblingEntered = gate(), siblingRelease = gate();
  let siblingSignal!: AbortSignal;
  const t = await setup(async (request) => {
    if (request.url.endsWith("/held")) return new Response(body);
    siblingSignal = request.signal; siblingEntered.release(); await siblingRelease.promise;
    return new Response("sibling body");
  });
  const old = t.contexts.get(t.ids[0]!)!, sibling = t.contexts.get(t.ids[1]!)!;
  await old.google!.prove(async () => old.account.email); await sibling.google!.prove(async () => sibling.account.email);
  const controller = new AbortController();
  const response = await old.google!.request({ request: { endpoint: "gmail-api", purpose: "mail" }, generation: old.google!.generation() }, `${api}/messages/held`, { signal: controller.signal });
  const siblingController = new AbortController();
  const siblingResponse = sibling.google!.request({ request: { endpoint: "gmail-api", purpose: "mail" }, generation: sibling.google!.generation() }, `${api}/messages/sibling`, { signal: siblingController.signal });
  cleanup.push(async () => { siblingRelease.release(); const res = await siblingResponse; if (!res.bodyUsed) await res.arrayBuffer(); });
  await siblingEntered.promise;
  expect(t.backend.net.googlePending()).toBe(2);
  if (event === "cancel") { await response.body!.cancel(); expect(cancelled).toBe(1); }
  else { controller.abort(); native.close(); expect(await response.text()).toBe(""); expect(cancelled).toBe(0); }
  expect(t.backend.net.googlePending()).toBe(2);
  const assertIndependent = () => expect(siblingSignal.aborted).toBe(false);
  assertIndependent();
  siblingRelease.release();
  expect(await (await siblingResponse).text()).toBe("sibling body");
  // Oracle control acts on the same native Request signal, not a fabricated signal.
  siblingController.abort();
  expect(assertIndependent).toThrow();
  expect(t.backend.net.googlePending()).toBe(1);
  await turn(); expect(t.backend.net.googlePending()).toBe(1);
  expect(t.unexpected).toEqual([]);
});


it("teardown consumes a fulfilled unread response before joining its native terminal", async () => {
  const terminal = gate(); let pulls = 0;
  const response = new Response(new ReadableStream<Uint8Array>({ pull(c) { pulls++; c.close(); terminal.release(); } }, { highWaterMark: 0 }));
  const result = Promise.resolve([ { status: "fulfilled" as const, value: response } ]);
  const joining = joinRead(result, () => pulls > 0, terminal.promise);
  try { await turn(); expect(pulls).toBe(1); }
  finally { if (!response.bodyUsed) await response.text(); await joining; }
});

it("teardown runs remaining owners after a close failure and still reports that failure", async () => {
  const fault = new Error("Synthetic close failure"), events: string[] = [];
  await expect(finish([async () => { throw fault; }, async () => { events.push("remaining owner closed"); }])).rejects.toThrow();
  expect(events).toEqual(["remaining owner closed"]);
});
