import { afterEach, describe, expect, it } from "vitest";
import { createRegistry } from "./registry";
import { SyntheticMicrosoft } from "./test/microsoft.fixture";
import { ProviderError, type ProviderContext } from "./types";

let ms: SyntheticMicrosoft | undefined;
afterEach(async () => { await ms?.stop(); ms = undefined; });

describe("the registry per account kind (plan 259)", () => {
  it("Outlook gets its Graph provider, never IMAP's: it verifies against Graph with the stored refresh token, and sends with nodemailer's MIME (stage 2b)", async () => {
    ms = await new SyntheticMicrosoft().start();
    const refresh = ms.accessToken().replace("access-", "refresh-");
    ms.refreshTokens.add(refresh);
    let secret = refresh;
    const ctx = {
      account: { id: 1, kind: "outlook", email: "ana@contoso.com" }, config: {},
      fetch: (input: string | URL | Request, init?: RequestInit) => fetch(input, init),
      getSecret: async () => secret,
      replaceSecret: async (_name: string, expected: string, next: string) => { if (expected !== secret && next !== secret) return false; secret = next; return true; },
      oauthClient: async () => ({ clientId: ms!.clientId, clientSecret: null }),
    } as unknown as ProviderContext;
    const provider = createRegistry({ microsoft: { endpoints: ms.endpoints() } }).create(ctx);
    expect(provider.quickChecks).toBe(true);
    expect(provider.flagSnapshots).toBe(true);
    await provider.verify();
    expect(ms.graphRequests).toEqual(["/v1.0/me"]);
    // the refresh token rotated and was kept
    expect(secret).not.toBe(refresh);
    // stage 2b: a send's MIME is nodemailer's, its Bcc kept (Graph reads a MIME message's headers)
    const sent = await provider.execute({ id: "1", kind: "send", target: {}, payload: { from: { name: "Ana", email: "ana@contoso.com" }, to: [{ name: "", email: "bo@example.test" }], cc: [], bcc: [{ name: "", email: "hidden@example.test" }], subject: "Hi", text: "Hello", messageId: "r1@contoso.com", inReplyTo: null, references: [], providerThreadId: null } }).catch((error: unknown) => error);
    expect(sent).not.toBeInstanceOf(ProviderError);
    expect(ms.sent).toHaveLength(1);
    expect(ms.sent[0]!.mime).toMatch(/^Bcc: hidden@example\.test/m);
    await provider.close();
  });
});
