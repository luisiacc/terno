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

/**
 * electron-builder's publish config for a release (plan 257). Its GitHub publisher never takes the channel from the
 * version (only the generic one does), so a nightly names its own: that is what makes the zip target write
 * nightly-mac.yml. A copy's engine sets the channel on every check, so the one in app-update.yml changes nothing.
 */
export function publishConfig(version) {
  const channel = channelOf(version);
  return { provider: "github", owner: "luisiacc", repo: "terno", ...(channel === "latest" ? {} : { channel }) };
}

/** A nightly's tag, the only kind the scheduler builds and prunes: vX.Y.Z-nightly.N */
export const NIGHTLY_TAG = /^v(\d+)\.(\d+)\.(\d+)-nightly\.(\d+)$/;

/** Orders x.y.z and x.y.z-nightly.n as semver does (a nightly before its release; nightlies by number). */
export function compareRelease(a, b) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-nightly\.(\d+))?$/.exec(v);
    if (!m) throw new Error(`${v} isn't x.y.z or x.y.z-nightly.n`);
    return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? Infinity : Number(m[4])];
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
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
