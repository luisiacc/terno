/**
 * Plan 125: removing a Gmail account withdraws Terno's grant at Google (desktop), after the local removal, which never
 * waits on it or fails because of it. Revoking ends the user's authorization for every Terno client in the Cloud
 * project, so Terno elsewhere has to sign in again; the remove dialog says so. The web can't (no CORS on Google's
 * endpoint): its dialog points to Google's page instead.
 */
import type { GmailAccountConfig } from "@terno/mail";
import type { BackendCore as Backend } from "./core";

const REVOKE_TIMEOUT_MS = 5_000;

/**
 * Gmail removals in progress, from their first step to the end of their revoke: a new Google sign-in waits for them,
 * and one whose consent was already open when a removal of the same address began is refused (the revoke ends the
 * whole grant, the one it just made included). `seq` orders them; `recent` remembers the last few addresses.
 */
interface Removals { seq: number; running: Set<Promise<void>>; recent: { seq: number; email: string }[] }
const removals = new WeakMap<Backend, Removals>();
const removalsOf = (b: Backend): Removals => {
  let r = removals.get(b);
  if (!r) removals.set(b, (r = { seq: 0, running: new Set(), recent: [] }));
  return r;
};

/** A Gmail account's removal begins (before anything is deleted); `end` once its revoke is over, or it failed. */
export function beginGoogleRemoval(b: Backend, email: string): { end: () => void } {
  const r = removalsOf(b);
  r.recent.push({ seq: ++r.seq, email: email.toLowerCase() });
  if (r.recent.length > 20) r.recent.shift();
  let end!: () => void;
  const done = new Promise<void>((resolve) => (end = resolve));
  r.running.add(done);
  void done.then(() => r.running.delete(done));
  return { end };
}

/** Where removals stand now: a sign-in remembers it before opening Google's consent. */
export const removalMark = (b: Backend): number => removalsOf(b).seq;

/** A removal of this address began after `mark` (its revoke ends the grant this sign-in made). */
export const removedSince = (b: Backend, mark: number, email: string): boolean => removalsOf(b).recent.some((r) => r.seq > mark && r.email === email.toLowerCase());

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
  return revoke(token, b.net.fetchFor("mail"), AbortSignal.any([b.abort.signal, AbortSignal.timeout(REVOKE_TIMEOUT_MS)]));
}

/** Before a new Google consent: removals still running finish first (their revoke at most its timeout). */
export async function revokesSettled(b: Backend): Promise<void> {
  const { running } = removalsOf(b);
  if (running.size) await Promise.allSettled(running);
}
