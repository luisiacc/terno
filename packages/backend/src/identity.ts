import { SecretUnreadableError } from "./keychain";
import { log } from "@terno/core/diag";
import { isOAuthKind, isValidEmail, messageOf, OAUTH_SUBJECT, signInMethod, unhandled, type Account } from "@terno/core";
import { RpcError, type OwnerIdentity } from "@terno/core/rpc";
import { L } from "@terno/i18n";
import type { OAuthAdmission, OwnerClaim, OwnerDecision, SecretIntent } from "@terno/store";
import { microsoftMailGranted, oauthToken, type GmailAccountConfig, type GmailConnectResult, type GmailRenewalProof, type ImapAccountConfig, type MicrosoftConnectResult, type OutlookAccountConfig } from "@terno/mail/portable";
import type { BackendCore as Backend } from "./core";
import { oauthClientFor, rememberedClient } from "./oauth-clients";

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

const MICROSOFT_SUBJECT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Plan 259: Microsoft's sign-in crosses the registry boundary too; only a well-formed identity with mail is kept. */
export function validateMicrosoftConnection(result: unknown): asserts result is MicrosoftConnectResult {
  const value = result as Record<string, unknown> | null;
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    typeof value.email !== "string" || value.email.length > 254 || !isValidEmail(value.email) || /\p{Cc}/u.test(value.email) ||
    typeof value.name !== "string" ||
    typeof value.subject !== "string" || !MICROSOFT_SUBJECT.test(value.subject) ||
    (value.tenant !== "consumers" && value.tenant !== "organizations") ||
    !oauthToken(value.refreshToken) ||
    !Array.isArray(value.grantedScopes) || !value.grantedScopes.every((scope) => typeof scope === "string") ||
    (value.username !== undefined && (typeof value.username !== "string" || !value.username || value.username.length > 254 || /[\s\p{Cc}]/u.test(value.username)))) throw new RpcError("BAD_REQUEST", L("errors.microsoft.invalidResponse"));
  if (!microsoftMailGranted(value.grantedScopes as string[])) throw new RpcError("BAD_REQUEST", L("errors.microsoft.mailScopeRequired"));
}

export function microsoftFlowActive(b: Backend): void {
  if (b.abort.signal.aborted) throw new RpcError("BAD_REQUEST", L("errors.microsoft.cancelled"));
}

export function microsoftClaim(result: Pick<MicrosoftConnectResult, "name" | "subject" | "tenant">): Omit<OwnerClaim, "accountId" | "email"> {
  return {
    displayName: result.name,
    provider: "outlook",
    verifiedBy: "microsoft_oauth",
    evidence: { microsoftSubject: result.subject, tenant: result.tenant },
  };
}

/** What an OAuth sign-in hands the credential commit: the refresh token (Google may omit it) and the subject it proved. */
export interface OAuthGrant {
  refreshToken: string | null;
  sub: string;
}

export interface PendingGmailRenewal {
  stamp: { id: number; email: string; createdAt: number };
  expectedBlob: Uint8Array;
  proof: GmailRenewalProof;
  verified: boolean;
  subject?: string;
  blob?: Uint8Array;
}

const signInVersions = new WeakMap<Backend, Map<number, number>>();
export function forgetSignInVersion(b: Backend, accountId: number): void { signInVersions.get(b)?.delete(accountId); }
export function signInVersion(b: Backend, accountId: number): number { return signInVersions.get(b)?.get(accountId) ?? 0; }

