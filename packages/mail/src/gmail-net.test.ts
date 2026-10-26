/**
 * Plan 20: Gmail requests across network changes. A read never hangs on a dead socket (its deadline,
 * reset()), a send is never cut short by a reset and never retried once it may have left.
 */
import { describe, expect, it } from "vitest";
import { createGmailProvider } from "./gmail";
import { createGmailApiProvider } from "./gmail-api";
import { ProviderAuthError, ProviderError, type MailProvider, type ProviderContext, type SyncSink } from "./types";

interface Call {
  url: string;
  signal: AbortSignal | undefined;
  respond(res: Response): void;
  fail(e: unknown): void;
}

/** a fetch whose answers the test gives by hand; it rejects on abort, as fetch does */
function manualFetch() {
  const calls: Call[] = [];
  const fetch = ((input: string | URL, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const signal = init?.signal ?? undefined;
      if (signal?.aborted) return reject(signal.reason);
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      calls.push({ url: String(input), signal, respond: resolve, fail: reject });
    })) as typeof globalThis.fetch;
  return { fetch, calls };
}

function provider(fetch: typeof globalThis.fetch, o: { readTimeoutMs?: number; sendTimeoutMs?: number; tokens?: () => Promise<string>; invalidate?: (token: string) => void } = {}): MailProvider {
  const ctx = { account: { id: 1, email: "me@gmail.com" }, store: {}, config: {}, fetch } as unknown as ProviderContext;
  return createGmailApiProvider(ctx, {
    tokens: { get: o.tokens ?? (async () => "token"), invalidate: o.invalidate ?? (() => {}) },
    buildRaw: async () => new TextEncoder().encode("raw"),
    readTimeoutMs: o.readTimeoutMs,
    sendTimeoutMs: o.sendTimeoutMs,
  });
}

