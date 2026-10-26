import { afterEach, describe, expect, it, vi } from "vitest";
import { createGmailProvider } from "./gmail";
import { RequestNotDispatchedError } from "./net-errors";
import { ProviderAuthError, ProviderError, type ProviderContext } from "./types";

const valid = { access_token: "access-1", refresh_token: "refresh-2", token_type: "Bearer", expires_in: 3600 };
const json = (body: unknown, status = 200) => Response.json(body, { status });
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
function harness(response: () => Response | Promise<Response> = () => json(valid)) {
  let durable: string | null = "refresh-1";
  const exchanges: string[] = [];
  const api: string[] = [];
  const events: unknown[] = [];
  const replace = vi.fn(async (_name: string, expected: string, next: string) => {
    if (durable !== expected) return false;
    durable = next;
    return true;
  });
  const ctx = {
    account: { id: 1, email: "synthetic@example.test" }, config: {},
    store: { setting: async () => ({ gmailClientId: "client" }) },
    getSecret: vi.fn(async () => durable), getAppSecret: async () => null,
    replaceSecret: replace,
    event: (...args: unknown[]) => { events.push(args); },
    fetch: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes("/token")) {
        exchanges.push(new URLSearchParams(String(init?.body)).get("refresh_token")!);
        return response();
      }
      api.push(new Headers(init?.headers).get("authorization")!);
      return json({ historyId: "10", emailAddress: "synthetic@example.test" });
    }),
  } as unknown as ProviderContext;
  return { provider: createGmailProvider(ctx), ctx, exchanges, api, events, replace, get durable() { return durable; }, set durable(value) { durable = value; } };
}
afterEach(() => { vi.useRealTimers(); });

