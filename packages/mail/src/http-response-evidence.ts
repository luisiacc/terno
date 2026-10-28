import type { BoundedHttpHeader, HttpReceipt, HttpRequestContext, HttpResponseEvidence } from "./types";

export const HTTP_EVIDENCE_HEADER_LIMIT = 256;

/** Preserve observations, not retry policy or quota scope. Never retain the Response. */
export function captureHttpResponseEvidence(response: Response, request: HttpRequestContext, receivedWallMs: number): HttpResponseEvidence | undefined {
  if (response.ok || !Number.isInteger(response.status) || response.status < 100 || response.status > 599) return;
  const header = (name: string): BoundedHttpHeader => {
    const value = response.headers.get(name);
    if (value === null) return Object.freeze({ kind: "not-visible" });
    if (value.length > HTTP_EVIDENCE_HEADER_LIMIT) return Object.freeze({ kind: "too-long" });
    return Object.freeze({ kind: "value", value });
  };
  const received: HttpReceipt = Number.isSafeInteger(receivedWallMs) && Math.abs(receivedWallMs) <= 8.64e15
    ? Object.freeze({ source: "date-now", kind: "wall", wallMs: receivedWallMs })
    : Object.freeze({ source: "date-now", kind: "invalid" });
  // Copy only the known fields; structural callers may have additional private properties.
  const context = Object.freeze({ endpoint: request.endpoint, purpose: request.purpose }) as HttpRequestContext;
  return Object.freeze({
    source: "http-response", request: context, status: response.status, quotaScope: "unknown", received,
    retryAfter: header("retry-after"), serverDate: header("date"),
  });
}
