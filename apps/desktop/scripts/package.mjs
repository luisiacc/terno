// Packages Terno for macOS Apple Silicon: a self-contained staging app
// (bundles only, no node_modules), electron-builder for the .app and its
// update artifacts (zip, blockmap, latest-mac.yml / nightly-mac.yml), signed
// with one stable identity (plan 11 §8.1), verified, then a compressed DMG.
//
// Signing: TERNO_SIGN_IDENTITY ("-" = ad-hoc), else a "Developer ID
// Application" identity, else "Apple Development", else ad-hoc. Squirrel
// accepts an update only when the new bundle satisfies the running one's
// designated requirement, which needs the same certificate every time; an
// ad-hoc build can't update itself (it says so in Settings). A Developer ID
// adds the hardened runtime, and notarization when APPLE_* credentials are
// set (APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID, or
// APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER).
//
// Test builds (TERNO_TEST_BUILD, see build.mjs) get their own bundle id and
// cache names (Squirrel's ShipIt state, electron-updater's cache) so they
// never touch a real Terno's, a generic feed, and no DMG.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, Platform, Arch } from "electron-builder";
import { withMounted } from "../src/dmg-mount.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const require = createRequire(join(root, "package.json"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const electronPkg = JSON.parse(readFileSync(require.resolve("electron/package.json"), "utf8"));
const electronDist = join(dirname(require.resolve("electron/package.json")), "dist");
const testBuild = process.env.TERNO_TEST_BUILD ? JSON.parse(process.env.TERNO_TEST_BUILD) : undefined;
const version = process.env.TERNO_VERSION || pkg.version;
const release = process.env.TERNO_PACKAGE_OUT || join(root, "release");
// a test build stages beside its own output, never in the checkout
const stage = process.env.TERNO_PACKAGE_OUT ? `${release}.stage` : join(root, ".stage");
// One ASCII name everywhere: bundle, CFBundleName (Electron derives the
// "<name> Helper.app" file names from it), the executable and the DMG volume.
const productName = "Terno";
/** what update tests are built as: never dev.terno.mail, so a real Terno's Squirrel state and caches stay untouched */
const TEST_APP_ID = "dev.terno.updatetest";
const appId = testBuild ? TEST_APP_ID : "dev.terno.mail";
// electron-updater's cache is ~/Library/Caches/<name>-updater
const packageName = testBuild ? "terno-updatetest" : "terno";

const dist = process.env.TERNO_BUILD_OUT || join(root, "dist");
if (!existsSync(join(dist, "main.cjs"))) throw new Error("run `pnpm --filter @terno/desktop build` first");
// a test build (its own feed and profile baked in) is never packaged as a release, nor a release as a test
if (existsSync(join(dist, "test-build.json")) !== Boolean(testBuild)) throw new Error(testBuild ? `${dist} is not a test build` : `${dist} is a test build: rebuild with \`pnpm build\``);

/** The identity to sign with: explicit, else the best one in the keychain, else ad-hoc ("-"). */
function pickIdentity() {
  const explicit = process.env.TERNO_SIGN_IDENTITY;
  if (explicit) return explicit;
  let listed = "";
  try {
    listed = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8", timeout: 15_000 });
  } catch {
    return "-";
  }
  const names = [...listed.matchAll(/^\s*\d+\)\s+[0-9A-F]{40}\s+"([^"]+)"/gm)].map((m) => m[1]);
  return names.find((n) => n.startsWith("Developer ID Application:")) ?? names.find((n) => n.startsWith("Apple Development:")) ?? "-";
}

/**
 * Fails fast instead of hanging: codesign waits forever on a keychain prompt
 * in a non-interactive shell. A throwaway binary is signed under a timeout.
 */
