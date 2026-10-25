/**
 * Main's Sentry transport: Electron's net.fetch (system proxy, and the
 * session's local-mode fence as a second wall), behind consentTransport.
 * Imported lazily: only once a report is about to go, in a build with a DSN.
 */
import { net } from "electron";
import { createReporter, fetchTransport, type Reporter, type ReporterOptions } from "@terno/core/diag/sentry";

export function createMainReporter(o: Omit<ReporterOptions, "transport">): Reporter {
  return createReporter({ ...o, transport: fetchTransport((url, init) => net.fetch(url, { method: init.method, body: typeof init.body === "string" ? init.body : Buffer.from(init.body), headers: init.headers })) });
}
