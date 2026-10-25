/**
 * Sentry as a dumb pipe for reports built elsewhere (report.ts). A bare
 * @sentry/core client with no integrations, no scope data, no sessions and
 * no client reports: beforeSend swaps whatever the SDK prepared for the exact
 * event we built, and the transport asks the live policy for every envelope,
 * so revoking consent (or turning local mode on) stops the very next one.
 * There is no offline queue: what can't go now is dropped (the local record
 * stays). Main hands it Electron's net.fetch; the web, @sentry/browser's fetch.
 * Loaded lazily, and only by builds that were given a DSN.
 */
import { Client, createStackParser, createTransport, type BaseTransportOptions, type ClientOptions, type Envelope, type ErrorEvent, type Event, type Transport, type TransportMakeRequestResponse } from "@sentry/core";
import type { ReportEvent } from "./report";

export type TransportFactory = (options: BaseTransportOptions) => Transport;

export type SendResult = { sent: true; status?: number } | { sent: false; reason: "policy" | "type" | "error" | "timeout" };

export interface ReporterOptions {
  dsn: string;
  release: string;
  environment: string;
  transport: TransportFactory;
  /** asked for every envelope, at send time */
  allow(eventId: string): boolean;
  /** every envelope's fate (counted by the host; never logged as a report itself) */
  onResult?(eventId: string | undefined, result: SendResult): void;
}

export interface Reporter {
  /** resolves with what happened to this report at the transport */
  send(event: ReportEvent): Promise<SendResult>;
  close(): Promise<void>;
}

class ReportClient extends Client<ClientOptions> {
  constructor(options: ClientOptions) {
    super(options);
  }
  // reports are built by buildReport; the SDK never turns errors into events itself
  override eventFromException(): PromiseLike<Event> {
    return Promise.resolve({});
  }
  override eventFromMessage(): PromiseLike<Event> {
    return Promise.resolve({});
  }
}

/** The consent boundary: only single-event envelopes the policy allows reach the network. */
export function consentTransport(inner: Transport, allow: (eventId: string) => boolean, onResult: (eventId: string | undefined, r: SendResult) => void): Transport {
  return {
    send(envelope: Envelope): PromiseLike<TransportMakeRequestResponse> {
      const [headers, items] = envelope;
      const eventId = typeof headers.event_id === "string" ? headers.event_id : undefined;
      if (!eventId || items.length !== 1 || items[0]![0].type !== "event") {
        onResult(eventId, { sent: false, reason: "type" });
        return Promise.resolve({});
      }
      if (!allow(eventId)) {
        onResult(eventId, { sent: false, reason: "policy" });
        return Promise.resolve({});
      }
      return inner.send(envelope).then(
        (r) => {
          onResult(eventId, r.statusCode && r.statusCode >= 400 ? { sent: false, reason: "error" } : { sent: true, status: r.statusCode });
          return r;
        },
        (error: unknown) => {
          onResult(eventId, { sent: false, reason: "error" });
          throw error;
        },
      );
    },
    flush: (timeout) => inner.flush(timeout),
  };
}

/** A transport over any fetch (Electron's net.fetch in main): POSTs the serialized envelope. */
export function fetchTransport(fetchImpl: (url: string, init: { method: "POST"; body: string | Uint8Array; headers: Record<string, string> }) => Promise<{ status: number; headers: { get(name: string): string | null } }>): TransportFactory {
  return (options) =>
    createTransport(options, async (request) => {
      const res = await fetchImpl(options.url, { method: "POST", body: request.body, headers: { "Content-Type": "application/x-sentry-envelope", ...options.headers } });
      return { statusCode: res.status, headers: { "x-sentry-rate-limits": res.headers.get("X-Sentry-Rate-Limits"), "retry-after": res.headers.get("Retry-After") } };
    });
}

const SEND_TIMEOUT_MS = 30_000;

export function createReporter(o: ReporterOptions): Reporter {
  const prepared = new Map<string, ReportEvent>();
  const waiting = new Map<string, (r: SendResult) => void>();
  const settle = (eventId: string | undefined, r: SendResult) => {
    o.onResult?.(eventId, r);
    if (!eventId) return;
    waiting.get(eventId)?.(r);
    waiting.delete(eventId);
  };
  const client = new ReportClient({
    dsn: o.dsn,
    release: o.release,
    environment: o.environment,
    integrations: [],
    stackParser: createStackParser(),
    transport: (options) => consentTransport(o.transport(options), o.allow, settle),
    sendClientReports: false,
    maxBreadcrumbs: 0,
    beforeBreadcrumb: () => null,
    attachStacktrace: false,
    // our event, exactly: nothing the SDK or a scope added survives
    beforeSend: (event) => {
      const own = event.event_id ? prepared.get(event.event_id) : undefined;
      if (event.event_id) prepared.delete(event.event_id);
      return own ? (structuredClone(own) as unknown as ErrorEvent) : null;
    },
  });
  return {
    send(event) {
      return new Promise<SendResult>((resolve) => {
        const timer = setTimeout(() => {
          waiting.delete(event.event_id);
          prepared.delete(event.event_id);
          resolve({ sent: false, reason: "timeout" });
        }, SEND_TIMEOUT_MS);
        waiting.set(event.event_id, (r) => {
          clearTimeout(timer);
          resolve(r);
        });
        prepared.set(event.event_id, event);
        client.captureEvent({ event_id: event.event_id }, { event_id: event.event_id });
      });
    },
    async close() {
      // never flush on the way out: a queued envelope must not outlive the decision that allowed it
      prepared.clear();
      await Promise.resolve(client.close(0)).catch(() => false);
    },
  };
}