function assertCanSign(identity) {
  if (identity === "-") return;
  const dir = mkdtempSync(join(tmpdir(), "terno-signcheck-"));
  try {
    const probe = join(dir, "probe");
    copyFileSync("/usr/bin/true", probe);
    const r = spawnSync("codesign", ["--force", "--sign", identity, "--timestamp=none", probe], { encoding: "utf8", timeout: 30_000 });
    if (r.error?.code === "ETIMEDOUT" || r.signal) {
      throw new Error(
        `codesign didn't answer within 30 s with "${identity}": the keychain is probably asking for permission. Unlock the login keychain and allow codesign to use the key (or set TERNO_SIGN_IDENTITY=- for an ad-hoc build that can't update itself).`,
      );
    }
    if (r.status !== 0) throw new Error(`codesign can't sign with "${identity}": ${r.stderr.trim()}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Plan 19: the icon macOS shows: Assets.car's "Icon" on macOS 26, the .icns elsewhere. */
function assertIcon(app) {
  const info = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", join(app, "Contents/Info.plist")], { encoding: "utf8" }));
  if (info.CFBundleIconName !== "Icon" || info.CFBundleIconFile !== "icon.icns") throw new Error(`unexpected icon keys: CFBundleIconName=${info.CFBundleIconName} CFBundleIconFile=${info.CFBundleIconFile}`);
  for (const f of ["Assets.car", "icon.icns"]) if (!existsSync(join(app, "Contents/Resources", f))) throw new Error(`${f} missing from the app's Resources`);
}

const identity = pickIdentity();
const developerId = identity.startsWith("Developer ID Application:");
const notarize = developerId && Boolean((process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID) || (process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER));
assertCanSign(identity);
console.log(`signing with ${identity === "-" ? "an ad-hoc signature (this build can't update itself)" : identity}${developerId ? `, hardened runtime${notarize ? ", notarized" : ", not notarized (no APPLE_* credentials)"}` : ""}`);

// Source maps (archived by build.mjs, never in the app) go to Sentry only when a token is set.
const latest = join(root, ".maps", "LATEST");
if (!testBuild && process.env.SENTRY_AUTH_TOKEN && existsSync(latest)) {
  const { release: name, archive } = JSON.parse(readFileSync(latest, "utf8"));
  const cli = join(root, "node_modules/.bin/sentry-cli");
  const scope = [...(process.env.SENTRY_ORG ? ["--org", process.env.SENTRY_ORG] : []), ...(process.env.SENTRY_PROJECT ? ["--project", process.env.SENTRY_PROJECT] : [])];
  execFileSync(cli, ["sourcemaps", "upload", ...scope, "--release", name, archive], { stdio: "inherit" });
  console.log(`✓ source maps for ${name} uploaded`);
}

rmSync(stage, { recursive: true, force: true });
rmSync(release, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(dist, join(stage, "dist"), { recursive: true });
writeFileSync(
  join(stage, "package.json"),
  JSON.stringify({ name: packageName, productName, version, description: pkg.description, main: "dist/main.cjs", author: productName, license: "PolyForm-Noncommercial-1.0.0" }, null, 2),
);

await build({
  // the zip target builds the .app too; with a publish config it also writes the channel file, the
  // blockmap and Resources/app-update.yml (electron-updater needs it, even with a feed set in code)
  targets: Platform.MAC.createTarget(["zip"], Arch.arm64),
  projectDir: stage,
  publish: "never",
  config: {
    appId,
    productName,
    copyright: `© 2026 ${productName}`,
    electronVersion: electronPkg.version,
    electronDist,
    directories: { output: release, buildResources: join(root, "resources") },
    files: ["dist/**/*", "!dist/mcp/**", "package.json"],
    extraResources: [
      { from: join(root, "resources/bin"), to: "bin" },
      { from: join(dist, "mcp"), to: "mcp" },
      // plan 19: the macOS 26 (Liquid Glass) icon, compiled by `pnpm brand` from resources/icon.icon
      { from: join(root, "resources/Assets.car"), to: "Assets.car" },
    ],
    asar: true,
    npmRebuild: false,
    nodeGypRebuild: false,
    buildDependenciesFromSource: false,
    electronLanguages: ["en", "es"],
    artifactName: "${productName}-${version}-${arch}-mac.${ext}",
    publish: testBuild ? { provider: "generic", url: testBuild.feed } : { provider: "github", owner: "luisiacc", repo: "terno" },
    mac: {
      category: "public.app-category.productivity",
      // the grid-drawn .icns (Finder before the catalog loads, the DMG, older systems);
      // CFBundleIconName points macOS at Assets.car's "Icon", the name actool gave it
      icon: join(root, "resources/icon.icns"),
      extendInfo: { CFBundleIconName: "Icon" },
      identity,
      hardenedRuntime: developerId,
      entitlements: developerId ? join(root, "resources/entitlements.mac.plist") : undefined,
      entitlementsInherit: developerId ? join(root, "resources/entitlements.mac.plist") : undefined,
      gatekeeperAssess: false,
      notarize,
      darkModeSupport: true,
    },
  },
});

const appDir = readdirSync(release).map((d) => join(release, d)).find((d) => existsSync(join(d, `${productName}.app`)));
if (!appDir) throw new Error("packaged app not found");
const app = join(appDir, `${productName}.app`);

execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app], { stdio: "inherit" });
if (identity !== "-") {
  // the designated requirement Squirrel compares updates against: the identifier and the certificate, never a cdhash
  const requirement = execFileSync("codesign", ["-d", "-r-", app], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (!requirement.includes(`identifier "${appId}"`) || !/certificate leaf|anchor apple generic/.test(requirement)) throw new Error(`unexpected designated requirement:\n${requirement}`);
}
const arch = execFileSync("lipo", ["-archs", join(app, "Contents/MacOS", productName)]).toString().trim();
if (arch !== "arm64") throw new Error(`unexpected architecture: ${arch}`);
if (!existsSync(join(app, "Contents/Resources/app-update.yml"))) throw new Error("app-update.yml missing: electron-updater can't run without it");
assertIcon(app);

const channelFile = readdirSync(release).find((f) => /^[a-z]+-mac\.yml$/.test(f));
if (!channelFile) throw new Error("no update channel file (latest-mac.yml) was written");

if (!testBuild && process.env.TERNO_PACKAGE_DMG !== "0") {
  const dmg = join(release, `${productName}-${version}-arm64.dmg`);
  if (existsSync("/usr/bin/SetFile")) {
    // a writable image first, so the mounted volume can take Terno's icon, then compressed
    const rw = join(release, "volume-rw.dmg");
    execFileSync("hdiutil", ["create", "-volname", productName, "-srcfolder", app, "-ov", "-format", "UDRW", "-fs", "APFS", rw], { stdio: "inherit" });
    withMounted(rw, false, (volume) => {
      copyFileSync(join(root, "resources/icon.icns"), join(volume, ".VolumeIcon.icns"));
      execFileSync("SetFile", ["-a", "C", volume]);
    });
    execFileSync("hdiutil", ["convert", rw, "-format", "UDZO", "-ov", "-o", dmg], { stdio: "inherit" });
    rmSync(rw, { force: true });
    withMounted(dmg, true, (volume) => {
      if (!existsSync(join(volume, `${productName}.app`))) throw new Error(`the DMG has no ${productName}.app at its root`);
      if (!existsSync(join(volume, ".VolumeIcon.icns")) || !execFileSync("GetFileInfo", ["-a", volume], { encoding: "utf8" }).includes("C")) throw new Error("the DMG volume lost its icon");
    });
  } else {
    console.log("! SetFile not found (Xcode command line tools): the DMG volume keeps the generic icon");
    execFileSync("hdiutil", ["create", "-volname", productName, "-srcfolder", app, "-ov", "-format", "UDZO", "-fs", "APFS", dmg], { stdio: "inherit" });
  }
  console.log(`\n✓ ${dmg}`);
}
console.log(`✓ ${app}\n✓ ${join(release, channelFile)}`);
