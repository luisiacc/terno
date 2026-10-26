import { createHash } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectGmail, type ConnectOptions } from "./gmail";
import { createGmailTokenBroker, inspectGmailToken } from "./gmail-web";

const mailScope = "https://www.googleapis.com/auth/gmail.modify";
const endpoints = { auth: "https://google.test/auth", token: "https://google.test/token", api: "https://google.test/gmail", userinfo: "https://google.test/userinfo" };
const token = { access_token: "test-access", refresh_token: "test-refresh", token_type: "Bearer", expires_in: 3600 };
const profile = { emailAddress: "reader@example.com" };
const info = { sub: "google-subject", name: "Reader", email: "reader@example.com", email_verified: true };
const json = (value: unknown, status = 200) => Response.json(value, { status });
afterEach(() => vi.restoreAllMocks());

function desktop(o: { token?: () => Response | Promise<Response>; profile?: () => Response | Promise<Response>; info?: () => Response | Promise<Response>; options?: Partial<ConnectOptions> } = {}) {
  let auth: URL;
  const netFetch = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url === endpoints.token) {
      const params = init!.body as URLSearchParams;
      expect(params.get("redirect_uri")).toBe(auth.searchParams.get("redirect_uri"));
      expect(createHash("sha256").update(params.get("code_verifier")!).digest("base64url")).toBe(auth.searchParams.get("code_challenge"));
      expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
      return o.token ? o.token() : json(token);
    }
    if (url === `${endpoints.api}/profile`) return o.profile ? o.profile() : json(profile);
    if (url === endpoints.userinfo) return o.info ? o.info() : json(info);
    throw new Error("Unexpected synthetic URL");
  });
  const result = connectGmail({
    clientId: "synthetic-client", clientSecret: null, endpoints, fetch: netFetch, timeoutMs: 2000,
    ...o.options,
    openExternal: async (url) => {
      auth = new URL(url);
      if (o.options?.openExternal) return o.options.openExternal(url);
      const callback = new URL(auth.searchParams.get("redirect_uri")!);
      expect(callback.hostname).toBe("127.0.0.1");
      callback.searchParams.set("state", auth.searchParams.get("state")!);
      callback.searchParams.set("code", "synthetic-code");
      await fetch(callback).then((res) => res.text());
    },
  });
  return { result, netFetch };
}

