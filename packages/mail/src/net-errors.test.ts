import { describe, expect, it } from "vitest";
import { toProviderError } from "./imap";
import { failedBeforeRequest, isFetchNetworkFailure, isNetworkError } from "./net-errors";
import { classifySmtpError } from "./smtp";

const err = (props: Record<string, unknown>, message = "boom") => Object.assign(new Error(message), props);
const fetchFailed = (cause?: Record<string, unknown>) => new TypeError("fetch failed", cause ? { cause: err(cause) } : undefined);

describe("plan 19: what counts as 'couldn't reach the server'", () => {
  it("socket and resolver errnos, imapflow's and undici's codes, and aborts (also as causes)", () => {
    for (const code of ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EPIPE"]) expect(isNetworkError(err({ code })), code).toBe(true);
    for (const code of ["NoConnection", "EConnectionClosed", "ETIMEOUT", "CONNECT_TIMEOUT", "GREETING_TIMEOUT"]) expect(isNetworkError(err({ code })), code).toBe(true);
    expect(isNetworkError(fetchFailed({ code: "UND_ERR_SOCKET" }))).toBe(true);
    expect(isNetworkError(new DOMException("x", "AbortError"))).toBe(true);
    expect(isNetworkError(new DOMException("x", "TimeoutError"))).toBe(true);
  });

  it("never a server's answer or a configuration problem", () => {
    expect(isNetworkError(err({ authenticationFailed: true }))).toBe(false);
    expect(isNetworkError(err({ responseStatus: "NO" }))).toBe(false);
    expect(isNetworkError(err({ code: "CERT_HAS_EXPIRED" }))).toBe(false);
    expect(isNetworkError(err({ code: "ERR_TLS_CERT_ALTNAME_INVALID" }))).toBe(false);
    expect(isNetworkError(new SyntaxError("Unexpected token"))).toBe(false);
  });

  it("nodemailer's ESOCKET counts only with a socket errno under it (it also wraps TLS failures)", () => {
    expect(isNetworkError(err({ code: "ESOCKET", originalCode: "ECONNRESET" }))).toBe(true);
    expect(isNetworkError(err({ code: "ESOCKET", errno: "ENETUNREACH" }))).toBe(true);
    expect(isNetworkError(err({ code: "ESOCKET", originalCode: "CERT_HAS_EXPIRED" }))).toBe(false);
    expect(isNetworkError(err({ code: "ESOCKET" }))).toBe(false);
    expect(isNetworkError(err({ code: "ECONNECTION" }))).toBe(true);
  });

  it("fetch: Node says why on the cause (a certificate isn't connectivity); a browser's bare TypeError is offline", () => {
    expect(isFetchNetworkFailure(fetchFailed({ code: "ECONNREFUSED" }))).toBe(true);
    expect(isFetchNetworkFailure(fetchFailed({ code: "CERT_HAS_EXPIRED" }))).toBe(false);
    expect(isFetchNetworkFailure(new TypeError("Failed to fetch"))).toBe(true);
    expect(isFetchNetworkFailure(new Error("other"))).toBe(false);
  });

  it("a send only 'never left' when it never connected", () => {
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]) expect(failedBeforeRequest(fetchFailed({ code })), code).toBe(true);
    for (const code of ["ECONNRESET", "ETIMEDOUT", "UND_ERR_SOCKET", "EPIPE"]) expect(failedBeforeRequest(fetchFailed({ code })), code).toBe(false);
    expect(failedBeforeRequest(new TypeError("Failed to fetch"))).toBe(false);
  });

  it("IMAP: network failures are flagged; logins and NO/BAD aren't", () => {
    expect(toProviderError(err({ code: "ECONNREFUSED" }))).toMatchObject({ retryable: true, network: true, ambiguous: false });
    expect(toProviderError(err({ code: "NoConnection" }))).toMatchObject({ retryable: true, network: true });
    expect(toProviderError(err({ authenticationFailed: true }))).toMatchObject({ retryable: false, network: false });
    expect(toProviderError(err({ responseStatus: "BAD" }))).toMatchObject({ retryable: false, network: false });
    expect(toProviderError(err({ code: "CERT_HAS_EXPIRED" }))).toMatchObject({ retryable: true, network: false });
  });

  it("SMTP: explicit replies and post-DATA ambiguity keep their precedence over the network", () => {
    expect(classifySmtpError(err({ code: "ECONNECTION" }))).toMatchObject({ retryable: true, network: true, ambiguous: false });
    expect(classifySmtpError(err({ code: "ETIMEDOUT" }))).toMatchObject({ retryable: true, network: true });
    // a disconnect after 354: the server may have the message
    expect(classifySmtpError(err({ code: "ECONNECTION" }), true)).toMatchObject({ retryable: false, ambiguous: true, network: false });
    // 451 is a temporary answer from a reachable server, 554 a permanent one
    expect(classifySmtpError(err({ code: "EMESSAGE", responseCode: 451 }))).toMatchObject({ retryable: true, network: false });
    expect(classifySmtpError(err({ code: "EMESSAGE", responseCode: 554 }))).toMatchObject({ retryable: false, network: false });
    expect(classifySmtpError(err({ code: "ESOCKET", originalCode: "CERT_HAS_EXPIRED" }))).toMatchObject({ network: false });
    expect(classifySmtpError(err({ code: "EAUTH" }))).toMatchObject({ retryable: false, network: false });
  });
});
