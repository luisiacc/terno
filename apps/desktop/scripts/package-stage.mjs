// What packaging Terno is on every platform (plan 189): the build it packages, the staging app electron-builder
// reads (bundles only, no node_modules), where updates come from, and plan 95's required-update stamp. package.mjs
// (macOS) and package-linux.mjs (deb and rpm) each add their platform's targets and checks.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fuseTable } from "./fuses.mjs";
import { bridgeDir, buildBridge, readManifest } from "./mcp-bridge.mjs";
import { publishConfig } from "./release-assets.mjs";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/** One ASCII name everywhere: the bundle, CFBundleName (Electron names its helpers after it), the DMG volume, the desktop entry. */
export const productName = "Terno";
/** the legal entity behind Terno: the LICENSE's Licensor, the Developer ID team, the packages' maintainer */
export const publisher = "Luisiacc LLC";
export const electronVersion = JSON.parse(readFileSync(require.resolve("electron/package.json"), "utf8")).version;
/** the host's own Electron: macOS packages it as is; Linux never does (each architecture downloads its own, plan 189) */
export const electronDist = join(dirname(require.resolve("electron/package.json")), "dist");
export const testBuild = process.env.TERNO_TEST_BUILD ? JSON.parse(process.env.TERNO_TEST_BUILD) : undefined;
/** plan 283: what release.mjs packages, with Node's inspector fused off; anything else stays inspectable for the smoke suite */
export const shipped = process.env.TERNO_SHIPPED === "1";
if (shipped && testBuild) throw new Error("a test build is never shipped: unset TERNO_SHIPPED");
export const version = process.env.TERNO_VERSION || pkg.version;
export const release = process.env.TERNO_PACKAGE_OUT || join(root, "release");
// a test build stages beside its own output, never in the checkout
const stage = process.env.TERNO_PACKAGE_OUT ? `${release}.stage` : join(root, ".stage");
/** what update tests are built as: never dev.terno.mail, so a real Terno's Squirrel state and caches stay untouched */
export const appId = testBuild ? "dev.terno.updatetest" : "dev.terno.mail";
// electron-updater's cache is ~/Library/Caches/<name>-updater
const packageName = testBuild ? "terno-updatetest" : "terno";
/** the feed a copy checks (plan 11): GitHub's releases, or a test build's own */
export const publish = testBuild ? { provider: "generic", url: testBuild.feed } : publishConfig(version);
const dist = process.env.TERNO_BUILD_OUT || join(root, "dist");

/** Checks the build is the right kind, then writes the staging app; returns its directory (electron-builder's projectDir). */
export function stageApp(extra = {}) {
  if (!existsSync(join(dist, "main.cjs"))) throw new Error("run `pnpm --filter @terno/desktop build` first");
  // a test build (its own feed and profile baked in) is never packaged as a release, nor a release as a test
  if (existsSync(join(dist, "test-build.json")) !== Boolean(testBuild)) throw new Error(testBuild ? `${dist} is not a test build` : `${dist} is a test build: rebuild with \`pnpm build\``);
  rmSync(stage, { recursive: true, force: true });
  rmSync(release, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  cpSync(dist, join(stage, "dist"), { recursive: true });
  writeFileSync(
    join(stage, "package.json"),
    JSON.stringify({ name: packageName, productName, version, description: pkg.description, main: "dist/main.cjs", author: publisher, license: "SEE LICENSE IN LICENSE", ...extra }, null, 2),
  );
  return stage;
}

/**
 * Plan 293: compiles the agents' bridge for each architecture into the staging app (after stageApp), from this
 * build's offline manifest; extraResources picks it up per architecture.
 */
export function stageBridges(os, arches) {
  const manifest = readManifest(dist);
  for (const arch of arches) {
    const out = buildBridge({ manifest, target: { os, arch }, out: join(bridgeDir(stage, os, arch), "terno-mcp") });
    console.log(`✓ the agents' bridge for ${os} ${arch}: ${out}`);
  }
}

/**
 * What every platform ships beside the app: the agents' bridge (plan 293: Resources/bin/terno-mcp, the path every
 * agent's config holds), the agents' skill, and the License (BSL 1.1). `${os}-${arch}` is electron-builder's.
 */
export const commonResources = [
  { from: join(stage, "bridge", "${os}-${arch}"), to: "bin" },
  { from: join(dist, "mcp"), to: "mcp" },
  { from: join(root, "../../LICENSE"), to: "LICENSE" },
];

/** electron-builder's options every platform shares (`platform`: the fuses differ, plan 283). */
export function commonConfig(platform) {
  return {
    appId,
    productName,
    // plan 201: links to emails (terno://message/…); a test build claims none, so it never takes the user's links
    ...(testBuild ? {} : { protocols: [{ name: "Terno email link", schemes: ["terno"] }] }),
    copyright: `© 2026 ${publisher}`,
    electronVersion,
    files: ["dist/**/*", "!dist/mcp/**", "!dist/native/**", "package.json"],
    asar: true,
    npmRebuild: false,
    nodeGypRebuild: false,
    buildDependenciesFromSource: false,
    electronLanguages: ["en", "es"],
    // plan 283: flipped before signing, so the signature and notarization cover them
    electronFuses: fuseTable({ platform, shipped }),
    publish,
  };
}

/** Source maps (archived by build.mjs, never in the app) go to Sentry for a release (plan 78). */
export async function uploadReleaseMaps() {
  if (!testBuild && process.env.TERNO_RELEASE === "1") (await import(join(root, "../../scripts/upload-maps.mjs"))).uploadMaps(join(root, ".maps", "LATEST"));
}

/**
 * Plan 95: a required update. Copies below `minimumVersion` cover their window with "Update Terno" once a check
 * reads this (TERNO_MINIMUM_VERSION, or apps/desktop/release-policy.json's minimumVersion); it must not exceed this
 * release. Stamped into the channel file the updater reads.
 */
export function stampMinimumVersion(channelFile) {
  const policyFile = join(root, "release-policy.json");
  const minimum = process.env.TERNO_MINIMUM_VERSION || (existsSync(policyFile) ? JSON.parse(readFileSync(policyFile, "utf8")).minimumVersion : null);
  if (!minimum) return;
  const semver = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;
  if (!semver.test(minimum)) throw new Error(`minimumVersion ${minimum} isn't x.y.z`);
  const core = (v) => semver.exec(v).slice(1, 4).map(Number);
  const [a, b] = [core(minimum), core(version)];
  const above = a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];
  if (above) throw new Error(`minimumVersion ${minimum} is above this release (${version}): no copy could meet it`);
  const yml = join(release, channelFile);
  writeFileSync(yml, `${readFileSync(yml, "utf8").replace(/^minimumVersion:.*\n?/m, "").trimEnd()}\nminimumVersion: '${minimum}'\n`);
  console.log(`✓ ${channelFile} requires ${minimum} or later`);
}
