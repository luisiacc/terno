// Plan 259: the refresh-token session every OAuth provider keeps (lifted out of the Gmail provider). One single-flight
// refresh owns both the exchange and its durable result for every waiting operation; a rotated refresh token is
// written by CAS before its access token is published (plan 32), and nothing outlives the provider's lifetime.
import { L, type Localized } from "@terno/i18n";
import { RequestNotDispatchedError } from "./net-errors";
import { ProviderAuthError, ProviderError, type HttpRequestContext, type MailAdmission, type ProviderContext, type RequestRun } from "./types";

/** What one refresh exchange returns: the provider's token endpoint answered, its checks passed. */
export interface OAuthExchange {
  accessToken: string;
  /** the refresh token to keep (a provider that rotates sends a new one; one that doesn't, the same) */
  refreshToken: string;
  expiresAt: number;
  /** when to refresh ahead of expiry */
  refreshAt: number;
}

export interface OAuthSessionOptions {
  /** the token endpoint's request context, checked before a refresh (its cooldowns, capacity) */
  token: HttpRequestContext;
  /** one exchange at the provider's token endpoint; `run.markDispatched` once the request has left */
  exchange(input: { refreshToken: string; clientId: string; clientSecret: string | null; signal: AbortSignal; generation: number; admission?: MailAdmission; run: Pick<RequestRun, "markDispatched"> }): Promise<OAuthExchange>;
  /** the provider's words: sign in again; the client record couldn't be read now; a token that expired while it was saved */
  messages: { reconnect: () => Localized; clientUnread: () => Localized; stale: () => Localized };
}

export interface OAuthSession {
  /** a live access token: the current one, or a refresh shared by every caller waiting for it */
  get(run?: RequestRun, admission?: MailAdmission): Promise<string>;
  /** the server refused this token: the next demand refreshes */
  invalidate(token: string): void;
  /** ends the lifetime: a refresh in flight settles as closed and nothing is published after */
  close(): void;
}

export function createOAuthSession(ctx: ProviderContext, options: OAuthSessionOptions): OAuthSession {
  let access: OAuthExchange | null = null;
  let refreshing: Promise<string> | null = null;
  let candidate: { expected: string; exchange: OAuthExchange; uncertain: boolean } | null = null;
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
      // plan 293: the keychain refusing the rotated token keeps its one message (not "couldn't save")
      if (error instanceof ProviderError && error.secretFailure) throw error;
      if (error instanceof Error && error.name === "AbortError") throw new DOMException("closed", "AbortError");
      throw persistenceFailure();
    }
  }

  /** Plan 99: the client that issued the refresh token; not having one this build knows means signing in again, never a retry. */
  async function oauthClient(): Promise<{ clientId: string; clientSecret: string | null }> {
    // plan 123: only the backend knows Terno's clients; a context without them can't refresh
    if (!ctx.oauthClient) throw new ProviderAuthError(options.messages.reconnect());
    let client: { clientId: string; clientSecret: string | null } | null;
    try { client = await ctx.oauthClient(); } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      // plan 264: our own record couldn't be read just now (a store read): that says nothing of the grant, try again
      throw new ProviderError(options.messages.clientUnread(), true);
    }
    if (!client) throw new ProviderAuthError(options.messages.reconnect());
    return client;
  }

  const refreshRuns = new Set<RequestRun>();
  let refreshIssued = false;
  function refresh(run?: RequestRun, admission?: MailAdmission): Promise<string> {
    if (run) { refreshRuns.add(run); if (refreshIssued) run.markDispatched(); }
    refreshing ??= Promise.resolve().then(async () => {
      const generation = ctx.requests?.generation() ?? 0;
      try {
        assertOpen();
        if (!candidate) {
          ctx.requests?.tokenUnavailable();
          ctx.requests?.check(options.token, admission);
          const refreshToken = await ctx.getSecret("refreshToken");
          assertOpen();
          if (!refreshToken) throw new ProviderAuthError(options.messages.reconnect());
          const { clientId, clientSecret } = await oauthClient();
          assertOpen();
          const exchange = await options.exchange({ refreshToken, clientId, clientSecret, signal: lifetime.signal, generation, admission, run: { markDispatched: () => { refreshIssued = true; for (const owner of refreshRuns) owner.markDispatched(); } } });
          assertOpen();
          candidate = { expected: refreshToken, exchange, uncertain: false };
        }
        const pending = candidate;
        await persist(pending);
        assertOpen();
        // A delayed commit consumes token life. The next demand uses the now-durable credential.
        if (pending.exchange.expiresAt <= Date.now()) throw new ProviderError(options.messages.stale(), true);
        access = pending.exchange;
        ctx.requests?.accessAvailable();
        await ctx.tokenResult?.(generation);
        return access.accessToken;
      } catch (error) {
        assertOpen();
        // plan 293 (CASA 2.2.1): a dead grant leaves no access token behind; the context deletes the refresh token
        if (error instanceof ProviderAuthError && error.grantRejected) access = null;
        if (error instanceof ProviderAuthError) await ctx.tokenResult?.(generation, error);
        if (error instanceof ProviderError || error instanceof RequestNotDispatchedError) throw error;
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

  return {
    get: async (run, admission) => {
      assertOpen();
      return access && access.refreshAt > Date.now() ? access.accessToken : refresh(run, admission);
    },
    invalidate: (token) => {
      if (access?.accessToken === token) access = null;
    },
    close: () => {
      lifetime.abort(new DOMException("closed", "AbortError"));
      access = null;
      candidate = null;
      refreshing = null;
    },
  };
}
