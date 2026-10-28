import { createServer, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { setTimeout as nativeTimeout, clearTimeout as clearNativeTimeout } from "node:timers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureError, installDiag, normalizeError } from "@terno/core/diag";
import { toErrorPayload } from "@terno/core/rpc";
import { createGmailApiProvider } from "./gmail-api";
import { connectGmail, createGmailProvider } from "./gmail";
import { createGmailTokenBroker } from "./gmail-web";
import { beginGmailRenewal } from "./gmail-renewal";
import { CONTACTS_SCOPE } from "./google-photos";
import { ProviderAuthError, ProviderError, type ProviderContext } from "./types";

const endpoints = { auth: "https://auth.test/authorize", token: "https://oauth.test/token", api: "https://gmail.test/mail", userinfo: "https://openid.test/userinfo" };
const date = "Tue, 27 Oct 2026 18:00:00 GMT";
const token = { access_token: "synthetic-access", token_type: "Bearer", expires_in: 3600 };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  installDiag({ proc: "backend", version: "test", build: "test", channel: "dev" });
});

async function wire(handle: (path: string, response: ServerResponse) => void) {
  const requests: string[] = [], logical: string[] = [];
  const sockets = new Set<Socket>();
  const watchdogs = new Set<ReturnType<typeof nativeTimeout>>();
  const controllers = new Set<AbortController>();
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Drain the small synthetic request. */ }
    requests.push(request.url!);
    response.sendDate = false;
    handle(request.url!, response);
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  const origin = `http://127.0.0.1:${address.port}`;
  const netFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (!["https://gmail.test", "https://oauth.test", "https://openid.test", "https://people.googleapis.com"].includes(url.origin)) throw new Error("Unexpected logical fixture origin");
    logical.push(url.toString());
    const abort = new AbortController();
    controllers.add(abort);
    watchdogs.add(nativeTimeout(() => abort.abort(new Error("Fixture watchdog")), 5000));
    return fetch(`${origin}${url.pathname}${url.search}`, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, abort.signal]) : abort.signal });
  };
  cleanup.push(async () => {
    for (const abort of controllers) abort.abort();
    for (const timer of watchdogs) clearNativeTimeout(timer);
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.all([...sockets].map((socket) => new Promise<void>((resolve) => { socket.once("close", resolve); socket.destroy(); })));
    await closed;
    expect(sockets.size).toBe(0);
  });
  return { requests, logical, fetch: netFetch };
}

function reply(response: ServerResponse, status: number, body = "{}", retryAfter: string | null = "120", serverDate: string | null = date) {
  response.writeHead(status, { "content-type": "application/json", ...(retryAfter === null ? {} : { "rEtRy-AfTeR": retryAfter }), ...(serverDate === null ? {} : { Date: serverDate }) });
  response.end(body);
}
function context(netFetch: typeof fetch) {
  const replaceSecret = vi.fn(async () => true);
  const ctx = {
    account: { id: 1, email: "synthetic@example.test" }, config: {},
    fetch: netFetch, store: { setting: async () => ({ gmailClientId: "synthetic-client" }) },
    getSecret: async () => "synthetic-refresh", getAppSecret: async () => null, replaceSecret,
  } as unknown as ProviderContext;
  return { ctx, replaceSecret };
}
function api(netFetch: typeof fetch) {
  const { ctx } = context(netFetch);
  const provider = createGmailApiProvider(ctx, { endpoints, tokens: { get: async () => "synthetic-access", invalidate() {} }, buildRaw: async () => new TextEncoder().encode("synthetic"), readTimeoutMs: 500, sendTimeoutMs: 500 });
  cleanup.push(() => provider.close());
  return provider;
}
async function failure(work: Promise<unknown>): Promise<ProviderError> {
  const error: unknown = await work.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(ProviderError);
  return error as ProviderError;
}
function evidence(error: ProviderError): unknown {
  return error.httpResponse;
}
function expected(endpoint: string, purpose: string, status: number, retryAfter = "120") {
  return { source: "http-response", request: { endpoint, purpose }, status, quotaScope: "unknown", received: { source: "date-now", kind: "wall", wallMs: expect.any(Number) }, retryAfter: { kind: "value", value: retryAfter }, serverDate: { kind: "value", value: date } };
}
const send = { id: "synthetic-op", kind: "send", target: {}, payload: { providerThreadId: null } };

