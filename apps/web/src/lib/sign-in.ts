/**
 * Plan 25 in the renderer: accounts that need you to sign in again, and signing them in. Two kinds
 * of state, kept apart (Codex review #8):
 *
 * - the incident, per account, while it needs a sign-in: the notice put off ("Later") and the
 *   send notice given. Both end when the account works again (`accountsChanged`), so the next
 *   refusal is news again. Memory only: a restart (or a reload) asks again.
 * - the attempt, per account: busy (the desktop's Google page open in the browser) and the error of
 *   the latest attempt. A newer attempt makes an older one's result say nothing (an abandoned
 *   Google page timing out five minutes later), whether or not the account needed a sign-in
 *   (Settings changes a healthy account's password through the same path).
 */
import type { Account } from "@terno/core";
import { RpcError } from "@terno/core/rpc";
import { t } from "@terno/i18n";
import { create } from "zustand";
import { snack, withdrawSnack } from "~/lib/snack";
import { client } from "~/rpc/connection";
import { getApp, setApp } from "~/state/app";

const WEB = import.meta.env.VITE_TARGET === "web";

export interface Attempt {
  seq: number;
  busy: boolean;
  /** what went wrong, in the user's words; `detail` is the server's own (a refused password) */
  error: { message: string; detail?: string } | null;
}

interface SignInState {
  /** notices put off with "Later", until the account needs a sign-in anew */
  later: ReadonlySet<number>;
  /** accounts whose parked send was announced in this incident */
  announced: ReadonlySet<number>;
  attempts: ReadonlyMap<number, Attempt>;
  /** web: Google's sign-in script (the popup needs the click's activation, so the button waits for it) */
  google: "idle" | "loading" | "ready" | "failed";
  /** the panel, opened from elsewhere (a send's snack): for that account, or every one that needs it */
  request: { accountId: number | null; seq: number } | null;
}

export const useSignIn = create<SignInState>(() => ({ later: new Set(), announced: new Set(), attempts: new Map(), google: "idle", request: null }));

export const needsSignIn = (a: Account): boolean => Boolean(a.syncState.authRequired);
/** a refused SMTP send on an IMAP account: only its sending waits (its mail still syncs) */
export const sendOnly = (a: Account): boolean => a.syncState.authScope === "send";

/** The notice's accounts: those that need a sign-in, less those put off. */
export function noticeAccounts(accounts: readonly Account[], later: ReadonlySet<number>): Account[] {
  return accounts.filter((a) => needsSignIn(a) && !later.has(a.id));
}

const sendSnackId = (accountId: number) => `sign-in-send-${accountId}`;

/** Every `accounts` event: an account that works again ends its incident (and what was said about it). */
export function accountsChanged(accounts: readonly Account[]): void {
  const need = new Set(accounts.filter(needsSignIn).map((a) => a.id));
  const s = useSignIn.getState();
  const over = [...new Set([...s.later, ...s.announced])].filter((id) => !need.has(id));
  if (!over.length) return;
  for (const id of over) if (s.announced.has(id)) withdrawSnack(sendSnackId(id));
  useSignIn.setState({ later: without(s.later, over), announced: without(s.announced, over) });
}

const without = (set: ReadonlySet<number>, ids: number[]) => new Set([...set].filter((id) => !ids.includes(id)));

/** "Later": the notice stops showing these until they need a sign-in anew (their row's key stays). */
export function putOff(ids: readonly number[]): void {
  useSignIn.setState((s) => ({ later: new Set([...s.later, ...ids]) }));
}

/** Opens the sign-in panel from elsewhere (a parked send's snack), even after "Later". */
export function requestSignIn(accountId: number | null): void {
  useSignIn.setState((s) => ({ later: accountId === null ? new Set() : without(s.later, [accountId]), request: { accountId, seq: (s.request?.seq ?? 0) + 1 } }));
}

