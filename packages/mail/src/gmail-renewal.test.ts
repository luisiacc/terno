import { afterEach, describe, expect, it, vi } from "vitest";
import { createRegistry } from "./registry";
import { CONTACTS_SCOPE, OTHER_CONTACTS_SCOPE } from "./google-photos";

const endpoints = { token: "https://google.test/token", api: "https://google.test/mail", userinfo: "https://google.test/userinfo" };
const identity = { email: "reader@example.test", name: "Reader", sub: "synthetic-sub", emailVerified: true };
afterEach(() => vi.useRealTimers());
function setup(scope?: string) {
  const net = vi.fn<typeof fetch>(async (url) => {
    if (String(url) === endpoints.token) return Response.json({ access_token: "cold-access", refresh_token: "rotated-refresh", token_type: "Bearer", expires_in: 3600, ...(scope === undefined ? {} : { scope }) });
    if (String(url) === `${endpoints.api}/profile`) return Response.json({ emailAddress: identity.email });
    if (String(url) === endpoints.userinfo) return Response.json({ sub: identity.sub, email: identity.email, name: identity.name, email_verified: true });
    return Response.json({});
  });
  const registry = createRegistry({ gmail: { endpoints } });
  const begin = () => registry.beginGmailRenewal!({ clientId: "client", clientSecret: null, refreshToken: "old-refresh", fetch: net });
  return { net, begin };
}

describe("cold installed grant proof", () => {
  it("registry exposes rotation before identity proof and never uses consent access", async () => {
    const t = setup();
    const proof = await t.begin();
    expect(proof.refreshToken).toBe("rotated-refresh");
    expect(t.net).toHaveBeenCalledTimes(1);
    expect(new URLSearchParams(t.net.mock.calls[0]![1]!.body as string).get("refresh_token")).toBe("old-refresh");
    await expect(proof.inspect()).resolves.toMatchObject(identity);
    expect(t.net.mock.calls.slice(1).every(([, init]) => new Headers(init?.headers).get("authorization") === "Bearer cold-access")).toBe(true);
  });

  it("omitted refresh scopes need actual selected photo endpoint proof", async () => {
    const t = setup();
    const proof = await t.begin();
    await proof.inspect();
    expect(proof.scopeSource).toBe("resource-proof");
    await expect(proof.provePhotos([CONTACTS_SCOPE, OTHER_CONTACTS_SCOPE])).resolves.toEqual([CONTACTS_SCOPE, OTHER_CONTACTS_SCOPE]);
    expect(t.net.mock.calls.filter(([url]) => String(url).startsWith("https://people.googleapis.com/")).map(([url]) => String(url))).toEqual([
      expect.stringContaining("people/me/connections?"), expect.stringContaining("otherContacts?"),
    ]);
  });

  it("fresh consent scope cannot replace denied durable photo permission", async () => {
    const t = setup();
    const proof = await t.begin();
    await proof.inspect();
    t.net.mockResolvedValueOnce(new Response("synthetic-secret-marker", { status: 403 }));
    await expect(proof.provePhotos([CONTACTS_SCOPE])).rejects.toThrow("403");
    expect(proof.refreshToken).toBe("rotated-refresh");
  });

  it("explicit reduced old grant refuses photos without claiming requested scopes", async () => {
    const t = setup("https://www.googleapis.com/auth/gmail.modify");
    const proof = await t.begin();
    await proof.inspect();
    expect(proof.scopeSource).toBe("refresh-response");
    const calls = t.net.mock.calls.length;
    await expect(proof.provePhotos([CONTACTS_SCOPE])).rejects.toThrow();
    expect(t.net).toHaveBeenCalledTimes(calls);
  });

  it("proof expires on the cumulative deadline with no idle timer", async () => {
    const t = setup();
    const proof = await t.begin();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 30_001);
    await expect(proof.inspect()).rejects.toThrow("timed out");
    expect(vi.getTimerCount()).toBe(0);
    expect(t.net).toHaveBeenCalledTimes(1);
  });
});
