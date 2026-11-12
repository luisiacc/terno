// `pnpm release`: starts the release on GitHub (plans 126 and 189, .github/workflows/release.yml, set up per
// RELEASING.md), which runs this same script there, one phase per job:
//
//   build-mac     the signed, notarized app and its update files (macOS runner)
//   build-linux   the deb and rpm packages, x64 and arm64 (Linux runner)
//   draft         every platform's files in one DRAFT release (the only phase that writes to GitHub)
//
// `pnpm release --local` builds macOS on this Mac and drafts it (macOS only). Nothing reaches users until the
// maintainer reviews the draft and publishes it: the zip, its blockmap, the channel file (latest-mac.yml, or
// nightly-mac.yml for an x.y.z-nightly.n version, published as a prerelease), the DMG, and the Linux packages.
// Never run by tests.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deleteFailedDraft, dispatch, isMainTip, tagExists } from "./release-ci.mjs";
import { channelOf, PLATFORMS, releaseAssets } from "./release-assets.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const repo = join(root, "..", "..");
const REPO = "luisiacc/terno";

const fail = (message) => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

if (process.env.TERNO_TEST_BUILD) fail("TERNO_TEST_BUILD is set: a release is never a test build");
const version = process.env.TERNO_VERSION || JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const prerelease = /-/.test(version);
const channel = channelOf(version);
if (prerelease && channel !== "nightly") fail(`${version}: only stable (x.y.z) and nightly (x.y.z-nightly.n) versions are released`);

const run = (cmd, args, o = {}) => spawnSync(cmd, args, { encoding: "utf8", ...o });
const ci = process.env.GITHUB_ACTIONS === "true";
const phase = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : null;
const sha = ci ? process.env.GITHUB_SHA : execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

/** a build step with TERNO_RELEASE=1: a release carries Terno's DSN (scripts/release-env.mjs) unless TERNO_SENTRY_DSN overrides it */
const step = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", env: { ...process.env, TERNO_RELEASE: "1" } });
  if (r.status !== 0) fail(`${cmd} ${args.join(" ")} failed`);
};
const out = join(root, "release");

/** The signed app and its update files, checked; never touches GitHub. */
function buildMac() {
  if (process.platform !== "darwin") fail("build-mac runs on a Mac");
  step("pnpm", ["build"], repo);
  step("node", [join(here, "package.mjs")], root);
  const app = join(out, "mac-arm64", "Terno.app");
  const signature = run("codesign", ["-dv", "--verbose=2", app]).stderr;
  if (/Signature=adhoc|TeamIdentifier=not set/.test(signature)) fail("this build is ad-hoc signed: it couldn't update itself, and updates to it would be refused. Sign with a stable identity (TERNO_SIGN_IDENTITY).");
  if (!/Authority=Developer ID Application/.test(signature)) {
    if (ci) fail("not signed with a Developer ID: check MAC_CERT_P12 (RELEASING.md)");
    console.warn("! not signed with a Developer ID: users must bypass Gatekeeper the first time (updates after that need nothing)");
  }
  // a release from GitHub is always notarized: Gatekeeper must open it without a warning
  if (ci && !/source=Notarized Developer ID/.test(run("spctl", ["-a", "-vv", "-t", "exec", app]).stderr)) fail("the app isn't notarized: check the APPLE_API_* secrets (RELEASING.md)");
  if (!existsSync(join(app, "Contents/Resources/app-update.yml"))) fail("app-update.yml missing from the app");
  checkFiles([out], ["mac"]);
}

/** The deb and rpm packages for both architectures, checked by package-linux.mjs; never touches GitHub. */
function buildLinux() {
  if (process.platform !== "linux") fail("build-linux runs on Linux");
  step("pnpm", ["build"], repo);
  step("node", [join(here, "package-linux.mjs")], root);
  checkFiles([out], ["linux"]);
}

