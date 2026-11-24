// Plans 126 and 189: releases build on GitHub (.github/workflows/release.yml).
// This module is what both ends share: the secrets each job needs, the checks
// it runs before touching them, and the `gh workflow run` call that starts it.
// `node release-ci.mjs check <phase>` is each job's preflight. RELEASING.md is
// the maintainer's setup guide.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { compareRelease, NIGHTLY_TAG } from "./release-assets.mjs";

export const REPO = "luisiacc/terno";
export const WORKFLOW = "release.yml";

// plan 99/123: an empty TERNO_GOOGLE_DESKTOP_ID means "a fork, no client" to buildGoogleClients,
// so without this check a missing secret would ship a release where Gmail can't connect. The web client
// (TERNO_GOOGLE_WEB_ID) is only the web build's (apps/web/vite.config.ts); a desktop release never reads it
const GOOGLE = ["TERNO_GOOGLE_DESKTOP_ID", "TERNO_GOOGLE_DESKTOP_SECRET"];
const MAC = [
  // the Developer ID Application certificate (.p12, base64) and its export password
  "MAC_CERT_P12",
  "MAC_CERT_PASSWORD",
  // notarization: an App Store Connect API key (the .p8's text) and its ids
  "APPLE_API_KEY_P8",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
];

/** Each job's secrets (plan 189): the draft holds none, and the Linux job never sees the signing key. Empty counts as missing: GitHub passes an unset secret as "". */
export const PHASE_SECRETS = { "build-mac": [...GOOGLE, ...MAC], "build-linux": GOOGLE, draft: [] };

/** Secrets the `release` environment must hold, for every job. */
export const REQUIRED_SECRETS = [...new Set(Object.values(PHASE_SECRETS).flat())];

/** Optional: a dev Google client (accounts made with it keep refreshing, plan 99; none since dev builds use the release's) and Sentry source maps. */
export const OPTIONAL_SECRETS = ["TERNO_GOOGLE_DESKTOP_DEV_ID", "TERNO_GOOGLE_DESKTOP_DEV_SECRET", "SENTRY_AUTH_TOKEN"];

const SHA = /^[0-9a-f]{40}$/;
/** What release.mjs releases: stable x.y.z or nightly x.y.z-nightly.n. */
export const VERSION = /^\d+\.\d+\.\d+(?:-nightly\.\d+)?$/;

