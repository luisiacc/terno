/**
 * The web build's report pipe (plan 78): the shared reporter over this page's
 * fetch, with no cookies, no referrer and no redirects (a 3xx can't carry a
 * report anywhere else). A chunk of its own, emitted only by web builds given
 * a DSN (diag-local.ts imports it behind that constant).
 */
import { createReporter, type Reporter, type ReporterOptions } from "@terno/core/diag/envelope";

export function createWebReporter(o: Omit<ReporterOptions, "fetch">): Reporter {
  return createReporter({
    ...o,
    auth: "query",
    fetch: (url, init) => fetch(url, { ...init, credentials: "omit", referrerPolicy: "no-referrer", redirect: "error", keepalive: false, cache: "no-store" }),
  });
}