/** Where each of the release's files is, across `dirs`; fails on a missing or doubled one. */
function checkFiles(dirs, platforms) {
  const want = releaseAssets(version, platforms);
  const found = new Map();
  for (const dir of dirs) {
    for (const f of existsSync(dir) ? readdirSync(dir) : []) {
      if (!want.includes(f)) continue;
      if (found.has(f)) fail(`${f} is in both ${dirname(found.get(f))} and ${dir}`);
      found.set(f, join(dir, f));
    }
  }
  const missing = want.filter((f) => !found.has(f));
  if (missing.length) fail(`missing artifacts: ${missing.join(", ")}`);
  if (platforms.includes("mac")) {
    const yml = readFileSync(found.get(`${channel}-mac.yml`), "utf8");
    if (!yml.includes(`version: ${version}`) || !yml.includes(`Terno-${version}-arm64-mac.zip`)) fail(`${channel}-mac.yml doesn't describe ${version}`);
  }
  return want.map((f) => found.get(f));
}

/** The draft release with every platform's files; the one phase that writes to GitHub. */
function draft(dirs, platforms) {
  const files = checkFiles(dirs, platforms);
  if (run("gh", ["release", "view", `v${version}`, "--repo", REPO]).status === 0) fail(`v${version} already exists on ${REPO}: bump the version in apps/desktop/package.json`);
  if (tagExists(version)) fail(`the tag v${version} already exists on ${REPO} without a release: bump the version, or delete the tag if it's a leftover`);
  const args = ["release", "create", `v${version}`, "--repo", REPO, "--draft", "--title", `Terno ${version}`, "--generate-notes", ...(ci ? ["--target", sha] : []), ...(prerelease ? ["--prerelease"] : []), ...files];
  const created = run("gh", args, { stdio: ["ignore", "pipe", "inherit"] });
  if (created.status !== 0) fail(`gh release create failed (nothing was published)${deleteFailedDraft(version) ? "; its unfinished draft was removed, so running the release again is safe" : ""}`);
  console.log(`\n✓ draft release v${version} (${prerelease ? "nightly, prerelease" : "stable"}, ${platforms.join(" and ")}): ${created.stdout.trim()}`);
  console.log("  Review the notes and assets, then publish it: until then no copy of Terno sees it.");
}

// the jobs of .github/workflows/release.yml
if (phase === "build-mac") buildMac();
else if (phase === "build-linux") buildLinux();
else if (phase === "draft") {
  // release.mjs draft <dir>…: the packages each build job uploaded, downloaded by the draft job
  const dirs = process.argv.slice(3).map((d) => resolve(d));
  if (!dirs.length) fail("draft needs the directories the builds' files are in");
  draft(dirs, PLATFORMS);
} else if (phase) fail(`unknown phase ${phase}: build-mac, build-linux or draft`);
else {
  // the maintainer's command: checks, then GitHub builds (or this Mac, with --local)
  if (run("gh", ["auth", "status"]).status !== 0) fail("gh isn't signed in: run `gh auth login` first");
  if (run("gh", ["repo", "view", REPO, "--json", "name"]).status !== 0) fail(`can't see ${REPO} with gh`);
  if (run("gh", ["release", "view", `v${version}`, "--repo", REPO]).status === 0) fail(`v${version} already exists on ${REPO}: bump the version in apps/desktop/package.json`);
  if (tagExists(version)) fail(`the tag v${version} already exists on ${REPO} without a release: bump the version, or delete the tag if it's a leftover`);
  const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: repo, encoding: "utf8" }).trim();
  if (dirty && process.env.TERNO_RELEASE_ALLOW_DIRTY !== "1") fail("the working tree has changes: commit them (or TERNO_RELEASE_ALLOW_DIRTY=1)");

  if (process.argv.includes("--local")) {
    buildMac();
    draft([out], ["mac"]);
  } else {
    if (dirty) fail("GitHub builds the commit, not your changes: commit them first");
    if (!isMainTip(sha)) fail(`${sha.slice(0, 10)} isn't the tip of GitHub's main: GitHub builds main's tip, so push your commits (or pull theirs), then run this again`);
    let url;
    try {
      url = dispatch({ sha, version: process.env.TERNO_VERSION });
    } catch (e) {
      fail(`${e.message}\n  Is the workflow on main, and is the "release" environment set up? See RELEASING.md`);
    }
    console.log(`\n✓ building v${version} from ${sha.slice(0, 10)} on GitHub (macOS and Linux)${url ? `: ${url}` : " (see the Actions tab)"}`);
    console.log(`  Follow it with \`gh run watch --repo ${REPO}\`, or close this: it runs without you.`);
    console.log("  When it's done, the draft release is waiting for your review on GitHub's Releases page.");
  }
}
