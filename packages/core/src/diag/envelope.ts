/**
 * Sentry's ingest, without its SDK (plan 78): a report built elsewhere
 * (report.ts) goes out as a one-event envelope over whatever fetch the host
 * hands in. The consent boundary is asked for every report at send time, so
 * revoking it stops the very next one. No queue, no flush on quit, no
 * integrations, sessions or client reports: one request per report the user
 * chose to send. Rate limits are a stored deadline (no timer). Loaded lazily,
 * and only by builds that were given a DSN.
 */
import type { ReportEvent } from "./report";

export type SendResult = { sent: true; status: number } | { sent: false; reason: "policy" | "type" | "error" | "timeout" | "rate" };

export interface Ingest {
  /** <scheme>://<host>/<path>api/<project>/envelope/ */
  url: string;
  key: string;
  dsn: string;
}

/** A DSN's envelope endpoint and public key; null for anything that isn't one. */
export function parseDsn(dsn: string): Ingest | null {
  let u: URL;
  try {
    u = new URL(dsn);
  } catch {
    return null;
  }
  if ((u.protocol !== "https:" && u.protocol !== "http:") || !u.username || u.password) return null;
  const parts = u.pathname.split("/").filter(Boolean);
  const project = parts.pop();
  if (!project || !/^\d+$/.test(project)) return null;
  const prefix = parts.length ? `/${parts.join("/")}` : "";
  return { url: `${u.protocol}//${u.host}${prefix}/api/${project}/envelope/`, key: decodeURIComponent(u.username), dsn: `${u.protocol}//${u.username}@${u.host}${prefix}/${project}` };
}

function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** The envelope, exactly: its header, one event item header, and the event the preview shows. */
export function serializeEnvelope(event: ReportEvent, ingest: Ingest, now = Date.now()): string {
  const payload = JSON.stringify(event);
  const header = JSON.stringify({ event_id: event.event_id, sent_at: new Date(now).toISOString(), dsn: ingest.dsn });
  return `${header}\n${JSON.stringify({ type: "event", length: utf8Length(payload) })}\n${payload}\n`;
}

const DEFAULT_RETRY_MS = 60_000;

/**
 * Until when error events may not be sent, from a response's headers (Sentry's
 * rules): X-Sentry-Rate-Limits wins when present (an item with no categories
 * covers all of them; only "error" and "default" are ours); else a 429's
 * Retry-After (seconds or an HTTP date), else 60 s. Null: not limited.
 */
export function rateLimitUntil(status: number, headers: { get(name: string): string | null }, now = Date.now()): number | null {
  const limits = headers.get("X-Sentry-Rate-Limits");
  if (limits) {
    let until: number | null = null;
    for (const item of limits.split(",")) {
      const [after, categories = ""] = item.trim().split(":", 3);
      const seconds = Number.parseInt(after ?? "", 10);
      const delay = (Number.isNaN(seconds) ? 60 : seconds) * 1000;
      const cats = categories.split(";").filter(Boolean);
      if (cats.length === 0 || cats.includes("error") || cats.includes("default")) until = Math.max(until ?? 0, now + delay);
    }
    return until;
  }
  if (status !== 429) return null;
  const after = headers.get("Retry-After");
  if (after) {
    const seconds = Number(after);
    if (Number.isFinite(seconds) && seconds >= 0) return now + seconds * 1000;
    const date = Date.parse(after);
    if (!Number.isNaN(date)) return Math.max(now, date);
  }
  return now + DEFAULT_RETRY_MS;
}

export type ReportFetch = (
  url: string,
  init: { method: "POST"; body: string; headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ status: number; headers: { get(name: string): string | null } }>;

export interface ReporterOptions {
  dsn: string;
  /** terno/<version>, in the auth header */
  client: string;
  /**
   * "header" (main): X-Sentry-Auth and the envelope content type. "query" (a
   * page): the key in the URL and a text/plain body, a simple request with no
   * CORS preflight, the way Sentry's browser SDK sends.
   */
  auth?: "header" | "query";
  fetch: ReportFetch;
  /** asked for every report, at send time */
  allow(eventId: string): boolean;
  /** every report's fate (counted by the host; never logged as a report itself) */
  onResult?(eventId: string, result: SendResult): void;
  now?: () => number;
}

export interface Reporter {
  /** resolves with what happened to this report */
  send(event: ReportEvent): Promise<SendResult>;
  close(): void;
}

const SEND_TIMEOUT_MS = 30_000;

export function createReporter(o: ReporterOptions): Reporter {
  const ingest = parseDsn(o.dsn);
  const now = o.now ?? Date.now;
  let limitedUntil = 0;
  // an event goes out once at a time: a second send of the same id waits for the first
  const inFlight = new Map<string, Promise<SendResult>>();
  const controllers = new Set<AbortController>();
  let closed = false;

  async function attempt(event: ReportEvent): Promise<SendResult> {
    if (!ingest || closed) return { sent: false, reason: "policy" };
    if (!o.allow(event.event_id)) return { sent: false, reason: "policy" };
    if (now() < limitedUntil) return { sent: false, reason: "rate" };
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      const query = o.auth === "query";
      const res = await o.fetch(query ? `${ingest.url}?sentry_version=7&sentry_key=${encodeURIComponent(ingest.key)}&sentry_client=${encodeURIComponent(o.client)}` : ingest.url, {
        method: "POST",
        body: serializeEnvelope(event, ingest, now()),
        headers: query ? { "Content-Type": "text/plain;charset=UTF-8" } : { "Content-Type": "application/x-sentry-envelope", "X-Sentry-Auth": `Sentry sentry_version=7, sentry_key=${ingest.key}, sentry_client=${o.client}` },
        signal: controller.signal,
      });
      const until = rateLimitUntil(res.status, res.headers, now());
      if (until !== null) limitedUntil = Math.max(limitedUntil, until);
      if (res.status >= 200 && res.status < 300) return { sent: true, status: res.status };
      return { sent: false, reason: res.status === 429 ? "rate" : "error" };
    } catch {
      return { sent: false, reason: controller.signal.aborted && !closed ? "timeout" : "error" };
    } finally {
      clearTimeout(timer);
      controllers.delete(controller);
    }
  }

  return {
    send(event) {
      const running = inFlight.get(event.event_id);
      if (running) return running;
      const p = attempt(event).then((r) => {
        inFlight.delete(event.event_id);
        o.onResult?.(event.event_id, r);
        return r;
      });
      inFlight.set(event.event_id, p);
      return p;
    },
    close() {
      // never finish on the way out: a report must not outlive the decision that allowed it
      closed = true;
      for (const c of controllers) c.abort();
    },
  };
}