describe("durable Gmail refresh", () => {
  it("20 expired readers share one exchange and one commit, exposing no access before commit", async () => {
    const h = harness();
    const commit = gate();
    h.replace.mockImplementation(async (_name, expected, next) => {
      await commit.promise;
      if (h.durable !== expected) return false;
      h.durable = next;
      return true;
    });
    const reads = Array.from({ length: 20 }, () => h.provider.verify());
    await flush();
    expect(h.exchanges).toEqual(["refresh-1"]);
    expect(h.replace).toHaveBeenCalledExactlyOnceWith("refreshToken", "refresh-1", "refresh-2");
    expect(h.api).toEqual([]);
    commit.resolve();
    await Promise.all(reads);
    expect(h.durable).toBe("refresh-2");
    expect(h.api).toHaveLength(20);
    await h.provider.verify();
    expect(h.replace).toHaveBeenCalledTimes(1);
    expect(h.exchanges).toHaveLength(1);
    await h.provider.close();
  });

  it.each([undefined, "refresh-1"])("omitted/identical rotation %s asserts ownership without another exchange", async (refresh) => {
    const result = { ...valid } as Record<string, unknown>;
    if (refresh === undefined) delete result.refresh_token;
    else result.refresh_token = refresh;
    const h = harness(() => json(result));
    await h.provider.verify();
    await h.provider.verify();
    expect(h.replace).toHaveBeenCalledExactlyOnceWith("refreshToken", "refresh-1", "refresh-1");
    expect(h.exchanges).toEqual(["refresh-1"]);
    expect(h.durable).toBe("refresh-1");
  });

  it.each([false, true])("retries only candidate persistence after a %s after-commit failure", async (afterCommit) => {
    const h = harness();
    const real = h.replace.getMockImplementation()!;
    h.replace.mockImplementationOnce(async (...args) => {
      if (afterCommit) await real(...args);
      throw new Error("SECRET_TOKEN synthetic@example.test PRIVATE_SUBJECT");
    });
    const failures = await Promise.all(Array.from({ length: 20 }, () => h.provider.verify().catch((error: unknown) => error)));
    expect(h.api).toEqual([]);
    expect(h.exchanges).toEqual(["refresh-1"]);
    for (const error of failures) {
      expect(error).toMatchObject({ retryable: true, network: false });
      expect(String(error)).not.toMatch(/SECRET_TOKEN|synthetic@example.test|PRIVATE_SUBJECT/);
    }
    await h.provider.verify();
    expect(h.exchanges).toEqual(["refresh-1"]);
    expect(h.durable).toBe("refresh-2");
    expect(h.api).toEqual(["Bearer access-1"]);
    expect(h.replace.mock.calls.slice(1)).toContainEqual(["refreshToken", "refresh-2", "refresh-2"]);
    expect(h.events).toEqual([]);
  });

  it.each([null, "newer-credential"])("CAS conflict with %s refuses stale exposure", async (replacement) => {
    const h = harness();
    h.replace.mockImplementation(async () => { h.durable = replacement; return false; });
    await expect(h.provider.verify()).rejects.toBeInstanceOf(ProviderError);
    expect(h.api).toEqual([]);
    expect(h.durable).toBe(replacement);
    expect(h.replace).toHaveBeenCalledTimes(1);
  });

  it("a candidate superseded after persistence failure cannot overwrite newer credentials", async () => {
    const h = harness();
    h.replace.mockRejectedValueOnce(new Error("disk"));
    await expect(h.provider.verify()).rejects.toBeInstanceOf(ProviderError);
    h.durable = "newer-credential";
    await expect(h.provider.verify()).rejects.toBeInstanceOf(ProviderError);
    expect(h.durable).toBe("newer-credential");
    expect(h.api).toEqual([]);
    expect(h.exchanges).toEqual(["refresh-1"]);
  });

  it("late close during commit drops the candidate and cannot expose access", async () => {
    const h = harness();
    const commit = gate();
    h.replace.mockImplementation(async () => { await commit.promise; return true; });
    const read = h.provider.verify();
    await flush();
    await h.provider.close();
    commit.resolve();
    await expect(read).rejects.toMatchObject({ name: "AbortError" });
    await expect(h.provider.verify()).rejects.toMatchObject({ name: "AbortError" });
    expect(h.api).toEqual([]);
  });

  it("expiry during commit retires the candidate; next demand exchanges the new durable credential", async () => {
    vi.useFakeTimers();
    const h = harness(() => json({ ...valid, expires_in: 1 }));
    const real = h.replace.getMockImplementation()!;
    h.replace.mockImplementationOnce(async (...args) => { await vi.advanceTimersByTimeAsync(1100); return real(...args); });
    await expect(h.provider.verify()).rejects.toBeInstanceOf(ProviderError);
    expect(h.durable).toBe("refresh-2");
    expect(h.api).toEqual([]);
    await h.provider.verify();
    expect(h.exchanges).toEqual(["refresh-1", "refresh-2"]);
  });

  it("short lifetimes are cached proportionally and refresh uses the rotated credential", async () => {
    vi.useFakeTimers();
    const h = harness(() => json({ ...valid, expires_in: 10 }));
    await h.provider.verify();
    await vi.advanceTimersByTimeAsync(1000);
    await h.provider.verify();
    expect(h.exchanges).toEqual(["refresh-1"]);
    await vi.advanceTimersByTimeAsync(9000);
    await h.provider.verify();
    expect(h.exchanges).toEqual(["refresh-1", "refresh-2"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["missing access", { ...valid, access_token: undefined }], ["numeric access", { ...valid, access_token: 7 }],
    ["empty access", { ...valid, access_token: "" }], ["blank access", { ...valid, access_token: " " }],
    ["control access", { ...valid, access_token: "secret\nvalue" }], ["oversized access", { ...valid, access_token: "x".repeat(4097) }],
    ["unicode access", { ...valid, access_token: "sécret" }], ["null refresh", { ...valid, refresh_token: null }],
    ["empty refresh", { ...valid, refresh_token: "" }], ["numeric refresh", { ...valid, refresh_token: 3 }],
    ["oversized refresh", { ...valid, refresh_token: "x".repeat(4097) }], ["control refresh", { ...valid, refresh_token: "refresh\r" }],
    ["missing type", { ...valid, token_type: undefined }], ["wrong type", { ...valid, token_type: "Basic" }],
    ["missing expiry", { ...valid, expires_in: undefined }], ["string expiry", { ...valid, expires_in: "3600" }],
    ["zero expiry", { ...valid, expires_in: 0 }], ["negative expiry", { ...valid, expires_in: -1 }],
    ["overflow expiry", { ...valid, expires_in: Number.MAX_VALUE }], ["unsafe expiry", { ...valid, expires_in: Number.MAX_SAFE_INTEGER }],
    ["numeric scope", { ...valid, scope: 4 }], ["no mail scope", { ...valid, scope: "openid email" }],
    ["empty scope", { ...valid, scope: "" }], ["null body", null], ["array body", []],
  ])("rejects %s before persistence or API use", async (_name, result) => {
    const h = harness(() => json(result));
    await expect(h.provider.verify()).rejects.toBeInstanceOf(ProviderError);
    expect(h.api).toEqual([]);
    expect(h.replace).not.toHaveBeenCalled();
  });

  it.each(["https://www.googleapis.com/auth/gmail.modify", "openid https://mail.google.com/ email"])("accepts explicit mail grant %s and mixed-case Bearer", async (scope) => {
    const h = harness(() => json({ ...valid, token_type: "bEaReR", scope }));
    await h.provider.verify();
    expect(h.replace).toHaveBeenCalledTimes(1);
  });

  it.each([400, 401, 403, 404, 429, 503])("only actual 400 invalid_grant means auth refusal (%i)", async (status) => {
    const h = harness(() => json({ error: "invalid_grant", error_description: "SECRET_TOKEN synthetic@example.test PRIVATE_SUBJECT" }, status));
    const error = await h.provider.verify().catch((e: unknown) => e);
    if (status === 400) expect(error).toBeInstanceOf(ProviderAuthError);
    else {
      expect(error).not.toBeInstanceOf(ProviderAuthError);
      expect(error).toMatchObject({ status, retryable: status === 429 || status >= 500, network: false });
    }
    expect(String(error)).not.toMatch(/SECRET_TOKEN|synthetic@example.test|PRIVATE_SUBJECT/);
    expect(h.events).toEqual([]);
  });

  it("preserves an undispatched host refusal by identity", async () => {
    const refusal = new RequestNotDispatchedError("fixed host refusal");
    const h = harness(() => { throw refusal; });
    await expect(h.provider.verify()).rejects.toBe(refusal);
  });

  it.each([200, 400, 429, 503])("bounds complete padded JSON, preserving HTTP recovery for %i", async (status) => {
    const text = status === 200 ? JSON.stringify(valid) : '{"error":"invalid_grant"}';
    const h = harness(() => new Response(text + " ".repeat(65_536), { status }));
    const error = await h.provider.verify().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).not.toBeInstanceOf(ProviderAuthError);
    if (status !== 200) expect(error).toMatchObject({ status, retryable: status === 429 || status >= 500 });
    expect(h.replace).not.toHaveBeenCalled();
    expect(h.api).toEqual([]);
  });

  it("accepts a complete JSON body exactly at the byte cap, including 4096-byte tokens", async () => {
    const text = JSON.stringify({ ...valid, access_token: "a".repeat(4096), refresh_token: "r".repeat(4096) });
    const h = harness(() => new Response(text + " ".repeat(65_536 - text.length)));
    await h.provider.verify();
    expect(h.replace).toHaveBeenCalledTimes(1);
  });

  it.each([200, 429, 503])("malformed complete JSON has fixed errors and preserves status %i", async (status) => {
    const h = harness(() => new Response('{"error":"SECRET_TOKEN synthetic@example.test PRIVATE_SUBJECT"', { status }));
    const error = await h.provider.verify().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).not.toBeInstanceOf(ProviderAuthError);
    expect(String(error)).not.toMatch(/SECRET_TOKEN|synthetic@example.test|PRIVATE_SUBJECT/);
    if (status !== 200) expect(error).toMatchObject({ status, retryable: true });
  });

  it("one cumulative deadline races ignored abort across headers and body, cancels/releases the reader", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(async () => {}), releaseLock = vi.fn();
    const read = vi.fn(() => new Promise<{ done: false; value: Uint8Array }>(() => {}));
    const response = { status: 200, ok: true, body: { getReader: () => ({ read, cancel, releaseLock }) } } as unknown as Response;
    const h = harness(() => new Promise((resolve) => { setTimeout(() => resolve(response), 20_000); }));
    const outcome = h.provider.verify().catch((e: unknown) => e);
    await flush();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    await flush();
    expect(await Promise.race([outcome, Promise.resolve("still pending")])).toMatchObject({ retryable: true, network: true });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
    expect(h.api).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("deadline settles ignored-abort fetch and cancels a late response body", async () => {
    vi.useFakeTimers();
    let answer!: (response: Response) => void;
    const h = harness(() => new Promise((resolve) => { answer = resolve; }));
    const outcome = h.provider.verify().catch((e: unknown) => e);
    await flush();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await Promise.race([outcome, Promise.resolve("still pending")])).toMatchObject({ retryable: true, network: true });
    const cancel = vi.fn();
    answer(new Response(new ReadableStream({ cancel })));
    await flush();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(h.replace).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("close races an ignored-abort refresh fetch without waiting for its 30-second budget", async () => {
    vi.useFakeTimers();
    const h = harness(() => new Promise(() => {}));
    const outcome = h.provider.verify().catch((e: unknown) => e);
    await flush();
    await h.provider.close();
    await flush();
    expect(await Promise.race([outcome, Promise.resolve("still pending")])).toMatchObject({ name: "AbortError" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reset preserves a refresh already rotating credentials and its persistence", async () => {
    const h = harness();
    const commit = gate();
    const real = h.replace.getMockImplementation()!;
    h.replace.mockImplementation(async (...args) => { await commit.promise; return real(...args); });
    const outcome = h.provider.verify();
    await flush();
    h.provider.reset!();
    commit.resolve();
    await outcome;
    expect(h.exchanges).toEqual(["refresh-1"]);
    expect(h.durable).toBe("refresh-2");
  });

  it.each([true, false])("transport failures are private, with network=%s classification", async (network) => {
    const failure = network ? new TypeError("SECRET_TOKEN synthetic@example.test PRIVATE_SUBJECT") : new Error("SECRET_TOKEN synthetic@example.test PRIVATE_SUBJECT");
    const h = harness(() => { throw failure; });
    const error = await h.provider.verify().catch((e: unknown) => e);
    expect(error).toMatchObject({ retryable: true, network });
    expect(String(error)).not.toMatch(/SECRET_TOKEN|synthetic@example.test|PRIVATE_SUBJECT/);
    expect(h.events).toEqual([]);
  });


  it("secret lookup failures cannot expose arbitrary exception details", async () => {
    const h = harness();
    vi.mocked(h.ctx.getSecret).mockRejectedValueOnce(new Error("SECRET_TOKEN synthetic@example.test PRIVATE_SUBJECT"));
    const error = await h.provider.verify().catch((e: unknown) => e);
    expect(error).toMatchObject({ retryable: true, network: false });
    expect(String(error)).not.toMatch(/SECRET_TOKEN|synthetic@example.test|PRIVATE_SUBJECT/);
    expect(h.exchanges).toEqual([]);
  });

  it("a failed persistence candidate expires without re-exchanging the spent original token", async () => {
    vi.useFakeTimers();
    const h = harness(() => json({ ...valid, expires_in: 1 }));
    h.replace.mockRejectedValueOnce(new Error("disk"));
    await expect(h.provider.verify()).rejects.toBeInstanceOf(ProviderError);
    await vi.advanceTimersByTimeAsync(1100);
    await expect(h.provider.verify()).rejects.toBeInstanceOf(ProviderError);
    expect(h.durable).toBe("refresh-2");
    expect(h.exchanges).toEqual(["refresh-1"]);
    expect(h.api).toEqual([]);
    await h.provider.verify();
    expect(h.exchanges).toEqual(["refresh-1", "refresh-2"]);
    expect(h.replace).toHaveBeenCalledTimes(4);
  });

  it("slow complete body receipt consumes access lifetime before persistence", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ ...valid, expires_in: 1 })));
      finish = () => controller.close();
    } });
    const h = harness(() => new Response(body));
    const outcome = h.provider.verify().catch((e: unknown) => e);
    await flush();
    await vi.advanceTimersByTimeAsync(1100);
    finish();
    expect(await outcome).toMatchObject({ retryable: true, network: false });
    expect(h.durable).toBe("refresh-2");
    expect(h.api).toEqual([]);
  });

  it("an invalid UTF-8 complete token response cannot be decoded by replacement", async () => {
    const text = new TextEncoder().encode(JSON.stringify(valid));
    const bytes = new Uint8Array(text.length + 2);
    bytes.set(text); bytes.set([0xc0, 0x80], text.length);
    const h = harness(() => new Response(bytes));
    await expect(h.provider.verify()).rejects.toBeInstanceOf(ProviderError);
    expect(h.replace).not.toHaveBeenCalled();
  });

  it("a body overflow cancels and releases the stream without waiting for cleanup", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(65_537));
    }, cancel }));
    const h = harness(() => response);
    await expect(h.provider.verify()).rejects.toBeInstanceOf(ProviderError);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(response.body!.locked).toBe(false);
    expect(h.replace).not.toHaveBeenCalled();
  });

});
