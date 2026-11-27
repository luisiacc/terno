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

describe("connectMicrosoft (plan 259)", () => {
  it("asks Microsoft for exactly Outlook's scopes on the registered localhost redirect, as a public client, and reads who signed in", async () => {
    const ms = await microsoft();
    const result = await connect(ms);
    const asked = ms.authorizations[0]!;
    expect(Object.fromEntries([...asked].filter(([k]) => !["state", "code_challenge", "redirect_uri"].includes(k)))).toEqual({
      client_id: ms.clientId, response_type: "code", response_mode: "query", scope: "openid email profile offline_access User.Read Mail.ReadWrite Mail.Send",
      code_challenge_method: "S256", prompt: "select_account",
    });
    // Codex code review #1: the registration is http://localhost, and Entra ignores only the port
    expect(asked.get("redirect_uri")).toMatch(/^http:\/\/localhost:\d+$/);
    const exchange = ms.tokenRequests[0]!;
    expect(exchange.has("client_secret")).toBe(false);
    expect(exchange.get("redirect_uri")).toBe(asked.get("redirect_uri"));
    expect(exchange.get("scope")).toBe(MICROSOFT_SCOPES.join(" "));
    expect(result).toEqual({
      email: "ana@contoso.com", name: "Ana Ruiz", refreshToken: expect.stringMatching(/^refresh-/), tenant: "organizations", username: "ana@contoso.com",
      subject: `${ms.tid}:${ms.oid}`, grantedScopes: expect.arrayContaining(["https://graph.microsoft.com/Mail.ReadWrite", "https://graph.microsoft.com/Mail.Send"]),
    });
  });

  it("review round 4 (Fable #4): a work account's long access token (a JWT past 4 KiB) signs in; one past 16 KiB is still refused", async () => {
    const ms = await microsoft();
    ms.accessLength = 9000;
    await expect(connect(ms)).resolves.toMatchObject({ email: "ana@contoso.com" });
    ms.accessLength = 16_385;
    await expect(connect(ms)).rejects.toMatchObject({ i18n: { key: "errors.microsoft.invalidResponse" } });
  });

  it("a personal account is the consumer tenant, and its address is the user principal name when Graph has no mail", async () => {
    const ms = (await microsoft()).personal("ana@outlook.com");
    ms.displayName = null;
    expect(await connect(ms)).toMatchObject({ email: "ana@outlook.com", name: "", tenant: "consumers", subject: `9188040d-6c67-4c5b-b112-36a304b66dad:${ms.oid}` });
  });

  it("Codex code review #2: signing an account in again pre-fills it on Microsoft's page, without prompt=select_account", async () => {
    const ms = await microsoft();
    await connect(ms, "approve", { loginHint: "ana@contoso.com" });
    expect(ms.authorizations[0]!.get("login_hint")).toBe("ana@contoso.com");
    expect(ms.authorizations[0]!.has("prompt")).toBe(false);
  });

  it("Codex code review #5: an account without an Outlook mailbox is refused in its own words", async () => {
    const ms = (await microsoft()).personal("ana@gmail.com");
    ms.mailbox = false;
    expect(key(await connect(ms).catch((e: unknown) => e))).toBe("errors.microsoft.noMailbox");
  });

  it("an omitted scope is the request's; a grant without mail is refused in Microsoft's words", async () => {
    const ms = await microsoft();
    ms.grantedScope = undefined;
    expect((await connect(ms)).grantedScopes).toEqual(MICROSOFT_SCOPES);
    ms.grantedScope = "openid profile https://graph.microsoft.com/Mail.ReadWrite";
    expect(key(await connect(ms).catch((e: unknown) => e))).toBe("errors.microsoft.mailScopeRequired");
  });

  it("an id_token for another client, from another issuer, expired, or none, is an invalid response (Codex code review #6)", async () => {
    const ms = await microsoft();
    for (const claims of [{ aud: "someone-else" }, { iss: "https://login.microsoftonline.com/00000000-0000-0000-0000-000000000000/v2.0" }, { iss: undefined }, { exp: Math.floor(Date.now() / 1000) - 3600 }, { exp: undefined }]) {
      ms.claims = claims;
      expect(key(await connect(ms).catch((e: unknown) => e))).toBe("errors.microsoft.invalidResponse");
    }
    ms.claims = {};
    expect(await connect(ms)).toMatchObject({ subject: `${ms.tid}:${ms.oid}` });
    expect(idTokenSubject(undefined, ms.clientId)).toBeNull();
    expect(idTokenSubject("not.a.jwt", ms.clientId)).toBeNull();
  });

  it("stage 2b: keeps the id_token's preferred_username, the sign-in name a work account's address can differ from; never a malformed one", async () => {
    const ms = await microsoft();
    ms.userPrincipalName = "ana.ruiz@contoso.onmicrosoft.com";
    expect(await connect(ms)).toMatchObject({ email: "ana@contoso.com", username: "ana.ruiz@contoso.onmicrosoft.com" });
    for (const preferred of ["two words", "", 42, "x".repeat(300)]) {
      ms.claims = { preferred_username: preferred };
      expect((await connect(ms)).username).toBeUndefined();
    }
  });

  it("maps Microsoft's refusals: denied, consent not given, an administrator's approval needed, anything else invalid", async () => {
    const ms = await microsoft();
    expect(key(await connect(ms, "deny").catch((e: unknown) => e))).toBe("errors.microsoft.denied");
    // Codex code review #8: consent not given isn't an administrator's block
    expect(key(await connect(ms, { error: "consent_required" }).catch((e: unknown) => e))).toBe("errors.microsoft.consentRequired");
    expect(key(await connect(ms, { error: "interaction_required", description: "AADSTS65001: The user or administrator has not consented to use the application" }).catch((e: unknown) => e))).toBe("errors.microsoft.consentRequired");
    expect(key(await connect(ms, { error: "access_denied", description: "AADSTS90094: The grant requires admin permission." }).catch((e: unknown) => e))).toBe("errors.microsoft.adminConsent");
    expect(key(await connect(ms, { error: "server_error" }).catch((e: unknown) => e))).toBe("errors.microsoft.invalidResponse");
    expect(microsoftRefusal("access_denied", "AADSTS90095: Admin consent is required for the permissions requested by this application.").page).toBe("errors.microsoft.adminConsent");
    // Codex code review round 2 #1: user consent turned off, and risk policy asking for an administrator
    expect(microsoftRefusal("access_denied", "AADSTS90093: This application requires admin consent.").page).toBe("errors.microsoft.adminConsent");
    expect(microsoftRefusal("access_denied", "AADSTS900941: Administrator consent is required. App is considered risky.").page).toBe("errors.microsoft.adminConsent");
    expect(microsoftRefusal("access_denied", "AADSTS9009410: not a code we know").page).toBe("backend.oauth.microsoftDenied");
    expect(microsoftRefusal("access_denied", "the administrator can't be reached").page).toBe("backend.oauth.microsoftDenied");
    expect(microsoftRefusal("access_denied", null).page).toBe("backend.oauth.microsoftDenied");
    expect(microsoftRefusal("invalid_request", null).page).toBe("backend.oauth.microsoftInvalid");
  });

  it("the code exchange's answer: a consent refusal says so; a server failure is retryable", async () => {
    const ms = await microsoft();
    ms.tokenFailure = { status: 400, body: { error: "invalid_grant", error_description: "AADSTS65001: The user or administrator has not consented" } };
    expect(key(await connect(ms).catch((e: unknown) => e))).toBe("errors.microsoft.consentRequired");
    ms.tokenFailure = { status: 400, body: { error: "invalid_grant", error_description: "AADSTS90094: The grant requires admin permission." } };
    expect(key(await connect(ms).catch((e: unknown) => e))).toBe("errors.microsoft.adminConsent");
    ms.tokenFailure = { status: 503, body: {} };
    const failure = await connect(ms).catch((e: unknown) => e) as ProviderError;
    expect(key(failure)).toBe("errors.microsoft.signInFailed");
    expect(failure.retryable).toBe(true);
  });

  it("Codex code review #3: a token endpoint that redirects never gets the code or the refresh token replayed elsewhere", async () => {
    const ms = await microsoft();
    const elsewhere = await microsoft();
    ms.tokenRedirect = `${elsewhere.url}/common/oauth2/v2.0/token`;
    await expect(connect(ms)).rejects.toBeInstanceOf(ProviderError);
    const session = createMicrosoftSession(context(ms, "refresh-any").ctx, { endpoints: ms.endpoints() });
    try { await expect(session.get()).rejects.toBeInstanceOf(Error); } finally { session.close(); }
    expect(ms.tokenRequests.length).toBe(2);
    expect(elsewhere.tokenRequests).toEqual([]);
  });

  it("Codex code review round 2 #3: a Graph identity read or mailbox probe that redirects is refused, never followed", async () => {
    const ms = await microsoft();
    const elsewhere = await microsoft();
    for (const path of ["/v1.0/me", "/v1.0/me/mailFolders/inbox"]) {
      ms.graphRedirect = (asked) => asked === path ? `${elsewhere.url}${path}` : null;
      await expect(connect(ms)).rejects.toBeInstanceOf(ProviderError);
    }
    expect(ms.graphRequests).toEqual(["/v1.0/me", "/v1.0/me", "/v1.0/me/mailFolders/inbox"]);
    expect(elsewhere.graphRequests).toEqual([]);
  });

  it("names Outlook's mail scopes in either of Microsoft's spellings", () => {
    expect(microsoftMailGranted(["Mail.ReadWrite", "Mail.Send"])).toBe(true);
    expect(microsoftMailGranted(["https://graph.microsoft.com/mail.readwrite", "https://graph.microsoft.com/MAIL.SEND"])).toBe(true);
    expect(microsoftMailGranted(["Mail.Read", "Mail.Send"])).toBe(false);
    expect(microsoftMailGranted(["https://outlook.office.com/Mail.ReadWrite", "Mail.Send"])).toBe(false);
  });
});