describe("initial Google sign-in", () => {
  it("refuses explicit reduced mail consent with an actionable error", async () => {
    const { result, netFetch } = desktop({ token: () => json({ ...token, scope: "openid email profile" }) });
    await expect(result).rejects.toThrow("Allow Gmail access");
    expect(netFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["null", null], ["array", []], ["numeric access", { ...token, access_token: 123 }],
    ["blank refresh", { ...token, refresh_token: " " }], ["wrong token type", { ...token, token_type: "MAC" }], ["missing token type", { ...token, token_type: undefined }],
    ["invalid lifetime", { ...token, expires_in: -1 }], ["invalid scope type", { ...token, scope: [] }],
  ])("rejects malformed token responses: %s", async (_name, value) => {
    const { result } = desktop({ token: () => json(value) });
    await expect(result).rejects.toThrow("Google returned an invalid sign-in response");
  });

  it("the desktop deadline includes the complete token body after the callback", async () => {
    let finish!: () => void;
    const cancelled = vi.fn();
    const response = new Response(new ReadableStream({ start(controller) { finish = () => controller.close(); }, cancel: cancelled }));
    const { result } = desktop({ token: () => response, options: { timeoutMs: 100 } });
    const outcome = result.then(() => "connected", (error: Error) => error.message);
    try {
      await expect(Promise.race([outcome, new Promise((r) => setTimeout(() => r("still waiting"), 500))])).resolves.toBe("Google sign-in timed out.");
      expect(cancelled).toHaveBeenCalledOnce();
    } finally { if (!cancelled.mock.calls.length) finish(); await outcome; }
  });

  it.each([
    ["missing mailbox", {}], ["numeric mailbox", { emailAddress: 12 }],
    ["invalid mailbox", { emailAddress: "not an address" }], ["blank mailbox", { emailAddress: " " }], ["address delimiter", { emailAddress: "reader,other@example.com" }], ["control in mailbox", { emailAddress: "read\u0000er@example.com" }],
  ])("rejects invalid Gmail profile identity: %s", async (_name, value) => {
    await expect(desktop({ profile: () => json(value), info: () => json({ sub: "google-subject" }) }).result).rejects.toThrow("Google returned an invalid sign-in response");
  });

  it.each([
    ["missing subject", {}], ["numeric subject", { ...info, sub: 123 }], ["control in subject", { ...info, sub: "id\u0000" }],
    ["invalid name", { ...info, name: {} }], ["invalid verified flag", { ...info, email_verified: "true" }],
    ["another mailbox", { ...info, email: "other@example.com" }],
  ])("rejects invalid OpenID identity: %s", async (_name, value) => {
    await expect(desktop({ info: () => json(value) }).result).rejects.toThrow("Google returned an invalid sign-in response");
  });

  it("rejects a callback with no authorization code before token exchange", async () => {
    const { result, netFetch } = desktop({ options: { openExternal: async (url) => {
      const auth = new URL(url);
      const callback = new URL(auth.searchParams.get("redirect_uri")!);
      callback.searchParams.set("state", auth.searchParams.get("state")!);
      await fetch(callback).then((res) => res.text());
    } } });
    await expect(result).rejects.toThrow("Google returned an invalid sign-in response");
    expect(netFetch).not.toHaveBeenCalled();
  });

  it("omitted scope retains the scopes originally requested (RFC 6749)", async () => {
    const { result } = desktop();
    await expect(result).resolves.toMatchObject({ email: "reader@example.com", grantedScopes: expect.arrayContaining([mailScope, "openid"]) });
  });
});

describe("browser Google token inspection", () => {
  it("rejects an invalid access token before contacting Google", async () => {
    const netFetch = vi.fn<typeof fetch>(async (url) => json(String(url).endsWith("/profile") ? profile : info));
    await expect(inspectGmailToken(" ", netFetch, { endpoints })).rejects.toThrow("Google returned an invalid sign-in response");
    expect(netFetch).not.toHaveBeenCalled();
  });
});

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("Google initial-flow resource bounds", () => {
  it.each(["token", "profile", "info"] as const)("desktop bounds stalled %s headers and cancels late response bodies", async (stage) => {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    const cancelled = vi.fn();
    const { result, netFetch } = desktop({ [stage]: () => pending, options: { timeoutMs: 100 } });
    await expect(result).rejects.toThrow("Google sign-in timed out.");
    expect(netFetch.mock.calls.at(-1)![1]!.signal!.aborted).toBe(true);
    release(new Response(new ReadableStream({ cancel: cancelled })));
    await expect.poll(() => cancelled.mock.calls.length).toBe(1);
  });

  it.each(["profile", "info"] as const)("desktop bounds stalled %s bodies and releases the reader", async (stage) => {
    const cancelled = vi.fn();
    const response = new Response(new ReadableStream({ cancel: cancelled }));
    await expect(desktop({ [stage]: () => response, options: { timeoutMs: 100 } }).result).rejects.toThrow("Google sign-in timed out.");
    expect(cancelled).toHaveBeenCalledOnce();
    expect(response.body!.locked).toBe(false);
  });

  it.each(["token", "profile", "info"] as const)("desktop abort cancels a stalled %s body", async (stage) => {
    const cancel = new AbortController();
    const cancelled = vi.fn();
    const response = new Response(new ReadableStream({ cancel: cancelled }));
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const { result } = desktop({ [stage]: () => { started(); return response; }, options: { signal: cancel.signal } });
    const outcome = expect(result).rejects.toThrow("Sign-in cancelled.");
    await entered;
    await delay(0);
    cancel.abort();
    await outcome;
    expect(cancelled).toHaveBeenCalledOnce();
    expect(response.body!.locked).toBe(false);
  });

  it.each(["token", "profile", "info"] as const)("rejects streamed %s bodies above 64 KiB without trusting Content-Length", async (stage) => {
    const cancelled = vi.fn();
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(' '.repeat(65_537))); }, cancel: cancelled }), { headers: { "content-length": "2" } });
    await expect(desktop({ [stage]: () => response }).result).rejects.toThrow("Google returned an invalid sign-in response");
    expect(cancelled).toHaveBeenCalledOnce();
    expect(response.body!.locked).toBe(false);
  });

  it("uses a cumulative deadline rather than restarting it for each stage", async () => {
    const { result } = desktop({ token: async () => { await delay(65); return json(token); }, profile: async () => { await delay(65); return json(profile); }, options: { timeoutMs: 100 } });
    await expect(result).rejects.toThrow("Google sign-in timed out.");
  });

  it.each([401, 403, 429, 503])("checks HTTP %s before parsing a malformed error body", async (status) => {
    await expect(desktop({ profile: () => new Response("private-provider-error", { status }) }).result).rejects.toMatchObject({ message: `Google sign-in failed: ${status}`, retryable: status >= 429 });
  });

  it("rejects a non-OK profile even if its body contains a valid mailbox", async () => {
    await expect(desktop({ profile: () => json(profile, 503) }).result).rejects.toMatchObject({ retryable: true });
  });

  it("rejects failed userinfo instead of saving an account with missing identity evidence", async () => {
    await expect(desktop({ info: () => json(info, 503) }).result).rejects.toMatchObject({ retryable: true });
  });

  it("does not open a browser or request tokens for a pre-aborted flow", async () => {
    const cancel = new AbortController();
    cancel.abort();
    const openExternal = vi.fn();
    const { result, netFetch } = desktop({ options: { signal: cancel.signal, openExternal } });
    await expect(result).rejects.toThrow("Sign-in cancelled.");
    expect(openExternal).not.toHaveBeenCalled();
    expect(netFetch).not.toHaveBeenCalled();
  });

  it("browser inspection bounds stalled headers even if fetch ignores abort", async () => {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    const netFetch = vi.fn<typeof fetch>(async () => pending);
    const cancelled = vi.fn();
    await expect(inspectGmailToken("synthetic-token", netFetch, { endpoints, timeoutMs: 40 })).rejects.toThrow("Google sign-in timed out.");
    release(new Response(new ReadableStream({ cancel: cancelled })));
    await expect.poll(() => cancelled.mock.calls.length).toBe(1);
  });

  it.each(["profile", "userinfo"])("browser inspection bounds stalled %s bodies", async (stage) => {
    const cancelled = vi.fn();
    const response = new Response(new ReadableStream({ cancel: cancelled }));
    const netFetch = vi.fn<typeof fetch>(async (url) => String(url).endsWith(`/${stage}`) ? response : json(profile));
    await expect(inspectGmailToken("synthetic-token", netFetch, { endpoints, timeoutMs: 40 })).rejects.toThrow("Google sign-in timed out.");
    expect(cancelled).toHaveBeenCalledOnce();
    expect(response.body!.locked).toBe(false);
  });

  it("browser inspection accepts caller cancellation and stops before userinfo", async () => {
    const cancel = new AbortController();
    const response = new Response(new ReadableStream());
    const netFetch = vi.fn<typeof fetch>(async () => response);
    const result = inspectGmailToken("synthetic-token", netFetch, { endpoints, signal: cancel.signal });
    const outcome = expect(result).rejects.toThrow("Sign-in cancelled.");
    await delay(0);
    cancel.abort();
    await outcome;
    expect(netFetch).toHaveBeenCalledOnce();
  });

  it("the browser broker validates the stable identity and permits missing optional claims", async () => {
    const broker = createGmailTokenBroker({ endpoints });
    const netFetch = vi.fn<typeof fetch>(async (url) => json(String(url).endsWith("/profile") ? profile : { sub: "google-subject" }));
    await expect(broker.inspect("synthetic-token", netFetch)).resolves.toEqual({ email: "reader@example.com", name: "", sub: "google-subject", emailVerified: false });
    netFetch.mockImplementation(async (url) => json(String(url).endsWith("/profile") ? profile : { sub: [] }));
    await expect(broker.inspect("synthetic-token", netFetch)).rejects.toThrow("Google returned an invalid sign-in response");
  });
});