describe("failed HTTP evidence through public Gmail boundaries", () => {
  it.each([[429, undefined, true], [503, undefined, true], [403, "userRateLimitExceeded", true], [403, "rateLimitExceeded", true], [403, "insufficientPermissions", false], [403, "accessNotConfigured", false], [403, "dailyLimitExceeded", false], [404, undefined, false]] as const)("retains headers without changing API status %i / %s", async (status, reason, retryable) => {
    const t = await wire((_path, response) => reply(response, status, JSON.stringify({ error: { errors: reason ? [{ reason }] : [] } })));
    const error = await failure(api(t.fetch).verify());
    expect(error).toMatchObject({ status, retryable, ambiguous: false, network: false });
    expect(error).not.toBeInstanceOf(ProviderAuthError);
    expect(t.requests).toEqual(["/mail/profile"]);
    expect(evidence(error)).toEqual(expected("gmail-api", "mail", status));
  });

  it.each([429, 503])("send HTTP %i keeps definitive versus ambiguous precedence", async (status) => {
    const t = await wire((_path, response) => reply(response, status));
    const error = await failure(api(t.fetch).execute(send));
    expect(error).toMatchObject({ retryable: true, ambiguous: status === 503, network: false });
    expect(t.requests).toEqual(["/mail/messages/send"]);
    expect(evidence(error)).toEqual(expected("gmail-api", "mail", status));
  });

  it.each(["malformed", "utf8", "oversized", "empty", "truncated"] as const)("API error evidence survives %s body", async (mode) => {
    const t = await wire((_path, response) => {
      if (mode === "truncated") {
        response.writeHead(429, { "retry-after": "120", date, "content-length": "100" });
        response.write("{");
        const timer = nativeTimeout(() => response.destroy(), 10);
        cleanup.push(async () => clearNativeTimeout(timer));
      } else if (mode === "utf8") {
        response.writeHead(429, { "retry-after": "120", date }); response.end(Buffer.from([255]));
      } else reply(response, 429, mode === "oversized" ? "x".repeat(65_537) : mode === "empty" ? "" : "{");
    });
    const error = await failure(api(t.fetch).verify());
    expect(error).toMatchObject({ status: 429, retryable: true, network: false });
    expect(t.requests).toEqual(["/mail/profile"]);
    expect(evidence(error)).toEqual(expected("gmail-api", "mail", 429));
  });

  it.each(["0", "9".repeat(256), "Tue, 27 Oct 2026 18:10:00 GMT", "Sun, 06 Nov 1994 08:49:37 GMT", "1, 2", ""]) ("preserves bounded directive verbatim (%s)", async (value) => {
    const t = await wire((_path, response) => reply(response, 429, "{}", value));
    expect(evidence(await failure(api(t.fetch).verify()))).toEqual(expected("gmail-api", "mail", 429, value));
  });

  it("bounds both fields independently and distinguishes unobserved headers", async () => {
    let pass = 0;
    const t = await wire((_path, response) => {
      pass++;
      if (pass === 1) reply(response, 429, "{}", "1".repeat(257));
      else if (pass === 2) reply(response, 429, "{}", "120", "x".repeat(257));
      else reply(response, 429, "{}", null, null);
    });
    const p = api(t.fetch);
    expect(evidence(await failure(p.verify()))).toMatchObject({ retryAfter: { kind: "too-long" }, serverDate: { kind: "value", value: date } });
    expect(evidence(await failure(p.verify()))).toMatchObject({ retryAfter: { kind: "value", value: "120" }, serverDate: { kind: "too-long" } });
    expect(evidence(await failure(p.verify()))).toMatchObject({ retryAfter: { kind: "not-visible" }, serverDate: { kind: "not-visible" } });
    expect(t.requests).toHaveLength(3);
  });

  it("keeps final401 auth and successful-body uncertainty unchanged", async () => {
    const t = await wire((_path, response) => reply(response, 401));
    const error = await failure(api(t.fetch).verify());
    expect(error).toBeInstanceOf(ProviderAuthError);
    expect(error).not.toHaveProperty("status");
    expect(t.requests).toHaveLength(2);
    expect(evidence(error)).toEqual(expected("gmail-api", "mail", 401));
    const success = await wire((_path, response) => reply(response, 200, "{"));
    const uncertain = await failure(api(success.fetch).execute(send));
    expect(uncertain).toMatchObject({ ambiguous: true, retryable: false });
    expect(evidence(uncertain)).toBeUndefined();
    expect(success.requests).toHaveLength(1);
  });

  it.each([[400, true], [429, false], [503, false]] as const)("refresh %i invalid_grant retains original auth/status policy", async (status, auth) => {
    const t = await wire((_path, response) => reply(response, status, '{"error":"invalid_grant"}'));
    const h = context(t.fetch), p = createGmailProvider(h.ctx, { endpoints });
    cleanup.push(() => p.close());
    const error = await failure(p.verify());
    if (auth) { expect(error).toBeInstanceOf(ProviderAuthError); expect(error).not.toHaveProperty("status"); }
    else expect(error).toMatchObject({ status, retryable: true, network: false, ambiguous: false });
    expect(h.replaceSecret).not.toHaveBeenCalled();
    expect(t.requests).toEqual(["/token"]);
    expect(evidence(error)).toEqual(expected("oauth-token", "refresh", status));
  });

  it.each(["malformed", "oversized", "utf8", "truncated"] as const)("refresh response evidence survives %s body", async (mode) => {
    const t = await wire((_path, response) => {
      if (mode === "truncated") {
        response.writeHead(503, { "retry-after": "120", date, "content-length": "100" }); response.write("{");
        const timer = nativeTimeout(() => response.destroy(), 10); cleanup.push(async () => clearNativeTimeout(timer));
      } else if (mode === "utf8") { response.writeHead(503, { "retry-after": "120", date }); response.end(Buffer.from([255])); }
      else reply(response, 503, mode === "oversized" ? "x".repeat(65_537) : "{");
    });
    const h = context(t.fetch), p = createGmailProvider(h.ctx, { endpoints }); cleanup.push(() => p.close());
    const error = await failure(p.verify());
    expect(error).toMatchObject({ status: 503, retryable: true, network: false });
    expect(h.replaceSecret).not.toHaveBeenCalled(); expect(t.requests).toEqual(["/token"]);
    expect(evidence(error)).toEqual(expected("oauth-token", "refresh", 503));
  });

  it("an API401 followed by token404 preserves token provenance and prevents send dispatch", async () => {
    let exchanges = 0;
    const t = await wire((path, response) => path === "/token" ? reply(response, ++exchanges === 1 ? 200 : 404, exchanges === 1 ? JSON.stringify(token) : "{") : reply(response, 401));
    const h = context(t.fetch), p = createGmailProvider(h.ctx, { endpoints }); cleanup.push(() => p.close());
    const error = await failure(p.verify());
    expect(error).toMatchObject({ status: 404, retryable: false, network: false });
    expect(t.requests).toEqual(["/token", "/mail/profile", "/token"]);
    expect(evidence(error)).toEqual(expected("oauth-token", "refresh", 404));
  });

  it.each(["profile", "userinfo"] as const)("browser inspect tags %s identity proof", async (stage) => {
    const t = await wire((path, response) => path === "/mail/profile" && stage !== "profile" ? reply(response, 200, '{"emailAddress":"synthetic@example.test"}') : reply(response, 429, "private body"));
    const broker = createGmailTokenBroker({ endpoints });
    const error = await failure(broker.inspect("synthetic-access", t.fetch));
    expect(error).toMatchObject({ retryable: true, ambiguous: false, network: false });
    expect(error).not.toHaveProperty("status");
    expect(t.requests).toEqual(stage === "profile" ? ["/mail/profile"] : ["/mail/profile", "/userinfo"]);
    expect(evidence(error)).toEqual(expected(stage === "profile" ? "gmail-api" : "google-userinfo", "identity-proof", 429));
  });

  it("installed authorization-code refusal is separate from refresh", async () => {
    const t = await wire((_path, response) => reply(response, 429, "malformed"));
    const error = await failure(connectGmail({ clientId: "synthetic-client", clientSecret: null, endpoints, fetch: t.fetch, timeoutMs: 2000, openExternal: async (url) => {
      const auth = new URL(url), callback = new URL(auth.searchParams.get("redirect_uri")!);
      callback.searchParams.set("state", auth.searchParams.get("state")!); callback.searchParams.set("code", "synthetic-code");
      const abort = new AbortController(), timer = nativeTimeout(() => abort.abort(), 5000);
      try { await fetch(callback, { signal: abort.signal }).then((response) => response.text()); } finally { clearNativeTimeout(timer); }
    } }));
    expect(error).toMatchObject({ retryable: true }); expect(error).not.toHaveProperty("status");
    expect(t.requests).toEqual(["/token"]);
    expect(evidence(error)).toEqual(expected("oauth-token", "authorization-code", 429));
  });

  it("cold proof tags People separately and preserves the known refresh result", async () => {
    const t = await wire((path, response) => path === "/token" ? reply(response, 200, JSON.stringify(token)) : reply(response, 429));
    const proof = await beginGmailRenewal({ clientId: "synthetic-client", clientSecret: null, refreshToken: "synthetic-refresh", fetch: t.fetch, endpoints });
    const error = await failure(proof.provePhotos([CONTACTS_SCOPE]));
    expect(proof.refreshToken).toBe("synthetic-refresh");
    expect(t.requests).toEqual(["/token", "/v1/people/me/connections?personFields=photos&pageSize=1"]);
    expect(t.logical[1]).toBe("https://people.googleapis.com/v1/people/me/connections?personFields=photos&pageSize=1");
    expect(evidence(error)).toEqual(expected("google-people", "grant-proof", 429));
  });

  it("portable broker uses the API boundary and absent tokens have no response evidence", async () => {
    const t = await wire((_path, response) => reply(response, 429)), broker = createGmailTokenBroker({ endpoints });
    const { ctx } = context(t.fetch), p = broker.provider(ctx); cleanup.push(() => p.close());
    const absent = await failure(p.verify()); expect(absent).toBeInstanceOf(ProviderAuthError); expect(evidence(absent)).toBeUndefined(); expect(t.requests).toEqual([]);
    broker.set(1, "synthetic-access", Date.now() + 3_600_000);
    expect(evidence(await failure(p.verify()))).toEqual(expected("gmail-api", "mail", 429));
    expect(t.requests).toEqual(["/mail/profile"]);
  });

  it("raw hostile headers remain local to the error and out of diagnostic/RPC/JSON projections", async () => {
    const marker = "PRIVATE_HEADER_synthetic@example.test_SECRET_TOKEN";
    const t = await wire((_path, response) => reply(response, 429, marker, marker, marker));
    const error = await failure(api(t.fetch).verify());
    expect(evidence(error)).toMatchObject({ retryAfter: { value: marker }, serverDate: { value: marker } });
    const entries: unknown[] = [];
    installDiag({ proc: "backend", version: "test", build: "test", channel: "dev", sink: { write: (entry) => entries.push(entry), capture: (record) => entries.push(record) } });
    captureError(error, { code: "sync.failed", fields: { accountKind: "gmail", retryable: error.retryable } });
    expect(JSON.stringify([entries, normalizeError(error), toErrorPayload(error), { ...error }])).not.toContain(marker);
    expect(Object.keys(error)).not.toContain("httpResponse");
  });
});


