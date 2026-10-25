/**
 * The web build's reporter: @sentry/browser's fetch transport behind the
 * shared consent boundary. A chunk of its own, emitted only by web builds
 * given a DSN (diag-local.ts imports it behind that constant).
 */
import { makeFetchTransport } from "@sentry/browser";
import { createReporter, type Reporter, type ReporterOptions } from "@terno/core/diag/sentry";

export function createWebReporter(o: Omit<ReporterOptions, "transport">): Reporter {
  return createReporter({ ...o, transport: makeFetchTransport });
}
