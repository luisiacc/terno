// `pnpm release:mac`: starts the release on GitHub (plan 126,
// .github/workflows/release-mac.yml, set up per RELEASING.md), which runs this
// same script there. `pnpm release:mac --local` builds on this Mac instead.
// The build signs and packages this version, then creates a
// DRAFT GitHub release with everything the updater reads (plan 11 §8.2):
// the zip, its blockmap, the channel file (latest-mac.yml, or
// nightly-mac.yml for an x.y.z-nightly.n version, published as a
// prerelease) and the DMG. Nothing reaches users until the maintainer
// reviews the draft and publishes it. Never run by tests.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dispatch, isMainTip, tagExists } from "./release-ci.mjs";

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
const channel = prerelease ? (/-([a-z]+)/.exec(version)?.[1] ?? "") : "latest";
if (prerelease && channel !== "nightly") fail(`${version}: only stable (x.y.z) and nightly (x.y.z-nightly.n) versions are released`);

const run = (cmd, args, o = {}) => spawnSync(cmd, args, { encoding: "utf8", ...o });
if (run("gh", ["auth", "status"]).status !== 0) fail("gh isn't signed in: run `gh auth login` first");
if (run("gh", ["repo", "view", REPO, "--json", "name"]).status !== 0) fail(`can't see ${REPO} with gh`);
if (run("gh", ["release", "view", `v${version}`, "--repo", REPO]).status === 0) fail(`v${version} already exists on ${REPO}: bump the version in apps/desktop/package.json`);
if (tagExists(version)) fail(`the tag v${version} already exists on ${REPO} without a release: bump the version, or delete the tag if it's a leftover`);
const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: repo, encoding: "utf8" }).trim();
if (dirty && process.env.TERNO_RELEASE_ALLOW_DIRTY !== "1") fail("the working tree has changes: commit them (or TERNO_RELEASE_ALLOW_DIRTY=1)");

// plan 126: on GitHub unless --local; GitHub's runner is where this script then builds (GITHUB_ACTIONS)
const ci = process.env.GITHUB_ACTIONS === "true";
const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
if (!ci && !process.argv.includes("--local")) {
  if (dirty) fail("GitHub builds the commit, not your changes: commit them first");
  if (!isMainTip(sha)) fail(`${sha.slice(0, 10)} isn't the tip of GitHub's main: GitHub builds main's tip, so push your commits (or pull theirs), then run this again`);
  let url;
  try {
    url = dispatch({ sha, version: process.env.TERNO_VERSION });
  } catch (e) {
    fail(`${e.message}\n  Is the workflow on main, and is the "release" environment set up? See RELEASING.md`);
  }
  console.log(`\n✓ building v${version} from ${sha.slice(0, 10)} on GitHub${url ? `: ${url}` : " (see the Actions tab)"}`);
  console.log(`  Follow it with \`gh run watch --repo ${REPO}\`, or close this: it runs without you.`);
  console.log("  When it's done, the draft release is waiting for your review on GitHub's Releases page.");
  process.exit(0);
}

// web + desktop bundles, then the signed app and its update artifacts; a release carries
// Terno's DSN (scripts/release-env.mjs) unless TERNO_SENTRY_DSN overrides it
const step = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", env: { ...process.env, TERNO_RELEASE: "1" } });
  if (r.status !== 0) fail(`${cmd} ${args.join(" ")} failed`);
};
step("pnpm", ["build"], repo);
step("node", [join(here, "package.mjs")], root);

const out = join(root, "release");
const app = join(out, "mac-arm64", "Terno.app");
const signature = run("codesign", ["-dv", "--verbose=2", app]).stderr;
if (/Signature=adhoc|TeamIdentifier=not set/.test(signature)) fail("this build is ad-hoc signed: it couldn't update itself, and updates to it would be refused. Sign with a stable identity (TERNO_SIGN_IDENTITY).");
if (!/Authority=Developer ID Application/.test(signature)) {
  if (ci) fail("not signed with a Developer ID: check MAC_CERT_P12 (RELEASING.md)");
  console.warn("! not signed with a Developer ID: users must bypass Gatekeeper the first time (updates after that need nothing)");
}
// a release from GitHub is always notarized: Gatekeeper must open it without a warning
if (ci && !/source=Notarized Developer ID/.test(run("spctl", ["-a", "-vv", "-t", "exec", app]).stderr)) fail("the app isn't notarized: check the APPLE_API_* secrets (RELEASING.md)");

const files = readdirSync(out);
const want = [`Terno-${version}-arm64-mac.zip`, `Terno-${version}-arm64-mac.zip.blockmap`, `${channel}-mac.yml`, `Terno-${version}-arm64.dmg`];
const missing = want.filter((f) => !files.includes(f));
if (missing.length) fail(`missing artifacts: ${missing.join(", ")}`);
const yml = readFileSync(join(out, `${channel}-mac.yml`), "utf8");
if (!yml.includes(`version: ${version}`) || !yml.includes(`Terno-${version}-arm64-mac.zip`)) fail(`${channel}-mac.yml doesn't describe ${version}`);

const args = ["release", "create", `v${version}`, "--repo", REPO, "--draft", "--title", `Terno ${version}`, "--generate-notes", ...(ci ? ["--target", sha] : []), ...(prerelease ? ["--prerelease"] : []), ...want.map((f) => join(out, f))];
const created = run("gh", args, { stdio: ["ignore", "pipe", "inherit"] });
if (created.status !== 0) fail("gh release create failed (nothing was published)");
console.log(`\n✓ draft release v${version} (${prerelease ? "nightly, prerelease" : "stable"}): ${created.stdout.trim()}`);
console.log("  Review the notes and assets, then publish it: until then no copy of Terno sees it.");
if (!existsSync(join(app, "Contents/Resources/app-update.yml"))) console.warn("! app-update.yml missing from the app");
