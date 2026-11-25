import type { HttpRequestContext, ProviderRequests, RequestDescriptor } from "./types";
import { captureHttpResponseEvidence } from "./http-response-evidence";
import { resolveRetryMinimum } from "./retry-after-deadline";
export type { ProviderRequests, RequestDescriptor, RequestRun, RequestTicket, Observation429 } from "./types";

/**
 * Plan 259: an answer that says "too many requests, wait": a 429 from anyone, and Microsoft's 503 with a Retry-After
 * ("overloaded … repeat the request after a delay, the length of which can be specified in a Retry-After header",
 * learn.microsoft.com/graph/errors). Both pause the service in the cooldown ledger.
 */
export function throttled(request: HttpRequestContext, status: number, retryAfter: boolean): boolean {
  if (status === 429) return true;
  return status === 503 && retryAfter && (request.endpoint === "graph-api" || request.endpoint === "microsoft-token" || request.endpoint === "microsoft-identity");
}

/** The ticket owns the final synchronous check and pre-body observation. */
export async function requestHttp(
  policy: ProviderRequests,
  descriptor: RequestDescriptor,
  transport: () => Promise<Response>,
  wallNow: () => number,
): Promise<Response> {
  policy.check(descriptor);
  const ticket = policy.reserve(descriptor);
  const onHeaders = descriptor.onHeaders;
  let transferred = false;
  try {
    const response = await ticket.dispatch(transport);
    const evidence = !response.ok ? captureHttpResponseEvidence(response, ticket.request, wallNow()) : undefined;
    onHeaders?.(response.status, evidence);
    if (throttled(ticket.request, response.status, evidence?.retryAfter.kind === "value")) {
      if (!evidence) throw new Error("Missing HTTP response evidence");
      const durable = ticket.headers429({ received: evidence.received, minimum: resolveRetryMinimum(evidence) });
      await durable;
    } else if (response.status === 403 && descriptor.onForbidden && evidence) {
      const observation = { received: evidence.received, minimum: resolveRetryMinimum(evidence) };
      let settled = false;
      descriptor.onForbidden(async (kind) => {
        if (settled) return;
        settled = true;
        try {
          if (kind === "quota") await ticket.headers429(observation);
          else ticket.headers(403);
        } finally { ticket.release(); }
      });
      transferred = true;
    } else {
      ticket.headers(response.status);
    }
    return response;
  } finally {
    if (!transferred) ticket.release();
  }
}
