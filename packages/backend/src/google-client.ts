// Plan 99: which Google OAuth client a Gmail sign-in or token refresh uses.
// A build carries Terno's own Desktop clients, so connecting needs no setup, and
// (plan 123) they are the only ones. A refresh token works only with the client
// that issued it, so an account remembers its client (GmailAccountConfig.googleClientId).
import type { GmailAccountConfig } from "@terno/mail";
import type { BackendCore as Backend } from "./core";

export interface GoogleClient {
  clientId: string;
  clientSecret: string | null;
}

export interface GoogleClients {
  /** what a new connection uses when Settings has no client */
  preferred: string;
  clients: { clientId: string; clientSecret: string }[];
}

/** The build's clients from their JSON define (empty or malformed: none). */
export function parseGoogleClients(json: string | undefined): GoogleClients | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as Partial<GoogleClients>;
    if (typeof v.preferred !== "string" || !Array.isArray(v.clients)) return null;
    const clients = v.clients.filter((c) => typeof c?.clientId === "string" && c.clientId !== "" && typeof c.clientSecret === "string");
    return clients.some((c) => c.clientId === v.preferred) ? { preferred: v.preferred, clients } : null;
  } catch {
    return null;
  }
}

/**
 * The client for an account (the one it remembers) or for a new connection (the build's preferred
 * one; an account that remembers none was connected before plan 99 and gets it too). Only the
 * build's clients exist (plan 123: no client of the user's own). null: none, or the remembered
 * client isn't one of them.
 */
export async function googleClientFor(b: Backend, remembered?: string): Promise<GoogleClient | null> {
  const built = b.options.googleClients ?? null;
  const id = remembered || built?.preferred;
  const baked = id ? built?.clients.find((c) => c.clientId === id) : undefined;
  return baked ? { clientId: baked.clientId, clientSecret: baked.clientSecret || null } : null;
}

/** The client a Gmail account was connected with (undefined: before plan 99, or none recorded). */
export async function rememberedGoogleClient(b: Backend, accountId: number): Promise<string | undefined> {
  const id = (await b.store.accounts.config<GmailAccountConfig>(accountId))?.config.googleClientId;
  return typeof id === "string" && id ? id : undefined;
}

/** Plan 123: a client secret the user saved for a client of their own (before it) is used by nothing now. */
export async function forgetOwnGoogleClient(b: Backend): Promise<void> {
  if (await b.store.secrets.has(OWN_SECRET)) await b.store.secrets.delete(OWN_SECRET);
}

const OWN_SECRET = "gmailClientSecret";
