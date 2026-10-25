/**
 * Whether a report may leave the machine, decided per report at send time.
 * Local mode wins over everything; a build without a DSN sends nothing; "ask"
 * sends only what the user approved, one report at a time.
 */
export type ErrorReports = "ask" | "always" | "never";
export const ERROR_REPORTS: readonly ErrorReports[] = ["ask", "always", "never"];

export interface ReportPolicy {
  localMode: boolean;
  errorReports: ErrorReports;
  /** this build was given a DSN */
  dsn: boolean;
}

/** Unknown (before the backend said): nothing goes. */
export const CLOSED_POLICY: ReportPolicy = { localMode: true, errorReports: "never", dsn: false };

export function mayReport(p: ReportPolicy, approved: boolean): boolean {
  if (!p.dsn || p.localMode) return false;
  return p.errorReports === "always" || (p.errorReports === "ask" && approved);
}

/** Reports go out without asking. */
export function reportsAutomatically(p: ReportPolicy): boolean {
  return mayReport(p, false);
}

/** What the post-crash row offers: ask to send, say it was sent, or keep it local (export). */
export function reportOffer(p: ReportPolicy): "ask" | "sent" | "local" {
  if (!p.dsn || p.localMode || p.errorReports === "never") return "local";
  return p.errorReports === "always" ? "sent" : "ask";
}