describe("Microsoft's refresh session (plan 259)", () => {
  it("refreshes as a public client, keeps each new refresh token before using its access, and refreshes with it next", async () => {
    const ms = await microsoft();
    const signedIn = await connect(ms);
    const { ctx, stored } = context(ms, signedIn.refreshToken);
    // Codex code review #10: the write is slow; no access token comes back before it has committed
    let release!: () => void, writing!: () => void;
    const written = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { writing = resolve; });
    const replace = ctx.replaceSecret.bind(ctx);
    ctx.replaceSecret = async (name, expected, next) => { writing(); await written; return replace(name, expected, next); };
    const session = createMicrosoftSession(ctx, { endpoints: ms.endpoints() });
    try {
      let settled = false;
      const pending = session.get().then((token) => { settled = true; return token; });
      // the exchange answered and the write began: nothing is published while it is held
      await started;
      await new Promise((r) => setTimeout(r, 10));
      expect(settled).toBe(false);
      expect(stored.refreshToken).toBe(signedIn.refreshToken);
      release();
      const first = await pending;
      const refresh = ms.tokenRequests.at(-1)!;
      expect(refresh.get("grant_type")).toBe("refresh_token");
      expect(refresh.get("refresh_token")).toBe(signedIn.refreshToken);
      expect(refresh.has("client_secret")).toBe(false);
      expect(refresh.get("scope")).toBe(MICROSOFT_SCOPES.join(" "));
      const rotated = stored.refreshToken;
      expect(rotated).not.toBe(signedIn.refreshToken);
      expect(await session.get()).toBe(first);
      session.invalidate(first);
      expect(await session.get()).not.toBe(first);
      expect(ms.refreshCalls).toBe(2);
      expect(ms.tokenRequests.at(-1)!.get("refresh_token")).toBe(rotated);
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
      // plan 293: invalid_grant says the refresh token is dead (it's deleted)
      expect(error).toMatchObject({ grantRejected: true });
    } finally { session.close(); }
  });

  it("plan 293: MFA or consent a tenant now asks for means signing in again, but the grant isn't called dead (its token is kept)", async () => {
    const ms = await microsoft();
    const { ctx } = context(ms, "refresh-1");
    ms.tokenFailure = { status: 400, body: { error: "interaction_required", error_description: "AADSTS50076: multi-factor authentication required" } };
    const session = createMicrosoftSession(ctx, { endpoints: ms.endpoints() });
    try {
      const error = await session.get().catch((e: unknown) => e);
      expect(key(error)).toBe("errors.microsoft.revoked");
      expect(error).toMatchObject({ grantRejected: false });
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
