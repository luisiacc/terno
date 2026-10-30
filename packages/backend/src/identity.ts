import { isValidEmail, messageOf, type Account } from "@terno/core";
import { RpcError, type OwnerIdentity } from "@terno/core/rpc";
import { L } from "@terno/i18n";
import type { OwnerClaim, OwnerDecision, SecretIntent } from "@terno/store";
import type { GmailAccountConfig, GmailConnectResult, GmailRenewalProof, ImapAccountConfig } from "@terno/mail";
import type { BackendCore as Backend } from "./core";
import { consumeGooglePhotosPending, googlePhotosPending, readSettings, setGooglePhotosPending } from "./settings";
import { CONTACTS_SCOPE, GMAIL_SCOPES, OTHER_CONTACTS_SCOPE } from "@terno/mail/portable";

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

/** Provider registries are a boundary too: malformed identity must never become a saved account or claim. */
export function validateGoogleConnection(result: unknown, policy: "browser" | "initial" | "renewal" = "browser"): asserts result is GmailConnectResult {
  const value = result as Record<string, unknown> | null;
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    typeof value.email !== "string" || value.email.length > 254 || (!isValidEmail(value.email) || /\p{Cc}/u.test(value.email)) ||
    typeof value.name !== "string" ||
    typeof value.sub !== "string" || !value.sub || value.sub.length > 255 || /[\s\p{Cc}]/u.test(value.sub) ||
    typeof value.emailVerified !== "boolean" ||
    (policy !== "browser" && !(policy === "renewal" && value.refreshToken === null) && (typeof value.refreshToken !== "string" || value.refreshToken.length > 4096 || !/^[\x21-\x7e]+$/.test(value.refreshToken)))) throw new RpcError("BAD_REQUEST", L("errors.google.invalidResponse"));
  if (value.grantedScopes !== undefined) {
    if (!Array.isArray(value.grantedScopes) || !value.grantedScopes.every((scope) => typeof scope === "string")) throw new RpcError("BAD_REQUEST", L("errors.google.invalidResponse"));
    if (!value.grantedScopes.includes("https://www.googleapis.com/auth/gmail.modify") && !value.grantedScopes.includes("https://mail.google.com/")) throw new RpcError("BAD_REQUEST", L("errors.google.mailScopeRequired"));
  }
}

export function googleFlowActive(b: Backend): void {
  if (b.abort.signal.aborted) throw new RpcError("BAD_REQUEST", L("errors.google.cancelled"));
}

export function gmailClaim(result: Omit<GmailConnectResult, "refreshToken">): Omit<OwnerClaim, "accountId" | "email"> {
  return {
    displayName: result.name,
    provider: "gmail",
    verifiedBy: "google_oauth",
    evidence: { googleSub: result.sub, emailVerified: result.emailVerified },
  };
}

export interface PendingGmailRenewal {
  stamp: { id: number; email: string; createdAt: number };
  expectedBlob: Uint8Array;
  proof: GmailRenewalProof;
  verified: boolean;
  subject?: string;
  blob?: Uint8Array;
}

export function beginSignIn(b: Backend, accountId: number): AbortController {
  if (b.signIns.has(accountId)) b.gmailRenewals.delete(accountId);
  b.signIns.get(accountId)?.abort();
  const flow = new AbortController();
  b.signIns.set(accountId, flow);
  return flow;
}

export async function endSignIn(b: Backend, accountId: number, flow: AbortController): Promise<void> {
  try { await b.recoverSignIn(accountId, flow); }
  finally { if (b.signIns.get(accountId) === flow) b.signIns.delete(accountId); }
}

export async function encryptCredential(b: Backend, value: string): Promise<Uint8Array> {
  try { return await b.options.cipher.encrypt(value); }
  catch { throw new RpcError("BAD_REQUEST", L("errors.secret.replaceFailed")); }
}

export async function sameAccount(b: Backend, stamp: { id: number; email: string; createdAt: number }, flow: AbortController): Promise<void> {
  const current = await b.store.accounts.stamp(stamp.id);
  b.assertSignIn(stamp.id, flow);
  if (!current || current.createdAt !== stamp.createdAt || current.email !== stamp.email) throw new RpcError("NOT_FOUND", L("errors.accountGone"));
}

