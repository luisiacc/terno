import { beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "@terno/i18n";
import type { Account } from "@terno/core";
import { GMAIL_SCOPES } from "@terno/mail/portable";

const mocks = vi.hoisted(() => ({ call: vi.fn(), clientId: "synthetic-client" }));
vi.mock("~/rpc/connection", () => ({ client: { call: mocks.call } }));
// plan 123: the build's client ID is the only one
vi.mock("~/lib/google-client", () => ({ webBuiltInClientId: () => mocks.clientId }));
import { connectGmailWeb } from "./google";

const mail = "https://www.googleapis.com/auth/gmail.modify";
const account = { id: 7, email: "synthetic@example.test" } as Account;
let config: { callback: (value: unknown) => void; error_callback: (value: unknown) => void; scope: string; login_hint?: string; include_granted_scopes?: boolean };
let request: ReturnType<typeof vi.fn>;
const valid = { access_token: "synthetic-token", expires_in: 3600, scope: mail };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.clientId = "synthetic-client";
  mocks.call.mockImplementation(async () => account);
  request = vi.fn();
  vi.stubGlobal("window", { google: { accounts: { oauth2: { initTokenClient: (c: typeof config) => { config = c; return { requestAccessToken: request }; } } } } });
});

/** Add account, or signing an account in again */
const start = (reconnect: boolean) => (reconnect ? connectGmailWeb(account.email, account.id) : connectGmailWeb());
async function respond(value: unknown, reconnect = false) {
  const result = start(reconnect);
  await Promise.resolve();
  config.callback(value);
  return result;
}

describe("GIS public helpers", () => {
  it.each([false, true])("plan 258: asks Google for exactly Terno's four scopes and no earlier grant (reconnect=%s)", async (reconnect) => {
    await expect(respond(valid, reconnect)).resolves.toEqual(account);
    expect(config.scope).toBe(GMAIL_SCOPES.join(" "));
    // Google's default is true: an older grant (plan 22's contacts) would come back in the token
    expect(config.include_granted_scopes).toBe(false);
  });
  it.each([false, true])("validates malformed callbacks (reconnect=%s)", async (reconnect) => {
    for (const value of [null, undefined, 42, {}, { access_token: valid.access_token, expires_in: 3600 }, { ...valid, scope: null }, { ...valid, scope: 12 }, { ...valid, scope: "" }, { ...valid, scope: "openid" }, { ...valid, access_token: "" }, { ...valid, access_token: "secret\n" }, { ...valid, access_token: "x".repeat(4097) }, { ...valid, expires_in: undefined }, { ...valid, expires_in: 0 }, { ...valid, expires_in: 59 }, { ...valid, expires_in: 86401 }, { ...valid, expires_in: 60.5 }, { ...valid, expires_in: "not-a-number" }]) {
      const reduced = typeof value === "object" && value !== null && "scope" in value && value.scope === "openid";
      await expect(respond(value, reconnect)).rejects.toThrow(t(reduced ? "web.google.noGmailScope" : "errors.google.invalidResponse"));
      expect(mocks.call).not.toHaveBeenCalled();
    }
  });
  it.each([["access_denied", "errors.google.denied"], ["admin_policy_enforced", "errors.google.adminPolicy"], ["secret-provider-code", "errors.google.unavailable"]] as const)("sanitizes %s", async (error, key) => {
    for (const reconnect of [false, true]) {
      await expect(respond({ error, error_description: "secret-provider-description" }, reconnect)).rejects.toThrow(t(key));
      expect(mocks.call).not.toHaveBeenCalled();
    }
  });
  it.each([["popup_closed", "web.google.popupClosed"], ["popup_failed_to_open", "web.google.popupBlocked"], ["secret", "errors.google.unavailable"], [null, "errors.google.unavailable"]] as const)("sanitizes popup error %#", async (type, key) => {
    for (const reconnect of [false, true]) {
      const result = start(reconnect); await Promise.resolve();
      config.error_callback(type === null ? null : { type, message: "secret-message" });
      await expect(result).rejects.toThrow(t(key));
      expect(mocks.call).not.toHaveBeenCalled();
    }
  });
  it("Add account asks with consent and hands the token to the worker once", async () => {
    await expect(respond(valid)).resolves.toEqual(account);
    expect(request).toHaveBeenCalledWith({ prompt: "consent" });
    expect(mocks.call).toHaveBeenCalledTimes(1);
    expect(mocks.call).toHaveBeenCalledWith("accounts.connectGmailToken", expect.not.objectContaining({ accountId: expect.anything() }));
  });
  it("reconnects and delegates mailbox identity to the worker", async () => {
    await expect(respond(valid, true)).resolves.toEqual(account);
    expect(config.login_hint).toBe(account.email);
    expect(mocks.call).toHaveBeenCalledWith("accounts.connectGmailToken", expect.objectContaining({ accountId: 7 }));
    expect(mocks.call).toHaveBeenCalledTimes(1);
  });
  it.each([60, 86400, "3600"])("accepts RPC lifetime %s", async (expires_in) => {
    await expect(respond({ ...valid, expires_in })).resolves.toEqual(account);
    expect(mocks.call).toHaveBeenCalledWith("accounts.connectGmailToken", expect.objectContaining({ expiresIn: Number(expires_in) }));
  });
});

describe("plan 123: a web build without Terno's Google client", () => {
  it("says it can't connect Google and never opens Google's window", async () => {
    mocks.clientId = "";
    await expect(connectGmailWeb()).rejects.toMatchObject({ message: t("errors.google.noClientWeb"), i18n: { key: "errors.google.noClientWeb" } });
    expect(request).not.toHaveBeenCalled();
  });
});
