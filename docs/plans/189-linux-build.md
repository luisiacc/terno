# Plan 189: Terno on Linux

## Request

> start preparing linux build and that it works, set it up on the releases for linux for github ci

## What exists

- **Packaging is macOS only.** `apps/desktop/scripts/package.mjs` (`pnpm dist:mac`) stages the bundles (`dist/`, no `node_modules`, no native modules: SQLite is `node:sqlite`), runs electron-builder for an arm64 zip, signs, verifies, then makes the DMG. Most of it (codesign, `lipo`, `hdiutil`, the icon catalog) is Mac-only. The staging part (stage dir, its `package.json`, the publish feed, the `minimumVersion` stamp of plan 95) applies to any platform.
- **Releases** (plan 126): `pnpm release:mac` dispatches `.github/workflows/release-mac.yml`, one `macos-15` job that runs `release.mjs`, which builds, packages, checks the signature and notarization, and creates the **draft** release with `gh`. `--local` does the same on the maintainer's Mac. `release-ci.mjs` holds the shared preflight and dispatch.
- **Main process.** Few checks of the platform: the window uses `titleBarStyle: "default"` and no vibrancy off macOS; the app quits when its last window closes off macOS; a second instance hands over to the first (`requestSingleInstanceLock`); `network-watch` only spawns `scutil` on macOS; `db/clone.ts` falls back to a plain copy off APFS; the Dock badge is `app.dock?.…`, so nothing off macOS.
- **The menu** (`menu.ts`) is the macOS bar: an app menu with Services, Hide and Hide Others, Edit's Speech submenu, and a Window menu with Zoom and Bring All to Front. On Linux Electron draws it inside the window, where those items do nothing.
- **Updates** (plan 11) are Squirrel.Mac. `updates/main.ts`'s probe looks for a `.app` bundle; off macOS it finds none and reports `"dev"` ("Updates are off in development builds"), which is wrong for a packaged Linux build.
- **Agents** (plan 183): `resources/bin/terno-mcp` runs `../MacOS/Terno` as Node. There is no such binary on Linux.
- **Diagnostics context** in the backend and the MCP server says `darwin` or `other`; the core type already has `linux`.
- **Secrets** go through Electron's `safeStorage`. On Linux it uses the Secret Service (GNOME Keyring, KWallet); with none running, Electron falls back to `basic_text`, a fixed key.
- **Smoke tests** (`apps/desktop/e2e`) launch `release/mac-arm64/Terno.app` and check codesign; none runs on Linux.

## Design

### 1. Packages: `.deb` and `.rpm`, x64 and arm64

`pnpm dist:linux` (`apps/desktop/scripts/package-linux.mjs`), run on Linux, packages `dist/` as `Terno-<version>-linux-<arch>.<deb|rpm>`, each named with its format's own architecture (`amd64.deb`, `x86_64.rpm`, `arm64.deb`, `aarch64.rpm`; see the build notes below).

- **Why deb and rpm, and no AppImage or tarball.** Mail HTML is untrusted, and Terno renders it in a sandboxed renderer. Chromium's sandbox on Linux needs either a setuid `chrome-sandbox` or unprivileged user namespaces. Ubuntu 23.10 and later restrict those through AppArmor. The deb and rpm install `chrome-sandbox` setuid root and, on Ubuntu, an AppArmor profile (electron-builder's own install scripts), so the sandbox is on. An AppImage cannot do either; it would need `--no-sandbox`, which turns off the protection Terno relies on for mail. So no AppImage until there is a way to ship it sandboxed.
- **Shared staging.** The part of `package.mjs` that isn't Mac-specific moves to `scripts/package-stage.mjs`: the stage directory and its `package.json`, the publish feed, and the `minimumVersion` stamp. `package.mjs` (Mac) and `package-linux.mjs` both use it. Nothing changes in what the Mac build produces.
- **Package metadata.** Executable `terno`; desktop entry `Terno`, categories `Network;Email;Office;`, `StartupWMClass` so the window groups under its launcher icon; the 1024 px icon (electron-builder makes the sizes); maintainer `Luisiacc LLC <support@terno.app>`, homepage `https://terno.app`; the License in `resources/`. Dependencies are electron-builder's defaults plus `libsecret-1-0` (deb) / `libsecret` (rpm), so `safeStorage` has its backend.
- **Checks after packaging**, failing the build: each package exists for each architecture; `linux-unpacked/` holds `terno`, `chrome-sandbox`, `resources/app.asar`, `resources/bin/terno-mcp`, `resources/mcp/terno-mcp.cjs` and `resources/LICENSE`; the executable's ELF machine matches the architecture (`file`); the deb's control file has the maintainer, the version and the architecture (`dpkg-deb -f`) and its install script makes `chrome-sandbox` setuid.
- Arm64 is packaged on the x64 runner: there are no native modules, so it is the arm64 Electron plus the same bundles.