const sameBytes = (a: Uint8Array | null, c: Uint8Array) => !!a && a.length === c.length && a.every((v, i) => v === c[i]);
const invalidRenewal = () => new RpcError("BAD_REQUEST", L("errors.google.invalidResponse"));
const persistenceFailed = () => new RpcError("BAD_REQUEST", L("errors.secret.replaceFailed"));

async function credentialSnapshot(b: Backend, accountId: number, flow: AbortController, key: "refreshToken" | "password"): Promise<Uint8Array | null> {
  let blob: Uint8Array | null;
  try { blob = await b.store.secrets.get(`account:${accountId}:${key}`); }
  catch { b.assertSignIn(accountId, flow); throw persistenceFailed(); }
  b.assertSignIn(accountId, flow);
  return blob && Uint8Array.from(blob);
}

/** Called after old provider drain, under the account's finalization owner. */
export async function googleCredentialIntent(b: Backend, account: Account, stamp: { id: number; email: string; createdAt: number }, result: GmailConnectResult, flow: AbortController, freshBlob?: Uint8Array): Promise<{ intent: SecretIntent; pending?: PendingGmailRenewal }> {
  await sameAccount(b, stamp, flow);
  const name = `account:${account.id}:refreshToken`;
  const current = await credentialSnapshot(b, account.id, flow, "refreshToken");
  if (result.refreshToken !== null) {
    b.gmailRenewals.delete(account.id);
    return { intent: { kind: "replace", name, expectedBlob: current, blob: freshBlob! } };
  }
  if (!current || !b.options.providers.beginGmailRenewal) throw invalidRenewal();
  let pending = b.gmailRenewals.get(account.id);
  if (pending && (pending.stamp.email !== stamp.email || pending.stamp.createdAt !== stamp.createdAt || (!sameBytes(current, pending.expectedBlob) && !(pending.blob && sameBytes(current, pending.blob))))) {
    b.gmailRenewals.delete(account.id);
    pending = undefined;
  }
  if (!pending) {
    let refreshToken: string | null;
    try { refreshToken = await b.getSecret(name); } catch { throw invalidRenewal(); }
    b.assertSignIn(account.id, flow);
    if (!refreshToken) throw invalidRenewal();
    // getSecret honors the keychain migration fingerprint. Assert the exact ciphertext again before exchange.
    const latest = await credentialSnapshot(b, account.id, flow, "refreshToken");
    if (!sameBytes(latest, current)) throw persistenceFailed();
    b.assertSignIn(account.id, flow);
    const settings = await readSettings(b.store);
    const clientSecret = await b.getSecret("gmailClientSecret");
    b.assertSignIn(account.id, flow);
    let proof: GmailRenewalProof;
    try { proof = await b.options.providers.beginGmailRenewal({ clientId: settings.gmailClientId, clientSecret, refreshToken, fetch: b.net.fetchFor("mail"), signal: AbortSignal.any([b.abort.signal, flow.signal]) }); }
    catch { throw invalidRenewal(); }
    b.assertSignIn(account.id, flow);
    if (!proof || typeof proof.refreshToken !== "string" || proof.refreshToken.length > 4096 || !/^[\x21-\x7e]+$/.test(proof.refreshToken) || !Number.isFinite(proof.expiresAt) || typeof proof.inspect !== "function" || typeof proof.provePhotos !== "function") throw invalidRenewal();
    pending = { stamp: { ...stamp }, expectedBlob: current, proof, verified: false };
    b.gmailRenewals.set(account.id, pending);
  }
  if (pending.verified && pending.subject !== result.sub) { b.gmailRenewals.delete(account.id); throw invalidRenewal(); }
  if (!pending.verified) {
    if (pending.proof.expiresAt <= Date.now()) { b.gmailRenewals.delete(account.id); throw invalidRenewal(); }
    let who: Omit<GmailConnectResult, "refreshToken">;
    try { who = await pending.proof.inspect(AbortSignal.any([b.abort.signal, flow.signal])); } catch { throw invalidRenewal(); }
    b.assertSignIn(account.id, flow);
    validateGoogleConnection(who, "browser");
    if (who.email.toLowerCase() !== account.email.toLowerCase() || who.sub !== result.sub) { b.gmailRenewals.delete(account.id); throw invalidRenewal(); }
    pending.verified = true;
    pending.subject = who.sub!;
  }
  if (!pending.blob) {
    let old: string;
    try { old = await b.options.cipher.decrypt(pending.expectedBlob); } catch { throw invalidRenewal(); }
    b.assertSignIn(account.id, flow);
    pending.blob = old === pending.proof.refreshToken ? pending.expectedBlob : await encryptCredential(b, pending.proof.refreshToken);
    b.assertSignIn(account.id, flow);
  }
  // A commit may have succeeded before its adapter threw. Never restore the old bytes.
  if (sameBytes(current, pending.blob)) return { intent: { kind: "retain", name, expectedBlob: current }, pending };
  return { intent: { kind: "replace", name, expectedBlob: pending.expectedBlob, blob: pending.blob }, pending };
}

