// Uploads a build's archived source maps to Sentry (plan 78), with the `sentry`
// CLI (https://cli.sentry.dev) instead of an SDK dependency: its own login, or
// SENTRY_AUTH_TOKEN. The archive (from build.mjs or the web build) holds each
// minified file beside its map, both tagged with the same debug id, so
// reports resolve without any URL matching. Never fails a build: without the
// CLI or a login it says so and the maps stay archived (`pnpm diag:symbolicate`).
//
//   node scripts/upload-maps.mjs <path to a LATEST pointer>
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { SENTRY_ORG, SENTRY_PROJECT } from "./release-env.mjs";

export function uploadMaps(pointer) {
  if (!existsSync(pointer)) return console.warn(`! no source maps to upload (${pointer} missing)`);
  const { release, archive } = JSON.parse(readFileSync(pointer, "utf8"));
  if (spawnSync("sentry", ["--version"], { stdio: "ignore" }).status !== 0) return console.warn(`! source maps for ${release} not uploaded: install the sentry CLI (curl https://cli.sentry.dev/install -fsS | bash); they stay in ${archive}`);
  const env = { ...process.env, SENTRY_ORG: process.env.SENTRY_ORG || SENTRY_ORG, SENTRY_PROJECT: process.env.SENTRY_PROJECT || SENTRY_PROJECT };
  try {
    // the files are tagged already (scripts/sourcemaps.mjs): upload them as they are
    execFileSync("sentry", ["sourcemap", "upload", archive, "--release", release, "--no-rewrite"], { stdio: "inherit", env });
    console.log(`✓ source maps for ${release} uploaded to ${env.SENTRY_ORG}/${env.SENTRY_PROJECT}`);
  } catch {
    console.warn(`! source maps for ${release} were NOT uploaded (sentry auth status?); they stay in ${archive}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) uploadMaps(process.argv[2]);
