import { L } from "@terno/i18n";
import { isFetchNetworkFailure, RequestNotDispatchedError } from "./net-errors";
import { ProviderAuthError, ProviderError, type GoogleRequests, type RequestRun, type HttpResponseEvidence } from "./types";
import { captureHttpResponseEvidence } from "./http-response-evidence";

export interface GmailRefreshExchange {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshAt: number;
  /** Absent scope retains the existing grant; a supplied scope must prove mail access. */
  grantedScopes?: string[];
}

const invalid = () => new ProviderError(L("errors.gmail.invalidResponse"), false);
const networkFailure = () => ProviderError.network(L("errors.network.offline"));
const statusFailure = (status: number, httpResponse?: HttpResponseEvidence) => Object.assign(new ProviderError(L("errors.gmail.refreshFailed", { status }), status === 429 || status >= 500, false, false, httpResponse), { status });
const token = (value: unknown): value is string => typeof value === "string" && value.length <= 4096 && /^[\x21-\x7e]+$/.test(value);

/** A refresh exchange only: the caller owns durable credential replacement before access publication. */
export async function exchangeGmailRefresh(options: {
  fetch: typeof fetch;
  google?: GoogleRequests;
  run?: RequestRun;
  generation?: number;
  url: string;
  clientId: string;
  clientSecret: string | null;
  refreshToken: string;
  signal?: AbortSignal;
}): Promise<GmailRefreshExchange> {
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
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: options.refreshToken, client_id: options.clientId });
    if (options.clientSecret) body.set("client_secret", options.clientSecret);
    const init = { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, signal };
    const dispatched = options.google ? options.google.request({ request: { endpoint: "oauth-token", purpose: "refresh" }, run: options.run, generation: options.generation ?? options.google.generation(), onHeaders: (status, evidence) => { responseStatus = status; httpResponse = evidence; } }, options.url, init) : options.fetch(options.url, init);
    const response = await wait(dispatched.then((res) => {
      if (signal.aborted) {
        void res.body?.cancel().catch(() => {});
        throw signal.reason;
      }
      if (!res.ok && !httpResponse) httpResponse = captureHttpResponseEvidence(res, { endpoint: "oauth-token", purpose: "refresh" }, Date.now());
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
    if (response.status === 400 && value.error === "invalid_grant") throw new ProviderAuthError(L("errors.gmail.revoked"), httpResponse);
    if (!response.ok) throw statusFailure(response.status, httpResponse);
    if (!token(value.access_token) ||
      (Object.hasOwn(value, "refresh_token") && !token(value.refresh_token)) ||
      typeof value.token_type !== "string" || value.token_type.toLowerCase() !== "bearer" ||
      typeof value.expires_in !== "number" || !Number.isFinite(value.expires_in) || value.expires_in <= 0 ||
      (Object.hasOwn(value, "scope") && typeof value.scope !== "string")) throw invalid();
    const duration = value.expires_in * 1000;
    const expiresAt = receivedAt + duration;
    if (!Number.isFinite(duration) || duration > Number.MAX_SAFE_INTEGER || !Number.isFinite(expiresAt) || expiresAt > Number.MAX_SAFE_INTEGER || expiresAt <= receivedAt) throw invalid();
    const grantedScopes = typeof value.scope === "string" ? value.scope.split(/\s+/).filter(Boolean) : undefined;
    if (grantedScopes && !grantedScopes.includes("https://www.googleapis.com/auth/gmail.modify") && !grantedScopes.includes("https://mail.google.com/")) throw invalid();
    return {
      accessToken: value.access_token,
      refreshToken: typeof value.refresh_token === "string" ? value.refresh_token : options.refreshToken,
      expiresAt,
      refreshAt: expiresAt - Math.min(60_000, duration / 10),
      grantedScopes,
    };
  } catch (error) {
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
