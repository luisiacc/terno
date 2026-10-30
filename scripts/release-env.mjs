// What a release build carries (plan 78). The DSN is public by design: it can
// only submit events, to the `terno` project (luisiaccorg). A release gets it
// unless TERNO_SENTRY_DSN says otherwise (empty: reports off, e.g. a fork);
// dev, demo and test builds never do.
export const TERNO_DSN = "https://94ef4113e2c6f556c30c47b6533c43d7@o4505891924738048.ingest.us.sentry.io/4512346705166336";
export const SENTRY_ORG = "luisiaccorg";
export const SENTRY_PROJECT = "terno";

/** The DSN a build bakes in: the override if set, else ours for a release, else none. */
export function buildDsn(env = process.env) {
  if (env.TERNO_SENTRY_DSN !== undefined) return env.TERNO_SENTRY_DSN;
  return env.TERNO_RELEASE === "1" ? TERNO_DSN : "";
}
