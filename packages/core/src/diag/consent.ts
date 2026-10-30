/**
 * Whether a report may leave the machine, decided per report at send time.
 * The user's choice is the consent (plan 78): "ask" sends only what they
 * approved, one report at a time; "always" sends without asking; "never"
 * sends nothing. Local mode doesn't decide it (sending is something the user
 * asked for, like a remote image they load); a build without a DSN sends nothing.
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
  if (!p.dsn) return false;
  return p.errorReports === "always" || (p.errorReports === "ask" && approved);
}

/** Reports go out without asking. */
export function reportsAutomatically(p: ReportPolicy): boolean {
  return mayReport(p, false);
}

/** What the post-crash row offers: ask to send, say it was sent, or keep it here (no DSN, or "never"). */
export function reportOffer(p: ReportPolicy): "ask" | "sent" | "local" {
  if (!p.dsn || p.errorReports === "never") return "local";
  return p.errorReports === "always" ? "sent" : "ask";
}
