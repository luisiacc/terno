import { isValidEmail } from "@terno/core";
import { L } from "@terno/i18n";
import { GMAIL_UNITS_PER_SECOND } from "./gmail-quota";
import { createGmailApiProvider, isRateLimit, GOOGLE_ENDPOINTS, type GmailEndpoints } from "./gmail-api";
import { buildRawPortable } from "./compose-portable";
import { ProviderAuthError, ProviderError, type AccountRequests, type GmailTokenBroker, type HttpRequestContext, type HttpResponseEvidence, type MailProvider, type ProviderContext } from "./types";
import { readResponseText } from "./http-body";
import { captureHttpResponseEvidence } from "./http-response-evidence";
import { readJsonObject, withSignIn, type SignInFlow, type SignInWords } from "./oauth-flow";

interface GoogleSignInFlow extends SignInFlow {
  json(url: string, init?: RequestInit, httpContext?: HttpRequestContext): Promise<Record<string, unknown>>;
}

const GOOGLE_SIGN_IN: SignInWords = {
  cancelled: () => L("errors.google.cancelled"),
  timedOut: () => L("errors.google.timedOut"),
  unavailable: () => L("errors.google.unavailable"),
};

/** Plan 259: the shared sign-in flow (oauth-flow.ts) with Google's words, its request policy and its quota answer. */
export async function withGoogleSignIn<T>(options: { signal?: AbortSignal; timeoutMs?: number; fetch: typeof fetch; google?: Pick<AccountRequests, "request"> }, run: (flow: GoogleSignInFlow) => Promise<T>): Promise<T> {
  return withSignIn({ signal: options.signal, timeoutMs: options.timeoutMs, words: GOOGLE_SIGN_IN, keep: (error) => error instanceof ProviderError && error.i18n?.key === "errors.google.quota" }, (flow) => {
    const { signal, wait } = flow;
    const json = async (url: string, init?: RequestInit, httpContext: HttpRequestContext = { endpoint: "unknown", purpose: "unknown" }): Promise<Record<string, unknown>> => {
      signal.throwIfAborted();
      let httpResponse: HttpResponseEvidence | undefined;
      let settleForbidden: ((kind: "quota" | "policy" | "none") => Promise<void>) | undefined;
      const wire = { ...init, signal };
      const response = await wait((options.google ? options.google.request({ request: httpContext, onForbidden: (settle) => {
        if (signal.aborted) void settle("none");
        else settleForbidden = settle;
      } }, url, wire) : options.fetch(url, wire)).then((res) => {
        if (signal.aborted) {
          void res.body?.cancel().catch(() => {});
          throw signal.reason;
        }
        if (!res.ok) httpResponse = captureHttpResponseEvidence(res, httpContext, Date.now());
        return res;
      })).catch(async (error: unknown) => {
        await settleForbidden?.("none");
        throw error;
      });
      if (!response.ok) {
        // Only a bounded, structured Google quota reason can turn 403 into quota admission.
        let quota = response.status === 429;
        try {
          const text = await wait(readResponseText(response, 65_536, signal)).catch(() => "");
          quota ||= response.status === 403 && !signal.aborted && isRateLimit(text);
        } finally {
          // Logical sign-in can end while the coordinator still owns the durable ticket.
          if (settleForbidden) await wait(settleForbidden(quota && !signal.aborted ? "quota" : "none"));
        }
        throw new ProviderError(quota ? L("errors.google.quota") : L("errors.google.signInFailed", { detail: response.status }), quota || response.status >= 500, false, false, httpResponse);
      }
      return readJsonObject(response, flow, () => new ProviderError(L("errors.google.invalidResponse"), false));
    };
    return run({ ...flow, json });
  });
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

export async function inspectGmailToken(accessToken: string, netFetch: typeof fetch, options: { signal?: AbortSignal; timeoutMs?: number; endpoints?: Partial<GmailEndpoints>; google?: Pick<AccountRequests, "request"> } = {}) {
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
    inspect: (accessToken, netFetch, options?: { signal?: AbortSignal; timeoutMs?: number; google?: Pick<AccountRequests, "request"> }) => inspectGmailToken(accessToken, netFetch, { ...options, endpoints: o.endpoints }),
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
        unitsPerSecond: GMAIL_UNITS_PER_SECOND,
        tokens: {
          async get() {
            const t = tokens.get(id);
            // ops wait for the user (no attempts spent) and resume when the account is reconnected
            if (!t || t.expiresAt - 60_000 <= now()) {
              // plan 184: said where it's found, since a caller may carry on without it
              const error = new ProviderAuthError(gmailReconnect());
              ctx.refused?.(error);
              throw error;
            }
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
