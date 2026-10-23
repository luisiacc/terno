import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { buildRaw } from "./compose";
import { createGmailApiProvider, GMAIL_SCOPES as SCOPES, GOOGLE_ENDPOINTS, type GmailEndpoints } from "./gmail-api";
import { ProviderAuthError, ProviderError, type GmailConnectResult, type MailProvider, type ProviderContext } from "./types";

export * from "./gmail-api";

const b64url = (buf: Buffer) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

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
  /** pre-selects the account on Google's consent screen (re-verifying an owner) */
  loginHint?: string;
}

/**
 * RFC 8252 flow: a one-shot HTTP listener on 127.0.0.1:<random>, PKCE S256 and
 * a random state. The redirect is accepted only with the matching state.
 */
export async function connectGmail(options: ConnectOptions): Promise<GmailConnectResult> {
  const ep = { ...GOOGLE_ENDPOINTS, ...options.endpoints };
  const netFetch = options.fetch;
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(24));
  let server: Server | null = null;
  try {
    const code = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new ProviderError("Google sign-in timed out", false)), options.timeoutMs ?? 300_000);
      options.signal?.addEventListener("abort", () => reject(new ProviderError("Sign-in cancelled", false)));
      server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (url.pathname !== "/callback") return void res.writeHead(404).end();
        const done = (ok: boolean, msg: string) => {
          res.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
          res.end(`<!doctype html><meta charset="utf-8"><body style="font:15px -apple-system;padding:40px;text-align:center"><h2>${ok ? "Cuenta conectada ✓" : "No se pudo conectar"}</h2><p>${msg}</p></body>`);
        };
        if (url.searchParams.get("state") !== state) {
          done(false, "Solicitud inválida.");
          return; // ignore forged/stale redirects, keep waiting for the real one
        }
        clearTimeout(timer);
        const error = url.searchParams.get("error");
        if (error) {
          done(false, "Permiso denegado.");
          reject(new ProviderError(error === "access_denied" ? "Google access was denied" : `Google error: ${error}`, false));
          return;
        }
        done(true, "Ya puedes volver a Única.");
        const port = (server!.address() as AddressInfo).port;
        resolve({ code: url.searchParams.get("code") ?? "", redirectUri: `http://127.0.0.1:${port}/callback` });
      });
      server.listen(0, "127.0.0.1", () => {
        const port = (server!.address() as AddressInfo).port;
        const params = new URLSearchParams({
          client_id: options.clientId,
          redirect_uri: `http://127.0.0.1:${port}/callback`,
          response_type: "code",
          scope: SCOPES.join(" "),
          code_challenge: challenge,
          code_challenge_method: "S256",
          state,
          access_type: "offline",
          prompt: "consent",
        });
        if (options.loginHint) params.set("login_hint", options.loginHint);
        void options.openExternal(`${ep.auth}?${params}`).catch(reject);
      });
    });
    const body = new URLSearchParams({ client_id: options.clientId, code: code.code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: code.redirectUri });
    if (options.clientSecret) body.set("client_secret", options.clientSecret);
    const tokenRes = await netFetch(ep.token, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    const tokens = (await tokenRes.json()) as { access_token?: string; refresh_token?: string; error?: string };
    if (!tokenRes.ok || !tokens.access_token || !tokens.refresh_token) throw new ProviderError(`Token exchange failed: ${tokens.error ?? tokenRes.status}`, false);
    const profile = (await (await netFetch(`${ep.api}/profile`, { headers: { authorization: `Bearer ${tokens.access_token}` } })).json()) as { emailAddress: string };
    const info = (await netFetch(ep.userinfo, { headers: { authorization: `Bearer ${tokens.access_token}` } }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}))) as { name?: string; sub?: string; email_verified?: boolean };
    return { email: profile.emailAddress, name: info.name ?? "", refreshToken: tokens.refresh_token, sub: info.sub ?? null, emailVerified: info.email_verified === true };
  } finally {
    (server as Server | null)?.close();
  }
}

// ───────────────────────────── provider (refresh token) ─────────────────────────────

/** Desktop: the API client with tokens refreshed from the stored refresh token, and nodemailer's MIME. */
export function createGmailProvider(ctx: ProviderContext, options: { endpoints?: Partial<GmailEndpoints> } = {}): MailProvider {
  const ep = { ...GOOGLE_ENDPOINTS, ...options.endpoints };
  const netFetch = ctx.fetch;
  const store = ctx.store;
  let access: { token: string; expiresAt: number } | null = null;
  let refreshing: Promise<string> | null = null;

  /** One refresh at a time: concurrent 401s share the same in-flight refresh. */
  function refresh(): Promise<string> {
    refreshing ??= (async () => {
      try {
        const refreshToken = await ctx.getSecret("refreshToken");
        if (!refreshToken) throw new ProviderAuthError("Gmail account needs to be reconnected");
        const clientId = (await store.setting<{ gmailClientId?: string }>("app"))?.gmailClientId;
        const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId ?? "" });
        const secret = await ctx.getAppSecret("gmailClientSecret").catch(() => null);
        if (secret) body.set("client_secret", secret);
        let res: Response;
        try {
          res = await netFetch(ep.token, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
        } catch (e) {
          throw new ProviderError(`Network error refreshing Gmail token: ${e instanceof Error ? e.message : e}`, true);
        }
        const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
        if (json.error === "invalid_grant") throw new ProviderAuthError("Gmail access was revoked; reconnect the account");
        if (!res.ok || !json.access_token) throw new ProviderError(`Gmail token refresh failed (${res.status})`, res.status >= 500);
        access = { token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 - 60_000 };
        return json.access_token;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  return createGmailApiProvider(ctx, {
    endpoints: options.endpoints,
    tokens: {
      get: async () => (access && access.expiresAt > Date.now() ? access.token : refresh()),
      invalidate: () => void (access = null),
    },
    buildRaw: (payload) => buildRaw(payload, { keepBcc: true }),
  });
}