async function confirmCredential(b: Backend, stamp: { id: number; email: string; createdAt: number }, intent: SecretIntent, owner?: OwnerDecision): Promise<boolean> {
  return owner ? b.store.owner.confirm(owner) : b.store.secrets.commit({ kind: "retain", name: intent.name, expectedBlob: intent.kind === "retain" ? intent.expectedBlob : intent.blob }, stamp);
}

export async function commitGoogleCredential(b: Backend, accountId: number, stamp: { id: number; email: string; createdAt: number }, flow: AbortController, intent: SecretIntent): Promise<void> {
  await sameAccount(b, stamp, flow);
  let committed: boolean;
  try { committed = await b.credentialCommit(accountId, flow, () => b.store.secrets.commit(intent, stamp), () => confirmCredential(b, stamp, intent)); }
  catch { b.assertSignIn(accountId, flow); throw persistenceFailed(); }
  b.assertSignIn(accountId, flow);
  if (!committed) { b.gmailRenewals.delete(accountId); throw persistenceFailed(); }
  b.gmailRenewals.delete(accountId);
}

export async function connectExistingGoogle(b: Backend, account: Account, flow: AbortController, scopes?: string[]): Promise<GmailConnectResult> {
  if (b.options.providers.gmailTokens) throw new RpcError("UNAVAILABLE", L("errors.gmailReconnectInBrowser"));
  const settings = await readSettings(b.store);
  b.assertSignIn(account.id, flow);
  if (!settings.gmailClientId) throw new RpcError("BAD_REQUEST", L("errors.gmailClientIdMissing"));
  if (!b.options.openExternal) throw new RpcError("UNAVAILABLE", L("errors.googleConnectNeedsDesktop"));
  const clientSecret = await b.getSecret("gmailClientSecret");
  b.assertSignIn(account.id, flow);
  let result: GmailConnectResult;
  try { result = await b.options.providers.connectGmail({ clientId: settings.gmailClientId, clientSecret, openExternal: b.options.openExternal, signal: AbortSignal.any([b.abort.signal, flow.signal]), fetch: b.net.fetchFor("mail"), loginHint: account.email, scopes, allowOmittedRefreshToken: true }); }
  catch { b.assertSignIn(account.id, flow); throw invalidRenewal(); }
  b.assertSignIn(account.id, flow);
  validateGoogleConnection(result, "renewal");
  if (result.email.toLowerCase() !== account.email.toLowerCase()) throw new RpcError("BAD_REQUEST", L("errors.googleConnectedOther", { got: result.email, expected: account.email }));
  return result;
}

/** Plan 71: reconnects asking Google for photos waiting on them (photos switched off meanwhile don't cancel them). */
export const photoReconnects = new WeakSet<AbortController>();

