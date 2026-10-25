/**
 * What this build is, baked in by scripts/build.mjs: the version, the commit
 * it was built from, and the Sentry DSN (public by design; empty in dev and
 * fork builds, which then never load the reporter at all).
 */
import type { Channel } from "@terno/core/diag";

export const BUILD_VERSION = process.env.TERNO_BUILD_VERSION ?? "0.0.0";
export const BUILD_SHA = process.env.TERNO_BUILD_SHA ?? "dev";
export const BUILD_DSN = process.env.TERNO_SENTRY_DSN ?? "";

/** version+sha: the release, the log lines and the source-map archive all use it */
export const BUILD_ID = `${BUILD_VERSION}+${BUILD_SHA}`;

export function channelOf(o: { packaged: boolean; demo: boolean; test: boolean }): Channel {
  if (o.test) return "test";
  if (o.demo) return "demo";
  return o.packaged ? "production" : "dev";
}
