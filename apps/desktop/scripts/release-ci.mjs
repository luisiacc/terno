// Plan 126: releases build on GitHub (.github/workflows/release-mac.yml). This
// module is what both ends share: the secrets the workflow needs, the checks
// it runs before touching them, and the `gh workflow run` call that starts it.
// `node release-ci.mjs check` is the workflow's preflight. RELEASING.md is the
// maintainer's setup guide.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const REPO = "luisiacc/terno";
export const WORKFLOW = "release-mac.yml";

/** Secrets the `release` environment must hold. Empty counts as missing: GitHub passes an unset secret as "". */
export const REQUIRED_SECRETS = [
  // plan 99/123: an empty TERNO_GOOGLE_DESKTOP_ID means "a fork, no client" to buildGoogleClients,
  // so without this check a missing secret would ship a release where Gmail can't connect
  "TERNO_GOOGLE_DESKTOP_ID",
  "TERNO_GOOGLE_DESKTOP_SECRET",
  "TERNO_GOOGLE_WEB_ID",
  // the Developer ID Application certificate (.p12, base64) and its export password
  "MAC_CERT_P12",
  "MAC_CERT_PASSWORD",
  // notarization: an App Store Connect API key (the .p8's text) and its ids
  "APPLE_API_KEY_P8",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
];

/** Optional: the dev Google client (accounts made in dev keep refreshing, plan 99) and Sentry source maps. */
export const OPTIONAL_SECRETS = ["TERNO_GOOGLE_DESKTOP_DEV_ID", "TERNO_GOOGLE_DESKTOP_DEV_SECRET", "SENTRY_AUTH_TOKEN"];

const SHA = /^[0-9a-f]{40}$/;
/** What release.mjs releases: stable x.y.z or nightly x.y.z-nightly.n. */
export const VERSION = /^\d+\.\d+\.\d+(?:-nightly\.\d+)?$/;

/** The preflight: every problem by name, never a value. Empty = ready. */
export function preflight(env) {
  const problems = REQUIRED_SECRETS.filter((name) => !env[name]?.trim()).map((name) => `the secret ${name} is missing or empty in the "release" environment (RELEASING.md)`);
  if (!SHA.test(env.RELEASE_SHA ?? "")) problems.push(`the commit "${env.RELEASE_SHA ?? ""}" isn't a full 40-character SHA`);
  if (env.TERNO_VERSION && !VERSION.test(env.TERNO_VERSION)) problems.push(`the version "${env.TERNO_VERSION}" isn't x.y.z or x.y.z-nightly.n`);
  return problems;
}

/** The `gh` arguments that start a release of `sha` (a version only for a nightly or an override). */
export function dispatchArgs({ sha, version }) {
  return ["workflow", "run", WORKFLOW, "--repo", REPO, "--ref", "main", "-f", `sha=${sha}`, ...(version ? ["-f", `version=${version}`] : [])];
}

/**
 * Whether `sha` is GitHub's `main` tip. The workflow builds main's tip with main's own release
 * tooling (an older commit would bring older scripts, without these checks), and fails if main
 * moved after the dispatch, so what you release is what you have.
 */
export function isMainTip(sha, run = gh) {
  const r = run(["api", `repos/${REPO}/commits/main`, "--jq", ".sha"]);
  return r.status === 0 && r.stdout.trim() === sha;
}

/**
 * Whether the tag `v<version>` already exists on GitHub. A tag without a release passes the
 * release check, and `gh release create` would then reuse it wherever it points.
 */
export function tagExists(version, run = gh) {
  return run(["api", `repos/${REPO}/git/ref/tags/v${version}`, "--silent"]).status === 0;
}

function gh(args) {
  return spawnSync("gh", args, { encoding: "utf8" });
}

const RUN_URL = /https:\/\/github\.com\/[^\s]+\/actions\/runs\/\d+/;
const listRuns = (run) => {
  const r = run(["run", "list", "--repo", REPO, "--workflow", WORKFLOW, "--event", "workflow_dispatch", "--limit", "10", "--json", "databaseId,url"]);
  return r.status === 0 ? JSON.parse(r.stdout) : null;
};

/**
 * Starts the workflow for `sha` and returns its run's URL (or null when GitHub hasn't
 * listed it yet). gh prints the URL when GitHub returns it; otherwise it is the first
 * run that wasn't listed before the dispatch (never a timestamp guess, which an earlier
 * run inside the clock-skew window could match).
 */
export function dispatch({ sha, version }, run = gh, wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)) {
  const before = new Set((listRuns(run) ?? []).map((x) => x.databaseId));
  const started = run(dispatchArgs({ sha, version }));
  if (started.status !== 0) throw new Error(`gh workflow run failed: ${(started.stderr ?? "").trim()}`);
  const printed = RUN_URL.exec(`${started.stdout ?? ""}\n${started.stderr ?? ""}`);
  if (printed) return printed[0];
  for (let i = 0; i < 10; i++) {
    wait(2_000);
    const found = listRuns(run)?.find((x) => !before.has(x.databaseId));
    if (found) return found.url;
  }
  return null;
}

/**
 * After a failed `gh release create`: deletes the draft it left (gh creates the draft before
 * uploading, and keeps it when an upload fails), so running the release again isn't blocked
 * by "already exists". Only a draft: a published release is never touched. Returns whether
 * it deleted one.
 */
export function deleteFailedDraft(version, run = gh) {
  const r = run(["release", "view", `v${version}`, "--repo", REPO, "--json", "isDraft", "--jq", ".isDraft"]);
  if (r.status !== 0 || r.stdout.trim() !== "true") return false;
  return run(["release", "delete", `v${version}`, "--repo", REPO, "--yes"]).status === 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "check") {
  const problems = preflight(process.env);
  for (const p of problems) console.error(`✗ ${p}`);
  if (problems.length) process.exit(1);
  console.log(`✓ every release secret is set; building ${process.env.RELEASE_SHA}${process.env.TERNO_VERSION ? ` as ${process.env.TERNO_VERSION}` : ""}`);
}