/** Explicit credential changes retain one owner through preparation, durable commit and state publication. */
export async function reconnectAccount(b: Backend, accountId: number, password: string | undefined): Promise<Account> {
  const flow = beginSignIn(b, accountId);
  try {
    const account = await b.store.accounts.get(accountId), stamp = await b.store.accounts.stamp(accountId);
    b.assertSignIn(accountId, flow);
    if (!account || !stamp) throw new RpcError("NOT_FOUND", L("errors.accountGone"));
    let result: GmailConnectResult | undefined;
    let blob: Uint8Array | undefined;
    let photos = false;
    if (account.kind === "imap") {
      if (!b.host.capabilities.imap) throw new RpcError("UNAVAILABLE", L("errors.imapNeedsDesktop"));
      if (!password) throw new RpcError("BAD_REQUEST", L("errors.passwordRequired"));
      const config = (await b.store.accounts.config<ImapAccountConfig>(accountId))!.config;
      try { await b.options.providers.verifyImap(config, password); } catch (error) { throw loginFailed("errors.couldNotConnectAccount", account.email, error); }
      b.assertSignIn(accountId, flow);
      blob = await encryptCredential(b, password);
    } else {
      // plan 71: photos switched on to come with this sign-in: Google asks for the contacts scopes too
      photos = await googlePhotosPending(b.store, accountId);
      b.assertSignIn(accountId, flow);
      if (photos) photoReconnects.add(flow);
      result = await connectExistingGoogle(b, account, flow, photos ? [...GMAIL_SCOPES, CONTACTS_SCOPE, OTHER_CONTACTS_SCOPE] : undefined);
      if (result.refreshToken !== null) blob = await encryptCredential(b, result.refreshToken);
    }
    b.assertSignIn(accountId, flow);
    return await b.credentialFlow(accountId, flow, async () => {
      await sameAccount(b, stamp, flow);
      await b.dropAccount(accountId);
      b.assertSignIn(accountId, flow);
      const prepared = result ? await googleCredentialIntent(b, account, stamp, result, flow, blob) : { intent: { kind: "replace" as const, name: `account:${accountId}:password`, expectedBlob: await credentialSnapshot(b, accountId, flow, "password"), blob: blob! } };
      await commitGoogleCredential(b, accountId, stamp, flow, prepared.intent);
      if (prepared.pending && prepared.pending.proof.expiresAt <= Date.now()) throw invalidRenewal();
      await b.signedIn(accountId, undefined, flow);
      const current = await b.store.accounts.get(accountId);
      b.assertSignIn(accountId, flow);
      if (!current) throw new RpcError("NOT_FOUND", L("errors.accountGone"));
      b.startAccount(current);
      // still wanted (not turned off while Google's window was open)?
      if (photos && result && (await googlePhotosPending(b.store, accountId))) {
        b.assertSignIn(accountId, flow);
        // what Google granted is the photo state, as for a new account; unticked, it stops waiting (no asking every sign-in)
        const granted = result.grantedScopes ?? [];
        const wanted = [CONTACTS_SCOPE, OTHER_CONTACTS_SCOPE].filter((scope) => granted.includes(scope));
        // Google kept the old grant (no new refresh token): the contacts scopes must be proven on it, as the switch's consent does
        let proven = true;
        if (prepared.pending && wanted.length) {
          try {
            const proved = await prepared.pending.proof.provePhotos(wanted, AbortSignal.any([b.abort.signal, flow.signal]));
            proven = wanted.every((scope) => proved.includes(scope));
          } catch { proven = false; }
          b.assertSignIn(accountId, flow);
        }
        const state = { connections: granted.includes(CONTACTS_SCOPE), otherContacts: granted.includes(OTHER_CONTACTS_SCOPE), apiDisabled: false };
        // unproven: mail is signed in all the same; photos keep waiting for the next sign-in
        if (!proven) {
          /* nothing: still pending */
        } else if (state.connections || state.otherContacts) {
          // on only if still waiting at this instant (switched off during the proof, it stays off)
          const on = await b.credentialWrite(accountId, flow, () => consumeGooglePhotosPending(b.store, accountId, state));
          b.assertSignIn(accountId, flow);
          // listed before the reconnect answers, as the switch's consent does: Settings then shows what Google said (People API off)
          if (on) await b.icons.syncPeople(accountId, state, flow.signal).catch(() => {});
        } else await b.credentialWrite(accountId, flow, () => setGooglePhotosPending(b.store, accountId, false));
        b.assertSignIn(accountId, flow);
      }
      return current;
    });
  } finally { await endSignIn(b, accountId, flow); }
}

