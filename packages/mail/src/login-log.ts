/**
 * Plan 293 (CASA 6.5.1): the sign-in and login steps, logged so a login can be followed from its log: the OAuth
 * authorization (PKCE S256, the loopback port), the callback (state verified, the code redacted), the token request
 * and its answer (status, which fields came back, every secret value "[redacted]"), and IMAP's and SMTP's LOGIN
 * (the user redacted, OK or NO). Structured lines only, through the process's diagnostics, local-only codes (never a
 * breadcrumb, so never in a report). No code, verifier, token, password, address or name is ever a value here: the
 * secret fields can only hold "[redacted]", and the rest are numbers, enums and known scope names.
 */
import { log } from "@terno/core/diag";

export type SignInProvider = "google" | "microsoft";
const R = "[redacted]" as const;

const KNOWN_ENDPOINTS = new Set(["https://oauth2.googleapis.com/token", "https://login.microsoftonline.com/common/oauth2/v2.0/token"]);
const endpointOf = (url: string) => (KNOWN_ENDPOINTS.has(url) ? (url as "https://oauth2.googleapis.com/token") : "other");

/** The token endpoint's answer, as field names and the values that aren't secret. */
function answered(tokens: Record<string, unknown> | null) {
  if (!tokens) return {};
  return {
    ...(typeof tokens.access_token === "string" && { accessToken: R }),
    ...(typeof tokens.refresh_token === "string" && { refreshToken: R }),
    ...(typeof tokens.id_token === "string" && { idToken: R }),
    ...(typeof tokens.expires_in === "number" && { expiresIn: tokens.expires_in }),
    ...(typeof tokens.scope === "string" && { scope: tokens.scope }),
    ...(typeof tokens.token_type === "string" && { tokenType: tokens.token_type.toLowerCase() === "bearer" ? ("Bearer" as const) : ("other" as const) }),
  };
}

const statusOf = (error: unknown): number | undefined => {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
};

export const signInLog = {
  /** the browser is sent to the provider: PKCE's method and the loopback port the answer comes back to */
  authorize(provider: SignInProvider, port: number, redirectHost: "127.0.0.1" | "localhost"): void {
    log.info("signin.authorize", { provider, pkce: "S256", port, redirectHost });
  },

  /** the browser came back: with a code (redacted) and the state verified, an error, or something malformed; a wrong state is ignored */
  callback(provider: SignInProvider, outcome: "code" | "error" | "malformed" | "mismatch"): void {
    if (outcome === "mismatch") return log.warn("signin.callback", { provider, oauthState: "mismatch" });
    log.info("signin.callback", { provider, callback: outcome, oauthState: "verified", ...(outcome === "code" && { authCode: R }) });
  },

  /** POST to the token endpoint with the code and the verifier (both redacted), and what came back */
  tokenExchange(provider: SignInProvider, url: string, result: { tokens: Record<string, unknown> } | { error: unknown }): void {
    const sent = { provider, httpMethod: "POST", endpoint: endpointOf(url), grantType: "authorization_code", authCode: R, codeVerifier: R } as const;
    if ("tokens" in result) log.info("signin.token_exchange", { ...sent, status: 200, ...answered(result.tokens) });
    else log.warn("signin.token_exchange", { ...sent, ...(statusOf(result.error) !== undefined && { status: statusOf(result.error) }) });
  },

  /** a refresh: POST with the refresh token (redacted), and what came back */
  refresh(provider: SignInProvider, url: string, result: { tokens: Record<string, unknown>; status: number } | { error: unknown }): void {
    const sent = { provider, httpMethod: "POST", endpoint: endpointOf(url), grantType: "refresh_token", refreshToken: R } as const;
    if ("tokens" in result) log.info("token.refresh", { ...sent, ...answered(result.tokens), refreshToken: R, status: result.status });
    else log.warn("token.refresh", { ...sent, ...(statusOf(result.error) !== undefined && { status: statusOf(result.error) }) });
  },

  /** the account's credentials are stored, sealed by the keychain */
  stored(provider: SignInProvider, accountId: number): void {
    log.info("signin.stored", { provider, encrypted: true, accountId });
  },
};

/** IMAP's LOGIN (or AUTHENTICATE) and its answer; `responseCode` is the server's bracketed code (AUTHENTICATIONFAILED). */
export function imapLogin(result: "OK" | "NO" | "error", responseCode?: string): void {
  const fields = { user: R, loginResult: result, ...(responseCode && { responseCode }) } as const;
  if (result === "OK") log.info("imap.login", fields);
  else log.warn("imap.login", fields);
}

/** Connects an IMAP client, logging the login's outcome: OK, NO (the credentials refused), or error (never reached LOGIN). */
export async function loggedImapConnect(connect: () => Promise<void>): Promise<void> {
  try {
    await connect();
  } catch (error) {
    const e = error as { authenticationFailed?: boolean; serverResponseCode?: unknown };
    imapLogin(e?.authenticationFailed ? "NO" : "error", typeof e?.serverResponseCode === "string" ? e.serverResponseCode : undefined);
    throw error;
  }
  imapLogin("OK");
}

/** SMTP's AUTH and its answer: OK (235), NO (535 and the like), or error (never reached AUTH). */
export function smtpLogin(result: "OK" | "NO" | "error", responseCode?: number): void {
  const fields = { user: R, loginResult: result, ...(responseCode !== undefined && { responseCode: String(responseCode) }) } as const;
  if (result === "OK") log.info("smtp.login", fields);
  else log.warn("smtp.login", fields);
}
