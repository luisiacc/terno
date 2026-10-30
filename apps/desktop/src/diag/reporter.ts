/**
 * Main's report pipe (plan 78): Electron's net.fetch (system proxy) in a
 * session of its own that can reach the DSN's envelope URL and nothing else,
 * without cookies or redirects. The default session's local-mode backstop
 * stays as it is, so the renderer still can't reach the ingest.
 * Imported lazily: only once a report is about to go, in a build with a DSN.
 */
import { session } from "electron";
import { createReporter, parseDsn, type Reporter, type ReporterOptions } from "@terno/core/diag/envelope";
import { reportInboundHeaders, reportOutboundHeaders, reportRequestAllowed } from "./report-fence";

const PARTITION = "terno-reports";

export function createMainReporter(o: Omit<ReporterOptions, "fetch">): Reporter {
  const ingest = parseDsn(o.dsn);
  const ses = session.fromPartition(PARTITION, { cache: false });
  ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !ingest || !reportRequestAllowed(details, ingest.url) }));
  ses.webRequest.onBeforeSendHeaders((details, callback) => callback({ requestHeaders: reportOutboundHeaders(details.requestHeaders) }));
  ses.webRequest.onHeadersReceived((details, callback) => callback({ responseHeaders: reportInboundHeaders(details.responseHeaders ?? {}) }));
  return createReporter({
    ...o,
    fetch: (url, init) => ses.fetch(url, { method: init.method, body: init.body, headers: init.headers, signal: init.signal, redirect: "error", credentials: "omit" }),
  });
}
