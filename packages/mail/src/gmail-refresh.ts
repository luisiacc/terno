import { L } from "@terno/i18n";
import { exchangeOAuthRefresh, type OAuthRefreshExchange } from "./oauth-refresh";
import { ProviderAuthError, ProviderError, type AccountRequests, type RequestRun, type MailAdmission } from "./types";

export type GmailRefreshExchange = OAuthRefreshExchange;

/** A refresh exchange only: the caller owns durable credential replacement before access publication. */
export async function exchangeGmailRefresh(options: {
  fetch: typeof fetch;
  google?: AccountRequests;
  run?: RequestRun;
  generation?: number;
  admission?: MailAdmission;
  url: string;
  clientId: string;
  clientSecret: string | null;
  refreshToken: string;
  signal?: AbortSignal;
}): Promise<GmailRefreshExchange> {
  const { google, ...rest } = options;
  return exchangeOAuthRefresh({ ...rest, requests: google }, {
    request: { endpoint: "oauth-token", purpose: "refresh" },
    // plan 293: Google's "the refresh token has expired or been revoked" (RFC 6749 §5.2): that token is dead
    refused: (status, body, evidence) => status === 400 && body.error === "invalid_grant" ? new ProviderAuthError(L("errors.gmail.revoked"), evidence, { grantRejected: true }) : null,
    // plan 184: a grant without mail (granular consent) is renewed by signing in again, not a bad response
    scopes: (granted) => !granted.includes("https://www.googleapis.com/auth/gmail.modify") && !granted.includes("https://mail.google.com/") ? new ProviderAuthError(L("errors.gmail.permissionRequired")) : null,
    invalid: () => new ProviderError(L("errors.gmail.invalidResponse"), false),
    failed: (status) => L("errors.gmail.refreshFailed", { status }),
  });
}
