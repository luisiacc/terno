import { L } from "@terno/i18n";
import { callbackPage } from "./oauth-page";
import { signInLog } from "./login-log";
import { openLoopback, pkce } from "./oauth-loopback";
import { validTokenResponse } from "./oauth-flow";
import { createOAuthSession } from "./oauth-session";
import { buildRaw } from "./compose";
import { readGoogleIdentity, withGoogleSignIn } from "./gmail-web";
import { GMAIL_UNITS_PER_SECOND } from "./gmail-quota";
import { exchangeGmailRefresh } from "./gmail-refresh";
import { createGmailApiProvider, GMAIL_SCOPES as SCOPES, GOOGLE_ENDPOINTS, type GmailEndpoints } from "./gmail-api";
import { ProviderError, type GmailConnectResult, type MailProvider, type ProviderContext, type AccountRequests } from "./types";

export * from "./gmail-api";
export { callbackPage } from "./oauth-page";

// ───────────────────────────── OAuth (installed app, PKCE, loopback) ─────────────────────────────

export interface ConnectOptions {
  clientId: string;
  clientSecret: string | null;
  openExternal: (url: string) => Promise<void>;
  signal?: AbortSignal;
  endpoints?: Partial<GmailEndpoints>;
  timeoutMs?: number;
  /** the backend's network-policy fetch (purpose "mail") */
  fetch: typeof fetch;
  google?: Pick<AccountRequests, "request">;
  /** pre-selects the account on Google's consent screen (re-verifying an owner) */
  loginHint?: string;
  /** Only an existing-account caller that will prove the stored grant may accept true wire omission. */
  allowOmittedRefreshToken?: boolean;
}

/**
 * RFC 8252 flow: a one-shot HTTP listener on 127.0.0.1:<random>, PKCE S256 and
 * a random state. The redirect is accepted only with the matching state.
 */
export async function connectGmail(options: ConnectOptions): Promise<GmailConnectResult> {
  return withGoogleSignIn({ fetch: options.fetch, google: options.google, signal: options.signal, timeoutMs: options.timeoutMs ?? 300_000 }, async (flow) => {
    const ep = { ...GOOGLE_ENDPOINTS, ...options.endpoints };
    // plan 258: always exactly these, in every build
    const requestedScopes = [...SCOPES];
    const { verifier, challenge, state } = pkce();
    const page = await flow.wait(callbackPage());
    const invalid = () => new ProviderError(L("errors.google.invalidResponse"), false);
    const loopback = openLoopback({
      provider: "google", authorize: ep.auth, state, redirectHost: "127.0.0.1", redirectPath: "/callback", page, invalid, invalidPage: "backend.oauth.invalid", openExternal: options.openExternal, signal: flow.signal,
      params: {
        client_id: options.clientId,
        response_type: "code",
        scope: requestedScopes.join(" "),
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
        access_type: "offline",
        prompt: "consent",
        ...(options.loginHint && { login_hint: options.loginHint }),
      },
      refused: (error) => {
        const adminPolicy = error === "admin_policy_enforced";
        return { page: adminPolicy ? "errors.google.adminPolicy" : "backend.oauth.denied", error: adminPolicy ? new ProviderError(L("errors.google.adminPolicy"), false) : error === "access_denied" ? new ProviderError(L("errors.google.denied"), false) : invalid() };
      },
    });
    try {
      const code = await flow.wait(loopback.code);
      const body = new URLSearchParams({ client_id: options.clientId, code: code.code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: code.redirectUri });
      if (options.clientSecret) body.set("client_secret", options.clientSecret);
      // plan 293 (CASA 6.5.1): the request and its answer are logged, every secret value redacted
      const tokens = await flow.json(ep.token, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }, { endpoint: "oauth-token", purpose: "authorization-code" }).catch((error: unknown) => {
        signInLog.tokenExchange("google", ep.token, { error });
        throw error;
      });
      signInLog.tokenExchange("google", ep.token, { tokens });
      if (!validTokenResponse(tokens, { allowOmittedRefreshToken: options.allowOmittedRefreshToken })) throw new ProviderError(L("errors.google.invalidResponse"), false);
      const grantedScopes = typeof tokens.scope === "string" ? tokens.scope.split(/\s+/).filter(Boolean) : requestedScopes;
      if (!grantedScopes.includes("https://www.googleapis.com/auth/gmail.modify") && !grantedScopes.includes("https://mail.google.com/")) throw new ProviderError(L("errors.google.mailScopeRequired"), false);
      const identity = await readGoogleIdentity(tokens.access_token, ep, flow);
      return { ...identity, refreshToken: (tokens.refresh_token as string | undefined) ?? null, grantedScopes };
    } finally {
      await loopback.close();
    }
  });
}

// ───────────────────────────── provider (refresh token) ─────────────────────────────

/** Desktop: the API client with tokens refreshed from the stored refresh token, and nodemailer's MIME. */
export function createGmailProvider(ctx: ProviderContext, options: { endpoints?: Partial<GmailEndpoints>; unitsPerSecond?: number } = {}): MailProvider {
  const ep = { ...GOOGLE_ENDPOINTS, ...options.endpoints };
  // plan 259: the refresh-token session every OAuth provider shares; Google's exchange and words
  const session = createOAuthSession(ctx, {
    token: { endpoint: "oauth-token", purpose: "refresh" },
    exchange: ({ refreshToken, clientId, clientSecret, signal, generation, admission, run }) =>
      exchangeGmailRefresh({ fetch: ctx.fetch, url: ep.token, clientId, clientSecret, refreshToken, signal, google: ctx.requests, generation, admission, run }),
    messages: { reconnect: () => L("errors.gmail.reconnect"), clientUnread: () => L("errors.gmail.clientUnread"), stale: () => L("errors.gmail.refreshFailed", { status: 200 }) },
  });

  const provider = createGmailApiProvider(ctx, {
    endpoints: options.endpoints,
    // plan 62 fix: paced under Google's per-user quota rather than refused
    unitsPerSecond: options.unitsPerSecond ?? GMAIL_UNITS_PER_SECOND,
    tokens: { get: session.get, invalidate: session.invalidate },
    buildRaw: (payload) => buildRaw(payload, { keepBcc: true }),
  });
  const close = provider.close.bind(provider);
  provider.close = async () => {
    session.close();
    await close();
  };
  return provider;
}