export function beginSignIn(b: Backend, accountId: number): AbortController {
  let versions = signInVersions.get(b);
  if (!versions) signInVersions.set(b, versions = new Map());
  versions.set(accountId, signInVersion(b, accountId) + 1);
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

/** Plan 293: a keychain failure is the one generic SecretStorageError, recorded; never what the keychain said. */
export function encryptCredential(b: Backend, accountId: number, key: "refreshToken" | "password", value: string): Promise<Uint8Array> {
  return b.secrets.seal(`account:${accountId}:${key}`, value, "signIn");
}

/** Records a sign-in's credential write once its commit returned (plan 293); a retained credential wrote nothing. */
function recordCommit(b: Backend, intent: SecretIntent, outcome: "ok" | "refused" | "failed"): void {
  if (intent.kind !== "replace") return;
  b.secrets.committed("write", intent.name, "signIn", outcome);
  // plan 293 (CASA 6.5.1): the sign-in's last step, its credentials stored sealed
  const accountId = Number(/^account:(\d+):refreshToken$/.exec(intent.name)?.[1]);
  if (outcome === "ok" && accountId) log.info("signin.stored", { provider: intent.oauth?.kind === "outlook" ? "microsoft" : "google", encrypted: true, accountId });
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

/**
 * Called after old provider drain, under the account's finalization owner. A new refresh token replaces the stored
 * one (every OAuth kind); only Google may omit it, and then proves the stored grant with a cold renewal.
 */
export async function oauthCredentialIntent(b: Backend, account: Account, stamp: { id: number; email: string; createdAt: number }, result: OAuthGrant, flow: AbortController, freshBlob?: Uint8Array): Promise<{ intent: SecretIntent; pending?: PendingGmailRenewal }> {
  await sameAccount(b, stamp, flow);
  const name = `account:${account.id}:refreshToken`;
  const current = await credentialSnapshot(b, account.id, flow, "refreshToken");
  if (result.refreshToken !== null) {
    b.gmailRenewals.delete(account.id);
    return { intent: { kind: "replace", name, expectedBlob: current, blob: freshBlob! } };
  }
  if (account.kind !== "gmail" || !current || !b.options.providers.beginGmailRenewal) throw invalidRenewal();
  let pending = b.gmailRenewals.get(account.id);
  if (pending && (pending.stamp.email !== stamp.email || pending.stamp.createdAt !== stamp.createdAt || (!sameBytes(current, pending.expectedBlob) && !(pending.blob && sameBytes(current, pending.blob))))) {
    b.gmailRenewals.delete(account.id);
    pending = undefined;
  }
  if (!pending) {
    let refreshToken: string | null;
    // plan 293 (Codex code review #10): a keychain failure keeps its one fixed category, never "invalid response"
    try { refreshToken = await b.getSecret(name, "renewal"); } catch (error) { throw error instanceof SecretUnreadableError ? error : invalidRenewal(); }
    b.assertSignIn(account.id, flow);
    if (!refreshToken) throw invalidRenewal();
    // getSecret honors the keychain migration fingerprint. Assert the exact ciphertext again before exchange.
    const latest = await credentialSnapshot(b, account.id, flow, "refreshToken");
    if (!sameBytes(latest, current)) throw persistenceFailed();
    b.assertSignIn(account.id, flow);
    // plan 99: the stored grant belongs to the account's own client (the one this sign-in used)
    const oauth = await oauthClientFor(b, "google", await rememberedClient(b, account.id, "google")).catch(() => null);
    b.assertSignIn(account.id, flow);
    if (!oauth) throw invalidRenewal();
    let proof: GmailRenewalProof;
    try { proof = await b.options.providers.beginGmailRenewal({ clientId: oauth.clientId, clientSecret: oauth.clientSecret, refreshToken, fetch: b.net.fetchFor("mail"), signal: AbortSignal.any([b.abort.signal, flow.signal]) }); }
    catch { throw invalidRenewal(); }
    b.assertSignIn(account.id, flow);
    if (!proof || typeof proof.refreshToken !== "string" || proof.refreshToken.length > 4096 || !/^[\x21-\x7e]+$/.test(proof.refreshToken) || !Number.isFinite(proof.expiresAt) || typeof proof.inspect !== "function") throw invalidRenewal();
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
    // plan 293: a keychain failure here is the one generic SecretStorageError
    const old = await b.secrets.open(name, pending.expectedBlob, "renewal");
    b.assertSignIn(account.id, flow);
    pending.blob = old === pending.proof.refreshToken ? pending.expectedBlob : await encryptCredential(b, account.id, "refreshToken", pending.proof.refreshToken);
    b.assertSignIn(account.id, flow);
  }
  // A commit may have succeeded before its adapter threw. Never restore the old bytes.
  if (sameBytes(current, pending.blob)) return { intent: { kind: "retain", name, expectedBlob: current }, pending };
  return { intent: { kind: "replace", name, expectedBlob: pending.expectedBlob, blob: pending.blob }, pending };
}

async function confirmCredential(b: Backend, stamp: { id: number; email: string; createdAt: number }, intent: SecretIntent, owner?: OwnerDecision): Promise<boolean> {
  return owner ? b.store.owner.confirm(owner) : b.store.secrets.commit({ kind: "retain", oauth: intent.oauth && { kind: intent.oauth.kind, expectedSubject: intent.oauth.subject, subject: intent.oauth.subject }, name: intent.name, expectedBlob: intent.kind === "retain" ? intent.expectedBlob : intent.blob }, stamp);
}

export async function commitGoogleCredential(b: Backend, accountId: number, stamp: { id: number; email: string; createdAt: number }, flow: AbortController, intent: SecretIntent): Promise<void> {
  await sameAccount(b, stamp, flow);
  let committed: boolean;
  try { committed = await b.credentialCommit(accountId, flow, (active) => b.store.secrets.commit({ ...intent, oauth: intent.oauth && { ...intent.oauth, eligible: () => active() && (!intent.oauth!.eligible || intent.oauth!.eligible()) } }, stamp), () => confirmCredential(b, stamp, intent)); }
  catch { recordCommit(b, intent, "failed"); b.assertSignIn(accountId, flow); throw persistenceFailed(); }
  recordCommit(b, intent, committed ? "ok" : "refused");
  b.assertSignIn(accountId, flow);
  if (!committed) { b.gmailRenewals.delete(accountId); throw persistenceFailed(); }
  b.gmailRenewals.delete(accountId);
}

/** What an OAuth account's sign-in must still find stored when it commits: the subject under its kind's key (plan 259). */
export async function oauthAdmission(b: Backend, accountId: number, flow: AbortController): Promise<Omit<OAuthAdmission, "subject"> & { stamp: { id: number; email: string; createdAt: number } }> {
  const generation = b.credentialsOf(accountId);
  const stamp = await b.store.accounts.stamp(accountId);
  const account = await b.store.accounts.get(accountId);
  const stored = await b.store.accounts.config<Record<string, unknown>>(accountId);
  b.assertSignIn(accountId, flow);
  if (!stored || !stamp || !account || !isOAuthKind(account.kind)) throw new RpcError("NOT_FOUND", L("errors.accountGone"));
  const key = OAUTH_SUBJECT[account.kind], subject = stored.config[key];
  if (Object.hasOwn(stored.config, key) && (typeof subject !== "string" || !subject || subject.length > 255 || /[\s\p{Cc}]/u.test(subject))) throw invalidRenewal();
  return { stamp, kind: account.kind, expectedSubject: (subject as string | undefined) ?? null, eligible: () => {
    try { b.assertSignIn(accountId, flow); } catch { return false; }
    return b.credentialsOf(accountId) === generation;
  } };
}

export async function connectExistingGoogle(b: Backend, account: Account, flow: AbortController): Promise<GmailConnectResult> {
  if (b.options.providers.gmailTokens) throw new RpcError("UNAVAILABLE", L("errors.gmailReconnectInBrowser"));
  // plan 99: an account signs in again with the client that connected it (its refresh token works with no other)
  const remembered = await rememberedClient(b, account.id, "google");
  const oauth = await oauthClientFor(b, "google", remembered);
  b.assertSignIn(account.id, flow);
  if (!oauth) throw new RpcError("BAD_REQUEST", L(remembered ? "errors.google.clientGone" : "errors.google.noClient"));
  if (!b.options.openExternal) throw new RpcError("UNAVAILABLE", L("errors.googleConnectNeedsDesktop"));
  let result: GmailConnectResult;
  try { result = await b.options.providers.connectGmail({ clientId: oauth.clientId, clientSecret: oauth.clientSecret, openExternal: b.options.openExternal, signal: AbortSignal.any([b.abort.signal, flow.signal]), fetch: b.net.fetchFor("mail"), loginHint: account.email, allowOmittedRefreshToken: true }); }
  catch { b.assertSignIn(account.id, flow); throw invalidRenewal(); }
  b.assertSignIn(account.id, flow);
  validateGoogleConnection(result, "renewal");
  if (result.email.toLowerCase() !== account.email.toLowerCase()) throw new RpcError("BAD_REQUEST", L("errors.googleConnectedOther", { got: result.email, expected: account.email }));
  return result;
}

/**
 * Plan 259: an Outlook account signs in again with the app registration that connected it, its address pre-filled.
 * Microsoft always issues a refresh token with offline_access, so there is no cold renewal beside it; its refusals
 * (denied, an administrator's approval) reach the person in its own words.
 */
export async function connectExistingMicrosoft(b: Backend, account: Account, flow: AbortController): Promise<MicrosoftConnectResult> {
  const connect = b.options.providers.connectMicrosoft;
  if (!connect || !b.options.openExternal) throw new RpcError("UNAVAILABLE", L("errors.microsoft.needsDesktop"));
  const remembered = await rememberedClient(b, account.id, "microsoft");
  const oauth = await oauthClientFor(b, "microsoft", remembered);
  // plan 259 stage 2b: the name the person signs in with, as Microsoft last said it (a work account's can differ from
  // its mailbox address), else the address
  const username = (await b.store.accounts.config<Partial<OutlookAccountConfig>>(account.id))?.config.microsoftUsername;
  b.assertSignIn(account.id, flow);
  if (!oauth) throw new RpcError("BAD_REQUEST", L(remembered ? "errors.microsoft.clientGone" : "errors.microsoft.noClient"));
  let result: MicrosoftConnectResult;
  // through the request ledger, as a new sign-in is: a pause on Microsoft's token service holds this one too (review round 4)
  const requests = await b.initialOAuthRequests("outlook", true, account.id);
  try { result = await connect({ clientId: oauth.clientId, openExternal: b.options.openExternal, signal: AbortSignal.any([b.abort.signal, flow.signal]), fetch: b.net.fetchFor("mail"), requests, loginHint: typeof username === "string" && username ? username : account.email }); }
  catch (error) { b.assertSignIn(account.id, flow); throw error; }
  finally { requests.close(); }
  b.assertSignIn(account.id, flow);
  validateMicrosoftConnection(result);
  if (result.email.toLowerCase() !== account.email.toLowerCase()) throw new RpcError("BAD_REQUEST", L("errors.microsoft.connectedOther", { got: result.email, expected: account.email }));
  return result;
}

/** Plan 259 stage 2b: an Outlook account's sign-in name, kept for the next sign-in's hint when it changed (a hint only). */
async function rememberMicrosoftUsername(b: Backend, accountId: number, username: string): Promise<void> {
  const stored = await b.store.accounts.config<Partial<OutlookAccountConfig>>(accountId);
  if (!stored || stored.config.microsoftUsername === username) return;
  await b.store.accounts.setProviderConfig(accountId, { ...stored.config, microsoftUsername: username });
}

/** The account's OAuth sign-in, whichever provider: its grant, checked against the subject the account keeps. */
async function signInAgain(b: Backend, account: Account, flow: AbortController, method: "google" | "microsoft", expectedSubject: string | null): Promise<{ grant: OAuthGrant; blob?: Uint8Array; google?: GmailConnectResult; microsoft?: MicrosoftConnectResult }> {
  if (method === "google") {
    const google = await connectExistingGoogle(b, account, flow);
    if (expectedSubject !== null && expectedSubject !== google.sub) throw invalidRenewal();
    return { grant: { refreshToken: google.refreshToken, sub: google.sub! }, blob: google.refreshToken !== null ? await encryptCredential(b, account.id, "refreshToken", google.refreshToken) : undefined, google };
  }
  const microsoft = await connectExistingMicrosoft(b, account, flow);
  // another person behind the same address (a recreated mailbox): never this account's
  if (expectedSubject !== null && expectedSubject !== microsoft.subject) throw new RpcError("BAD_REQUEST", L("errors.microsoft.invalidResponse"));
  return { grant: { refreshToken: microsoft.refreshToken, sub: microsoft.subject }, blob: await encryptCredential(b, account.id, "refreshToken", microsoft.refreshToken), microsoft };
}

/** Explicit credential changes retain one owner through preparation, durable commit and state publication. */
export async function reconnectAccount(b: Backend, accountId: number, password: string | undefined): Promise<Account> {
  const flow = beginSignIn(b, accountId);
  try {
    const account = await b.store.accounts.get(accountId), stamp = await b.store.accounts.stamp(accountId);
    b.assertSignIn(accountId, flow);
    if (!account || !stamp) throw new RpcError("NOT_FOUND", L("errors.accountGone"));
    // plan 184: each kind's way, named in SIGN_IN (a new kind can't compile without one)
    const method = signInMethod(account.kind);
    const admission = method !== "password" ? await oauthAdmission(b, accountId, flow) : undefined;
    let grant: OAuthGrant | undefined;
    let blob: Uint8Array | undefined;
    let username: string | undefined;
    switch (method) {
    case "password": {
      if (!b.host.capabilities.imap) throw new RpcError("UNAVAILABLE", L("errors.imapNeedsDesktop"));
      if (!password) throw new RpcError("BAD_REQUEST", L("errors.passwordRequired"));
      const config = (await b.store.accounts.config<ImapAccountConfig>(accountId))!.config;
      try { await b.options.providers.verifyImap(config, password); } catch (error) { throw loginFailed("errors.couldNotConnectAccount", account.email, error); }
      b.assertSignIn(accountId, flow);
      blob = await encryptCredential(b, accountId, "password", password);
      break;
    }
    case "google":
    case "microsoft": {
      const signed = await signInAgain(b, account, flow, method, admission!.expectedSubject);
      ({ grant, blob } = signed);
      username = signed.microsoft?.username;
      break;
    }
    default: unhandled(method);
    }
    b.assertSignIn(accountId, flow);
    return await b.credentialFlow(accountId, flow, async () => {
      await sameAccount(b, stamp, flow);
      await b.dropAccount(accountId);
      b.assertSignIn(accountId, flow);
      // plan 259 stage 2b (Codex code review #11): the sign-in name Microsoft gave now is the next sign-in's hint, kept
      // while the account's sync is stopped (its cursor shares the config)
      if (username) await rememberMicrosoftUsername(b, accountId, username);
      const prepared = grant ? await oauthCredentialIntent(b, account, stamp, grant, flow, blob) : { intent: { kind: "replace" as const, name: `account:${accountId}:password`, expectedBlob: await credentialSnapshot(b, accountId, flow, "password"), blob: blob! } };
      if (grant) prepared.intent.oauth = { ...admission!, subject: grant.sub };
      await commitGoogleCredential(b, accountId, stamp, flow, prepared.intent);
      if (prepared.pending && prepared.pending.proof.expiresAt <= Date.now()) throw invalidRenewal();
      await b.signedIn(accountId, undefined, flow);
      const current = await b.store.accounts.get(accountId);
      b.assertSignIn(accountId, flow);
      if (!current) throw new RpcError("NOT_FOUND", L("errors.accountGone"));
      b.startAccount(current);
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
    const method = signInMethod(account.kind);
    const admission = method !== "password" ? await oauthAdmission(b, accountId, flow) : undefined;
    let grant: OAuthGrant | undefined;
    let blob: Uint8Array | undefined;
    switch (method) {
    case "password":
      if (!password) throw new RpcError("BAD_REQUEST", L("errors.passwordToVerify"));
      try { await b.options.providers.verifyImap(config as unknown as ImapAccountConfig, password); } catch (error) { throw loginFailed("errors.couldNotVerifyAccount", account.email, error); }
      b.assertSignIn(accountId, flow);
      blob = await encryptCredential(b, accountId, "password", password);
      claim = imapClaim(account, config as unknown as ImapAccountConfig, (config as unknown as ImapAccountConfig).senderName || account.displayName);
      break;
    case "google": {
      const signedIn = await signInAgain(b, account, flow, method, admission!.expectedSubject);
      ({ grant, blob } = signedIn);
      claim = gmailClaim({ ...signedIn.google!, name: signedIn.google!.name || (config as unknown as GmailAccountConfig).senderName });
      break;
    }
    case "microsoft": {
      const signedIn = await signInAgain(b, account, flow, method, admission!.expectedSubject);
      ({ grant, blob } = signedIn);
      claim = microsoftClaim({ ...signedIn.microsoft!, name: signedIn.microsoft!.name || (config as unknown as OutlookAccountConfig).senderName });
      break;
    }
    default: unhandled(method);
    }
    b.assertSignIn(accountId, flow);
    return await b.credentialFlow(accountId, flow, async () => {
      await sameAccount(b, stamp, flow);
      await b.dropAccount(accountId);
      b.assertSignIn(accountId, flow);
      const prepared = grant ? await oauthCredentialIntent(b, account, stamp, grant, flow, blob) : { intent: { kind: "replace" as const, name: `account:${accountId}:password`, expectedBlob: await credentialSnapshot(b, accountId, flow, "password"), blob: blob! } };
      if (grant) prepared.intent.oauth = { ...admission!, subject: grant.sub };
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
      } catch { recordCommit(b, prepared.intent, "failed"); b.assertSignIn(accountId, flow); throw persistenceFailed(); }
      recordCommit(b, prepared.intent, changed ? "ok" : "refused");
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

/** Browser consent persists identity before publishing its volatile access credential. */
export async function admitBrowserGoogle(b: Backend, account: Account, who: { sub: string | null; email: string }, accessToken: string, expiresAt: number, flow: AbortController, admission: Omit<OAuthAdmission, "subject"> & { stamp: { id: number; email: string; createdAt: number } }): Promise<void> {
  const stamp = admission.stamp;
  if (!stamp) throw new RpcError("NOT_FOUND", L("errors.accountGone"));
  if (who.email.toLowerCase() !== stamp.email.toLowerCase() || (admission.expectedSubject !== null && admission.expectedSubject !== who.sub)) throw invalidRenewal();
  const google: OAuthAdmission = { ...admission, subject: who.sub!, eligible: () => {
    try { b.assertSignIn(account.id, flow); } catch { return false; }
    return expiresAt > b.now() && (!admission.eligible || admission.eligible());
  } };
  await b.credentialFlow(account.id, flow, async () => {
    await sameAccount(b, stamp, flow);
    if (!google.eligible!()) throw invalidRenewal();
    await b.dropAccount(account.id);
    const admitted = await b.credentialCommit(account.id, flow, (active) => b.store.accounts.admitOAuth(stamp, { ...google, eligible: () => active() && google.eligible!() }));
    if (!admitted) throw persistenceFailed();
    b.assertSignIn(account.id, flow);
    await b.signedIn(account.id, () => {
      b.assertSignIn(account.id, flow);
      if (expiresAt <= b.now()) throw invalidRenewal();
      b.options.providers.gmailTokens!.set(account.id, accessToken, expiresAt);
    }, flow);
  });
}
