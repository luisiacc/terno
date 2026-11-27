// Plan 259 stage 1: signing in with Microsoft for Outlook over Microsoft Graph. The RFC 8252 loopback on
// http://localhost (the one loopback form whose port Microsoft ignores) with PKCE and state, a public client (no
// secret), and the person read from Graph's /me plus the id_token's oid and tid. Refresh tokens rotate on every use;
// the shared session persists each one by CAS before its access token is published (plan 32).
import { isValidEmail } from "@terno/core";
import { L } from "@terno/i18n";
import { readResponseText } from "./http-body";
import { CONSUMER_TENANT, MICROSOFT_SCOPES, microsoftMailGranted } from "./microsoft-scopes";
import { captureHttpResponseEvidence } from "./http-response-evidence";
import { readJsonObject, validTokenResponse, withSignIn, type SignInFlow, type SignInWords } from "./oauth-flow";
import { openLoopback, pkce } from "./oauth-loopback";
import { callbackPage, type CallbackKey } from "./oauth-page";
import { exchangeOAuthRefresh, type OAuthRefreshExchange, type OAuthRefreshOptions } from "./oauth-refresh";
import { createOAuthSession, type OAuthSession } from "./oauth-session";
import { ProviderAuthError, ProviderError, type AccountRequests, type HttpRequestContext, type HttpResponseEvidence, type MicrosoftConnectOptions, type MicrosoftConnectResult, type MicrosoftTenant, type ProviderContext } from "./types";

/** Where Microsoft's sign-in and Graph live; tests and the dev backend move them to a synthetic Microsoft. */
export interface MicrosoftEndpoints {
  authorize: string;
  token: string;
  /** Graph's v1.0 root */
  graph: string;
}

export const MICROSOFT_ENDPOINTS: MicrosoftEndpoints = {
  authorize: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
  graph: "https://graph.microsoft.com/v1.0",
};

const MICROSOFT_SIGN_IN: SignInWords = {
  cancelled: () => L("errors.microsoft.cancelled"),
  timedOut: () => L("errors.microsoft.timedOut"),
  unavailable: () => L("errors.microsoft.unavailable"),
};
const invalid = () => new ProviderError(L("errors.microsoft.invalidResponse"), false);

/**
 * A refusal about consent, named only in the error_description's AADSTS code. Only AADSTS90093 (user consent is
 * off), AADSTS90094 (the grant requires admin permission), AADSTS90095 (an admin consent request) and AADSTS900941
 * (risk policy wants an administrator) say an administrator must approve; AADSTS65001 and
 * consent_required say consent wasn't given, which the person may still give (Codex code review #8).
 */
function consentRefusal(error: unknown, description: unknown): "errors.microsoft.adminConsent" | "errors.microsoft.consentRequired" | null {
  const text = typeof description === "string" ? description : "";
  if (/\bAADSTS(?:9009[345]|900941)\b/.test(text)) return "errors.microsoft.adminConsent";
  if (error === "consent_required" || /\bAADSTS65001\b/.test(text)) return "errors.microsoft.consentRequired";
  return null;
}

/** A refused authorization (the redirect's ?error=): what the page says and what the caller hears. */
export function microsoftRefusal(error: string, description: string | null): { page: CallbackKey; error: ProviderError } {
  const consent = consentRefusal(error, description);
  if (consent) return { page: consent, error: new ProviderError(L(consent), false) };
  if (error === "access_denied") return { page: "backend.oauth.microsoftDenied", error: new ProviderError(L("errors.microsoft.denied"), false) };
  return { page: "backend.oauth.microsoftInvalid", error: invalid() };
}

/**
 * One bounded JSON answer from Microsoft's token endpoint or Graph, within the sign-in's deadline. A redirect is
 * refused: the form carries the code and its verifier, and the answer becomes the account's identity (Codex code
 * review #3). `notFound`: what a 404 means here.
 */
