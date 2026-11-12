// What a release carries, per platform (plan 189): the packagers check they wrote these, and the draft checks it has
// every one before it creates the release. Pure, so release-ci.test.ts covers it.

/** The Linux architectures Terno ships, with the names each package format and `file` give them. */
export const LINUX_ARCHES = [
  { arch: "x64", deb: "amd64", rpm: "x86_64", elf: "x86-64", unpacked: "linux-unpacked" },
  { arch: "arm64", deb: "arm64", rpm: "aarch64", elf: "ARM aarch64", unpacked: "linux-arm64-unpacked" },
];

export const PLATFORMS = ["mac", "linux"];

/** The update channel a version is released on: "latest" for x.y.z, "nightly" for x.y.z-nightly.n. */
export function channelOf(version) {
  return /-/.test(version) ? (/-([a-z]+)/.exec(version)?.[1] ?? "") : "latest";
}

/** The version deb and rpm record: a prerelease sorts before its release there only with "~" (electron-builder's own rule). */
export function packageVersion(version) {
  return version.replace("-", "~");
}

/** The Linux packages for one architecture, each named with its format's own architecture (amd64.deb, x86_64.rpm). */
export function linuxPackages(version, arch) {
  const a = LINUX_ARCHES.find((x) => x.arch === arch);
  if (!a) throw new Error(`unknown architecture ${arch}`);
  return [`Terno-${version}-linux-${a.deb}.deb`, `Terno-${version}-linux-${a.rpm}.rpm`];
}

/** Every file a release of `version` uploads for `platforms` (the draft from GitHub: both; `--local`: macOS). */
export function releaseAssets(version, platforms) {
  for (const p of platforms) if (!PLATFORMS.includes(p)) throw new Error(`unknown platform ${p}`);
  const files = [];
  if (platforms.includes("mac")) files.push(`Terno-${version}-arm64-mac.zip`, `Terno-${version}-arm64-mac.zip.blockmap`, `${channelOf(version)}-mac.yml`, `Terno-${version}-arm64.dmg`);
  if (platforms.includes("linux")) for (const a of LINUX_ARCHES) files.push(...linuxPackages(version, a.arch));
  return files;
}
