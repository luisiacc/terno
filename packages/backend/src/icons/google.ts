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
import { beginSignIn, endSignIn, encryptCredential, connectExistingGoogle, googleCredentialIntent, sameAccount, commitGoogleCredential, photoReconnects } from "../identity";
import { consumeGooglePhotosPending, readSettings, setGooglePhotoState, setGooglePhotosPending } from "../settings";

const MAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
export const PHOTO_SCOPES = [CONTACTS_SCOPE, OTHER_CONTACTS_SCOPE];

export const photoStateFrom = (granted: readonly string[]): GooglePhotoState => ({ connections: granted.includes(CONTACTS_SCOPE), otherContacts: granted.includes(OTHER_CONTACTS_SCOPE), apiDisabled: false });

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
export async function setGooglePhotos(b: Backend, accountId: number, on: boolean, later = false): Promise<AppSettings> {
  // plan 71: on without a Google window now; the account's next sign-in asks for the contacts scopes
  if (on && later) {
    await gmailAccount(b, accountId);
    const settings = await readSettings(b.store);
    if (!settings.googlePhotos[String(accountId)]) await setGooglePhotosPending(b.store, accountId, true);
    return readSettings(b.store);
  }
  // plan 71: off while the account's reconnect is asking Google for these photos: that sign-in carries on (it reads the
  // wait again before turning anything on). Decided synchronously, so anything else supersedes older flows as before.
  const running = b.signIns.get(accountId);
  if (!on && running && photoReconnects.has(running)) {
    // wherever that sign-in has got to: no longer waiting, and off if it already turned them on (their photos forgotten)
    await setGooglePhotoState(b.store, accountId, null);
    await b.icons.dropPhotos(accountId);
    return readSettings(b.store);
  }
  const flow = beginSignIn(b, accountId);
  try {
    const account = await gmailAccount(b, accountId);
    const stamp = await b.store.accounts.stamp(accountId);
    b.assertSignIn(accountId, flow);
    if (!stamp) throw new RpcError("NOT_FOUND", L("errors.accountGone"));
    if (!on) return await b.credentialFlow(accountId, flow, async () => {
      await sameAccount(b, stamp, flow);
      await b.credentialWrite(accountId, flow, () => setGooglePhotoState(b.store, accountId, null));
      b.assertSignIn(accountId, flow);
      await b.icons.dropPhotos(accountId);
      b.assertSignIn(accountId, flow);
      return readSettings(b.store);
    });
    const result = await connectExistingGoogle(b, account, flow, [...GMAIL_SCOPES, ...PHOTO_SCOPES]);
    const granted = result.grantedScopes ?? [];
    if (!granted.includes(MAIL_SCOPE) && !granted.includes("https://mail.google.com/")) throw new RpcError("BAD_REQUEST", L("errors.icons.mailScopeLost"));
    const wanted = PHOTO_SCOPES.filter((scope) => granted.includes(scope));
    const blob = result.refreshToken === null ? undefined : await encryptCredential(b, result.refreshToken);
    b.assertSignIn(accountId, flow);
    return await b.credentialFlow(accountId, flow, async () => {
      await sameAccount(b, stamp, flow);
      await b.dropAccount(accountId);
      b.assertSignIn(accountId, flow);
      const prepared = await googleCredentialIntent(b, account, stamp, result, flow, blob);
      let photoFailed = false;
      if (prepared.pending) {
        try {
          if (!wanted.length || prepared.pending.proof.expiresAt <= Date.now()) throw new Error();
          const proved = await prepared.pending.proof.provePhotos(wanted, AbortSignal.any([b.abort.signal, flow.signal]));
          if (!wanted.every((scope) => proved.includes(scope))) throw new Error();
        } catch { photoFailed = true; }
        b.assertSignIn(accountId, flow);
      }
      // Mail identity is proven independently: do not lose its rotation when optional contacts access fails.
      await commitGoogleCredential(b, accountId, stamp, flow, prepared.intent);
      if (photoFailed || (prepared.pending && prepared.pending.proof.expiresAt <= Date.now())) throw new RpcError("BAD_REQUEST", L("errors.google.invalidResponse"));
      await b.signedIn(accountId, undefined, flow);
      const current = await b.store.accounts.get(accountId);
      b.assertSignIn(accountId, flow);
      if (!current) throw new RpcError("NOT_FOUND", L("errors.accountGone"));
      b.startAccount(current);
      await b.credentialWrite(accountId, flow, () => setGooglePhotoState(b.store, accountId, photoStateFrom(granted)));
      b.assertSignIn(accountId, flow);
      await b.icons.syncPeople(accountId, photoStateFrom(granted), flow.signal);
      b.assertSignIn(accountId, flow);
      return readSettings(b.store);
    });
  } finally { await endSignIn(b, accountId, flow); }
}

/** icons.authorizeGoogle (web): the token must open this account's mailbox and still cover mail; it never creates one. */
export async function authorizeGooglePhotos(b: Backend, p: { accountId: number; accessToken: string; expiresIn: number; scope: string; ifPending?: boolean }): Promise<AppSettings> {
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
  // plan 71: a sign-in's consent counts only if the account still waits, checked with the write (off meanwhile wins)
  if (p.ifPending) {
    const state = photoStateFrom(granted);
    if (await consumeGooglePhotosPending(b.store, account.id, state)) await b.icons.syncPeople(account.id, state);
    return readSettings(b.store);
  }
  return turnOn(b, account.id, photoStateFrom(granted));
}
