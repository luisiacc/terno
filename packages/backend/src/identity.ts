import { messageOf, type Account } from "@terno/core";
import { RpcError, type OwnerIdentity } from "@terno/core/rpc";
import { L } from "@terno/i18n";
import type { OwnerClaim } from "@terno/store";
import type { GmailAccountConfig, GmailConnectResult, ImapAccountConfig } from "@terno/mail";
import type { BackendCore as Backend } from "./core";
import { readSettings } from "./settings";

/**
 * A failed live login: the provider's own words when they are Terno's (they
 * already say what went wrong, in the user's language), else wrapped with
 * the address.
 */
export function loginFailed(key: "errors.couldNotConnectAccount" | "errors.couldNotVerifyAccount" | "errors.couldNotConnect", email: string, error: unknown): RpcError {
  const inner = messageOf(error);
  if (typeof inner !== "string") return new RpcError("BAD_REQUEST", inner);
  return new RpcError("BAD_REQUEST", key === "errors.couldNotConnect" ? L(key, { detail: inner }) : L(key, { email, detail: inner }));
}

/** An IMAP login proves the password, not the address: record whether the login user is the address. */
export function imapClaim(account: { email: string }, config: ImapAccountConfig, displayName: string): Omit<OwnerClaim, "accountId" | "email"> {
  return {
    displayName,
    provider: "imap",
    verifiedBy: "imap_login",
    evidence: { imapHost: config.imap.host, loginUser: config.imap.user, emailMatchesLogin: config.imap.user.toLowerCase() === account.email.toLowerCase() },
  };
}

export function gmailClaim(result: Omit<GmailConnectResult, "refreshToken">): Omit<OwnerClaim, "accountId" | "email"> {
  return {
    displayName: result.name,
    provider: "gmail",
    verifiedBy: "google_oauth",
    evidence: { googleSub: result.sub, emailVerified: result.emailVerified },
  };
}

/**
 * Signs an account in again with fresh credentials: the IMAP password checked
 * by a live login, or Google's sign-in for the same address. The new secret
 * replaces the old one only if it is still the same mailbox; then the account
 * restarts, its waiting actions resume and it syncs.
 */
export async function reconnectAccount(b: Backend, accountId: number, password: string | undefined): Promise<Account> {
  const store = b.store;
  const account = await store.accounts.get(accountId);
  const stamp = await store.accounts.stamp(accountId);
  if (!account || !stamp) throw new RpcError("NOT_FOUND", L("errors.accountGone"));
  const config = (await store.accounts.config<Record<string, unknown>>(accountId))!.config;
  let secret: { name: string; value: string };
  if (account.kind === "imap") {
    if (!b.host.capabilities.imap) throw new RpcError("UNAVAILABLE", L("errors.imapNeedsDesktop"));
    if (!password) throw new RpcError("BAD_REQUEST", L("errors.passwordRequired"));
    try {
      await b.options.providers.verifyImap(config as unknown as ImapAccountConfig, password);
    } catch (error) {
      throw loginFailed("errors.couldNotConnectAccount", account.email, error);
    }
    secret = { name: "password", value: password };
  } else {
    if (b.options.providers.gmailTokens) throw new RpcError("UNAVAILABLE", L("errors.gmailReconnectInBrowser"));
    const settings = await readSettings(store);
    if (!settings.gmailClientId) throw new RpcError("BAD_REQUEST", L("errors.gmailClientIdMissing"));
    if (!b.options.openExternal) throw new RpcError("UNAVAILABLE", L("errors.googleConnectNeedsDesktop"));
    let result: GmailConnectResult;
    // plan 25 (Codex review #4): one Google sign-in per account: "Open again" aborts the one before (its page
    // listener closes), so two flows never race to store a token
    b.signIns.get(accountId)?.abort();
    const flow = new AbortController();
    b.signIns.set(accountId, flow);
    try {
      result = await b.options.providers.connectGmail({
        clientId: settings.gmailClientId,
        clientSecret: await b.getSecret("gmailClientSecret"),
        openExternal: b.options.openExternal,
        signal: AbortSignal.any([b.abort.signal, flow.signal]),
        fetch: b.net.fetchFor("mail"),
        loginHint: account.email,
      });
    } catch (error) {
      throw new RpcError("BAD_REQUEST", messageOf(error));
    } finally {
      if (b.signIns.get(accountId) === flow) b.signIns.delete(accountId);
    }
    // a newer sign-in took over while Google answered this one: that one decides
    if (flow.signal.aborted) throw new RpcError("BAD_REQUEST", L("errors.google.cancelled"));
    if (result.email.toLowerCase() !== account.email.toLowerCase()) {
      throw new RpcError("BAD_REQUEST", L("errors.googleConnectedOther", { got: result.email, expected: account.email }));
    }
    secret = { name: "refreshToken", value: result.refreshToken };
  }
  // signing in took a while: the secret goes only to the same mailbox (not one removed and added again meanwhile)
  const now = await store.accounts.stamp(accountId);
  if (!now || now.createdAt !== stamp.createdAt || now.email !== stamp.email) throw new RpcError("NOT_FOUND", L("errors.accountGone"));
  await b.dropAccount(accountId);
  await b.setSecret(`account:${accountId}:${secret.name}`, secret.value);
  // plan 25: proven just now (a live login, Google's answer): it stops asking at once, and what waited goes
  await b.signedIn(accountId);
  b.startAccount((await store.accounts.get(accountId))!);
  return (await store.accounts.get(accountId))!;
}

