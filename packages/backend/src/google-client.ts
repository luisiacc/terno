// Plan 99: which Google OAuth client a Gmail sign-in or token refresh uses.
// A build carries Terno's own Desktop clients, so connecting needs no setup;
// a client ID in Settings overrides them for new connections. A refresh token
// works only with the client that issued it, so an account remembers its client
// (GmailAccountConfig.googleClientId) and is only ever paired with that client's secret.
import type { GmailAccountConfig } from "@terno/mail";
import type { BackendCore as Backend } from "./core";
import { readSettings } from "./settings";

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
 * The client for a new connection (Settings', else the build's), for an account (its remembered
 * one), or for an existing account that remembers none: the build's first, since the backfill
 * already bound every account Settings' client could have connected, and a Settings client added
 * later must not capture an account it never signed in. null: none, or the remembered client is
 * no longer here. Throws what reading the user's saved secret throws.
 */
export async function googleClientFor(b: Backend, remembered?: string, existing = false): Promise<GoogleClient | null> {
  const built = b.options.googleClients ?? null;
  const own = (await readSettings(b.store)).gmailClientId;
  const id = remembered || (existing ? built?.preferred || own : own || built?.preferred);
  if (!id) return null;
  const baked = built?.clients.find((c) => c.clientId === id);
  if (baked) return { clientId: id, clientSecret: baked.clientSecret || null };
  if (id !== own) return null;
  return { clientId: id, clientSecret: await b.getSecret("gmailClientSecret") };
}

/** The client a Gmail account was connected with (undefined: before plan 99, or none recorded). */
export async function rememberedGoogleClient(b: Backend, accountId: number): Promise<string | undefined> {
  const id = (await b.store.accounts.config<GmailAccountConfig>(accountId))?.config.googleClientId;
  return typeof id === "string" && id ? id : undefined;
}

const BACKFILLED = "googleClientBackfill";

/**
 * Accounts connected before plan 99 can only have used the client in Settings: they keep it,
 * so clearing that setting later doesn't move them to the build's client. Once (a later run
 * would bind an account the build's client reconnected to a Settings client added since).
 * Runs on start(), before any account syncs.
 */
export async function rememberLegacyGoogleClients(b: Backend): Promise<void> {
  // the web signs in per session (no refresh token, no client binding)
  if (b.options.providers.gmailTokens) return;
  if (await b.store.settings.get(BACKFILLED, false)) return;
  const own = (await readSettings(b.store)).gmailClientId;
  if (own) {
    for (const account of await b.store.accounts.list()) {
      if (account.kind !== "gmail") continue;
      const stored = await b.store.accounts.config<GmailAccountConfig & { demo?: boolean }>(account.id);
      if (!stored || stored.config.googleClientId || stored.config.demo) continue;
      await b.store.accounts.setProviderConfig(account.id, { ...stored.config, googleClientId: own });
    }
  }
  await b.store.settings.set(BACKFILLED, true);
}
