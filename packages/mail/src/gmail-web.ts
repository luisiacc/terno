import { L } from "@terno/i18n";
import { createGmailApiProvider, GOOGLE_ENDPOINTS, type GmailEndpoints } from "./gmail-api";
import { buildRawPortable } from "./compose-portable";
import { ProviderAuthError, ProviderError, type GmailTokenBroker, type MailProvider, type ProviderContext } from "./types";

/** What a web Gmail account shows when its hour-long token is gone (after a reload or an hour). */
export const GMAIL_RECONNECT = L("errors.gmail.reconnectWeb");

/**
 * Google's token model for the browser (no server, so no refresh token):
 * the page gets a 1-hour access token from Google Identity Services with
 * the user's client ID; it lives only in this worker's memory, per account.
 * Without one, sync and ops wait (retryable) behind "Reconectar Gmail".
 */
export function createGmailTokenBroker(o: { endpoints?: Partial<GmailEndpoints>; now?: () => number } = {}): GmailTokenBroker & { provider(ctx: ProviderContext): MailProvider } {
  const ep = { ...GOOGLE_ENDPOINTS, ...o.endpoints };
  const now = o.now ?? Date.now;
  const tokens = new Map<number, { token: string; expiresAt: number }>();
  return {
    async inspect(accessToken, netFetch) {
      const auth = { authorization: `Bearer ${accessToken}` };
      const res = await netFetch(`${ep.api}/profile`, { headers: auth });
      if (!res.ok) throw new ProviderError(res.status === 401 || res.status === 403 ? L("errors.gmail.accessRefused") : `Gmail API ${res.status}`, false);
      const profile = (await res.json()) as { emailAddress: string };
      const info = (await netFetch(ep.userinfo, { headers: auth })
        .then((r) => (r.ok ? r.json() : {}))
        .catch(() => ({}))) as { name?: string; sub?: string; email_verified?: boolean };
      return { email: profile.emailAddress, name: info.name ?? "", sub: info.sub ?? null, emailVerified: info.email_verified === true };
    },
    set(accountId, accessToken, expiresAt) {
      tokens.set(accountId, { token: accessToken, expiresAt });
    },
    provider(ctx) {
      const id = ctx.account.id;
      return createGmailApiProvider(ctx, {
        endpoints: o.endpoints,
        tokens: {
          async get() {
            const t = tokens.get(id);
            // ops wait for the user (no attempts spent) and resume when the account is reconnected
            if (!t || t.expiresAt - 60_000 <= now()) throw new ProviderAuthError(GMAIL_RECONNECT);
            return t.token;
          },
          invalidate: () => void tokens.delete(id),
        },
        buildRaw: async (payload) => buildRawPortable(payload),
      });
    },
  };
}
