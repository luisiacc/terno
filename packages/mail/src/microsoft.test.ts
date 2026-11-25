import { afterEach, describe, expect, it } from "vitest";
import { connectMicrosoft, createMicrosoftSession, idTokenSubject, microsoftRefusal } from "./microsoft";
import { microsoftMailGranted, MICROSOFT_SCOPES } from "./microsoft-scopes";
import { SyntheticMicrosoft } from "./test/microsoft.fixture";
import { ProviderAuthError, ProviderError, type ProviderContext } from "./types";

// Plan 259 stage 1: signing in with Microsoft against a synthetic identity platform and Graph /me.
const servers: SyntheticMicrosoft[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await s.stop(); });

async function microsoft() {
  const ms = await new SyntheticMicrosoft().start();
  servers.push(ms);
  return ms;
}

const connect = (ms: SyntheticMicrosoft, behaviour?: Parameters<SyntheticMicrosoft["browser"]>[0], extra: { loginHint?: string } = {}) =>
  connectMicrosoft({ clientId: ms.clientId, openExternal: ms.browser(behaviour), fetch, endpoints: ms.endpoints(), timeoutMs: 10_000, ...extra });

const key = (error: unknown) => (error as ProviderError).i18n?.key;

describe("connectMicrosoft (plan 259)", () => {
  it("asks Microsoft for exactly Outlook's scopes on the localhost loopback, as a public client, and reads who signed in", async () => {
    const ms = await microsoft();
    const result = await connect(ms);
    const asked = ms.authorizations[0]!;
    expect(Object.fromEntries([...asked].filter(([k]) => !["state", "code_challenge", "redirect_uri"].includes(k)))).toEqual({
      client_id: ms.clientId, response_type: "code", response_mode: "query", scope: "openid email profile offline_access User.Read Mail.ReadWrite Mail.Send",
      code_challenge_method: "S256", prompt: "select_account",
    });
    expect(new URL(asked.get("redirect_uri")!)).toMatchObject({ protocol: "http:", hostname: "localhost", pathname: "/callback" });
    const exchange = ms.tokenRequests[0]!;
    expect(exchange.has("client_secret")).toBe(false);
    expect(exchange.get("redirect_uri")).toBe(asked.get("redirect_uri"));
    expect(exchange.get("scope")).toBe(MICROSOFT_SCOPES.join(" "));
    expect(result).toEqual({
      email: "ana@contoso.com", name: "Ana Ruiz", refreshToken: expect.stringMatching(/^refresh-/), tenant: "organizations",
      subject: `${ms.tid}:${ms.oid}`, grantedScopes: expect.arrayContaining(["https://graph.microsoft.com/Mail.ReadWrite", "https://graph.microsoft.com/Mail.Send"]),
    });
  });

  it("a personal account is the consumer tenant, and its address is the user principal name when Graph has no mail", async () => {
    const ms = (await microsoft()).personal("ana@outlook.com");
    ms.displayName = null;
    expect(await connect(ms)).toMatchObject({ email: "ana@outlook.com", name: "", tenant: "consumers", subject: `9188040d-6c67-4c5b-b112-36a304b66dad:${ms.oid}` });
  });

  it("signing an account in again pre-fills it on Microsoft's page", async () => {
    const ms = await microsoft();
    await connect(ms, "approve", { loginHint: "ana@contoso.com" });
    expect(ms.authorizations[0]!.get("login_hint")).toBe("ana@contoso.com");
  });

  it("an omitted scope is the request's; a grant without mail is refused in Microsoft's words", async () => {
    const ms = await microsoft();
    ms.grantedScope = undefined;
    expect((await connect(ms)).grantedScopes).toEqual(MICROSOFT_SCOPES);
    ms.grantedScope = "openid profile https://graph.microsoft.com/Mail.ReadWrite";
    expect(key(await connect(ms).catch((e: unknown) => e))).toBe("errors.microsoft.mailScopeRequired");
  });

  it("an id_token for another client, or none, is an invalid response", async () => {
    const ms = await microsoft();
    ms.audience = "someone-else";
    expect(key(await connect(ms).catch((e: unknown) => e))).toBe("errors.microsoft.invalidResponse");
    expect(idTokenSubject(undefined, ms.clientId)).toBeNull();
    expect(idTokenSubject("not.a.jwt", ms.clientId)).toBeNull();
  });

  it("maps Microsoft's refusals: denied, an administrator's approval needed, anything else invalid", async () => {
    const ms = await microsoft();
    expect(key(await connect(ms, "deny").catch((e: unknown) => e))).toBe("errors.microsoft.denied");
    expect(key(await connect(ms, { error: "consent_required" }).catch((e: unknown) => e))).toBe("errors.microsoft.adminConsent");
    expect(key(await connect(ms, { error: "interaction_required", description: "AADSTS65001: The user or administrator has not consented to use the application" }).catch((e: unknown) => e))).toBe("errors.microsoft.adminConsent");
    expect(key(await connect(ms, { error: "server_error" }).catch((e: unknown) => e))).toBe("errors.microsoft.invalidResponse");
    expect(microsoftRefusal("access_denied", "AADSTS90094: The grant requires admin permission.").page).toBe("errors.microsoft.adminConsent");
    expect(microsoftRefusal("access_denied", null).page).toBe("backend.oauth.microsoftDenied");
    expect(microsoftRefusal("invalid_request", null).page).toBe("backend.oauth.microsoftInvalid");
  });

  it("the code exchange's answer: an administrator's refusal says so; a server failure is retryable", async () => {
    const ms = await microsoft();
    ms.tokenFailure = { status: 400, body: { error: "invalid_grant", error_description: "AADSTS65001: The user or administrator has not consented" } };
    expect(key(await connect(ms).catch((e: unknown) => e))).toBe("errors.microsoft.adminConsent");
    ms.tokenFailure = { status: 503, body: {} };
    const failure = await connect(ms).catch((e: unknown) => e) as ProviderError;
    expect(key(failure)).toBe("errors.microsoft.signInFailed");
    expect(failure.retryable).toBe(true);
  });

  it("names Outlook's mail scopes in either of Microsoft's spellings", () => {
    expect(microsoftMailGranted(["Mail.ReadWrite", "Mail.Send"])).toBe(true);
    expect(microsoftMailGranted(["https://graph.microsoft.com/mail.readwrite", "https://graph.microsoft.com/MAIL.SEND"])).toBe(true);
    expect(microsoftMailGranted(["Mail.Read", "Mail.Send"])).toBe(false);
    expect(microsoftMailGranted(["https://outlook.office.com/Mail.ReadWrite", "Mail.Send"])).toBe(false);
  });
});

