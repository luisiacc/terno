import { afterEach, describe, expect, it } from "vitest";
import { createRegistry } from "./registry";
import { SyntheticMicrosoft } from "./test/microsoft.fixture";
import { ProviderError, type ProviderContext } from "./types";

let ms: SyntheticMicrosoft | undefined;
afterEach(async () => { await ms?.stop(); ms = undefined; });

describe("the registry per account kind (plan 259)", () => {
  it("stage 2a: Outlook gets its Graph provider, never IMAP's: it verifies against Graph with the stored refresh token, and refuses writes until stage 2b", async () => {
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
    const refusal = await provider.execute({ id: "1", kind: "markRead", target: { messageIds: [1] }, payload: {} }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ProviderError);
    expect((refusal as ProviderError).i18n?.key).toBe("errors.outlook.actionNotYet");
    expect((refusal as ProviderError).retryable).toBe(false);
    await provider.close();
  });
});