/**
 * Moves the Terno account to another connected mailbox, which must be verified
 * again right now: Google OAuth with the address pre-selected (and matching),
 * or a live IMAP login with the password typed again. A stored password does
 * not count. The user id stays; the previous owner goes to history.
 */
export async function changeOwnerTo(b: Backend, accountId: number, password: string | undefined): Promise<OwnerIdentity> {
  const store = b.store;
  if (!b.canClaimOwner()) throw new RpcError("BAD_REQUEST", L("errors.demoNoOwner"));
  const account = await store.accounts.get(accountId);
  const stamp = await store.accounts.stamp(accountId);
  if (!account || !stamp) throw new RpcError("NOT_FOUND", L("errors.accountGone"));
  const config = (await store.accounts.config<Record<string, unknown>>(accountId))!.config;
  if (config.demo) throw new RpcError("BAD_REQUEST", L("errors.demoAccountOwner"));
  const current = await store.owner.get();
  if (current?.accountId === accountId) throw new RpcError("BAD_REQUEST", L("errors.alreadyOwner", { email: account.email }));

  let claim: Omit<OwnerClaim, "accountId" | "email">;
  let secret: { name: string; blob: Uint8Array };
  if (account.kind === "imap") {
    if (!password) throw new RpcError("BAD_REQUEST", L("errors.passwordToVerify"));
    const imap = config as unknown as ImapAccountConfig;
    try {
      await b.options.providers.verifyImap(imap, password);
    } catch (error) {
      throw loginFailed("errors.couldNotVerifyAccount", account.email, error);
    }
    secret = { name: `account:${accountId}:password`, blob: await b.options.cipher.encrypt(password) };
    claim = imapClaim(account, imap, (config as unknown as ImapAccountConfig).senderName || account.displayName);
  } else {
    const settings = await readSettings(store);
    if (!settings.gmailClientId) throw new RpcError("BAD_REQUEST", L("errors.gmailClientIdMissing"));
    if (!b.options.openExternal) throw new RpcError("UNAVAILABLE", L("errors.googleVerifyNeedsDesktop"));
    const result = await b.options.providers.connectGmail({
      clientId: settings.gmailClientId,
      clientSecret: await b.getSecret("gmailClientSecret"),
      openExternal: b.options.openExternal,
      signal: b.abort.signal,
      fetch: b.net.fetchFor("mail"),
      loginHint: account.email,
    });
    if (result.email.toLowerCase() !== account.email.toLowerCase()) {
      throw new RpcError("BAD_REQUEST", L("errors.googleVerifiedOther", { got: result.email, expected: account.email }));
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