/** A job's preflight: every problem by name, never a value. Empty = ready. */
export function preflight(env, phase) {
  if (!Object.hasOwn(PHASE_SECRETS, phase)) return [`unknown phase "${phase}"`];
  const problems = PHASE_SECRETS[phase].filter((name) => !env[name]?.trim()).map((name) => `the secret ${name} is missing or empty in the "release" environment (RELEASING.md)`);
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

// ── Plan 257: the nightly ─────────────────────────────────────────────────────────────────────────────────────────
// .github/workflows/nightly.yml runs `node release-ci.mjs nightly` each night: it reads GitHub, decides, and starts
// release.yml exactly as `pnpm release` does. The draft job then publishes the nightly and prunes old ones.

/** Nightlies kept on the Releases page; a copy only ever needs the newest. */
export const KEEP_NIGHTLIES = 10;

/** `0.1.5` → `0.1.6` */
export function nextPatch(version) {
  const [major, minor, patch] = version.split(".").map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

/** The nightly number: the run's start in UTC as YYYYMMDDHHmm, so nightlies sort by time (12 digits, a safe integer). */
export function nightlyStamp(now) {
  return now.toISOString().slice(0, 16).replace(/\D/g, "");
}

/**
 * Tonight's decision, from what GitHub says (plan 257). `nightlies` are the published ones, newest first or not.
 * The base is the package's version until it's released, then the next patch, and never below the newest nightly's:
 * a nightly sorts above the last stable, below the next one, and above every earlier nightly.
 */
export function nightlyPlan({ pkgVersion, pkgReleased, nightlies, mainSha, busy, now }) {
  if (busy) return { build: false, reason: "a release run is queued or running: it would replace a waiting one, so tonight is skipped" };
  const newest = [...nightlies].sort((a, b) => compareRelease(b.version, a.version))[0] ?? null;
  if (newest && newest.sha === mainSha) return { build: false, reason: `main (${mainSha.slice(0, 10)}) is already ${newest.version}` };
  let base = pkgReleased ? nextPatch(pkgVersion) : pkgVersion;
  const newestBase = newest?.version.replace(/-.*/, "");
  if (newestBase && compareRelease(newestBase, base) > 0) base = newestBase;
  const version = `${base}-nightly.${nightlyStamp(now)}`;
  if (newest && compareRelease(version, newest.version) <= 0) return { build: false, reason: `${version} wouldn't sort above ${newest.version}` };
  return { build: true, version };
}

/** The published nightlies past the newest `keep`, oldest last: never a draft, a stable release or a stray tag. */
export function nightliesToPrune(releases, keep = KEEP_NIGHTLIES) {
  const nightlies = releases.filter((r) => r.prerelease && !r.draft && NIGHTLY_TAG.test(r.tag));
  return nightlies.sort((a, b) => compareRelease(b.tag.slice(1), a.tag.slice(1))).slice(keep).map((r) => r.tag);
}

/** A `gh` read that fails loudly: a guess here could build the wrong version or delete the wrong release. */
function ghRead(run, args, what) {
  const r = run(args);
  if (r.status !== 0) throw new Error(`couldn't read ${what} from GitHub: ${(r.stderr ?? "").trim()}`);
  return r.stdout;
}

/** Every release on GitHub (all pages), as { tag, prerelease, draft }. */
export function listReleases(run = gh) {
  const out = ghRead(run, ["api", "--paginate", `repos/${REPO}/releases?per_page=100`, "--jq", ".[] | {tag: .tag_name, prerelease, draft}"], "the releases");
  return out.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/** Whether `v<version>` is a published release: only a 404 means no. */
export function isReleased(version, run = gh) {
  const r = run(["api", `repos/${REPO}/releases/tags/v${version}`, "--jq", ".draft"]);
  if (r.status === 0) return r.stdout.trim() === "false";
  if (/HTTP 404|Not Found/.test(r.stderr ?? "")) return false;
  throw new Error(`couldn't read the release v${version} from GitHub: ${(r.stderr ?? "").trim()}`);
}

/** The published nightlies, as { version, sha } (only the newest's commit is read; the plan needs no other). */
export function publishedNightlies(run = gh) {
  const versions = listReleases(run)
    .filter((r) => r.prerelease && !r.draft && NIGHTLY_TAG.test(r.tag))
    .map((r) => r.tag.slice(1))
    .sort((a, b) => compareRelease(b, a));
  return versions.map((version, i) => ({ version, sha: i === 0 ? ghRead(run, ["api", `repos/${REPO}/commits/v${version}`, "--jq", ".sha"], `v${version}'s commit`).trim() : null }));
}

/** Whether any release.yml run hasn't finished (queued, waiting, pending or in progress). */
export function releaseBusy(run = gh) {
  const runs = JSON.parse(ghRead(run, ["run", "list", "--repo", REPO, "--workflow", WORKFLOW, "--limit", "20", "--json", "status"], "the release runs"));
  return runs.some((x) => x.status !== "completed");
}

/** The scheduler: reads GitHub, decides, and starts release.yml for main's tip. */
export function startNightly({ run = gh, now = new Date(), start = dispatch } = {}) {
  const mainSha = ghRead(run, ["api", `repos/${REPO}/commits/main`, "--jq", ".sha"], "main's tip").trim();
  if (!SHA.test(mainSha)) throw new Error(`main's tip "${mainSha}" isn't a SHA`);
  const content = ghRead(run, ["api", `repos/${REPO}/contents/apps/desktop/package.json?ref=${mainSha}`, "--jq", ".content"], "the desktop package.json");
  const pkgVersion = JSON.parse(Buffer.from(content, "base64").toString("utf8")).version;
  if (!/^\d+\.\d+\.\d+$/.test(pkgVersion)) throw new Error(`apps/desktop/package.json's version ${pkgVersion} isn't x.y.z`);
  const plan = nightlyPlan({ pkgVersion, pkgReleased: isReleased(pkgVersion, run), nightlies: publishedNightlies(run), mainSha, busy: releaseBusy(run), now });
  if (plan.build) plan.url = start({ sha: mainSha, version: plan.version }, run);
  return { ...plan, mainSha };
}

/**
 * The draft job, for a nightly built on GitHub: refuses one that wouldn't sort above every published nightly (the
 * updater takes the feed's first nightly, so order must match), before anything is created.
 */
export function assertNightlyIsNewest(version, run = gh) {
  const newest = publishedNightlies(run)[0];
  if (newest && compareRelease(version, newest.version) <= 0) throw new Error(`${version} doesn't sort above the published ${newest.version}`);
}

/**
 * Publishes a nightly's draft as a prerelease that is never "Latest" (stable copies and the site read /releases/latest).
 * On a failed edit the release is read back: still a draft → deleted, so nothing half-done stays; published → done.
 */
export function publishNightly(version, run = gh) {
  const edited = run(["release", "edit", `v${version}`, "--repo", REPO, "--draft=false", "--prerelease", "--latest=false"]);
  if (edited.status === 0) return;
  const state = run(["release", "view", `v${version}`, "--repo", REPO, "--json", "isDraft,isPrerelease", "--jq", "[.isDraft, .isPrerelease] | @tsv"]);
  if (state.status === 0 && state.stdout.trim() === "false\ttrue") return;
  const removed = deleteFailedDraft(version, run);
  throw new Error(`couldn't publish v${version}: ${(edited.stderr ?? "").trim()}${removed ? " (its draft was removed; the next night builds again)" : ""}`);
}

/** Deletes the nightlies past the newest KEEP_NIGHTLIES, with their tags; returns the ones it couldn't (throws only if it can't list them). */
export function pruneNightlies(run = gh) {
  const failed = [];
  for (const tag of nightliesToPrune(listReleases(run))) {
    if (run(["release", "delete", tag, "--repo", REPO, "--cleanup-tag", "--yes"]).status !== 0) failed.push(tag);
  }
  return failed;
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "nightly") {
  try {
    const r = startNightly();
    console.log(r.build ? `✓ building ${r.version} from ${r.mainSha.slice(0, 10)}${r.url ? `: ${r.url}` : ""}` : `· no nightly tonight: ${r.reason}`);
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "check") {
  const problems = preflight(process.env, process.argv[3]);
  for (const p of problems) console.error(`✗ ${p}`);
  if (problems.length) process.exit(1);
  console.log(`✓ ${process.argv[3]}: every secret it needs is set; releasing ${process.env.RELEASE_SHA}${process.env.TERNO_VERSION ? ` as ${process.env.TERNO_VERSION}` : ""}`);
}
