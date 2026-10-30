/**
 * The reports session's fence (plan 78), kept apart from Electron so it's
 * unit-tested in Node: the one envelope URL of the DSN this build carries,
 * by POST, and nothing else; no cookies either way.
 */
export { inboundHeaders as reportInboundHeaders, outboundHeaders as reportOutboundHeaders } from "../updates/policy";

export function reportRequestAllowed(req: { url: string; method: string }, ingestUrl: string): boolean {
  return req.method === "POST" && req.url === ingestUrl;
}

/**
 * Where this run may report: production uses the DSN it was built with; a test
 * run only its loopback sink (never the DSN of the release it copied); demo
 * and dev runs nowhere (a demo mailbox's problems aren't users' bugs).
 */
export function effectiveDsn(o: { channel: "production" | "dev" | "test" | "demo"; built: string; testSink: string | undefined }): string {
  if (o.channel === "production") return o.built;
  return o.channel === "test" ? loopbackDsn(o.testSink) : "";
}

/** A test run's sink: loopback only, so a test can never reach a real ingest. */
export function loopbackDsn(dsn: string | undefined): string {
  try {
    const host = dsn ? new URL(dsn).hostname : "";
    return host === "127.0.0.1" || host === "localhost" || host === "[::1]" ? dsn! : "";
  } catch {
    return "";
  }
}
