import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DEFAULT_LOCALE, L, LOCALE_IDS, LOCALES } from "@terno/i18n";
import { buildRaw } from "./compose";
import { readGoogleIdentity, withGoogleSignIn } from "./gmail-web";
import { isFetchNetworkFailure } from "./net-errors";
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
  /** plan 22: the whole list asked for (installed apps get no incremental consent: mail's scopes plus the new ones) */
  scopes?: string[];
}

type CallbackKey = "backend.oauth.invalid" | "backend.oauth.denied" | "backend.oauth.back";

/**
 * The page the browser shows after Google's redirect. The backend has no
 * language, so the page carries every locale and shows the browser's own
 * (English without script).
 */
export async function callbackPage(): Promise<(ok: boolean, msg: CallbackKey) => string> {
  const catalogs = await Promise.all(LOCALE_IDS.map(async (id) => [id, await LOCALES[id].load()] as const));
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const pick = `<script>(function(){var ids=${JSON.stringify(LOCALE_IDS)};var l=(navigator.languages||[navigator.language]).map(function(t){return String(t).toLowerCase().split(/[-_]/)[0]}).find(function(b){return ids.indexOf(b)>=0});if(l)document.querySelectorAll("[data-locale]").forEach(function(e){e.hidden=e.getAttribute("data-locale")!==l})})()</script>`;
  return (ok, msg) => {
    const blocks = catalogs.map(([id, m]) => {
      const text = (k: CallbackKey | "backend.oauth.connected" | "backend.oauth.failed") => esc(String(m[k] ?? k));
      return `<div lang="${LOCALES[id].tag}" data-locale="${id}"${id === DEFAULT_LOCALE ? "" : " hidden"}><h2>${text(ok ? "backend.oauth.connected" : "backend.oauth.failed")}</h2><p>${text(msg)}</p></div>`;
    });
    return `<!doctype html><meta charset="utf-8"><body style="font:15px -apple-system;padding:40px;text-align:center">${blocks.join("")}${pick}</body>`;
  };
}

/**
 * RFC 8252 flow: a one-shot HTTP listener on 127.0.0.1:<random>, PKCE S256 and
 * a random state. The redirect is accepted only with the matching state.
 */
