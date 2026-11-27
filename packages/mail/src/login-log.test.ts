import { installDiag, setDiagSink, type DiagEntry } from "@terno/core/diag";
import { beforeEach, expect, it } from "vitest";
import { imapLogin, signInLog } from "./login-log";
import { ProviderError } from "./types";

// Plan 293 (CASA 6.5.1, the Codex code review #4 and #12): what a login line may hold.
let entries: DiagEntry[] = [];
beforeEach(() => {
  entries = [];
  installDiag({ proc: "backend", version: "t", build: "t", channel: "dev" });
  setDiagSink({ write: (e) => void entries.push(e), capture: () => {} });
});

it("a refused token exchange logs the HTTP status it got, read from the error's response evidence", () => {
  const refused = Object.assign(new ProviderError("refused", false), { httpResponse: { status: 400 } });
  signInLog.tokenExchange("google", "https://oauth2.googleapis.com/token", { error: refused });
  expect(entries.at(-1)).toMatchObject({ code: "signin.token_exchange", level: "warn", fields: { endpoint: "https://oauth2.googleapis.com/token", status: 400, authCode: "[redacted]", codeVerifier: "[redacted]" } });
});

it("a server's own refusal atom, or a scope Terno never asked for, is never written as it came", () => {
  imapLogin("NO", "hunter2");
  signInLog.tokenExchange("microsoft", "https://login.microsoftonline.com/common/oauth2/v2.0/token", { tokens: { access_token: "eyJ0eXAi", token_type: "Bearer", expires_in: 3600, scope: "Mail.Send hunter2" } });
  expect(JSON.stringify(entries)).not.toContain("hunter2");
  expect(JSON.stringify(entries)).not.toContain("eyJ0eXAi");
  expect(entries[0]!.fields).toMatchObject({ user: "[redacted]", loginResult: "NO", responseCode: "other" });
  expect(entries[1]!.fields).toMatchObject({ scope: "Mail.Send other", accessToken: "[redacted]" });
});
