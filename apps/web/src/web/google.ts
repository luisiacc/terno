import type { Account } from "@terno/core";
import { t } from "@terno/i18n";
import { client } from "~/rpc/connection";
import { getApp, setApp } from "~/state/app";

/** Google Identity Services' token model: the subset Terno uses. */
interface TokenResponse {
  access_token: string;
  expires_in: number;
  scope: string;
}
interface TokenClient {
  requestAccessToken(o?: { prompt?: string; login_hint?: string }): void;
}
declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient(config: {
            client_id: string;
            scope: string;
            login_hint?: string;
            include_granted_scopes?: boolean;
            callback: (r: unknown) => void;
            error_callback?: (e: unknown) => void;
          }): TokenClient;
        };
      };
    };
  }
}

const GIS = "https://accounts.google.com/gsi/client";
/** the same scopes as desktop (@terno/mail's GMAIL_SCOPES) */
const GMAIL_SCOPES = ["openid", "email", "profile", "https://www.googleapis.com/auth/gmail.modify"];
/** plan 22: the two contacts scopes (@terno/mail's CONTACTS_SCOPE, OTHER_CONTACTS_SCOPE) */
const PHOTO_SCOPES = ["https://www.googleapis.com/auth/contacts.readonly", "https://www.googleapis.com/auth/contacts.other.readonly"];
let loading: Promise<void> | null = null;

/** Loads Google's sign-in script (allowed by the web build's CSP). Call it before the click: the popup needs the click's activation. */
export function preloadGoogle(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  loading ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = GIS;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      loading = null;
      reject(new Error(t("web.google.loadFailed")));
    };
    document.head.append(script);
  });
  return loading;
}

function accessToken(clientId: string, loginHint?: string, scopes = GMAIL_SCOPES, photo = false): Promise<TokenResponse> {
  return new Promise((resolve, reject) => {
    const invalid = () => new Error(t("errors.google.invalidResponse"));
    try {
      const tokens = window.google!.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: scopes.join(" "),
        login_hint: loginHint,
        include_granted_scopes: true,
        callback: (value) => {
          try {
            if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
            const r = value as Record<string, unknown>;
            if (r.error !== undefined) {
              if (typeof r.error !== "string" || !r.error) throw invalid();
              throw new Error(t(r.error === "access_denied" ? "errors.google.denied" : r.error === "admin_policy_enforced" ? "errors.google.adminPolicy" : "errors.google.unavailable"));
            }
            const expiresIn = typeof r.expires_in === "number" ? r.expires_in : typeof r.expires_in === "string" && /^\d+$/.test(r.expires_in) ? Number(r.expires_in) : NaN;
            if (typeof r.access_token !== "string" || r.access_token.length > 4096 || !/^[\x21-\x7e]+$/.test(r.access_token) ||
              !Number.isInteger(expiresIn) || expiresIn < 60 || expiresIn > 86_400 ||
              typeof r.scope !== "string" || !r.scope.trim() || (photo && r.scope.length > 2000)) throw invalid();
            if (!r.scope.split(/\s+/).includes(GMAIL_SCOPES[3]!)) throw new Error(t("web.google.noGmailScope"));
            resolve({ access_token: r.access_token, expires_in: expiresIn, scope: r.scope });
          } catch (error) {
            reject(error instanceof Error && [t("errors.google.invalidResponse"), t("errors.google.denied"), t("errors.google.adminPolicy"), t("errors.google.unavailable"), t("web.google.noGmailScope")].includes(error.message) ? error : invalid());
          }
        },
        error_callback: (value) => {
          try {
            const type = value && typeof value === "object" ? (value as { type?: unknown }).type : undefined;
            reject(new Error(t(type === "popup_closed" ? "web.google.popupClosed" : type === "popup_failed_to_open" ? "web.google.popupBlocked" : "errors.google.unavailable")));
          } catch { reject(new Error(t("errors.google.unavailable"))); }
        },
      });
      tokens.requestAccessToken(photo ? { prompt: "consent", login_hint: loginHint } : { prompt: loginHint ? "" : "consent" });
    } catch { reject(new Error(t("errors.google.unavailable"))); }
  });
}

/**
 * Connects Gmail (or renews an account's hour-long access) with the user's
 * own OAuth client ID of type "Web application". There is no refresh token
 * without a server: the token goes to the worker's memory and is never stored.
 * With `accountId` (signing that account in again, plan 25) the token must be
 * that account's: another Google account picked in the popup changes nothing.
 */
export async function connectGmailWeb(loginHint?: string, accountId?: number): Promise<Account> {
  const clientId = getApp().settings?.gmailClientId;
  if (!clientId) throw Object.assign(new Error(t("errors.gmailClientIdMissing")), { i18n: { key: "errors.gmailClientIdMissing" } });
  await preloadGoogle();
  // plan 22: a new account asks for photos from Google too (the user can untick them on Google's screen)
  const adding = loginHint === undefined && accountId === undefined;
  // plan 71: an account whose photos wait for this sign-in asks for them too
  // the accounts waiting before Google's popup: their consent is read again by the backend (switched off meanwhile, it counts for nothing)
  const waitedBefore = new Set(getApp().settings?.googlePhotosPending ?? []);
  const pending = accountId !== undefined && waitedBefore.has(accountId);
  const token = await accessToken(clientId, loginHint, adding || pending ? [...GMAIL_SCOPES, ...PHOTO_SCOPES] : GMAIL_SCOPES);
  const granted = token.scope.split(/\s+/);
  const expiresIn = token.expires_in;
  const account = await client.call("accounts.connectGmailToken", { accessToken: token.access_token, expiresIn, ...(accountId !== undefined && { accountId }) });
  // still wanted after Google's popup (not turned off meanwhile); Add account may have reached a waiting mailbox too
  const waited = waitedBefore.has(account.id);
  const stillPending = waited && (getApp().settings?.googlePhotosPending ?? []).includes(account.id);
  if ((adding || stillPending) && token.scope.length <= 2000 && PHOTO_SCOPES.some((scope) => granted.includes(scope)) && !getApp().settings?.googlePhotos[String(account.id)]) {
    // photos are extra: the account is connected even if this fails
    await client.call("icons.authorizeGoogle", { accountId: account.id, accessToken: token.access_token, expiresIn, scope: token.scope, ...(waited && { ifPending: true }) }).then((settings) => setApp({ settings }), () => {});
  } else if (stillPending) {
    // unticked on Google's screen: it stops waiting (no asking at every sign-in)
    await client.call("icons.googlePhotos", { accountId: account.id, on: false }).then((settings) => setApp({ settings }), () => {});
  }
  return account;
}

/**
 * Plan 22: photos from Google for an account. Google's popup asks for the contacts scopes beside
 * mail's (granted ones kept), for that address; the token goes to that account only, never
 * creating one, and later reconnects carry the same grant (include_granted_scopes).
 */
export async function authorizeGooglePhotosWeb(account: Account): Promise<void> {
  const clientId = getApp().settings?.gmailClientId;
  if (!clientId) throw Object.assign(new Error(t("errors.gmailClientIdMissing")), { i18n: { key: "errors.gmailClientIdMissing" } });
  await preloadGoogle();
  const token = await accessToken(clientId, account.email, [...GMAIL_SCOPES, ...PHOTO_SCOPES], true);
  setApp({ settings: await client.call("icons.authorizeGoogle", { accountId: account.id, accessToken: token.access_token, expiresIn: token.expires_in, scope: token.scope }) });
}
