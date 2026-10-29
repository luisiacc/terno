import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DEFAULT_LOCALE, L, LOCALE_IDS, LOCALES } from "@terno/i18n";
import { buildRaw } from "./compose";
import { readGoogleIdentity, withGoogleSignIn } from "./gmail-web";
import { exchangeGmailRefresh, type GmailRefreshExchange } from "./gmail-refresh";
import { createGmailApiProvider, GMAIL_SCOPES as SCOPES, GOOGLE_ENDPOINTS, type GmailEndpoints } from "./gmail-api";
import { ProviderAuthError, ProviderError, type GmailConnectResult, type MailProvider, type ProviderContext, type RequestRun } from "./types";

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
  /** Only an existing-account caller that will prove the stored grant may accept true wire omission. */
  allowOmittedRefreshToken?: boolean;
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
      const tokens = await flow.json(ep.token, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }, { endpoint: "oauth-token", purpose: "authorization-code" });
      if (typeof tokens.access_token !== "string" || tokens.access_token.length > 4096 || !/^[\x21-\x7e]+$/.test(tokens.access_token) ||
        (Object.hasOwn(tokens, "refresh_token") ? (typeof tokens.refresh_token !== "string" || tokens.refresh_token.length > 4096 || !/^[\x21-\x7e]+$/.test(tokens.refresh_token)) : !options.allowOmittedRefreshToken) ||
        typeof tokens.token_type !== "string" || tokens.token_type.toLowerCase() !== "bearer" ||
        (tokens.expires_in !== undefined && (typeof tokens.expires_in !== "number" || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0)) ||
        (tokens.scope !== undefined && typeof tokens.scope !== "string")) throw new ProviderError(L("errors.google.invalidResponse"), false);
      const grantedScopes = tokens.scope === undefined ? requestedScopes : tokens.scope.split(/\s+/).filter(Boolean);
      if (!grantedScopes.includes("https://www.googleapis.com/auth/gmail.modify") && !grantedScopes.includes("https://mail.google.com/")) throw new ProviderError(L("errors.google.mailScopeRequired"), false);
      const identity = await readGoogleIdentity(tokens.access_token, ep, flow);
      return { ...identity, refreshToken: (tokens.refresh_token as string | undefined) ?? null, grantedScopes };
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
  let access: GmailRefreshExchange | null = null;
  let refreshing: Promise<string> | null = null;
  let candidate: { expected: string; exchange: GmailRefreshExchange; uncertain: boolean } | null = null;
  const lifetime = new AbortController();
  const assertOpen = () => { lifetime.signal.throwIfAborted(); };
  const persistenceFailure = () => new ProviderError(L("errors.secret.replaceFailed"), true);

  async function persist(pending: NonNullable<typeof candidate>): Promise<void> {
    assertOpen();
    try {
      // A failed acknowledgement may already have committed. Assert ownership before retrying old bytes.
      let committed = pending.uncertain && await ctx.replaceSecret("refreshToken", pending.exchange.refreshToken, pending.exchange.refreshToken);
      assertOpen();
      if (!committed) committed = await ctx.replaceSecret("refreshToken", pending.expected, pending.exchange.refreshToken);
      assertOpen();
      if (!committed) {
        candidate = null;
        throw persistenceFailure();
      }
      candidate = null;
    } catch (error) {
      assertOpen();
      if (candidate === pending) pending.uncertain = true;
      if (error instanceof ProviderAuthError) throw error;
      if (error instanceof Error && error.name === "AbortError") throw new DOMException("closed", "AbortError");
      throw persistenceFailure();
    }
  }

  /** One promise owns both the exchange and its durable result for every waiting operation. */
  const refreshRuns = new Set<RequestRun>();
  let refreshIssued = false;
  function refresh(run?: RequestRun): Promise<string> {
    if (run) { refreshRuns.add(run); if (refreshIssued) run.markDispatched(); }
    refreshing ??= Promise.resolve().then(async () => {
      try {
        assertOpen();
        if (!candidate) {
          const generation = ctx.google?.generation();
          ctx.google?.tokenUnavailable();
          ctx.google?.check({ endpoint: "oauth-token", purpose: "refresh" });
          const refreshToken = await ctx.getSecret("refreshToken");
          assertOpen();
          if (!refreshToken) throw new ProviderAuthError(L("errors.gmail.reconnect"));
          const clientId = (await ctx.store.setting<{ gmailClientId?: string }>("app"))?.gmailClientId;
          const clientSecret = await ctx.getAppSecret("gmailClientSecret").catch(() => null);
          assertOpen();
          const exchange = await exchangeGmailRefresh({ fetch: ctx.fetch, url: ep.token, clientId: clientId ?? "", clientSecret, refreshToken, signal: lifetime.signal, google: ctx.google, generation, run: { markDispatched: () => { refreshIssued = true; for (const owner of refreshRuns) owner.markDispatched(); } } });
          assertOpen();
          candidate = { expected: refreshToken, exchange, uncertain: false };
        }
        const pending = candidate;
        await persist(pending);
        assertOpen();
        // A delayed commit consumes token life. The next demand uses the now-durable credential.
        if (pending.exchange.expiresAt <= Date.now()) throw new ProviderError(L("errors.gmail.refreshFailed", { status: 200 }), true);
        access = pending.exchange;
        ctx.google?.accessAvailable();
        return access.accessToken;
      } catch (error) {
        assertOpen();
        if (error instanceof ProviderError) throw error;
        if (error instanceof Error && error.name === "AbortError") {
          candidate = null;
          throw new DOMException("closed", "AbortError");
        }
        throw persistenceFailure();
      } finally {
        refreshRuns.clear(); refreshIssued = false;
        refreshing = null;
      }
    });
    return refreshing;
  }

  const provider = createGmailApiProvider(ctx, {
    endpoints: options.endpoints,
    tokens: {
      get: async (run) => {
        assertOpen();
        return access && access.refreshAt > Date.now() ? access.accessToken : refresh(run);
      },
      invalidate: (token) => {
        if (access?.accessToken === token) access = null;
      },
    },
    buildRaw: (payload) => buildRaw(payload, { keepBcc: true }),
  });
  const close = provider.close.bind(provider);
  provider.close = async () => {
    lifetime.abort(new DOMException("closed", "AbortError"));
    access = null;
    candidate = null;
    refreshing = null;
    await close();
  };
  return provider;
}
