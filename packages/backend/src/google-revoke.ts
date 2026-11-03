/**
 * Plan 125: removing a Gmail account withdraws Terno's grant at Google (desktop), after the local removal, which never
 * waits on it or fails because of it. Revoking ends the user's authorization for every Terno client in the Cloud
 * project, so Terno elsewhere has to sign in again; the remove dialog says so. The web can't (no CORS on Google's
 * endpoint): its dialog points to Google's page instead.
 */
import type { GmailAccountConfig } from "@terno/mail";
import type { BackendCore as Backend } from "./core";

const REVOKE_TIMEOUT_MS = 5_000;
/** revokes still running: a new Google sign-in waits for them, or the late revoke would end the grant it just made */
const running = new WeakMap<Backend, Set<Promise<unknown>>>();

/**
 * The token to revoke, read after dropAccount (its sign-ins and renewals are over, and their writes drained, so
 * nothing replaces it any more) and before the secrets go. undefined: nothing to try (a registry without revoke, a
 * demo account, no saved token); null: a saved one that can't be opened (sealed, or the keychain refused).
 */
export async function googleGrantOf(b: Backend, accountId: number): Promise<string | null | undefined> {
  if (!b.options.providers.revokeGoogle) return undefined;
  const saved = await b.store.accounts.config<GmailAccountConfig & { demo?: boolean }>(accountId).catch(() => null);
  if (!saved || saved.config.demo) return undefined;
  try {
    return (await b.getSecret(`account:${accountId}:refreshToken`)) ?? undefined;
  } catch {
    return null;
  }
}

/** Bounded; offline or without a readable token it's "failed" at once, and the user is told to check at Google. */
export function withdrawGoogleGrant(b: Backend, token: string | null): Promise<"revoked" | "failed"> {
  const revoke = b.options.providers.revokeGoogle;
  if (!revoke || token === null || !b.connectivity.online) return Promise.resolve("failed");
  const done = revoke(token, b.net.fetchFor("mail"), AbortSignal.any([b.abort.signal, AbortSignal.timeout(REVOKE_TIMEOUT_MS)]));
  const set = running.get(b) ?? new Set();
  running.set(b, set);
  set.add(done);
  void done.finally(() => set.delete(done)).catch(() => {});
  return done;
}

/** Before a new Google consent: a removal's revoke still in flight finishes first (at most its timeout). */
export async function revokesSettled(b: Backend): Promise<void> {
  const set = running.get(b);
  if (set?.size) await Promise.allSettled(set);
}