async function microsoftJson(flow: SignInFlow, reach: MicrosoftNet, url: string, init: RequestInit, httpContext: HttpRequestContext, notFound?: () => ProviderError): Promise<Record<string, unknown>> {
  const { signal, wait } = flow;
  signal.throwIfAborted();
  let httpResponse: HttpResponseEvidence | undefined;
  const wire: RequestInit = { ...init, redirect: "error", signal };
  // through the ledger when the host gives one: a pause on Microsoft's token or Graph service holds a sign-in too, and
  // a throttle answered here pauses them
  const sent = reach.requests ? reach.requests.request({ request: httpContext }, url, wire) : reach.fetch(url, wire);
  const response = await wait(sent.then((res) => {
    if (signal.aborted) {
      void res.body?.cancel().catch(() => {});
      throw signal.reason;
    }
    if (!res.ok) httpResponse = captureHttpResponseEvidence(res, httpContext, Date.now());
    return res;
  }));
  if (!response.ok) {
    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(await wait(readResponseText(response, 65_536, signal)).catch(() => ""));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch { /* an unreadable error body says only its status */ }
    // the code exchange is where a tenant's consent requirement can surface too
    const consent = consentRefusal(body.error, body.error_description);
    if (consent) throw new ProviderError(L(consent), false, false, false, httpResponse);
    if (response.status === 404 && notFound) throw notFound();
    throw new ProviderError(L("errors.microsoft.signInFailed", { detail: response.status }), response.status === 429 || response.status >= 500, false, false, httpResponse);
  }
  return readJsonObject(response, flow, invalid);
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The id_token's tenant and object ids. It came straight from the token endpoint over TLS, which OpenID Connect
 * Core §3.1.3.7 accepts in place of its signature; its issuer (the tenant's v2.0 issuer), audience (this client) and
 * expiry are still checked (Codex code review #6). `now` allows five minutes of clock skew.
 */
export function idTokenSubject(idToken: unknown, clientId: string, now = Date.now()): { tid: string; oid: string; username?: string } | null {
  if (typeof idToken !== "string" || idToken.length > 16_384) return null;
  const parts = idToken.split(".");
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[1]!)) return null;
  let claims: unknown;
  try {
    const b64 = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    claims = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))));
  } catch { return null; }
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) return null;
  const { aud, tid, oid, iss, exp, preferred_username: preferred } = claims as Record<string, unknown>;
  if (aud !== clientId || typeof tid !== "string" || !GUID.test(tid) || typeof oid !== "string" || !GUID.test(oid)) return null;
  if (typeof iss !== "string" || iss.toLowerCase() !== `https://login.microsoftonline.com/${tid.toLowerCase()}/v2.0`) return null;
  if (typeof exp !== "number" || !Number.isFinite(exp) || exp * 1000 <= now - 300_000) return null;
  // plan 259 stage 2b: the sign-in name, "mutable … used for username hints" (id-token-claims-reference): a hint, never identity
  const username = typeof preferred === "string" && preferred.length <= 254 && preferred.trim() && !/[\s\p{Cc}]/u.test(preferred) ? preferred : undefined;
  return { tid: tid.toLowerCase(), oid: oid.toLowerCase(), ...(username && { username }) };
}

/** Who signed in: the mailbox from Graph's /me, the stable subject from the id_token of the same answer. */
/** How a sign-in reaches Microsoft: the host's fetch, through its request ledger when it has one. */
export interface MicrosoftNet { fetch: typeof fetch; requests?: Pick<AccountRequests, "request"> }

export async function readMicrosoftIdentity(flow: SignInFlow, reach: MicrosoftNet, ep: MicrosoftEndpoints, tokens: { accessToken: string; idToken: unknown; clientId: string }): Promise<Omit<MicrosoftConnectResult, "refreshToken" | "grantedScopes">> {
  const ids = idTokenSubject(tokens.idToken, tokens.clientId);
  if (!ids) throw invalid();
  const me = await microsoftJson(flow, reach, `${ep.graph}/me?$select=mail,userPrincipalName,displayName`, { headers: { authorization: `Bearer ${tokens.accessToken}` } }, { endpoint: "microsoft-identity", purpose: "identity-proof" });
  // personal accounts often have no `mail`; their user principal name is the address
  const email = typeof me.mail === "string" && me.mail ? me.mail : me.userPrincipalName;
  if (typeof email !== "string" || email.length > 254 || !isValidEmail(email) || /\p{Cc}/u.test(email)) throw invalid();
  if (me.displayName !== undefined && me.displayName !== null && typeof me.displayName !== "string") throw invalid();
  // a profile isn't a mailbox: a work account without an Exchange Online licence, or a personal Microsoft account
  // under another provider's address, signs in but has no mail to keep (Codex code review #5)
  const inbox = await microsoftJson(flow, reach, `${ep.graph}/me/mailFolders/inbox?$select=id`, { headers: { authorization: `Bearer ${tokens.accessToken}` } }, { endpoint: "graph-api", purpose: "identity-proof" }, () => new ProviderError(L("errors.microsoft.noMailbox"), false));
  if (typeof inbox.id !== "string" || !inbox.id) throw invalid();
  const tenant: MicrosoftTenant = ids.tid === CONSUMER_TENANT ? "consumers" : "organizations";
  return { email, name: typeof me.displayName === "string" ? me.displayName.slice(0, 256) : "", subject: `${ids.tid}:${ids.oid}`, tenant, ...(ids.username && { username: ids.username }) };
}

