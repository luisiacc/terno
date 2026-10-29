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
  try {
    const response = await ticket.dispatch(transport);
    const evidence = !response.ok ? captureHttpResponseEvidence(response, ticket.request, wallNow()) : undefined;
    onHeaders?.(response.status, evidence);
    if (response.status === 429) {
      if (!evidence) throw new Error("Missing HTTP response evidence");
      const durable = ticket.headers429({ received: evidence.received, minimum: resolveRetryMinimum(evidence) });
      await durable;
    } else {
      ticket.headers(response.status);
    }
    return response;
  } finally {
    ticket.release();
  }
}
