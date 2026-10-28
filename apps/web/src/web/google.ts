import type { Account } from "@terno/core";
import { t } from "@terno/i18n";
import { client } from "~/rpc/connection";
import { getApp, setApp } from "~/state/app";

/** Google Identity Services' token model: the subset Terno uses. */
interface TokenResponse {
  access_token: string;
  expires_in: number | string;
  scope: string;
  error?: string;
  error_description?: string;
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
            callback: (r: TokenResponse) => void;
            error_callback?: (e: { type: string; message?: string }) => void;
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

function accessToken(clientId: string, loginHint?: string, scopes = GMAIL_SCOPES): Promise<TokenResponse> {
  return new Promise((resolve, reject) => {
    const tokens = window.google!.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: scopes.join(" "),
      login_hint: loginHint,
      include_granted_scopes: true,
      callback: (r) => (r.error ? reject(new Error(r.error_description || r.error)) : resolve(r)),
      error_callback: (e) => reject(new Error(e.type === "popup_closed" ? t("web.google.popupClosed") : e.type === "popup_failed_to_open" ? t("web.google.popupBlocked") : (e.message ?? e.type))),
    });
    tokens.requestAccessToken({ prompt: loginHint ? "" : "consent" });
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
  const token = await accessToken(clientId, loginHint, adding ? [...GMAIL_SCOPES, ...PHOTO_SCOPES] : GMAIL_SCOPES);
  const granted = token.scope.split(" ");
  if (!granted.includes("https://www.googleapis.com/auth/gmail.modify")) throw new Error(t("web.google.noGmailScope"));
  const expiresIn = Number(token.expires_in) || 3600;
  const account = await client.call("accounts.connectGmailToken", { accessToken: token.access_token, expiresIn, ...(accountId !== undefined && { accountId }) });
  if (adding && PHOTO_SCOPES.some((scope) => granted.includes(scope)) && !getApp().settings?.googlePhotos[String(account.id)]) {
    // photos are extra: the account is connected even if this fails
    await client.call("icons.authorizeGoogle", { accountId: account.id, accessToken: token.access_token, expiresIn, scope: token.scope }).then((settings) => setApp({ settings }), () => {});
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
  const token = await new Promise<TokenResponse>((resolve, reject) => {
    const tokens = window.google!.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: [...GMAIL_SCOPES, ...PHOTO_SCOPES].join(" "),
      login_hint: account.email,
      include_granted_scopes: true,
      callback: (r) => (r.error ? reject(new Error(r.error_description || r.error)) : resolve(r)),
      error_callback: (e) => reject(new Error(e.type === "popup_closed" ? t("web.google.popupClosed") : e.type === "popup_failed_to_open" ? t("web.google.popupBlocked") : (e.message ?? e.type))),
    });
    tokens.requestAccessToken({ prompt: "consent", login_hint: account.email });
  });
  setApp({ settings: await client.call("icons.authorizeGoogle", { accountId: account.id, accessToken: token.access_token, expiresIn: Number(token.expires_in) || 3600, scope: token.scope }) });
}
