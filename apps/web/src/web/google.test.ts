import { beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "@terno/i18n";
import type { Account } from "@terno/core";

const mocks = vi.hoisted(() => ({ call: vi.fn(), setApp: vi.fn(), getApp: vi.fn() }));
vi.mock("~/rpc/connection", () => ({ client: { call: mocks.call } }));
vi.mock("~/state/app", () => ({ getApp: mocks.getApp, setApp: mocks.setApp }));
import { authorizeGooglePhotosWeb, connectGmailWeb } from "./google";

const mail = "https://www.googleapis.com/auth/gmail.modify";
const contacts = "https://www.googleapis.com/auth/contacts.readonly";
const account = { id: 7, email: "synthetic@example.test" } as Account;
let config: { callback: (value: unknown) => void; error_callback: (value: unknown) => void; scope: string; login_hint?: string };
let request: ReturnType<typeof vi.fn>;
const valid = { access_token: "synthetic-token", expires_in: 3600, scope: mail };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getApp.mockReturnValue({ settings: { gmailClientId: "synthetic-client", googlePhotos: {} } });
  mocks.call.mockImplementation(async (method: string) => method === "accounts.connectGmailToken" ? account : { googlePhotos: { "7": {} } });
  request = vi.fn();
  vi.stubGlobal("window", { google: { accounts: { oauth2: { initTokenClient: (c: typeof config) => { config = c; return { requestAccessToken: request }; } } } } });
});

async function respond(value: unknown, photo = false) {
  const result = photo ? authorizeGooglePhotosWeb(account) : connectGmailWeb();
  await Promise.resolve();
  config.callback(value);
  return result;
}

describe("GIS public helpers", () => {
  it.each([false, true])("validates malformed callbacks for photo=%s", async (photo) => {
    for (const value of [null, undefined, 42, {}, { access_token: valid.access_token, expires_in: 3600 }, { ...valid, scope: null }, { ...valid, scope: 12 }, { ...valid, scope: "" }, { ...valid, scope: "openid" }, { ...valid, access_token: "" }, { ...valid, access_token: "secret\n" }, { ...valid, access_token: "x".repeat(4097) }, { ...valid, expires_in: undefined }, { ...valid, expires_in: 0 }, { ...valid, expires_in: 59 }, { ...valid, expires_in: 86401 }, { ...valid, expires_in: 60.5 }, { ...valid, expires_in: "not-a-number" }]) {
      const reduced = typeof value === "object" && value !== null && "scope" in value && value.scope === "openid";
      await expect(respond(value, photo)).rejects.toThrow(t(reduced ? "web.google.noGmailScope" : "errors.google.invalidResponse"));
      expect(mocks.call).not.toHaveBeenCalled();
      expect(mocks.setApp).not.toHaveBeenCalled();
    }
  });
  it.each([["access_denied", "errors.google.denied"], ["admin_policy_enforced", "errors.google.adminPolicy"], ["secret-provider-code", "errors.google.unavailable"]] as const)("sanitizes %s", async (error, key) => {
    for (const photo of [false, true]) {
      await expect(respond({ error, error_description: "secret-provider-description" }, photo)).rejects.toThrow(t(key));
      expect(mocks.call).not.toHaveBeenCalled(); expect(mocks.setApp).not.toHaveBeenCalled();
    }
  });
  it.each([["popup_closed", "web.google.popupClosed"], ["popup_failed_to_open", "web.google.popupBlocked"], ["secret", "errors.google.unavailable"], [null, "errors.google.unavailable"]] as const)("sanitizes popup error %#", async (type, key) => {
    for (const photo of [false, true]) {
      const result = photo ? authorizeGooglePhotosWeb(account) : connectGmailWeb(); await Promise.resolve();
      config.error_callback(type === null ? null : { type, message: "secret-message" });
      await expect(result).rejects.toThrow(t(key));
      expect(mocks.call).not.toHaveBeenCalled(); expect(mocks.setApp).not.toHaveBeenCalled();
    }
  });
  it("connects mail without optional contacts, and forwards an explicit partial contact grant", async () => {
    await expect(respond(valid)).resolves.toEqual(account);
    expect(mocks.call).toHaveBeenCalledTimes(1);
    mocks.call.mockClear();
    await expect(respond({ ...valid, scope: `${mail} ${contacts}` })).resolves.toEqual(account);
    expect(mocks.call).toHaveBeenCalledTimes(2);
    expect(mocks.call).toHaveBeenLastCalledWith("icons.authorizeGoogle", expect.objectContaining({ accountId: 7, scope: `${mail} ${contacts}` }));
  });
  it("reconnects and delegates mailbox identity to the worker", async () => {
    const result = connectGmailWeb(account.email, account.id); await Promise.resolve(); config.callback(valid);
    await expect(result).resolves.toEqual(account);
    expect(mocks.call).toHaveBeenCalledWith("accounts.connectGmailToken", expect.objectContaining({ accountId: 7 }));
    expect(mocks.call).toHaveBeenCalledTimes(1);
  });
  it("authorizes own photos with no contacts and preserves the account hint", async () => {
    await expect(respond(valid, true)).resolves.toBeUndefined();
    expect(config.login_hint).toBe(account.email);
    expect(request).toHaveBeenCalledWith({ prompt: "consent", login_hint: account.email });
    expect(mocks.call).toHaveBeenCalledWith("icons.authorizeGoogle", expect.objectContaining({ accountId: 7, scope: mail }));
    expect(mocks.setApp).toHaveBeenCalledOnce();
  });
  it.each([60, 86400, "3600"])("accepts RPC lifetime %s", async (expires_in) => {
    await expect(respond({ ...valid, expires_in })).resolves.toEqual(account);
    expect(mocks.call).toHaveBeenCalledWith("accounts.connectGmailToken", expect.objectContaining({ expiresIn: Number(expires_in) }));
  });
  it("keeps mail when optional photo scope exceeds its RPC bound or authorization fails", async () => {
    const scope = `${mail} ${contacts} ${"x".repeat(2001)}`;
    await expect(respond({ ...valid, scope })).resolves.toEqual(account);
    expect(mocks.call).toHaveBeenCalledTimes(1);
    mocks.call.mockClear();
    mocks.call.mockImplementation(async (method: string) => { if (method === "icons.authorizeGoogle") throw new Error("synthetic"); return account; });
    await expect(respond({ ...valid, scope: `${mail} ${contacts}` })).resolves.toEqual(account);
    expect(mocks.setApp).not.toHaveBeenCalled();
  });
  it("leaves existing photo settings untouched", async () => {
    mocks.getApp.mockReturnValue({ settings: { gmailClientId: "synthetic-client", googlePhotos: { "7": {} } } });
    await expect(respond({ ...valid, scope: `${mail} ${contacts}` })).resolves.toEqual(account);
    expect(mocks.call).toHaveBeenCalledTimes(1);
  });
  it("rejects oversized scope for explicit photo authorization", async () => {
    await expect(respond({ ...valid, scope: `${mail} ${"x".repeat(2001)}` }, true)).rejects.toThrow(t("errors.google.invalidResponse"));
    expect(mocks.call).not.toHaveBeenCalled();
  });
  it("rejects an invalid photo grant without state effects", async () => {
    await expect(respond({ ...valid, scope: contacts }, true)).rejects.toThrow(t("web.google.noGmailScope"));
    expect(mocks.call).not.toHaveBeenCalled(); expect(mocks.setApp).not.toHaveBeenCalled();
  });
});
