// Packages Terno for Linux (plan 189): a .deb and an .rpm for x64 and arm64, from the same staging app as macOS,
// named with each format's own architecture (Terno-<v>-linux-amd64.deb, Terno-<v>-linux-x86_64.rpm, …).
// No AppImage: Chromium's sandbox needs a setuid helper or user namespaces, which Ubuntu 23.10+ grants only through
// an AppArmor profile; the deb and rpm install both (electron-builder's install scripts), an AppImage can't, and
// mail HTML is untrusted, so the renderer must stay sandboxed.
//
// Run on Linux (CI's ubuntu runner, or Docker: docs/DEVELOPMENT.md); the rpm needs `rpmbuild` (the rpm package).
// TERNO_LINUX_ARCH=x64 (or arm64) packages one architecture. Each architecture's Electron is downloaded and
// checked by electron-builder, never the host's: there are no native modules, so arm64 packages on x64 too.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Arch, build, Platform } from "electron-builder";
import { commonConfig, commonResources, productName, publisher, release, root, stageApp, testBuild, uploadReleaseMaps, version } from "./package-stage.mjs";
import { LINUX_ARCHES, linuxPackages, packageVersion } from "./release-assets.mjs";

if (process.platform !== "linux") throw new Error("Linux packages are built on Linux: see docs/DEVELOPMENT.md → Linux for Docker");
if (testBuild) throw new Error("update test builds are macOS only");
const wanted = (process.env.TERNO_LINUX_ARCH || LINUX_ARCHES.map((a) => a.arch).join(",")).split(",").map((a) => a.trim());
const arches = LINUX_ARCHES.filter((a) => wanted.includes(a.arch));
if (arches.length !== wanted.length) throw new Error(`TERNO_LINUX_ARCH: only ${LINUX_ARCHES.map((a) => a.arch).join(" and ")}`);

/** the executable and the desktop entry's name: Electron takes the window's WM_CLASS / app_id from desktopName */
const executableName = "terno";
const maintainer = `${publisher} <support@terno.app>`;

await uploadReleaseMaps();
const stage = stageApp({ desktopName: `${executableName}.desktop`, homepage: "https://terno.app" });

await build({
  targets: Platform.LINUX.createTarget(["deb", "rpm"], ...arches.map((a) => Arch[a.arch])),
  projectDir: stage,
  publish: "never",
  config: {
    ...commonConfig(),
    directories: { output: release, buildResources: join(root, "resources") },
    // the window's icon (X11 draws it in the title bar and the switcher; the desktop entry's comes from linux.icon)
    extraResources: [...commonResources, { from: join(root, "resources/icon.png"), to: "icon.png" }],
    artifactName: "${productName}-${version}-linux-${arch}.${ext}",
    linux: {
      executableName,
      syncDesktopName: true,
      icon: join(root, "resources/icon.png"),
      // the desktop entry's Categories (electron-builder writes this over desktop.entry's)
      category: "Network;Email;Office;",
      maintainer,
      vendor: publisher,
      synopsis: "Your mail, made to measure",
      desktop: { entry: { Keywords: "mail;email;inbox;imap;gmail;" } },
    },
    // the defaults already hold libsecret-1-0 (safeStorage's keyring)
    deb: { packageCategory: "mail", priority: "optional" },
    // `depends` replaces electron-builder's list: its defaults, written out, plus libsecret
    rpm: { depends: ["gtk3", "libnotify", "nss", "libXScrnSaver", "(libXtst or libXtst6)", "xdg-utils", "at-spi2-core", "(libuuid or libuuid1)", "libsecret"] },
  },
});

const read = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" }).trim();
const fail = (message) => {
  throw new Error(`Linux package check: ${message}`);
};

for (const a of arches) {
  // the app itself, per architecture: the right Electron, the bundles, the agents' server and the License
  const dir = join(release, a.unpacked);
  for (const f of [executableName, "chrome-sandbox", "resources/app.asar", "resources/bin/terno-mcp", "resources/mcp/terno-mcp.cjs", "resources/mcp/SKILL.md", "resources/LICENSE", "resources/icon.png", "resources/apparmor-profile"]) {
    if (!existsSync(join(dir, f))) fail(`${a.unpacked}/${f} is missing`);
  }
  const elf = read("file", ["-b", join(dir, executableName)]);
  if (!elf.includes("ELF 64-bit") || !elf.includes(a.elf)) fail(`${a.unpacked}/${executableName} isn't ${a.elf}: ${elf}`);

  const [deb, rpm] = linuxPackages(version, a.arch).map((f) => join(release, f));
  if (!existsSync(deb) || !existsSync(rpm)) fail(`missing ${!existsSync(deb) ? deb : rpm}`);

  const control = Object.fromEntries(read("dpkg-deb", ["-f", deb, "Package", "Version", "Architecture", "Maintainer"]).split("\n").map((l) => l.split(/:\s*/, 2)));
  const wantDeb = { Package: executableName, Version: packageVersion(version), Architecture: a.deb, Maintainer: maintainer };
  for (const [k, v] of Object.entries(wantDeb)) if (control[k] !== v) fail(`${deb}: ${k} is "${control[k]}", not "${v}"`);
  // the install script is what sets up the sandbox (setuid helper or AppArmor profile)
  const postinst = read("dpkg-deb", ["-I", deb, "postinst"]);
  if (!postinst.includes(`/opt/${productName}/chrome-sandbox`) || !postinst.includes("apparmor")) fail(`${deb}'s postinst doesn't set up the sandbox`);
  const debFiles = read("dpkg-deb", ["-c", deb]);
  if (!debFiles.includes(`./usr/share/applications/${executableName}.desktop`)) fail(`${deb} installs no ${executableName}.desktop`);
  const entry = execFileSync("sh", ["-c", `dpkg-deb --fsys-tarfile "$1" | tar -xOf - ./usr/share/applications/${executableName}.desktop`, "sh", deb], { encoding: "utf8" });
  for (const line of ["Exec=/opt/Terno/terno %U", "Categories=Network;Email;Office;", `StartupWMClass=${executableName}`]) if (!entry.split("\n").includes(line)) fail(`${deb}'s desktop entry lacks ${line}`);

  const rpmInfo = read("rpm", ["-qp", "--qf", "%{NAME} %{VERSION} %{ARCH}", rpm]);
  if (rpmInfo !== `${executableName} ${packageVersion(version)} ${a.rpm}`) fail(`${rpm} is "${rpmInfo}"`);
  if (!read("rpm", ["-qp", "--scripts", rpm]).includes(`/opt/${productName}/chrome-sandbox`)) fail(`${rpm}'s scripts don't set up the sandbox`);
  if (!read("rpm", ["-qpR", rpm]).includes("libsecret")) fail(`${rpm} doesn't depend on libsecret`);
  console.log(`✓ ${deb}\n✓ ${rpm}`);
}
const extra = readdirSync(release).filter((f) => /\.(deb|rpm)$/.test(f) && !arches.some((a) => linuxPackages(version, a.arch).includes(f)));
if (extra.length) fail(`unexpected packages: ${extra.join(", ")}`);