export async function connectGmail(options: ConnectOptions): Promise<GmailConnectResult> {
  return withGoogleSignIn({ fetch: options.fetch, signal: options.signal, timeoutMs: options.timeoutMs ?? 300_000 }, async (flow) => {
    const ep = { ...GOOGLE_ENDPOINTS, ...options.endpoints };
    const requestedScopes = [...(options.scopes ?? SCOPES)];
    const verifier = b64url(randomBytes(48));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    const state = b64url(randomBytes(24));
    const page = await flow.wait(callbackPage());
    let server: Server | null = null;
    try {
      let settled = false;
      const code = await flow.wait(new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
        server = createServer((req, res) => {
          const url = new URL(req.url ?? "/", "http://127.0.0.1");
          if (url.pathname !== "/callback") return void res.writeHead(404).end();
          const done = (ok: boolean, msg: CallbackKey) => {
            res.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
            res.end(page(ok, msg));
          };
          if (url.searchParams.get("state") !== state) {
            done(false, "backend.oauth.invalid");
            return; // ignore forged/stale redirects, keep waiting for the real one
          }
          if (settled) return void res.writeHead(409).end();
          settled = true;
          const error = url.searchParams.get("error");
          if (error) {
            done(false, "backend.oauth.denied");
            reject(new ProviderError(error === "access_denied" ? L("errors.google.denied") : L("errors.google.invalidResponse"), false));
            return;
          }
          const authorizationCode = url.searchParams.get("code");
          if (!authorizationCode?.trim() || url.searchParams.getAll("code").length !== 1) {
            done(false, "backend.oauth.invalid");
            reject(new ProviderError(L("errors.google.invalidResponse"), false));
            return;
          }
          done(true, "backend.oauth.back");
          const port = (server!.address() as AddressInfo).port;
          resolve({ code: authorizationCode, redirectUri: `http://127.0.0.1:${port}/callback` });
        });
        server.on("error", reject);
        server.listen(0, "127.0.0.1", () => {
          if (flow.signal.aborted) return;
          const port = (server!.address() as AddressInfo).port;
          const params = new URLSearchParams({
            client_id: options.clientId,
            redirect_uri: `http://127.0.0.1:${port}/callback`,
            response_type: "code",
            scope: requestedScopes.join(" "),
            code_challenge: challenge,
            code_challenge_method: "S256",
            state,
            access_type: "offline",
            prompt: "consent",
          });
          if (options.loginHint) params.set("login_hint", options.loginHint);
          void Promise.resolve().then(() => options.openExternal(`${ep.auth}?${params}`)).catch(reject);
        });
      }));
      const body = new URLSearchParams({ client_id: options.clientId, code: code.code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: code.redirectUri });
      if (options.clientSecret) body.set("client_secret", options.clientSecret);
      const tokens = await flow.json(ep.token, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
      if (typeof tokens.access_token !== "string" || !/^[\x21-\x7e]+$/.test(tokens.access_token) ||
        typeof tokens.refresh_token !== "string" || !/^[\x21-\x7e]+$/.test(tokens.refresh_token) ||
        typeof tokens.token_type !== "string" || tokens.token_type.toLowerCase() !== "bearer" ||
        (tokens.expires_in !== undefined && (typeof tokens.expires_in !== "number" || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0)) ||
        (tokens.scope !== undefined && typeof tokens.scope !== "string")) throw new ProviderError(L("errors.google.invalidResponse"), false);
      const grantedScopes = tokens.scope === undefined ? requestedScopes : tokens.scope.split(/\s+/).filter(Boolean);
      if (!grantedScopes.includes("https://www.googleapis.com/auth/gmail.modify") && !grantedScopes.includes("https://mail.google.com/")) throw new ProviderError(L("errors.google.mailScopeRequired"), false);
      const identity = await readGoogleIdentity(tokens.access_token, ep, flow);
      return { ...identity, refreshToken: tokens.refresh_token, grantedScopes };
    } finally {
      const listener = server as Server | null;
      if (listener) {
        listener.closeAllConnections();
        await new Promise<void>((resolve) => listener.close(() => resolve()));
      }
    }
  });
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
        if (!refreshToken) throw new ProviderAuthError(L("errors.gmail.reconnect"));
        const clientId = (await store.setting<{ gmailClientId?: string }>("app"))?.gmailClientId;
        const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId ?? "" });
        const secret = await ctx.getAppSecret("gmailClientSecret").catch(() => null);
        if (secret) body.set("client_secret", secret);
        let res: Response;
        try {
          // once an hour: a refresh on a dead socket gives up in 30 s instead of undici's 5 minutes (plan 20)
          res = await netFetch(ep.token, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(30_000) });
        } catch (e) {
          throw ProviderError.network(L("errors.gmail.refreshOffline", { detail: e instanceof Error ? e.message : String(e) }));
        }
        let json: { access_token?: string; expires_in?: number; error?: string };
        try {
          const value: unknown = await res.json();
          json = value !== null && typeof value === "object" && !Array.isArray(value) ? value as typeof json : {};
        } catch (e) {
          // an answer whose body never arrived (the deadline, a dead socket) is the network, never a refusal
          if (isFetchNetworkFailure(e)) throw ProviderError.network(L("errors.gmail.refreshOffline", { detail: e instanceof Error ? e.message : String(e) }));
          json = {};
        }
        if (res.status === 400 && json.error === "invalid_grant") throw new ProviderAuthError(L("errors.gmail.revoked"));
        if (!res.ok || !json.access_token) throw Object.assign(new ProviderError(L("errors.gmail.refreshFailed", { status: res.status }), res.status === 429 || res.status >= 500), { status: res.status });
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
      invalidate: (token) => {
        if (access?.token === token) access = null;
      },
    },
    buildRaw: (payload) => buildRaw(payload, { keepBcc: true }),
  });
}