const sendOp = { id: "op-1", kind: "send", target: {}, payload: { providerThreadId: null } };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("Gmail requests and the network (plan 20)", () => {
  it.each(["cached full", "cached delta", "new raw", "history"] as const)("an OAuth refresh 404 during %s cannot delete mail or advance its checkpoint", async (phase) => {
    const removed: number[] = [];
    const saved: unknown[] = [];
    let refreshes = 0;
    const ctx = {
      account: { id: 1, email: "me@gmail.com" }, config: {},
      getSecret: async () => "refresh-token", getAppSecret: async () => null,
      store: {
        setting: async () => ({ gmailClientId: "client" }),
        syncedMessages: async () => [{ id: 7, providerMsgId: "g7" }],
        messageByProviderId: async () => phase === "new raw" ? null : { id: 7 },
      },
      loadCursor: async () => phase === "cached full" ? null : { historyId: "10" },
      saveCursor: async (cursor: unknown) => { saved.push(cursor); },
      fetch: async (input: string | URL) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/token")) return ++refreshes === 1 ? json({ access_token: "token", expires_in: 3600 }) : json({ error: "not_found" }, 404);
        if (path.endsWith("/profile")) return json({ historyId: "11" });
        if (path.endsWith("/messages")) return json({ messages: [] });
        if (path.endsWith("/history")) return phase === "history" ? json({}, 401) : json({ historyId: "11", history: [{ [phase === "new raw" ? "messagesAdded" : "labelsAdded"]: [{ message: { id: "g7" } }] }] });
        if (path.endsWith("/messages/g7")) return json({}, 401);
        throw new Error(`unexpected request ${path}`);
      },
    } as unknown as ProviderContext;
    const sink: SyncSink = {
      signal: new AbortController().signal, windowStart: 0,
      ingest: async () => {}, setBody: async () => {}, updateFlags: async () => {}, setSyncState: async () => {}, pendingMessageIds: async () => new Set(),
      removeMessages: async (ids) => { removed.push(...ids); },
    };
    await expect(createGmailProvider(ctx).sync(sink)).rejects.toMatchObject({ status: 404 });
    expect(removed).toEqual([]);
    expect(saved).toEqual([]);
  });

  it.each([
    ["userRateLimitExceeded", true],
    ["rateLimitExceeded", true],
    ["insufficientPermissions", false],
    ["domainPolicy", false],
    ["dailyLimitExceeded", false],
    ["failedPrecondition", false],
  ] as const)("Gmail 403 reason %s has the appropriate recovery policy", async (reason, retryable) => {
    const fetch = (async () => json({ error: { code: 403, errors: [{ reason }] } }, 403)) as typeof globalThis.fetch;
    const error = await provider(fetch).verify().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).not.toBeInstanceOf(ProviderAuthError);
    expect(error).toMatchObject({ status: 403, retryable, ambiguous: false, network: false });
  });

  it.each([[403, "userRateLimitExceeded"], [403, "rateLimitExceeded"], [429, "unknown"]] as const)("a quota-rejected send (%i, %s) is safely retryable, never uncertain", async (status, reason) => {
    let submissions = 0;
    let tokens = 0;
    let invalidations = 0;
    const fetch = (async () => {
      submissions++;
      return json({ error: { code: status, errors: [{ reason }] } }, status);
    }) as typeof globalThis.fetch;
    const error = await provider(fetch, { tokens: async () => { tokens++; return "token"; }, invalidate: () => { invalidations++; } }).execute(sendOp).catch((e: unknown) => e);
    expect(error).toMatchObject({ retryable: true, ambiguous: false, network: false });
    expect(submissions).toBe(1);
    expect(tokens).toBe(1);
    expect(invalidations).toBe(0);
  });

  it.each(["null", "42", '"rateLimitExceeded"', "not JSON: rateLimitExceeded", '{"error":{"message":"rateLimitExceeded"}}', '{"error":{"errors":[null,{},"rateLimitExceeded",{"reason":4}]}}', '{"error":{"errors":{"reason":"rateLimitExceeded"}}}'])("unstructured forbidden responses remain action-required: %s", async (body) => {
    const fetch = (async () => new Response(body, { status: 403 })) as typeof globalThis.fetch;
    expect(await provider(fetch).verify().catch((e: unknown) => e)).toMatchObject({ retryable: false, ambiguous: false });
  });

  it("a valid quota reason after malformed entries is still recognized, and body code never overrides HTTP status", async () => {
    const body = { error: { code: 403, errors: [null, {}, { reason: "rateLimitExceeded" }] } };
    const throttled = (async () => json(body, 403)) as typeof globalThis.fetch;
    expect(await provider(throttled).verify().catch((e: unknown) => e)).toMatchObject({ retryable: true });
    const badRequest = (async () => json(body, 400)) as typeof globalThis.fetch;
    expect(await provider(badRequest).verify().catch((e: unknown) => e)).toMatchObject({ retryable: false, status: 400 });
  });

  it.each(['{"error":"temporarily_unavailable"}', '{"error":"invalid_grant"}', "null", "", "{broken"])("a throttled token endpoint remains retryable for body %s", async (body) => {
    let requests = 0;
    const ctx = {
      account: { id: 1, email: "me@gmail.com" }, config: {},
      fetch: async () => { requests++; return new Response(body, { status: 429 }); },
      getSecret: async () => "refresh-token", getAppSecret: async () => null,
      store: { setting: async () => ({ gmailClientId: "client" }) },
    } as unknown as ProviderContext;
    const error = await createGmailProvider(ctx).verify().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ retryable: true, ambiguous: false, network: false, status: 429 });
    expect(error).not.toBeInstanceOf(ProviderAuthError);
    expect(requests).toBe(1);
  });

  it.each([500, 200])("a send's uncertain HTTP %i response cannot become a safe quota retry", async (status) => {
    let requests = 0;
    const fetch = (async () => {
      requests++;
      return status === 200 ? new Response("{truncated", { status }) : json({ error: { errors: [{ reason: "rateLimitExceeded" }] } }, status);
    }) as typeof globalThis.fetch;
    expect(await provider(fetch).execute(sendOp).catch((e: unknown) => e)).toMatchObject({ ambiguous: true });
    expect(requests).toBe(1);
  });

  it("an empty HTTP 204 send acknowledgement is uncertain, not an ordinary error eligible for retry", async () => {
    const fetch = (async () => new Response(null, { status: 204 })) as typeof globalThis.fetch;
    const error = await provider(fetch).execute(sendOp).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ ambiguous: true, retryable: false });
  });

  it("reset() fails a read in flight at once, as a network failure (the sync goes again on fresh sockets)", async () => {
    const { fetch, calls } = manualFetch();
    const p = provider(fetch);
    const read = p.verify();
    await settle();
    expect(calls).toHaveLength(1);
    p.reset!();
    const error = await read.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ retryable: true, network: true, ambiguous: false });
  });

  it("reset() never touches a send in flight: it finishes and counts", async () => {
    const { fetch, calls } = manualFetch();
    const p = provider(fetch);
    const sending = p.execute(sendOp);
    await settle();
    await settle();
    const call = calls.find((c) => c.url.endsWith("/messages/send"))!;
    p.reset!();
    expect(call.signal?.aborted).toBe(false);
    call.respond(json({ id: "gm-1", threadId: "th-1" }));
    await expect(sending).resolves.toEqual({ providerMsgId: "gm-1", providerThreadId: "th-1" });
  });

  it("a read that gets no answer gives up at its deadline (not undici's 5 minutes)", async () => {
    const { fetch } = manualFetch();
    const started = Date.now();
    const error = await provider(fetch, { readTimeoutMs: 80 }).verify().catch((e: unknown) => e);
    expect(error).toMatchObject({ network: true, retryable: true });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("a read whose body stalls after the headers gives up at its deadline too", async () => {
    const fetch = (async (_input: string, init?: RequestInit) => {
      const signal = init!.signal!;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"emailAddress":'));
          signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
        },
      });
      return new Response(body, { status: 200 });
    }) as typeof globalThis.fetch;
    const error = await provider(fetch, { readTimeoutMs: 80 }).verify().catch((e: unknown) => e);
    expect(error).toMatchObject({ network: true, retryable: true });
  });

  it("a send with no answer becomes unknown at its (long) deadline, never retried", async () => {
    const { fetch } = manualFetch();
    const error = await provider(fetch, { sendTimeoutMs: 80 }).execute(sendOp).catch((e: unknown) => e);
    expect(error).toMatchObject({ ambiguous: true, retryable: false, network: false });
  });

  it("a send that never connected never left: it waits for the network like a read", async () => {
    const refused = (async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
    }) as typeof globalThis.fetch;
    expect(await provider(refused).execute(sendOp).catch((e: unknown) => e)).toMatchObject({ network: true, retryable: true, ambiguous: false });
    // a reset mid-request, though, may come after Google got it
    const reset = (async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) });
    }) as typeof globalThis.fetch;
    expect(await provider(reset).execute(sendOp).catch((e: unknown) => e)).toMatchObject({ ambiguous: true, retryable: false });
  });

  it("a read refused by a certificate is retryable but isn't connectivity", async () => {
    const cert = (async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" }) });
    }) as typeof globalThis.fetch;
    expect(await provider(cert).verify().catch((e: unknown) => e)).toMatchObject({ network: false, retryable: true });
  });

  it("a fresh token refused as well is a sign-in to redo (ops wait for it); a 403 isn't", async () => {
    let tokenCalls = 0;
    const refused = (async () => new Response("{}", { status: 401 })) as typeof globalThis.fetch;
    const error = await provider(refused, { tokens: async () => `t${++tokenCalls}` }).verify().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderAuthError);
    expect(tokenCalls).toBe(2);
    const forbidden = (async () => json({ error: "insufficientPermissions" }, 403)) as typeof globalThis.fetch;
    const e403 = await provider(forbidden).verify().catch((e: unknown) => e);
    expect(e403).toBeInstanceOf(ProviderError);
    expect(e403).not.toBeInstanceOf(ProviderAuthError);
  });

  it("Codex review: a token refresh whose body is cut short is the network (the op waits), never a refusal", async () => {
    const cut = (async (input: string) => {
      if (!String(input).includes("token")) return json({ emailAddress: "me@gmail.com" });
      // Google answered 200, then the socket died mid-body (what undici reports)
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"access_token":'));
          controller.error(new TypeError("terminated", { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) }));
        },
      });
      return new Response(body, { status: 200 });
    }) as typeof globalThis.fetch;
    const ctx = {
      account: { id: 1, email: "me@gmail.com" },
      config: {},
      fetch: cut,
      getSecret: async () => "refresh-token",
      getAppSecret: async () => null,
      store: { setting: async () => ({ gmailClientId: "client" }) },
    } as unknown as ProviderContext;
    const error = await createGmailProvider(ctx).verify().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ network: true, retryable: true });
  });

  it("a read leaves no timer behind once it's answered", async () => {
    const { fetch, calls } = manualFetch();
    const p = provider(fetch, { readTimeoutMs: 50 });
    const read = p.verify();
    await settle();
    calls[0]!.respond(json({ emailAddress: "me@gmail.com", historyId: "10" }));
    await read;
    // past the deadline: the answered request's timer would have aborted something (no unhandled rejection, no abort)
    await new Promise((r) => setTimeout(r, 80));
    expect(calls[0]!.signal!.aborted).toBe(false);
  });
});
