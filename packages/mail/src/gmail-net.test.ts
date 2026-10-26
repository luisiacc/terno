/**
 * Plan 20: Gmail requests across network changes. A read never hangs on a dead socket (its deadline,
 * reset()), a send is never cut short by a reset and never retried once it may have left.
 */
import { describe, expect, it } from "vitest";
import { createGmailApiProvider } from "./gmail-api";
import { ProviderAuthError, ProviderError, type MailProvider, type ProviderContext } from "./types";

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

function provider(fetch: typeof globalThis.fetch, o: { readTimeoutMs?: number; sendTimeoutMs?: number; tokens?: () => Promise<string> } = {}): MailProvider {
  const ctx = { account: { id: 1, email: "me@gmail.com" }, store: {}, config: {}, fetch } as unknown as ProviderContext;
  return createGmailApiProvider(ctx, {
    tokens: { get: o.tokens ?? (async () => "token"), invalidate() {} },
    buildRaw: async () => new TextEncoder().encode("raw"),
    readTimeoutMs: o.readTimeoutMs,
    sendTimeoutMs: o.sendTimeoutMs,
  });
}

const sendOp = { id: "op-1", kind: "send", target: {}, payload: { providerThreadId: null } };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("Gmail requests and the network (plan 20)", () => {
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

  it("a read leaves no timer behind once it's answered", async () => {
    const { fetch, calls } = manualFetch();
    const p = provider(fetch, { readTimeoutMs: 50 });
    const read = p.verify();
    await settle();
    calls[0]!.respond(json({ emailAddress: "me@gmail.com" }));
    await read;
    // past the deadline: the answered request's timer would have aborted something (no unhandled rejection, no abort)
    await new Promise((r) => setTimeout(r, 80));
    expect(calls[0]!.signal!.aborted).toBe(false);
  });
});
