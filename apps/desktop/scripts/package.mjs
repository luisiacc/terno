// Packages Única for macOS Apple Silicon: a self-contained staging app (bundles
// only, no node_modules), electron-builder for the .app, explicit ad-hoc
// signing with verification, then a compressed DMG.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, Platform, Arch } from "electron-builder";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const require = createRequire(join(root, "package.json"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const electronPkg = JSON.parse(readFileSync(require.resolve("electron/package.json"), "utf8"));
const electronDist = join(dirname(require.resolve("electron/package.json")), "dist");
const stage = join(root, ".stage");
const release = join(root, "release");
// File names stay ASCII: Electron locates "<name> Helper.app" by path, and a
// non-ASCII name (Ú) can differ in Unicode normalization on APFS → startup crash.
// The user-visible name is "Única" via CFBundleDisplayName. CFBundleName must stay
// ASCII too: Electron derives the helper app file name from it.
const productName = "Unica";
const displayName = "Única";

if (!existsSync(join(root, "dist/main.cjs"))) throw new Error("run `pnpm --filter @unica/desktop build` first");

rmSync(stage, { recursive: true, force: true });
rmSync(release, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(join(root, "dist"), join(stage, "dist"), { recursive: true });
writeFileSync(
  join(stage, "package.json"),
  JSON.stringify({ name: "unica", productName, version: pkg.version, description: pkg.description, main: "dist/main.cjs", author: "Única", license: "UNLICENSED" }, null, 2),
);

await build({
  targets: Platform.MAC.createTarget(["dir"], Arch.arm64),
  projectDir: stage,
  config: {
    appId: "dev.unica.mail",
    productName,
    copyright: "© 2026 Única",
    electronVersion: electronPkg.version,
    electronDist,
    directories: { output: release, buildResources: join(root, "resources") },
    files: ["dist/**/*", "!dist/mcp/**", "package.json"],
    extraResources: [
      { from: join(root, "resources/bin"), to: "bin" },
      { from: join(root, "dist/mcp"), to: "mcp" },
    ],
    asar: true,
    npmRebuild: false,
    nodeGypRebuild: false,
    buildDependenciesFromSource: false,
    electronLanguages: ["en", "es"],
    mac: {
      category: "public.app-category.productivity",
      icon: join(root, "resources/icon.icns"),
      identity: null, // signed explicitly (ad-hoc) below
      hardenedRuntime: false,
      darkModeSupport: true,
      extendInfo: { CFBundleDisplayName: displayName, NSHumanReadableCopyright: "El único cliente de email que necesitas" },
    },
  },
});

const appDir = readdirSync(release).map((d) => join(release, d)).find((d) => existsSync(join(d, `${productName}.app`)));
if (!appDir) throw new Error("packaged app not found");
const app = join(appDir, `${productName}.app`);

// Ad-hoc signature: required for arm64 code to run after electron-builder edited the bundle.
execFileSync("codesign", ["--force", "--deep", "--sign", "-", "--timestamp=none", app], { stdio: "inherit" });
execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app], { stdio: "inherit" });
const arch = execFileSync("lipo", ["-archs", join(app, "Contents/MacOS", productName)]).toString().trim();
if (arch !== "arm64") throw new Error(`unexpected architecture: ${arch}`);

const dmg = join(release, `Unica-${pkg.version}-arm64.dmg`);
execFileSync("hdiutil", ["create", "-volname", displayName, "-srcfolder", app, "-ov", "-format", "UDZO", "-fs", "APFS", dmg], { stdio: "inherit" });
console.log(`\n✓ ${app}\n✓ ${dmg}`);
