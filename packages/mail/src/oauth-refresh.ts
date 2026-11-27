// Plan 259: one refresh-token exchange at a provider's token endpoint (lifted out of exchangeGmailRefresh). Bounded
// time and body; error bodies never turn a quota or server status into a refusal; the provider names its refusals,
// its scope check and its words. The caller owns durable credential replacement before publishing the access token.
import { signInLog } from "./login-log";
import { isFetchNetworkFailure, RequestNotDispatchedError } from "./net-errors";
import { L } from "@terno/i18n";
import { oauthToken } from "./oauth-flow";
import { ProviderError, type AccountRequests, type HttpRequestContext, type HttpResponseEvidence, type MailAdmission, type ProviderAuthError, type RequestRun } from "./types";
import { captureHttpResponseEvidence } from "./http-response-evidence";

export interface OAuthRefreshExchange {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshAt: number;
  /** Absent scope retains the existing grant; a supplied scope must prove mail access. */
  grantedScopes?: string[];
}

export interface OAuthRefreshOptions {
  fetch: typeof fetch;
  /** the account's request policy (absent: plain fetch) */
  requests?: AccountRequests;
  run?: RequestRun;
  generation?: number;
  admission?: MailAdmission;
  url: string;
  clientId: string;
  clientSecret: string | null;
  refreshToken: string;
  signal?: AbortSignal;
}

/** What differs per provider: its token endpoint's context, extra form fields, refusals, scope check and words. */
export interface OAuthRefreshProvider {
  request: HttpRequestContext;
  /** form fields beside grant_type, refresh_token, client_id (Microsoft's scope) */
  params?: Record<string, string>;
  /** an answer that means the grant is gone (sign in again), or null */
  refused(status: number, body: Record<string, unknown>, evidence?: HttpResponseEvidence): ProviderAuthError | null;
  /** a supplied scope without mail: sign in again (plan 184), or null */
  scopes(granted: string[]): ProviderAuthError | null;
  invalid(): ProviderError;
  failed(status: number): ReturnType<typeof L>;
}

