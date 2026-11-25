import { describe, expect, it } from "vitest";
import { L } from "@terno/i18n";
import { openLoopback, pkce } from "./oauth-loopback";
import { createOAuthSession } from "./oauth-session";
import { ProviderAuthError, ProviderError, type ProviderContext } from "./types";

// Plan 259: the loopback and the refresh session every OAuth provider shares (Gmail's tests cover their behaviour in
// depth); here, what a second provider relies on: its own redirect host, refusals and words.
const page = (ok: boolean, key: string) => `${ok}:${key}`;

function open(redirectHost: "127.0.0.1" | "localhost", state = "s1") {
  let opened!: URL;
  const loopback = openLoopback({
    authorize: "https://login.example.test/authorize", state, redirectHost, page, signal: new AbortController().signal,
    params: { client_id: "public-client", response_type: "code", state, prompt: "select_account" },
    refused: (error, description) => ({ page: "backend.oauth.denied", error: new ProviderError(`refused ${error} ${description ?? "-"}`, false) }),
    invalid: () => new ProviderError("invalid", false), invalidPage: "backend.oauth.invalid",
    openExternal: async (url) => { opened = new URL(url); },
  });
  const ready = async () => { while (!opened) await new Promise((r) => setTimeout(r, 5)); return opened; };
  return { loopback, ready };
}

describe("the shared OAuth loopback (plan 259)", () => {
  it("names the redirect host the provider matches, listening on 127.0.0.1, and hands back its code", async () => {
    const { loopback, ready } = open("localhost");
    try {
      const url = await ready();
      const redirect = new URL(url.searchParams.get("redirect_uri")!);
      expect(redirect.hostname).toBe("localhost");
      expect(url.searchParams.get("client_id")).toBe("public-client");
      expect(url.searchParams.get("prompt")).toBe("select_account");
      // a forged state is answered and ignored
      expect((await fetch(`http://127.0.0.1:${redirect.port}/callback?state=forged&code=x`)).status).toBe(400);
      const answer = await fetch(`http://127.0.0.1:${redirect.port}/callback?state=s1&code=the-code`);
      expect(await answer.text()).toBe("true:backend.oauth.back");
      expect(await loopback.code).toEqual({ code: "the-code", redirectUri: `http://localhost:${redirect.port}/callback` });
    } finally { await loopback.close(); }
  });

  it("a provider's refusal reaches the page and the caller in its own words; a malformed answer is invalid", async () => {
    const first = open("127.0.0.1");
    try {
      const port = new URL((await first.ready()).searchParams.get("redirect_uri")!).port;
      const refused = first.loopback.code.catch((error: unknown) => error);
      expect(await (await fetch(`http://127.0.0.1:${port}/callback?state=s1&error=interaction_required&error_description=AADSTS65001%3A+admin+consent`)).text()).toBe("false:backend.oauth.denied");
      expect(String(await refused)).toContain("refused interaction_required AADSTS65001: admin consent");
    } finally { await first.loopback.close(); }
    const second = open("127.0.0.1");
    try {
      const port = new URL((await second.ready()).searchParams.get("redirect_uri")!).port;
      const invalid = second.loopback.code.catch((error: unknown) => error);
      await fetch(`http://127.0.0.1:${port}/callback?state=s1&error=x&code=y`);
      expect(String(await invalid)).toContain("invalid");
    } finally { await second.loopback.close(); }
  });

  it("makes a fresh PKCE pair and state each time", () => {
    const a = pkce(), b = pkce();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.state).not.toBe(b.state);
    expect(a.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("the shared refresh session (plan 259)", () => {
  const words = { reconnect: () => L("errors.microsoft.notYet"), clientUnread: () => L("errors.gmail.clientUnread"), stale: () => L("errors.gmail.refreshFailed", { status: 200 }) };

  it("a public client (no secret) refreshes with the provider's own exchange and keeps the rotated token", async () => {
    let durable = "refresh-1";
    const seen: { clientSecret: string | null }[] = [];
    const ctx = {
      getSecret: async () => durable,
      replaceSecret: async (_name: string, expected: string, next: string) => { if (durable !== expected && durable !== next) return false; durable = next; return true; },
      oauthClient: async () => ({ clientId: "public-client", clientSecret: null }),
    } as unknown as ProviderContext;
    const session = createOAuthSession(ctx, {
      token: { endpoint: "oauth-token", purpose: "refresh" }, messages: words,
      exchange: async (input) => { seen.push(input); return { accessToken: "access-1", refreshToken: "refresh-2", expiresAt: Date.now() + 3_600_000, refreshAt: Date.now() + 3_000_000 }; },
    });
    expect(await session.get()).toBe("access-1");
    expect(await session.get()).toBe("access-1");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.clientSecret).toBeNull();
    expect(durable).toBe("refresh-2");
    session.close();
  });

  it("no client for the account asks for a sign-in in the provider's words", async () => {
    const ctx = { getSecret: async () => "refresh-1", replaceSecret: async () => true } as unknown as ProviderContext;
    const session = createOAuthSession(ctx, { token: { endpoint: "oauth-token", purpose: "refresh" }, messages: words, exchange: async () => { throw new Error("unreached"); } });
    const refusal = await session.get().catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ProviderAuthError);
    expect((refusal as ProviderAuthError).i18n?.key).toBe("errors.microsoft.notYet");
    session.close();
  });
});