/**
 * RFC 8252 flow on http://localhost:<random> (the listener is on 127.0.0.1), PKCE S256 and a random state. A new
 * connection asks `prompt=select_account` so a second mailbox can be picked; an account signing in again sends
 * `login_hint` instead, since Microsoft doesn't take the two together (Codex code review #2).
 */
export async function connectMicrosoft(options: MicrosoftConnectOptions & { endpoints?: Partial<MicrosoftEndpoints>; timeoutMs?: number }): Promise<MicrosoftConnectResult> {
  return withSignIn({ signal: options.signal, timeoutMs: options.timeoutMs ?? 300_000, words: MICROSOFT_SIGN_IN }, async (flow) => {
    const ep = { ...MICROSOFT_ENDPOINTS, ...options.endpoints };
    const scope = MICROSOFT_SCOPES.join(" ");
    const { verifier, challenge, state } = pkce();
    const page = await flow.wait(callbackPage());
    const loopback = openLoopback({
      authorize: ep.authorize, state, redirectHost: "localhost", redirectPath: "", page, invalid, invalidPage: "backend.oauth.microsoftInvalid", openExternal: options.openExternal, signal: flow.signal,
      params: {
        client_id: options.clientId,
        response_type: "code",
        response_mode: "query",
        scope,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
        ...(options.loginHint ? { login_hint: options.loginHint } : { prompt: "select_account" }),
      },
      refused: microsoftRefusal,
    });
    try {
      const code = await flow.wait(loopback.code);
      // a public client: PKCE and the loopback protect the code, there is no secret
      const body = new URLSearchParams({ client_id: options.clientId, scope, code: code.code, redirect_uri: code.redirectUri, grant_type: "authorization_code", code_verifier: verifier });
      const reach: MicrosoftNet = { fetch: options.fetch, ...(options.requests && { requests: options.requests }) };
      const tokens = await microsoftJson(flow, reach, ep.token, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }, { endpoint: "microsoft-token", purpose: "authorization-code" });
      if (!validTokenResponse(tokens)) throw invalid();
      const grantedScopes = typeof tokens.scope === "string" ? tokens.scope.split(/\s+/).filter(Boolean) : [...MICROSOFT_SCOPES];
      if (!microsoftMailGranted(grantedScopes)) throw new ProviderError(L("errors.microsoft.mailScopeRequired"), false);
      const identity = await readMicrosoftIdentity(flow, reach, ep, { accessToken: tokens.access_token, idToken: tokens.id_token, clientId: options.clientId });
      return { ...identity, refreshToken: tokens.refresh_token as string, grantedScopes };
    } finally {
      await loopback.close();
    }
  });
}

/** Grant answers that mean signing in again: expired or revoked, or a tenant now asking for MFA or consent. */
const REFUSED_GRANTS = new Set(["invalid_grant", "interaction_required", "consent_required"]);

/** One refresh at Microsoft's token endpoint; the new refresh token it returns replaces the old one. */
export function exchangeMicrosoftRefresh(options: OAuthRefreshOptions): Promise<OAuthRefreshExchange> {
  return exchangeOAuthRefresh(options, {
    request: { endpoint: "microsoft-token", purpose: "refresh" },
    params: { scope: MICROSOFT_SCOPES.join(" ") },
    // plan 293: only invalid_grant says the refresh token itself is dead (expired or revoked); MFA or consent asks the
    // user to act on a grant that may still be good, so that one is kept
    refused: (status, body, evidence) => status === 400 && REFUSED_GRANTS.has(body.error as string) ? new ProviderAuthError(L("errors.microsoft.revoked"), evidence, { grantRejected: body.error === "invalid_grant" }) : null,
    scopes: (granted) => microsoftMailGranted(granted) ? null : new ProviderAuthError(L("errors.microsoft.permissionRequired")),
    invalid,
    failed: (status) => L("errors.microsoft.refreshFailed", { status }),
  });
}

/** What the Graph provider (stage 2) gets its access tokens from: the account's stored, rotating refresh token. */
export function createMicrosoftSession(ctx: ProviderContext, options: { endpoints?: Partial<MicrosoftEndpoints> } = {}): OAuthSession {
  const ep = { ...MICROSOFT_ENDPOINTS, ...options.endpoints };
  return createOAuthSession(ctx, {
    token: { endpoint: "microsoft-token", purpose: "refresh" },
    exchange: ({ refreshToken, clientId, clientSecret, signal, generation, admission, run }) =>
      exchangeMicrosoftRefresh({ fetch: ctx.fetch, url: ep.token, clientId, clientSecret, refreshToken, signal, requests: ctx.requests, generation, admission, run }),
    messages: { reconnect: () => L("errors.microsoft.reconnect"), clientUnread: () => L("errors.microsoft.clientUnread"), stale: () => L("errors.microsoft.refreshFailed", { status: 200 }) },
  });
}
