// Plan 259: the RFC 8252 installed-app sign-in every OAuth provider shares (lifted out of connectGmail): a one-shot
// HTTP listener on 127.0.0.1:<random>, PKCE S256 and a random state. The redirect is accepted only with the matching
// state; anything else is answered and ignored, so a forged or stale redirect can't end the flow.
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { signInLog, type SignInProvider } from "./login-log";
import type { CallbackKey } from "./oauth-page";

const b64url = (buf: Buffer) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A fresh PKCE verifier and its S256 challenge, and the state that ties the redirect to this flow. */
export function pkce(): { verifier: string; challenge: string; state: string } {
  const verifier = b64url(randomBytes(48));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()), state: b64url(randomBytes(24)) };
}

export interface LoopbackAuthorization {
  /** whose sign-in, for its log lines (plan 293) */
  provider: SignInProvider;
  /** the provider's authorize endpoint */
  authorize: string;
  /** every query parameter but redirect_uri (state and the PKCE challenge among them) */
  params: Record<string, string>;
  state: string;
  /**
   * The host the redirect names. The listener is on 127.0.0.1 either way; Google takes it as written, and Microsoft
   * matches a desktop client's loopback port only for `localhost` (plan 259).
   */
  redirectHost: "127.0.0.1" | "localhost";
  /**
   * The path the redirect names, as the app registration has it: Google's `/callback`; Microsoft's none, since Entra
   * matches the registered `http://localhost` by its path too and ignores only the port (Codex code review #1).
   */
  redirectPath: "/callback" | "";
  /** the page the browser shows after the redirect */
  page: (ok: boolean, key: CallbackKey) => string;
  /**
   * A single, well-formed ?error=: what the page says and what the caller hears. `description` is the provider's
   * error_description (at most 1 KiB, never shown as is): Microsoft names an administrator's refusal only there (AADSTS65001)
   */
  refused(error: string, description: string | null): { page: CallbackKey; error: Error };
  /** a malformed answer (several errors, an error beside a code, no code) */
  invalid(): Error;
  /** what the page says to a malformed or forged answer (it names the provider) */
  invalidPage: CallbackKey;
  openExternal(url: string): Promise<void>;
  /** the flow's signal: once aborted, the browser is never opened */
  signal: AbortSignal;
}

/** Starts listening and opens the browser; `code` settles with the redirect's answer; `close` ends the listener. */
export function openLoopback(a: LoopbackAuthorization): { code: Promise<{ code: string; redirectUri: string }>; close(): Promise<void> } {
  let server: Server | null = null;
  let settled = false;
  const redirectUri = (port: number) => `http://${a.redirectHost}:${port}${a.redirectPath}`;
  const code = new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== (a.redirectPath || "/")) return void res.writeHead(404).end();
      const done = (ok: boolean, msg: CallbackKey) => {
        res.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
        res.end(a.page(ok, msg));
      };
      if (url.searchParams.get("state") !== a.state) {
        signInLog.callback(a.provider, "mismatch");
        done(false, a.invalidPage);
        return; // ignore forged/stale redirects, keep waiting for the real one
      }
      if (settled) return void res.writeHead(409).end();
      settled = true;
      const errors = url.searchParams.getAll("error");
      if (errors.length) {
        if (errors.length !== 1 || !errors[0] || url.searchParams.has("code")) {
          signInLog.callback(a.provider, "malformed");
          done(false, a.invalidPage);
          reject(a.invalid());
          return;
        }
        signInLog.callback(a.provider, "error");
        const refusal = a.refused(errors[0], url.searchParams.get("error_description")?.slice(0, 1024) ?? null);
        done(false, refusal.page);
        reject(refusal.error);
        return;
      }
      const authorizationCode = url.searchParams.get("code");
      if (!authorizationCode?.trim() || url.searchParams.getAll("code").length !== 1) {
        signInLog.callback(a.provider, "malformed");
        done(false, a.invalidPage);
        reject(a.invalid());
        return;
      }
      signInLog.callback(a.provider, "code");
      done(true, "backend.oauth.back");
      resolve({ code: authorizationCode, redirectUri: redirectUri((server!.address() as AddressInfo).port) });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      if (a.signal.aborted) return;
      const port = (server!.address() as AddressInfo).port;
      signInLog.authorize(a.provider, port, a.redirectHost);
      const params = new URLSearchParams({ ...a.params, redirect_uri: redirectUri(port) });
      void Promise.resolve().then(() => a.openExternal(`${a.authorize}?${params}`)).catch(reject);
    });
  });
  return {
    code,
    async close() {
      const listener = server as Server | null;
      if (!listener) return;
      listener.closeAllConnections();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    },
  };
}
