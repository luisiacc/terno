import type { Account } from "@terno/core";
import { t } from "@terno/i18n";
import { client } from "~/rpc/connection";
import { webBuiltInClientId } from "~/lib/google-client";

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
/** the same scopes as desktop (@terno/mail's GMAIL_SCOPES, pinned by plan 258's tests): Terno asks for nothing else */
const GMAIL_SCOPES = ["openid", "email", "profile", "https://www.googleapis.com/auth/gmail.modify"];
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

function accessToken(clientId: string, loginHint?: string): Promise<TokenResponse> {
  return new Promise((resolve, reject) => {
    const invalid = () => new Error(t("errors.google.invalidResponse"));
    try {
      const tokens = window.google!.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: GMAIL_SCOPES.join(" "),
        login_hint: loginHint,
        // plan 258: Google's default is true, which would carry an older grant (plan 22's contacts) into this token
        include_granted_scopes: false,
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
              typeof r.scope !== "string" || !r.scope.trim()) throw invalid();
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
      tokens.requestAccessToken({ prompt: loginHint ? "" : "consent" });
    } catch { reject(new Error(t("errors.google.unavailable"))); }
  });
}

/**
 * Connects Gmail (or renews an account's hour-long access) with Terno's
 * own OAuth client ID of type "Web application" (plan 123: the only one). There is no refresh token
 * without a server: the token goes to the worker's memory and is never stored.
 * With `accountId` (signing that account in again, plan 25) the token must be
 * that account's: another Google account picked in the popup changes nothing.
 * `syncWindowDays` (plan 79, Add account): the days a new mailbox downloads.
 */
export async function connectGmailWeb(loginHint?: string, accountId?: number, o: { syncWindowDays?: number } = {}): Promise<Account> {
  const clientId = webBuiltInClientId();
  if (!clientId) throw Object.assign(new Error(t("errors.google.noClientWeb")), { i18n: { key: "errors.google.noClientWeb" } });
  await preloadGoogle();
  const adding = loginHint === undefined && accountId === undefined;
  const token = await accessToken(clientId, loginHint);
  return client.call("accounts.connectGmailToken", { accessToken: token.access_token, expiresIn: token.expires_in, ...(accountId !== undefined && { accountId }), ...(adding && o.syncWindowDays !== undefined && { syncWindowDays: o.syncWindowDays }) });
}
