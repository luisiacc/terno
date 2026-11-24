import { L } from "@terno/i18n";
import { GOOGLE_ENDPOINTS, type GmailEndpoints } from "./gmail-api";
import { exchangeGmailRefresh } from "./gmail-refresh";
import { readGoogleIdentity, withGoogleSignIn } from "./gmail-web";
import { ProviderError, type GmailRenewalOptions, type GmailRenewalProof } from "./types";

/** One cold grant and one cumulative network budget; returning the continuation preserves known rotation. */
export async function beginGmailRenewal(options: GmailRenewalOptions & { endpoints?: Partial<GmailEndpoints> }): Promise<GmailRenewalProof> {
  const ep = { ...GOOGLE_ENDPOINTS, ...options.endpoints };
  const deadline = Date.now() + 30_000;
  const grant = await exchangeGmailRefresh({ ...options, url: ep.token });
  const run = <T,>(signal: AbortSignal | undefined, work: Parameters<typeof withGoogleSignIn<T>>[1]) => {
    const remaining = Math.min(deadline, grant.expiresAt) - Date.now();
    if (remaining <= 0) return Promise.reject(new ProviderError(L("errors.google.timedOut"), true));
    return withGoogleSignIn({ fetch: options.fetch, signal: options.signal && signal ? AbortSignal.any([options.signal, signal]) : options.signal ?? signal, timeoutMs: remaining }, work);
  };
  return {
    scopeSource: grant.grantedScopes ? "refresh-response" : "resource-proof",
    grantedScopes: grant.grantedScopes,
    refreshToken: grant.refreshToken,
    expiresAt: grant.expiresAt,
    inspect: (signal) => run(signal, (flow) => readGoogleIdentity(grant.accessToken, ep, flow)),
  };
}
