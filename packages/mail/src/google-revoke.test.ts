import { describe, expect, it, vi } from "vitest";
import { GOOGLE_REVOKE, revokeGoogleToken } from "./google-revoke";

const respond = (status: number, body = "") => vi.fn<typeof fetch>(async () => new Response(body, { status }));

describe("revokeGoogleToken (plan 125)", () => {
  it("POSTs the token form-encoded to Google's revoke endpoint, never in the URL, never following a redirect", async () => {
    const f = respond(200);
    expect(await revokeGoogleToken("1//refresh+token/x", f)).toBe("revoked");
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(GOOGLE_REVOKE);
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(new URLSearchParams(String(init?.body)).get("token")).toBe("1//refresh+token/x");
  });

  it("only a 200 confirms: invalid_token (expired or revoked) and any other answer are unconfirmed", async () => {
    expect(await revokeGoogleToken("t", respond(400, '{"error":"invalid_token"}'))).toBe("failed");
    expect(await revokeGoogleToken("t", respond(400, '{"error":"invalid_request"}'))).toBe("failed");
    expect(await revokeGoogleToken("t", respond(503))).toBe("failed");
    expect(await revokeGoogleToken("t", respond(307))).toBe("failed");
  });

  it("a network failure, an abort, or a fetch that ignores its signal end in a failure, on time", async () => {
    expect(await revokeGoogleToken("t", vi.fn<typeof fetch>(async () => { throw new TypeError("fetch failed"); }))).toBe("failed");
    expect(await revokeGoogleToken("t", respond(200), AbortSignal.abort())).toBe("failed");
    const stalled = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));
    const started = Date.now();
    expect(await revokeGoogleToken("t", stalled, AbortSignal.timeout(50))).toBe("failed");
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
