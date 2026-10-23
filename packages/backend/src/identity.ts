import { RpcError, type OwnerIdentity } from "@unica/core/rpc";
import type { OwnerClaim } from "@unica/store";
import type { GmailAccountConfig, GmailConnectResult, ImapAccountConfig } from "@unica/mail";
import type { BackendCore as Backend } from "./core";
import { readSettings } from "./settings";

/** An IMAP login proves the password, not the address: record whether the login user is the address. */
export function imapClaim(account: { email: string }, config: ImapAccountConfig, displayName: string): Omit<OwnerClaim, "accountId" | "email"> {
  return {
    displayName,
    provider: "imap",
    verifiedBy: "imap_login",
    evidence: { imapHost: config.imap.host, loginUser: config.imap.user, emailMatchesLogin: config.imap.user.toLowerCase() === account.email.toLowerCase() },
  };
}

export function gmailClaim(result: GmailConnectResult): Omit<OwnerClaim, "accountId" | "email"> {
  return {
    displayName: result.name,
    provider: "gmail",
    verifiedBy: "google_oauth",
    evidence: { googleSub: result.sub, emailVerified: result.emailVerified },
  };
}

/**
 * Moves the Única account to another connected mailbox, which must be verified
 * again right now: Google OAuth with the address pre-selected (and matching),
 * or a live IMAP login with the password typed again. A stored password does
 * not count. The user id stays; the previous owner goes to history.
 */
export async function changeOwnerTo(b: Backend, accountId: number, password: string | undefined): Promise<OwnerIdentity> {
  const store = b.store;
  if (!b.canClaimOwner()) throw new RpcError("BAD_REQUEST", "El modo demo no tiene cuenta Única.");
  const account = await store.accounts.get(accountId);
  const stamp = await store.accounts.stamp(accountId);
  if (!account || !stamp) throw new RpcError("NOT_FOUND", "Esa cuenta ya no está conectada.");
  const config = (await store.accounts.config<Record<string, unknown>>(accountId))!.config;
  if (config.demo) throw new RpcError("BAD_REQUEST", "Una cuenta de demostración no puede ser tu cuenta Única.");
  const current = await store.owner.get();
  if (current?.accountId === accountId) throw new RpcError("BAD_REQUEST", `${account.email} ya es tu cuenta Única.`);

  let claim: Omit<OwnerClaim, "accountId" | "email">;
  let secret: { name: string; blob: Uint8Array };
  if (account.kind === "imap") {
    if (!password) throw new RpcError("BAD_REQUEST", "Escribe la contraseña de la cuenta para verificarla.");
    const imap = config as unknown as ImapAccountConfig;
    try {
      await b.options.providers.verifyImap(imap, password);
    } catch (error) {
      throw new RpcError("BAD_REQUEST", `No se pudo verificar ${account.email}: ${error instanceof Error ? error.message : String(error)}`);
    }
    secret = { name: `account:${accountId}:password`, blob: await b.options.cipher.encrypt(password) };
    claim = imapClaim(account, imap, (config as unknown as ImapAccountConfig).senderName || account.displayName);
  } else {
    const settings = await readSettings(store);
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
    secret = { name: `account:${accountId}:refreshToken`, blob: await b.options.cipher.encrypt(result.refreshToken) };
    claim = gmailClaim({ ...result, name: result.name || (config as unknown as GmailAccountConfig).senderName });
  }
  // Verification took a while (a login, a browser round trip): commit only if it is still the same mailbox,
  // and write its fresh credentials and the ownership together.
  await store.owner.change({
    claim: { ...claim, email: account.email, accountId },
    stamp: { createdAt: stamp.createdAt, email: stamp.email },
    secret,
    reason: current ? "changed by user" : "claimed by user",
    now: b.now(),
  });
  await b.emitOwner();
  return (await store.owner.get())!;
}
