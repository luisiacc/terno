/**
 * Photos from Google for a Gmail account (plan 22): turning them on asks
 * Google for the two contacts scopes, bound to that account, and lists the
 * photos at once (so Settings can say whether the project's People API is
 * off). Desktop: installed apps get no incremental consent, so the whole
 * scope list is asked again and the new refresh token replaces the old one
 * only when it opens the same mailbox and still covers mail. Web: the page
 * gets the token from Google's own popup and hands it here.
 */
import { messageOf } from "@terno/core";
import { RpcError, type AppSettings, type GooglePhotoState } from "@terno/core/rpc";
import { L } from "@terno/i18n";
import { CONTACTS_SCOPE, GMAIL_SCOPES, OTHER_CONTACTS_SCOPE } from "@terno/mail/portable";
import type { BackendCore as Backend } from "../core";
import { readSettings, setGooglePhotoState } from "../settings";

const MAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
export const PHOTO_SCOPES = [CONTACTS_SCOPE, OTHER_CONTACTS_SCOPE];

const stateFrom = (granted: readonly string[]): GooglePhotoState => ({ connections: granted.includes(CONTACTS_SCOPE), otherContacts: granted.includes(OTHER_CONTACTS_SCOPE), apiDisabled: false });

async function gmailAccount(b: Backend, accountId: number) {
  const account = await b.store.accounts.get(accountId);
  if (!account) throw new RpcError("NOT_FOUND", L("errors.accountGone"));
  if (account.kind !== "gmail") throw new RpcError("BAD_REQUEST", L("errors.icons.notGmail"));
  return account;
}

async function turnOn(b: Backend, accountId: number, state: GooglePhotoState): Promise<AppSettings> {
  await setGooglePhotoState(b.store, accountId, state);
  // listed now: Settings learns whether the People API is on, and the photos show
  await b.icons.syncPeople(accountId, state);
  return readSettings(b.store);
}

/** icons.googlePhotos: off anywhere; on through Google's consent on desktop (the web uses authorizeGooglePhotos). */
export async function setGooglePhotos(b: Backend, accountId: number, on: boolean): Promise<AppSettings> {
  const account = await gmailAccount(b, accountId);
  if (!on) {
    await setGooglePhotoState(b.store, accountId, null);
    await b.icons.dropPhotos(accountId);
    return readSettings(b.store);
  }
  if (b.options.providers.gmailTokens) throw new RpcError("UNAVAILABLE", L("errors.gmailReconnectInBrowser"));
  const settings = await readSettings(b.store);
  if (!settings.gmailClientId) throw new RpcError("BAD_REQUEST", L("errors.gmailClientIdMissing"));
  if (!b.options.openExternal) throw new RpcError("UNAVAILABLE", L("errors.googleConnectNeedsDesktop"));
  const stamp = await b.store.accounts.stamp(accountId);
  let result;
  try {
    result = await b.options.providers.connectGmail({
      clientId: settings.gmailClientId,
      clientSecret: await b.getSecret("gmailClientSecret"),
      openExternal: b.options.openExternal,
      signal: b.abort.signal,
      fetch: b.net.fetchFor("mail"),
      loginHint: account.email,
      scopes: [...GMAIL_SCOPES, ...PHOTO_SCOPES],
    });
  } catch (error) {
    throw new RpcError("BAD_REQUEST", messageOf(error));
  }
  // nothing changes unless it's the same mailbox and mail is still covered
  if (result.email.toLowerCase() !== account.email.toLowerCase()) throw new RpcError("BAD_REQUEST", L("errors.googleConnectedOther", { got: result.email, expected: account.email }));
  const granted = result.grantedScopes ?? [];
  if (!granted.includes(MAIL_SCOPE)) throw new RpcError("BAD_REQUEST", L("errors.icons.mailScopeLost"));
  const now = await b.store.accounts.stamp(accountId);
  if (!stamp || !now || now.createdAt !== stamp.createdAt || now.email !== stamp.email) throw new RpcError("NOT_FOUND", L("errors.accountGone"));
  // the provider holds an access token for the old grant: it starts again on the new one
  await b.dropAccount(accountId);
  await b.setSecret(`account:${accountId}:refreshToken`, result.refreshToken);
  b.startAccount((await b.store.accounts.get(accountId))!);
  return turnOn(b, accountId, stateFrom(granted));
}

/** icons.authorizeGoogle (web): the token must open this account's mailbox and still cover mail; it never creates one. */
export async function authorizeGooglePhotos(b: Backend, p: { accountId: number; accessToken: string; expiresIn: number; scope: string }): Promise<AppSettings> {
  const tokens = b.options.providers.gmailTokens;
  // i18n-ignore: a wiring mistake (only the web build calls this), for developers
  if (!tokens) throw new RpcError("UNAVAILABLE", "This host turns photos on with icons.googlePhotos.");
  const account = await gmailAccount(b, p.accountId);
  const who = await tokens.inspect(p.accessToken, b.net.fetchFor("mail")).catch((error: unknown) => {
    throw new RpcError("BAD_REQUEST", messageOf(error));
  });
  if (who.email.toLowerCase() !== account.email.toLowerCase()) throw new RpcError("BAD_REQUEST", L("errors.googleConnectedOther", { got: who.email, expected: account.email }));
  const granted = p.scope.split(/\s+/).filter(Boolean);
  if (!granted.includes(MAIL_SCOPE)) throw new RpcError("BAD_REQUEST", L("errors.icons.mailScopeLost"));
  tokens.set(account.id, p.accessToken, b.now() + p.expiresIn * 1000);
  await b.resumeAuth(account.id);
  return turnOn(b, account.id, stateFrom(granted));
}