describe("Google callback ownership and protocol", () => {
  it("ignores forged state, accepts the matching callback once and closes its listener", async () => {
    let callback!: URL;
    const { result, netFetch } = desktop({ options: { openExternal: async (url) => {
      const auth = new URL(url);
      callback = new URL(auth.searchParams.get("redirect_uri")!);
      callback.searchParams.set("code", "synthetic-code");
      callback.searchParams.set("state", "forged-state");
      expect((await fetch(callback)).status).toBe(400);
      callback.searchParams.set("state", auth.searchParams.get("state")!);
      await fetch(callback).then((r) => r.text());
    } } });
    await expect(result).resolves.toMatchObject({ email: "reader@example.com" });
    expect(netFetch.mock.calls.filter(([url]) => String(url) === endpoints.token)).toHaveLength(1);
    await expect(fetch(callback)).rejects.toThrow();
  });

  it.each(["access_denied", "private-provider-error"])("consent refusal %s never exchanges tokens or echoes unknown provider errors", async (error) => {
    let callback!: URL;
    const { result, netFetch } = desktop({ options: { openExternal: async (url) => {
      const auth = new URL(url);
      callback = new URL(auth.searchParams.get("redirect_uri")!);
      callback.searchParams.set("state", auth.searchParams.get("state")!);
      callback.searchParams.set("error", error);
      await fetch(callback).then((r) => r.text());
    } } });
    await expect(result).rejects.toThrow(error === "access_denied" ? "Google access was denied." : "Google returned an invalid sign-in response");
    expect(netFetch).not.toHaveBeenCalled();
    await expect(fetch(callback)).rejects.toThrow();
  });

  it("an abandoned browser expires and its listener stops accepting callbacks", async () => {
    let callback!: URL;
    const { result } = desktop({ options: { timeoutMs: 100, openExternal: async (url) => { callback = new URL(new URL(url).searchParams.get("redirect_uri")!); } } });
    await expect(result).rejects.toThrow("Google sign-in timed out.");
    await expect(fetch(callback)).rejects.toThrow();
  });

  it("browser launch rejection closes the listener and hides external error details", async () => {
    let callback!: URL;
    const { result } = desktop({ options: { openExternal: async (url) => {
      callback = new URL(new URL(url).searchParams.get("redirect_uri")!);
      throw new Error("private external details");
    } } });
    await expect(result).rejects.toThrow("Could not finish Google sign-in");
    await expect(fetch(callback)).rejects.toThrow();
  });

  it("accepts case-insensitive Bearer and preserves the exact requested custom scopes when omitted", async () => {
    const scopes = ["openid", mailScope, "https://www.googleapis.com/auth/photoslibrary.readonly"];
    const expected = [...scopes];
    const { result } = desktop({ options: { scopes }, token: () => { scopes.length = 0; return json({ ...token, token_type: "bearer" }); } });
    await expect(result).resolves.toMatchObject({ grantedScopes: expected });
  });

  it("accepts a broader explicit mail grant and unverified optional email evidence", async () => {
    await expect(desktop({ token: () => json({ ...token, scope: "https://mail.google.com/" }), info: () => json({ sub: "google-subject", email_verified: false }) }).result).resolves.toMatchObject({ emailVerified: false, grantedScopes: ["https://mail.google.com/"] });
  });

  it.each(["token", "profile", "info"] as const)("malformed successful %s JSON gets a fixed error without raw payload", async (stage) => {
    await expect(desktop({ [stage]: () => new Response("private-provider-error") }).result).rejects.toThrow("Google returned an invalid sign-in response");
  });
});

it("cancellation closes active partial callback sockets", async () => {
  const cancel = new AbortController();
  let socket: Socket | undefined;
  let opened!: () => void;
  const connected = new Promise<void>((resolve) => { opened = resolve; });
  let closed!: () => void;
  const closure = new Promise<void>((resolve) => { closed = resolve; });
  const { result } = desktop({ options: { signal: cancel.signal, openExternal: async (url) => {
    const callback = new URL(new URL(url).searchParams.get("redirect_uri")!);
    socket = createConnection({ host: "127.0.0.1", port: Number(callback.port) });
    socket.on("error", () => {});
    socket.once("close", closed);
    socket.once("connect", () => { socket!.write("GET /callback HTTP/1.1\r\nHost: localhost\r\n"); opened(); });
  } } });
  const outcome = expect(result).rejects.toThrow("Sign-in cancelled.");
  try {
    await connected;
    cancel.abort();
    await outcome;
    await closure;
    expect(socket!.destroyed).toBe(true);
  } finally { socket?.destroy(); }
});
