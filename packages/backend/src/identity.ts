import { RpcError, type OwnerIdentity } from "@unica/core/rpc";
import { changeOwner, getAccount, getAccountConfig, getOwner, type OwnerClaim } from "@unica/db";
import type { GmailAccountConfig, GmailConnectResult, ImapAccountConfig } from "@unica/mail";
import type { Backend } from "./backend";
import { readSettings } from "./settings";

/** An IMAP login proves the password, not the address: record whether the login user is the address. */
export function imapClaim(account: { id: number; email: string }, config: ImapAccountConfig, displayName: string): OwnerClaim {
  return {
    email: account.email,
    displayName,
    provider: "imap",
    verifiedBy: "imap_login",
    evidence: { imapHost: config.imap.host, loginUser: config.imap.user, emailMatchesLogin: config.imap.user.toLowerCase() === account.email.toLowerCase() },
    accountId: account.id,
  };
}

export function gmailClaim(account: { id: number; email: string }, result: GmailConnectResult): OwnerClaim {
  return {
    email: account.email,
    displayName: result.name,
    provider: "gmail",
    verifiedBy: "google_oauth",
    evidence: { googleSub: result.sub, emailVerified: result.emailVerified },
    accountId: account.id,
  };
}

/**
 * Moves the Única account to another connected mailbox, which must be verified
 * again right now: Google OAuth with the address pre-selected (and matching),
 * or a live IMAP login with the password typed again. A stored password does
 * not count. The user id stays; the previous owner goes to history.
 */
export async function changeOwnerTo(b: Backend, accountId: number, password: string | undefined): Promise<OwnerIdentity> {
  const db = b.db;
  if (!b.canClaimOwner()) throw new RpcError("BAD_REQUEST", "El modo demo no tiene cuenta Única.");
  const account = getAccount(db, accountId);
  if (!account) throw new RpcError("NOT_FOUND", "Esa cuenta ya no está conectada.");
  const config = getAccountConfig<Record<string, unknown>>(db, accountId)!.config;
  if (config.demo) throw new RpcError("BAD_REQUEST", "Una cuenta de demostración no puede ser tu cuenta Única.");
  const current = getOwner(db);
  if (current?.accountId === accountId) throw new RpcError("BAD_REQUEST", `${account.email} ya es tu cuenta Única.`);

  let claim: OwnerClaim;
  if (account.kind === "imap") {
    if (!password) throw new RpcError("BAD_REQUEST", "Escribe la contraseña de la cuenta para verificarla.");
    const imap = config as unknown as ImapAccountConfig;
    try {
      await b.options.providers.verifyImap(imap, password);
    } catch (error) {
      throw new RpcError("BAD_REQUEST", `No se pudo verificar ${account.email}: ${error instanceof Error ? error.message : String(error)}`);
    }
    await b.setSecret(`account:${accountId}:password`, password);
    claim = imapClaim(account, imap, (config as unknown as ImapAccountConfig).senderName || account.displayName);
  } else {
    const settings = readSettings(db);
    if (!settings.gmailClientId) throw new RpcError("BAD_REQUEST", "Añade tu Google OAuth client ID en Ajustes → Cuentas.");
    if (!b.options.openExternal) throw new RpcError("UNAVAILABLE", "Verificar con Google necesita la app de escritorio.");
    const result = await b.options.providers.connectGmail({
      clientId: settings.gmailClientId,
      clientSecret: await b.getSecret("gmailClientSecret"),
      openExternal: b.options.openExternal,
      signal: b.abort.signal,
      fetch: b.net.fetchFor("mail"),
      loginHint: account.email,
    });
    if (result.email.toLowerCase() !== account.email.toLowerCase()) {
      throw new RpcError("BAD_REQUEST", `Google verificó ${result.email}, no ${account.email}. Elige esa cuenta en la ventana de Google.`);
    }
    await b.setSecret(`account:${accountId}:refreshToken`, result.refreshToken);
    claim = gmailClaim(account, { ...result, name: result.name || (config as unknown as GmailAccountConfig).senderName });
  }
  changeOwner(db, claim, current ? "changed by user" : "claimed by user", b.now());
  b.emitOwner();
  return getOwner(db)!;
}
