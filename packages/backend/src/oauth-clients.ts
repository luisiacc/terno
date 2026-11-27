// Plans 99 and 259: which OAuth client a sign-in or token refresh uses, per sign-in method. A build carries
// Terno's own clients (Google's Desktop clients; Microsoft's Entra app registrations), so connecting needs no setup,
// and (plan 123) they are the only ones. A refresh token works only with the client that issued it, so an account
// remembers its client in its config (Gmail: googleClientId; Outlook: microsoftClientId).
import type { SignInMethod } from "@terno/core";
import type { BackendCore as Backend } from "./core";

export interface OAuthClient {
  clientId: string;
  /** null for a public client (Microsoft's): PKCE and the loopback protect the flow */
  clientSecret: string | null;
}

/** A build's clients for one method: every one it carries, and which a new connection uses. */
export interface OAuthClientSet {
  preferred: string;
  clients: { clientId: string; clientSecret: string }[];
}
/** plan 99's name for Google's set */
export type GoogleClients = OAuthClientSet;

export type OAuthMethod = Exclude<SignInMethod, "password">;
const REMEMBERED = { google: "googleClientId", microsoft: "microsoftClientId" } as const satisfies Record<OAuthMethod, string>;

/** The build's clients from their JSON define (empty or malformed: none). A public client's secret is "". */
export function parseOAuthClients(json: string | undefined): OAuthClientSet | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as Partial<OAuthClientSet>;
    if (typeof v.preferred !== "string" || !Array.isArray(v.clients)) return null;
    const clients = v.clients.filter((c) => typeof c?.clientId === "string" && c.clientId !== "" && typeof c.clientSecret === "string");
    return clients.some((c) => c.clientId === v.preferred) ? { preferred: v.preferred, clients } : null;
  } catch {
    return null;
  }
}
export const parseGoogleClients = parseOAuthClients;

/**
 * The client for an account (the one it remembers) or for a new connection (the build's preferred one; a Gmail
 * account that remembers none was connected before plan 99 and gets it too). Only the build's clients exist (plan
 * 123: no client of the user's own). null: none, or the remembered client isn't one of them.
 */
export async function oauthClientFor(b: Backend, method: OAuthMethod, remembered?: string): Promise<OAuthClient | null> {
  const built = (method === "google" ? b.options.googleClients : b.options.microsoftClients) ?? null;
  const id = remembered || built?.preferred;
  const baked = id ? built?.clients.find((c) => c.clientId === id) : undefined;
  return baked ? { clientId: baked.clientId, clientSecret: baked.clientSecret || null } : null;
}

/** The client an account was connected with (undefined: none recorded, e.g. a Gmail account from before plan 99). */
export async function rememberedClient(b: Backend, accountId: number, method: OAuthMethod): Promise<string | undefined> {
  const id = (await b.store.accounts.config<Record<string, unknown>>(accountId))?.config[REMEMBERED[method]];
  return typeof id === "string" && id ? id : undefined;
}

/** Plan 123: a client secret the user saved for a client of their own (before it) is used by nothing now. */
export async function forgetOwnGoogleClient(b: Backend): Promise<void> {
  if (await b.store.secrets.has(OWN_SECRET)) await b.secrets.delete(OWN_SECRET, "migration");
}

const OWN_SECRET = "gmailClientSecret";
