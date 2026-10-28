import { describe, expect, it, vi } from "vitest";
import { captureHttpResponseEvidence } from "./http-response-evidence";
import { ProviderAuthError, ProviderError, type HttpRequestContext } from "./types";

const request: HttpRequestContext = { endpoint: "oauth-token", purpose: "refresh" };
const response = () => new Response("unread body", { status: 429, headers: { "retry-after": "0", date: "Tue, 27 Oct 2026 18:00:00 GMT" } });

describe("bounded local response observations", () => {
  it.each([0, -8.64e15, 8.64e15, 1_000])("retains representable receipt %s without reading any clock", (wallMs) => {
    const clock = vi.spyOn(Date, "now").mockImplementation(() => { throw new Error("Clock is not an observation input"); });
    try { expect(captureHttpResponseEvidence(response(), request, wallMs)?.received).toEqual({ source: "date-now", kind: "wall", wallMs }); }
    finally { clock.mockRestore(); }
  });
  it.each([NaN, Infinity, -Infinity, 0.5, 8.64e15 + 1, Number.MAX_SAFE_INTEGER + 1])("marks invalid receipt %s without retaining the number", (wallMs) => {
    expect(captureHttpResponseEvidence(response(), request, wallMs)?.received).toEqual({ source: "date-now", kind: "invalid" });
  });
  it("copies only the request descriptor and never reads or retains the body", () => {
    const source = response(), body = vi.spyOn(source, "body", "get");
    const caller = { endpoint: "oauth-token" as const, purpose: "refresh" as const, url: "https://private.test/token" };
    const snapshot = captureHttpResponseEvidence(source, caller, 1_000)!;
    expect(body).not.toHaveBeenCalled();
    expect(snapshot.request).toEqual(request);
    expect(snapshot.request).not.toBe(caller);
    expect(Object.isFrozen(caller)).toBe(false);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.request)).toBe(true);
    expect(Object.isFrozen(snapshot.retryAfter)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("private.test");
  });
  it("counts exposed UTF16 units without parsing, trimming or truncating", () => {
    const short = new Response(null, { status: 503, headers: { "retry-after": "é".repeat(256), date: "9".repeat(257) } });
    expect(captureHttpResponseEvidence(short, request, 1_000)).toMatchObject({ retryAfter: { kind: "value", value: "é".repeat(256) }, serverDate: { kind: "too-long" } });
    const joined = new Response(null, { status: 503, headers: [["Retry-After", "1"], ["Retry-After", "2"]] });
    expect(captureHttpResponseEvidence(joined, request, 1_000)?.retryAfter).toEqual({ kind: "value", value: "1, 2" });
  });
  it("successful and opaque responses have no header evidence", () => {
    const success = new Response("invalid JSON", { headers: { "retry-after": "120" } });
    const headers = vi.spyOn(success.headers, "get");
    expect(captureHttpResponseEvidence(success, request, 1_000)).toBeUndefined();
    expect(headers).not.toHaveBeenCalled();
    expect(captureHttpResponseEvidence(Response.error(), request, 1_000)).toBeUndefined();
  });
  it("preserves absent constructor shape, subclasses and readonly nonenumerability", () => {
    for (const error of [new ProviderError("fixed", false), new ProviderError("fixed", true, true, false), ProviderError.network("fixed"), new ProviderAuthError("fixed")]) {
      expect(Object.hasOwn(error, "httpResponse")).toBe(false);
    }
    const snapshot = captureHttpResponseEvidence(response(), request, 1_000)!;
    const error = new ProviderError("fixed", true, false, false, snapshot);
    expect(Object.getOwnPropertyDescriptor(error, "httpResponse")).toEqual({ value: snapshot, enumerable: false, configurable: false, writable: false });
    expect(Reflect.set(error, "httpResponse", null)).toBe(false);
    const auth = new ProviderAuthError("fixed", snapshot);
    expect(auth).toBeInstanceOf(ProviderError);
    expect(auth).toMatchObject({ expected: true, retryable: false, ambiguous: false, network: false });
    expect(auth.httpResponse).toBe(snapshot);
  });
});