const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
describe("receipt and cancellation controls through public providers", () => {
  it("captures header receipt before a body read changes the local clock", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const t = await wire((_path, response) => reply(response, 429));
    const netFetch: typeof fetch = async (input, init) => {
      const response = await t.fetch(input, init), body = response.body;
      Object.defineProperty(response, "body", { get() { clock.mockReturnValue(2_000); return body; } });
      return response;
    };
    const error = await failure(api(netFetch).verify());
    expect(error.httpResponse?.received).toEqual({ source: "date-now", kind: "wall", wallMs: 1_000 });
    expect(Date.now()).toBe(2_000);
    expect(t.requests).toEqual(["/mail/profile"]);
  });

  it.each([429, 503])("a controlled stalled refresh%i preserves its header snapshot through the internal deadline", async (status) => {
    vi.useFakeTimers();
    const receivedAt = Date.now(), canceled = vi.fn();
    const response = new Response(new ReadableStream({ cancel: canceled }), { status, headers: { "retry-after": "120", date } });
    const netFetch = vi.fn<typeof fetch>(async () => response);
    const h = context(netFetch), p = createGmailProvider(h.ctx, { endpoints }); cleanup.push(() => p.close());
    const result = failure(p.verify()); await flush();
    await vi.advanceTimersByTimeAsync(30_000);
    const error = await result;
    expect(error).toMatchObject({ status, retryable: true, network: false, ambiguous: false });
    expect(error.httpResponse).toEqual({ ...expected("oauth-token", "refresh", status), received: { source: "date-now", kind: "wall", wallMs: receivedAt } });
    expect(netFetch).toHaveBeenCalledTimes(1); expect(h.replaceSecret).not.toHaveBeenCalled();
    expect(canceled).toHaveBeenCalledTimes(1); expect(response.body!.locked).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });

  it("explicit close overrides a known failing refresh with the existing cancellation", async () => {
    vi.useFakeTimers();
    const canceled = vi.fn(), response = new Response(new ReadableStream({ cancel: canceled }), { status: 429, headers: { "retry-after": "120", date } });
    const h = context(async () => response), p = createGmailProvider(h.ctx, { endpoints });
    const result = p.verify().catch((error: unknown) => error); await flush(); await p.close();
    expect(await result).toMatchObject({ name: "AbortError" }); expect(await result).not.toHaveProperty("httpResponse");
    expect(canceled).toHaveBeenCalledTimes(1); expect(response.body!.locked).toBe(false); expect(vi.getTimerCount()).toBe(0); expect(h.replaceSecret).not.toHaveBeenCalled();
  });

  it("late refresh response after close is canceled without publishing or reading headers", async () => {
    let answer!: (response: Response) => void;
    const h = context(() => new Promise<Response>((resolve) => { answer = resolve; })), p = createGmailProvider(h.ctx, { endpoints });
    const result = p.verify().catch((error: unknown) => error); await flush(); await p.close();
    expect(await result).toMatchObject({ name: "AbortError" });
    const canceled = vi.fn(), response = new Response(new ReadableStream({ cancel: canceled }), { status: 429, headers: { "retry-after": "120" } });
    const headers = vi.spyOn(response.headers, "get"); answer(response); await flush();
    expect(canceled).toHaveBeenCalledTimes(1); expect(headers).not.toHaveBeenCalled(); expect(h.replaceSecret).not.toHaveBeenCalled();
    expect(await result).not.toHaveProperty("httpResponse");
  });

  it("photo failures exercise exact userinfo and People routes without changing their public results", async () => {
    const t = await wire((_path, response) => reply(response, 429));
    const result = await api(t.fetch).photos!({ connections: true, otherContacts: true });
    expect(result).toMatchObject({ own: null, contacts: [], connections: "failed", otherContacts: "failed" });
    expect(t.requests).toHaveLength(3);
    expect(t.requests[0]).toBe("/userinfo");
    expect(t.requests[1]).toMatch(/^\/v1\/people\/me\/connections\?/);
    expect(t.requests[2]).toMatch(/^\/v1\/otherContacts\?/);
    expect(t.logical[0]).toBe(endpoints.userinfo);
    expect(t.logical.slice(1).every((url) => url.startsWith("https://people.googleapis.com/v1/"))).toBe(true);
  });
});
