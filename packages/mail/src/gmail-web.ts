import { isValidEmail } from "@terno/core";
import { L } from "@terno/i18n";
import { createGmailApiProvider, GOOGLE_ENDPOINTS, type GmailEndpoints } from "./gmail-api";
import { buildRawPortable } from "./compose-portable";
import { ProviderAuthError, ProviderError, type GmailTokenBroker, type HttpRequestContext, type HttpResponseEvidence, type MailProvider, type ProviderContext } from "./types";
import { captureHttpResponseEvidence } from "./http-response-evidence";

interface GoogleSignInFlow {
  signal: AbortSignal;
  wait<T>(work: Promise<T>): Promise<T>;
  json(url: string, init?: RequestInit, httpContext?: HttpRequestContext): Promise<Record<string, unknown>>;
}

/** One deadline covers headers and bodies, including fetch implementations that ignore abort. */
export async function withGoogleSignIn<T>(options: { signal?: AbortSignal; timeoutMs?: number; fetch: typeof fetch }, run: (flow: GoogleSignInFlow) => Promise<T>): Promise<T> {
  const abort = new AbortController();
  const cancel = () => abort.abort(new ProviderError(L("errors.google.cancelled"), false));
  const timer = setTimeout(() => abort.abort(new ProviderError(L("errors.google.timedOut"), false)), options.timeoutMs ?? 30_000);
  if (options.signal?.aborted) cancel();
  else options.signal?.addEventListener("abort", cancel, { once: true });
  const signal = abort.signal;
  const wait = async <V,>(work: Promise<V>): Promise<V> => {
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
  const json = async (url: string, init?: RequestInit, httpContext: HttpRequestContext = { endpoint: "unknown", purpose: "unknown" }): Promise<Record<string, unknown>> => {
    signal.throwIfAborted();
    let httpResponse: HttpResponseEvidence | undefined;
    const response = await wait(options.fetch(url, { ...init, signal }).then((res) => {
      if (signal.aborted) {
        void res.body?.cancel().catch(() => {});
        throw signal.reason;
      }
      if (!res.ok) httpResponse = captureHttpResponseEvidence(res, httpContext, Date.now());
      return res;
    }));
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new ProviderError(L("errors.google.signInFailed", { detail: response.status }), response.status === 429 || response.status >= 500, false, false, httpResponse);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new ProviderError(L("errors.google.invalidResponse"), false);
    let complete = false;
    try {
      const decoder = new TextDecoder();
      const parts: string[] = [];
      let size = 0;
      while (true) {
        const chunk = await wait(reader.read());
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 65_536) throw new ProviderError(L("errors.google.invalidResponse"), false);
        parts.push(decoder.decode(chunk.value, { stream: true }));
      }
      complete = true;
      parts.push(decoder.decode());
      let value: unknown;
      try { value = JSON.parse(parts.join("")); } catch { throw new ProviderError(L("errors.google.invalidResponse"), false); }
      if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ProviderError(L("errors.google.invalidResponse"), false);
      return value as Record<string, unknown>;
    } finally {
      if (!complete) void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  };
  try {
    signal.throwIfAborted();
    const result = await run({ signal, wait, json });
    signal.throwIfAborted();
    return result;
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(L("errors.google.unavailable"), true);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
  }
}

/** Gmail proves the mailbox; userinfo supplies stable owner evidence for that same token. */
export async function readGoogleIdentity(accessToken: string, ep: GmailEndpoints, flow: GoogleSignInFlow): Promise<Omit<import("./types").GmailConnectResult, "refreshToken">> {
  if (typeof accessToken !== "string" || !/^[\x21-\x7e]+$/.test(accessToken)) throw new ProviderError(L("errors.google.invalidResponse"), false);
  const auth = { authorization: `Bearer ${accessToken}` };
  const profile = await flow.json(`${ep.api}/profile`, { headers: auth }, { endpoint: "gmail-api", purpose: "identity-proof" });
  const email = profile.emailAddress;
  if (typeof email !== "string" || email.length > 254 || (!isValidEmail(email) || /\p{Cc}/u.test(email))) throw new ProviderError(L("errors.google.invalidResponse"), false);
  const info = await flow.json(ep.userinfo, { headers: auth }, { endpoint: "google-userinfo", purpose: "identity-proof" });
  if (typeof info.sub !== "string" || !info.sub || info.sub.length > 255 || /[\s\p{Cc}]/u.test(info.sub) ||
    (info.name !== undefined && typeof info.name !== "string") ||
    (info.email_verified !== undefined && typeof info.email_verified !== "boolean") ||
    (info.email !== undefined && (typeof info.email !== "string" || info.email.toLowerCase() !== email.toLowerCase()))) throw new ProviderError(L("errors.google.invalidResponse"), false);
  return { email, name: (info.name ?? "") as string, sub: info.sub, emailVerified: info.email_verified === true };
}

export async function inspectGmailToken(accessToken: string, netFetch: typeof fetch, options: { signal?: AbortSignal; timeoutMs?: number; endpoints?: Partial<GmailEndpoints> } = {}) {
  return withGoogleSignIn({ ...options, fetch: netFetch }, (flow) => readGoogleIdentity(accessToken, { ...GOOGLE_ENDPOINTS, ...options.endpoints }, flow));
}

/** What a web Gmail account shows when its hour-long token is gone (after a reload or an hour). */
export const gmailReconnect = () => L("errors.gmail.reconnectWeb");

/**
 * Google's token model for the browser (no server, so no refresh token):
 * the page gets a 1-hour access token from Google Identity Services with
 * the user's client ID; it lives only in this worker's memory, per account.
 * Without one, sync and ops wait (retryable) behind "Reconnect Gmail".
 */
export function createGmailTokenBroker(o: { endpoints?: Partial<GmailEndpoints>; now?: () => number } = {}): GmailTokenBroker & { provider(ctx: ProviderContext): MailProvider } {
  const now = o.now ?? Date.now;
  const tokens = new Map<number, { token: string; expiresAt: number }>();
  return {
    inspect: (accessToken, netFetch, options?: { signal?: AbortSignal; timeoutMs?: number }) => inspectGmailToken(accessToken, netFetch, { ...options, endpoints: o.endpoints }),
    set(accountId, accessToken, expiresAt) {
      tokens.set(accountId, { token: accessToken, expiresAt });
    },
    forget(accountId) {
      tokens.delete(accountId);
    },
    provider(ctx) {
      const id = ctx.account.id;
      return createGmailApiProvider(ctx, {
        endpoints: o.endpoints,
        tokens: {
          async get() {
            const t = tokens.get(id);
            // ops wait for the user (no attempts spent) and resume when the account is reconnected
            if (!t || t.expiresAt - 60_000 <= now()) throw new ProviderAuthError(gmailReconnect());
            return t.token;
          },
          invalidate: (token) => {
            if (tokens.get(id)?.token === token) tokens.delete(id);
          },
        },
        buildRaw: async (payload) => buildRawPortable(payload),
      });
    },
  };
}