/**
 * A send waits for this account's sign-in: said once per incident (more parked sends say nothing
 * new), with a way to sign in right there.
 */
export function announceParkedSend(account: Account): void {
  if (useSignIn.getState().announced.has(account.id)) return;
  useSignIn.setState((s) => ({ announced: new Set([...s.announced, account.id]) }));
  snack(t("signIn.sendWaits", { email: account.email }), {
    id: sendSnackId(account.id),
    duration: 10_000,
    background: true,
    action: { label: t("signIn.submit"), onClick: () => requestSignIn(account.id) },
  });
}

// ── Google on the web: loaded before the click (Codex review #9)

let google: typeof import("~/web/google") | null = null;

/** Web: loads Google's sign-in (the module and its script) so a click can open the popup at once. */
export function prepareGoogle(): void {
  if (!WEB) return;
  const state = useSignIn.getState().google;
  if (state === "loading" || state === "ready") return;
  useSignIn.setState({ google: "loading" });
  void import("~/web/google")
    .then(async (m) => {
      await m.preloadGoogle();
      google = m;
      useSignIn.setState({ google: "ready" });
    })
    .catch(() => useSignIn.setState({ google: "failed" }));
}

/** Can this account's sign-in start from a click now? (The web's Google popup needs its script first.) */
export function canStart(account: Account, state: SignInState["google"]): boolean {
  return !(WEB && account.kind === "gmail") || state === "ready";
}

// ── attempts

let seq = 0;

function setAttempt(accountId: number, attempt: Attempt | null): void {
  useSignIn.setState((s) => {
    const attempts = new Map(s.attempts);
    if (attempt) attempts.set(accountId, attempt);
    else attempts.delete(accountId);
    return { attempts };
  });
}

const latest = (accountId: number, mine: number) => useSignIn.getState().attempts.get(accountId)?.seq === mine;

/** What failed, plainly: a refused password says so (the server's words below it), anything else as it came. */
export function attemptError(error: unknown): Attempt["error"] {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof RpcError && error.i18n?.key === "errors.imap.loginFailed") return { message: t("signIn.passwordRefused"), detail: message };
  return { message };
}

/**
 * Signs the account in again: Gmail with Google (the desktop's browser page, or the web's popup,
 * which must be ready), IMAP with the password. True when it worked (the snack says so); the
 * account's row and notice go when the backend says it works.
 */
export async function signInAgain(account: Account, password?: string): Promise<boolean> {
  const mine = ++seq;
  setAttempt(account.id, { seq: mine, busy: true, error: null });
  try {
    if (WEB && account.kind === "gmail") {
      if (!google) throw new Error(t("web.google.loadFailed"));
      await google.connectGmailWeb(account.email, account.id);
    } else {
      await client.call("accounts.reconnect", { id: account.id, password: account.kind === "imap" ? password : undefined });
      // plan 71: photos waiting for this sign-in may have come on: Settings shows the state now (an empty update reads it)
      if ((getApp().settings?.googlePhotosPending ?? []).includes(account.id)) setApp({ settings: await client.call("settings.update", {}) });
    }
    if (!latest(account.id, mine)) return false;
    setAttempt(account.id, null);
    snack.success(t("account.reconnected", { email: account.email }));
    return true;
  } catch (error) {
    // a newer attempt took over (Open again): this one's end says nothing
    if (latest(account.id, mine)) setAttempt(account.id, { seq: mine, busy: false, error: attemptError(error) });
    return false;
  }
}

/** Forgets an attempt's error (the user typed again, or closed the panel). */
export function clearAttemptError(accountId: number): void {
  const a = useSignIn.getState().attempts.get(accountId);
  if (a && !a.busy) setAttempt(accountId, null);
}

/** tests */
export function resetSignIn(): void {
  seq = 0;
  google = null;
  useSignIn.setState({ later: new Set(), announced: new Set(), attempts: new Map(), google: "idle", request: null });
}