describe("Microsoft's refresh session (plan 259)", () => {
  function context(ms: SyntheticMicrosoft, initial: string) {
    const stored = { refreshToken: initial as string | null };
    const ctx = {
      fetch,
      getSecret: async () => stored.refreshToken,
      replaceSecret: async (_name: string, expected: string, next: string) => {
        if (stored.refreshToken !== expected && stored.refreshToken !== next) return false;
        stored.refreshToken = next;
        return true;
      },
      oauthClient: async () => ({ clientId: ms.clientId, clientSecret: null }),
    } as unknown as ProviderContext;
    return { ctx, stored };
  }

  it("refreshes as a public client and keeps each rotated refresh token before using its access", async () => {
    const ms = await microsoft();
    const signedIn = await connect(ms);
    const { ctx, stored } = context(ms, signedIn.refreshToken);
    const session = createMicrosoftSession(ctx, { endpoints: ms.endpoints() });
    try {
      const first = await session.get();
      expect(ms.refreshCalls).toBe(1);
      const refresh = ms.tokenRequests.at(-1)!;
      expect(refresh.get("grant_type")).toBe("refresh_token");
      expect(refresh.has("client_secret")).toBe(false);
      expect(refresh.get("scope")).toBe(MICROSOFT_SCOPES.join(" "));
      // the old one is spent at Microsoft; the new one is what's stored
      expect(stored.refreshToken).not.toBe(signedIn.refreshToken);
      expect(ms.refreshTokens.has(stored.refreshToken!)).toBe(true);
      expect(await session.get()).toBe(first);
      session.invalidate(first);
      expect(await session.get()).not.toBe(first);
      expect(ms.refreshCalls).toBe(2);
    } finally { session.close(); }
  });

  it("a revoked or expired grant means signing in again, in Microsoft's words", async () => {
    const ms = await microsoft();
    const { ctx } = context(ms, "refresh-gone");
    const session = createMicrosoftSession(ctx, { endpoints: ms.endpoints() });
    try {
      const error = await session.get().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProviderAuthError);
      expect(key(error)).toBe("errors.microsoft.revoked");
    } finally { session.close(); }
  });

  it("a renewed grant without mail means signing in again; a server failure is retryable", async () => {
    const ms = await microsoft();
    const signedIn = await connect(ms);
    ms.grantedScope = "openid profile https://graph.microsoft.com/User.Read";
    const { ctx } = context(ms, signedIn.refreshToken);
    const session = createMicrosoftSession(ctx, { endpoints: ms.endpoints() });
    try {
      const error = await session.get().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProviderAuthError);
      expect(key(error)).toBe("errors.microsoft.permissionRequired");
    } finally { session.close(); }
    const again = createMicrosoftSession(context(ms, [...ms.refreshTokens][0]!).ctx, { endpoints: ms.endpoints() });
    ms.tokenFailure = { status: 503, body: {} };
    try {
      const error = await again.get().catch((e: unknown) => e) as ProviderError;
      expect(error).not.toBeInstanceOf(ProviderAuthError);
      expect(key(error)).toBe("errors.microsoft.refreshFailed");
      expect(error.retryable).toBe(true);
    } finally { again.close(); }
  });
});
