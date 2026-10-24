import type { Account } from "@terno/core";
import { client } from "~/rpc/connection";
import { getApp } from "~/state/app";

/** Google Identity Services' token model: the subset Única uses. */
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
      reject(new Error("No se pudo cargar el inicio de sesión de Google (¿sin conexión?)"));
    };
    document.head.append(script);
  });
  return loading;
}

function accessToken(clientId: string, loginHint?: string): Promise<TokenResponse> {
  return new Promise((resolve, reject) => {
    const tokens = window.google!.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: GMAIL_SCOPES.join(" "),
      login_hint: loginHint,
      include_granted_scopes: true,
      callback: (r) => (r.error ? reject(new Error(r.error_description || r.error)) : resolve(r)),
      error_callback: (e) => reject(new Error(e.type === "popup_closed" ? "Se cerró la ventana de Google" : e.type === "popup_failed_to_open" ? "El navegador bloqueó la ventana de Google" : (e.message ?? e.type))),
    });
    tokens.requestAccessToken({ prompt: loginHint ? "" : "consent" });
  });
}

/**
 * Connects Gmail (or renews an account's hour-long access) with the user's
 * own OAuth client ID of type "Web application". There is no refresh token
 * without a server: the token goes to the worker's memory and is never stored.
 */
export async function connectGmailWeb(loginHint?: string): Promise<Account> {
  const clientId = getApp().settings?.gmailClientId;
  if (!clientId) throw new Error("Añade tu Google OAuth Client ID en Ajustes → Cuentas primero (client ID).");
  await preloadGoogle();
  const token = await accessToken(clientId, loginHint);
  if (!token.scope.split(" ").includes("https://www.googleapis.com/auth/gmail.modify")) throw new Error("Google no concedió el permiso de Gmail: vuelve a intentarlo y márcalo.");
  return client.call("accounts.connectGmailToken", { accessToken: token.access_token, expiresIn: Number(token.expires_in) || 3600 });
}