### 2. The app on Linux

- **Window.** `autoHideMenuBar: true`: the menu stays out of the way and Alt shows it. The window gets Terno's icon (X11 uses it for the title bar and the task switcher). The title bar is the system's (`titleBarStyle: "default"`, as today); the sidebar's top band stays, as on the web.
- **Menu.** `menuTemplate` takes the platform. Off macOS: no app menu and no Window menu; File gets Quit (Ctrl+Q); Edit loses Speech and Paste and Match Style; Help gets Check for Updates…, then the diagnostics items, then About Terno. macOS is unchanged.
- **Updates.** A new unsupported reason, `"linux"`: a packaged Linux build reports it instead of `"dev"`. Settings and a manual check say "Terno can't update itself on Linux yet. Download new versions from the releases page." (`en` and `es`). The diagnostics field enum gains it.
- **Agents.** `terno-mcp` finds the binary for either layout: `../MacOS/Terno` in a `.app`, `../terno` beside `resources/` on Linux. Both packages install to `/opt/Terno`, so the path Settings → Agents shows is stable.
- **Diagnostics.** The backend and the MCP server report `linux` (and `x64`) like main already does.
- **Secrets.** No change in this plan. With a keyring running, `safeStorage` uses it. With none, Electron falls back to a weaker provider; the secret stays on the machine (plan 97 holds). Warning the user about that is a follow-up.

### 3. Proof it works: `linux.smoke.ts`

A packaged smoke spec for Linux, `apps/desktop/e2e/linux.smoke.ts`, in its own Playwright project (`pnpm --filter @terno/desktop test:smoke:linux`). It launches the **installed** app (`/opt/Terno/terno`, `TERNO_LINUX_APP` to point elsewhere) in demo mode with a temp profile, under `xvfb-run` and a D-Bus session with GNOME Keyring unlocked, and checks:

- it boots from `app://terno/` with the backend in a utility process, and the demo mailbox's rows render;
- the sandbox is on: Chromium was not given `--no-sandbox`, and `chrome-sandbox` is setuid root;
- the menu is the Linux one (no Services, Hide or Speech; Quit under File) and the menu bar is hidden;
- `safeStorage` encrypts and decrypts through the keyring (not `basic_text`);
- Settings → Updates shows the Linux reason;
- the bundled `terno-mcp` answers an MCP `initialize` and a tool call against the running app once agents are allowed (the same exchange as `packaged.smoke.ts`);
- it quits cleanly, leaving no process behind.

Existing Mac smoke specs are untouched.

### 4. The release workflow: one release, both platforms

`.github/workflows/release-mac.yml` becomes `release.yml` with three jobs:

1. **`linux`** on `ubuntu-24.04`, in the `release` environment (the Google clients are baked into the build), `contents: read`: preflight (only the secrets it needs), install, `release.mjs build-linux` (build, `package-linux.mjs` for both architectures, checks), install the x64 deb with `apt`, run `linux.smoke.ts`, upload the packages as a workflow artifact, and the source maps as today.
2. **`mac`** on `macos-15`, in `release`, `contents: read`: today's steps, ending with `release.mjs build-mac` (build, package, signature and notarization checks) and uploading the four Mac files as an artifact. It no longer creates the release.
3. **`draft`** on `ubuntu-24.04`, `needs: [linux, mac]`, the only job with `contents: write`, no secrets: downloads both artifacts and runs `release.mjs draft`, which checks every expected file (`releaseAssets(version)`, one list for both platforms) and creates the draft with all of them. If either build fails, no draft is made, as today.