/** Owner and exact credential expectation commit as one store transaction. */
export async function changeOwnerTo(b: Backend, accountId: number, password: string | undefined): Promise<OwnerIdentity> {
  const flow = beginSignIn(b, accountId);
  try {
    if (!b.canClaimOwner()) throw new RpcError("BAD_REQUEST", L("errors.demoNoOwner"));
    const account = await b.store.accounts.get(accountId), stamp = await b.store.accounts.stamp(accountId);
    b.assertSignIn(accountId, flow);
    if (!account || !stamp) throw new RpcError("NOT_FOUND", L("errors.accountGone"));
    const config = (await b.store.accounts.config<Record<string, unknown>>(accountId))!.config;
    if (config.demo) throw new RpcError("BAD_REQUEST", L("errors.demoAccountOwner"));
    const current = await b.store.owner.get();
    b.assertSignIn(accountId, flow);
    if (current?.accountId === accountId) throw new RpcError("BAD_REQUEST", L("errors.alreadyOwner", { email: account.email }));
    let claim: Omit<OwnerClaim, "accountId" | "email">;
    let result: GmailConnectResult | undefined;
    let blob: Uint8Array | undefined;
    if (account.kind === "imap") {
      if (!password) throw new RpcError("BAD_REQUEST", L("errors.passwordToVerify"));
      try { await b.options.providers.verifyImap(config as unknown as ImapAccountConfig, password); } catch (error) { throw loginFailed("errors.couldNotVerifyAccount", account.email, error); }
      b.assertSignIn(accountId, flow);
      blob = await encryptCredential(b, password);
      claim = imapClaim(account, config as unknown as ImapAccountConfig, (config as unknown as ImapAccountConfig).senderName || account.displayName);
    } else {
      result = await connectExistingGoogle(b, account, flow);
      if (result.refreshToken !== null) blob = await encryptCredential(b, result.refreshToken);
      claim = gmailClaim({ ...result, name: result.name || (config as unknown as GmailAccountConfig).senderName });
    }
    b.assertSignIn(accountId, flow);
    return await b.credentialFlow(accountId, flow, async () => {
      await sameAccount(b, stamp, flow);
      await b.dropAccount(accountId);
      b.assertSignIn(accountId, flow);
      const prepared = result ? await googleCredentialIntent(b, account, stamp, result, flow, blob) : { intent: { kind: "replace" as const, name: `account:${accountId}:password`, expectedBlob: await credentialSnapshot(b, accountId, flow, "password"), blob: blob! } };
      if (prepared.pending && prepared.pending.proof.expiresAt <= Date.now()) {
        await commitGoogleCredential(b, accountId, stamp, flow, prepared.intent);
        throw invalidRenewal();
      }
      const expiresAt = prepared.pending?.proof.expiresAt;
      const decision: OwnerDecision = { claim: { ...claim, accountId, email: account.email }, stamp, secret: prepared.intent, reason: current ? "changed by user" : "claimed by user", now: b.now() };
      let changed = false, ownerAttempt = true;
      try {
        await b.credentialCommit(accountId, flow, async (active) => {
          changed = await b.store.owner.change({ ...decision, eligible: () => active() && !flow.signal.aborted && b.signIns.get(accountId) === flow && (expiresAt === undefined || Date.now() < expiresAt) });
          if (changed) return true;
          ownerAttempt = false;
          // A refused claim must not strand credentials already proven before admission.
          const recovered = active() && await b.store.secrets.commit(prepared.intent, stamp);
          if (recovered && b.gmailRenewals.get(accountId) === prepared.pending) b.gmailRenewals.delete(accountId);
          return recovered;
        }, () => confirmCredential(b, stamp, prepared.intent, ownerAttempt ? decision : undefined));
      } catch { b.assertSignIn(accountId, flow); throw persistenceFailed(); }
      b.assertSignIn(accountId, flow);
      if (!changed) throw prepared.pending ? invalidRenewal() : persistenceFailed();
      b.gmailRenewals.delete(accountId);
      await b.signedIn(accountId, undefined, flow);
      await b.emitOwner();
      b.assertSignIn(accountId, flow);
      const owner = await b.store.owner.get();
      b.assertSignIn(accountId, flow);
      const fresh = await b.store.accounts.get(accountId);
      b.assertSignIn(accountId, flow);
      if (fresh) b.startAccount(fresh);
      return owner!;
    });
  } finally { await endSignIn(b, accountId, flow); }
}