export async function exchangeOAuthRefresh(options: OAuthRefreshOptions, provider: OAuthRefreshProvider): Promise<OAuthRefreshExchange> {
  // plan 293 (CASA 6.5.1): the request and its answer are logged, every secret value redacted
  const logged = provider.request.endpoint === "microsoft-token" ? "microsoft" : "google";
  const invalid = provider.invalid;
  const networkFailure = () => ProviderError.network(L("errors.network.offline"));
  const statusFailure = (status: number, httpResponse?: HttpResponseEvidence) => Object.assign(new ProviderError(provider.failed(status), status === 429 || status >= 500, false, false, httpResponse), { status });
  const controller = new AbortController();
  const signal = controller.signal;
  const cancel = () => controller.abort(new DOMException("closed", "AbortError"));
  const timer = setTimeout(() => controller.abort(networkFailure()), 30_000);
  let responseStatus: number | undefined;
  let httpResponse: HttpResponseEvidence | undefined;
  if (options.signal?.aborted) cancel();
  else options.signal?.addEventListener("abort", cancel, { once: true });
  const wait = async <T,>(work: Promise<T>): Promise<T> => {
    let stop: (() => void) | undefined;
    try {
      return await Promise.race([work, new Promise<never>((_resolve, reject) => {
        stop = () => reject(signal.reason);
        if (signal.aborted) stop();
        else signal.addEventListener("abort", stop, { once: true });
      })]);
    } finally {
      if (stop) signal.removeEventListener("abort", stop);
    }
  };
  try {
    signal.throwIfAborted();
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: options.refreshToken, client_id: options.clientId, ...provider.params });
    if (options.clientSecret) body.set("client_secret", options.clientSecret);
    // the form carries the refresh token: a redirect would replay it to wherever it points (Codex code review #3)
    const init: RequestInit = { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, redirect: "error", signal };
    const dispatched = options.requests ? options.requests.request({ request: provider.request, admission: options.admission, run: options.run, generation: options.generation ?? options.requests.generation(), onHeaders: (status, evidence) => { responseStatus = status; httpResponse = evidence; } }, options.url, init) : options.fetch(options.url, init);
    const response = await wait(dispatched.then((res) => {
      if (signal.aborted) {
        void res.body?.cancel().catch(() => {});
        throw signal.reason;
      }
      if (!res.ok && !httpResponse) httpResponse = captureHttpResponseEvidence(res, provider.request, Date.now());
      return res;
    }));
    const receivedAt = Date.now();
    responseStatus = response.status;
    let value: Record<string, unknown>;
    try {
      const reader = response.body?.getReader();
      if (!reader) throw invalid();
      let complete = false;
      try {
        const decoder = new TextDecoder("utf-8", { fatal: true });
        const parts: string[] = [];
        let size = 0;
        while (true) {
          const chunk = await wait(reader.read());
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 65_536) throw invalid();
          parts.push(decoder.decode(chunk.value, { stream: true }));
        }
        complete = true;
        parts.push(decoder.decode());
        let parsed: unknown;
        try { parsed = JSON.parse(parts.join("")); } catch { throw invalid(); }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalid();
        value = parsed as Record<string, unknown>;
      } finally {
        if (!complete) void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    } catch (error) {
      // Error bodies cannot turn a quota/server status into a permanent failure or a grant refusal.
      if (!response.ok) throw statusFailure(response.status, httpResponse);
      if (signal.aborted) throw signal.reason;
      if (error instanceof ProviderError) throw error;
      if (isFetchNetworkFailure(error)) throw networkFailure();
      throw invalid();
    }
    signal.throwIfAborted();
    const refusal = provider.refused(response.status, value, httpResponse);
    if (refusal) throw refusal;
    if (!response.ok) throw statusFailure(response.status, httpResponse);
    if (!oauthToken(value.access_token) ||
      (Object.hasOwn(value, "refresh_token") && !oauthToken(value.refresh_token)) ||
      typeof value.token_type !== "string" || value.token_type.toLowerCase() !== "bearer" ||
      typeof value.expires_in !== "number" || !Number.isFinite(value.expires_in) || value.expires_in <= 0 ||
      (Object.hasOwn(value, "scope") && typeof value.scope !== "string")) throw invalid();
    const duration = value.expires_in * 1000;
    const expiresAt = receivedAt + duration;
    if (!Number.isFinite(duration) || duration > Number.MAX_SAFE_INTEGER || !Number.isFinite(expiresAt) || expiresAt > Number.MAX_SAFE_INTEGER || expiresAt <= receivedAt) throw invalid();
    const grantedScopes = typeof value.scope === "string" ? value.scope.split(/\s+/).filter(Boolean) : undefined;
    signInLog.refresh(logged, options.url, { tokens: value, status: response.status });
    const withoutMail = grantedScopes && provider.scopes(grantedScopes);
    if (withoutMail) throw withoutMail;
    return {
      accessToken: value.access_token,
      refreshToken: typeof value.refresh_token === "string" ? value.refresh_token : options.refreshToken,
      expiresAt,
      refreshAt: expiresAt - Math.min(60_000, duration / 10),
      grantedScopes,
    };
  } catch (error) {
    if (!options.signal?.aborted && !(error instanceof RequestNotDispatchedError)) signInLog.refresh(logged, options.url, { error: { status: responseStatus } });
    if (responseStatus === 429) throw statusFailure(429, httpResponse);
    if (options.signal?.aborted) throw new DOMException("closed", "AbortError");
    if (signal.aborted && responseStatus !== undefined && responseStatus >= 400) throw statusFailure(responseStatus, httpResponse);
    if (signal.aborted) throw signal.reason;
    if (error instanceof RequestNotDispatchedError || error instanceof ProviderError) throw error;
    throw isFetchNetworkFailure(error) ? networkFailure() : new ProviderError(L("errors.network.offline"), true);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
  }
}