Each build job checks that it builds the dispatched `sha` (main's tip). `release.mjs` keeps dispatching from the Mac (`pnpm release`, with `release:mac` kept as the same command), and `--local` still builds and drafts on the Mac, macOS only.

`RELEASING.md`: the Linux packages in the release, `pnpm release`, what each job does, and how to install (`sudo apt install ./Terno-…-linux-amd64.deb`, `sudo dnf install ./Terno-…-linux-x86_64.rpm`). `docs/DEVELOPMENT.md`: building and smoke-testing Linux, natively or in Docker.

## Tests

- `menu.test.ts`: the Linux template has no Mac-only roles (`services`, `hide`, `hideOthers`, `unhide`, `startSpeaking`, `stopSpeaking`, `front`, `zoom`), Quit is in File, Check for Updates… and About are in Help, and every label comes from the catalog; macOS's is unchanged.
- `updates/policy.test.ts`: a packaged Linux build is `"linux"`; an unpackaged one is still `"dev"`.
- `apps/web` unit (`updates` text): `"linux"` has its own text.
- `release-ci.test.ts`: `releaseAssets` lists the Mac and Linux files for a stable and a nightly version; the workflow has the three jobs, `draft` needs both builds and is the only job that can write, the Linux job installs the deb and runs the Linux smoke before uploading, both build jobs check the SHA, and the existing rules (no secret or input interpolated in `run:`, pinned actions, cleanup `always()`) hold across all jobs.
- `linux.smoke.ts` as above, run locally in Docker (arm64) and in CI (x64).

## Perf

No hot path changes. Startup on Linux is not gated in this plan.

## Out of scope

- AppImage, Flatpak and Snap (the sandbox, above), and tarballs.
- Updating itself on Linux, and an apt or dnf repository.
- Signing the packages with GPG.
- An unread count on the launcher, Linux title-bar integration (window controls overlay), and font choices for the macOS design on Linux.
- Warning the user when `safeStorage` falls back to `basic_text`.
- Registering as the `mailto:` handler (not done on macOS either).

## Revisions after the Codex review

The plan critique raised 12 points, all taken:

1. **`chrome-sandbox` isn't always setuid.** electron-builder's install script makes it 4755 only when user namespaces don't work, and 0755 otherwise (Chromium then uses the namespace sandbox). The smoke no longer checks the file mode: it checks the renderer *is* sandboxed, from `/proc/<pid>/status` (a seccomp filter, `Seccomp: 2`, and its own PID namespace, two ids in `NSpid`).
2. **Playwright adds `--no-sandbox` on Linux** unless `chromiumSandbox: true`. The Linux smoke launches with it, as an ordinary user (in Docker too, never root).
3. **The AppArmor profile is conditional.** The CI job asserts the runner restricts unprivileged user namespaces (`kernel.apparmor_restrict_unprivileged_userns = 1`, Ubuntu 24.04's default), so a sandboxed renderer there proves the installed profile works, and that `/etc/apparmor.d/terno` is in place.
4. **Terno uses the asynchronous `safeStorage` API**, whose provider is chosen apart from `getSelectedStorageBackend()`. No backend name is logged; the smoke seals a synthetic secret with the async API, restarts the app, and opens it again.
5. **`electronDist` is the host's Electron.** Linux packaging never passes it: electron-builder downloads (and checks) the Electron for each architecture, so the arm64 package can't carry an x64 binary. The ELF check per architecture backs this up.
6. **RPM needs `rpmbuild`** (the `rpm` package) on the runner, installed before packaging.
7. **`depends` replaces the defaults.** The deb keeps electron-builder's list (it already has `libsecret-1-0`); the rpm's list is the default one plus `libsecret`, written out in full.
8. **Unpacked output is per architecture** (`linux-unpacked/`, `linux-arm64-unpacked/`): each is checked on its own.
9. **Release phases get their own preflights.** `release-ci.mjs` checks only the secrets a phase uses (`build-linux`: the Google clients; `build-mac`: those plus signing and notarization; `draft`: none), build phases never call `gh`, and only `draft` gets the write token. `draft` keeps `--target <sha>` and the failed-draft cleanup.
10. **Artifact names per platform**: `source-maps-linux-<sha>`, `source-maps-mac-<sha>`, `release-linux`, `release-mac`; the draft job downloads only the two package artifacts.
11. **Package metadata differs from the app version**: deb and rpm write `1.4.0~nightly.3` for `1.4.0-nightly.3`, and the deb's architecture is `amd64`/`arm64`. The checks expect those.
12. **`releaseAssets(version, platforms)`** takes the platforms: the CI draft requires macOS and Linux, `--local` macOS only. Both are tested.
