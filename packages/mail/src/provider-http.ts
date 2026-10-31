import type { ProviderRequests, RequestDescriptor } from "./types";
import { captureHttpResponseEvidence } from "./http-response-evidence";
import { resolveRetryMinimum } from "./retry-after-deadline";
export type { ProviderRequests, RequestDescriptor, RequestRun, RequestTicket, Observation429 } from "./types";

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
    if (response.status === 429) {
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
