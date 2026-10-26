import { L } from "@terno/i18n";
import { GOOGLE_ENDPOINTS, type GmailEndpoints } from "./gmail-api";
import { exchangeGmailRefresh } from "./gmail-refresh";
import { readGoogleIdentity, withGoogleSignIn } from "./gmail-web";
import { CONTACTS_SCOPE, OTHER_CONTACTS_SCOPE, PEOPLE_API } from "./google-photos";
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
    refreshToken: grant.refreshToken,
    expiresAt: grant.expiresAt,
    inspect: (signal) => run(signal, (flow) => readGoogleIdentity(grant.accessToken, ep, flow)),
    provePhotos: (scopes, signal) => run(signal, async (flow) => {
      const proved: string[] = [];
      for (const scope of scopes) {
        const path = scope === CONTACTS_SCOPE ? "people/me/connections?personFields=photos&pageSize=1" : scope === OTHER_CONTACTS_SCOPE ? "otherContacts?readMask=photos&pageSize=1" : null;
        if (!path || (grant.grantedScopes && !grant.grantedScopes.includes(scope))) throw new ProviderError(L("errors.google.invalidResponse"), false);
        await flow.json(`${PEOPLE_API}/${path}`, { headers: { authorization: `Bearer ${grant.accessToken}` } });
        proved.push(scope);
      }
      return proved;
    }),
  };
}
