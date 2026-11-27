# Plan 283: No debugging in a release (CASA 6.2.1)

- **Status:** built (macOS verified locally, inspectable and shipped; the Linux steps run in the release workflow).
- **Why:** a CASA security assessment of the released v0.1.9 macOS build found debug modes reachable in production (control 6.2.1, "debug modes are disabled in production").

## The request (verbatim)

> Close a debug-mode gap that a CASA security assessment (control 6.2.1, "debug modes are disabled in production") found in Terno's released desktop build.
>
> What the assessment found in the released v0.1.9 macOS build
> 1. Electron fuses are at their defaults: RunAsNode is on (ELECTRON_RUN_AS_NODE turns the signed app into a Node runtime); EnableNodeOptionsEnvironmentVariable is on; EnableNodeCliInspectArguments is on (`--inspect` works); EnableEmbeddedAsarIntegrityValidation and OnlyLoadAppFromAsar are off. Anyone who can run programs as the user can start Terno with a debugger attached.
> 2. The DevTools menu item is hidden in packaged builds, but its keyboard shortcut may still open DevTools. Packaged builds should not open DevTools at all: `webPreferences.devTools: false`, or the equivalent, when not in dev mode. Dev mode is gated by `TERNO_DEV_URL`.
> 3. Minor: the `app://` protocol handler checks paths against the renderer folder as a string prefix without a trailing path separator. It isn't exploitable today, but make the check exact.
>
> Constraints: the packaged smoke suite launches the packaged app through Playwright's `_electron.launch`, which relies on inspector and remote-debugging arguments, so flipping EnableNodeCliInspectArguments naively breaks every smoke test. Find a clean design that hardens what users get while keeping the smoke tests meaningful (for example, fuses only in release builds, with a release-time check that the shipped binary has them set). Check every place the app relies on RunAsNode or NODE_OPTIONS before turning them off; if something needs RunAsNode, either move it to Electron's utilityProcess or keep that fuse on and say why. Use electron-builder's `electronFuses` or @electron/fuses. Asar integrity must work with the existing signing and notarization.
>
> Tests: a unit or build-config test that pins the fuse settings and the packaged `devTools: false`; a release-time verification that reads the fuses back from the built binary and fails the release if any is wrong; build locally with `pnpm dist:mac` and run the affected smoke tests.

## What exists

- **Packaging** (`apps/desktop/scripts/package.mjs`, `package-linux.mjs`, shared `package-stage.mjs`): electron-builder 26.15.3, Electron 45, no `electronFuses`, so every fuse is at Electron's default. The macOS build already writes `ElectronAsarIntegrity` into Info.plist (electron-builder does it for every asar build) and signs after packing; nothing reads it, because the fuse that checks it is off. electron-builder flips fuses right before it signs (`doAddElectronFuses`, then `doSignAfterPack`), so fuses and the asar hash are both inside the signature and the notarized ticket.
- **Releases** (`scripts/release.mjs` `build-mac` and `build-linux`, run by `.github/workflows/release.yml` or `pnpm release --local`): each step runs with `TERNO_RELEASE=1`. The root `pnpm dist:mac` and `dist:linux` set `TERNO_RELEASE=1` too, so that flag can't tell a shipped build from a local one.
- **Who uses RunAsNode or NODE_OPTIONS:**
  - **The agents' MCP connector** (plan 183): `resources/bin/terno-mcp` runs `ELECTRON_RUN_AS_NODE=1 exec <Terno binary> Resources/mcp/terno-mcp.cjs`. That's the only user. Settings → Agents hands agents this command, and `packaged.smoke.ts`, `links.smoke.ts` and `linux.smoke.ts` call it.
  - **Not users:** the backend is a `utilityProcess` (`app.ts`); the incoming and legacy-body workers are `worker_threads` inside it; the keychain helper (`keychain-helper.ts`) runs the binary as a full Electron app and deletes `ELECTRON_RUN_AS_NODE` from its environment; Squirrel.Mac's ShipIt is its own binary; demo-ai and `dev.mjs` run unpackaged Electron and delete the variable; Linux has no updater. Nothing reads NODE_OPTIONS, and Playwright deletes it before it launches Electron.
- **What Playwright needs:** `_electron.launch` always passes `--inspect=0 --remote-debugging-port=0` and waits for Node's "Debugger listening" line. It needs the inspect fuse on and Chromium's DevTools protocol (CDP) port, and nothing else from the fuses.
- **DevTools:** no window sets `webPreferences.devTools`, so DevTools are enabled everywhere. The View menu's `toggleDevTools` item is `visible: dev`, and macOS still fires the shortcut of a hidden item. `native-reload.smoke.ts` opens a detached DevTools in the *packaged* app to test that a reload from inside DevTools keeps drafts.
- **`--remote-debugging-port`** is a Chromium switch, not a Node one: no fuse covers it. On any build, `Terno --remote-debugging-port=9222` serves CDP, which drives the renderer (and through its preload, the backend) as fully as `--inspect` drives main. `devTools: false` doesn't stop it.
- **`TERNO_DEV_URL`:** `isDev = Boolean(process.env.TERNO_DEV_URL)` in `app.ts`, packaged or not. On a packaged app it loads that URL into the window, with the preload bridge and the IPC trust that go with it (`isTrustedSender`, the network fence, `will-navigate`). Dev mode's AI keys are already gated on `!app.isPackaged` (`devModeOf`, plan 146); the window isn't.
- **`app://`** (`registerAppProtocol`): `normalize(join(RENDERER_DIR, rel)).startsWith(RENDERER_DIR)`, so a sibling such as `…/rendererX/` would pass.

## Design

### 1. Two kinds of package: shipped and inspectable

A **shipped** build is one `release.mjs` packages (GitHub's release workflow, or `pnpm release --local`): it sets `TERNO_SHIPPED=1` for its packaging step. Everything else (`pnpm dist:mac`, `dist:linux`, update test builds) is **inspectable**: the same app, the same fuses except one, so the smoke suite can attach. `package-stage.mjs` exports `shipped` (and refuses a shipped test build). Only the inspect fuse differs, and main's DevTools-protocol rule follows it (§3), so the smoke suite tests the shipped app's code, asar, integrity check and fuses, except for the one bit Playwright needs.

The trade-off: a local `pnpm dist:mac` copy can be started with `--inspect`. It never reaches a user (only `release.mjs` builds publish, and the release refuses a build that isn't locked, §5); `docs/DEVELOPMENT.md` says so. The alternative, locking every package and having the smoke suite unlock a copy, means re-signing the copy: an ad-hoc signature changes Terno's identity, so the copy's keychain reads would prompt (and the suite must never take focus), and Linux's installed package is root-owned. Locking only shipped builds keeps the suite on the signed bundle as packaged.

### 2. The fuses (`apps/desktop/scripts/fuses.mjs`)

One module holds the table, and package.mjs, package-linux.mjs, release.mjs, the CI step and the tests use it:

| Fuse | Shipped | Inspectable | Why |
| --- | --- | --- | --- |
| RunAsNode | **on** | on | the agents' MCP connector (below) |
| EnableNodeOptionsEnvironmentVariable | off | off | nothing uses it |
| EnableNodeCliInspectArguments | **off** | on | Playwright's `--inspect=0`; also stops SIGUSR1 opening the inspector |
| EnableEmbeddedAsarIntegrityValidation | on (macOS) | on (macOS) | Info.plist already carries the hash; Electron implements the check on macOS and Windows only, so Linux leaves it at its default |
| OnlyLoadAppFromAsar | on | on | no `app/` folder or `default_app.asar` fallback |
| EnableCookieEncryption, GrantFileProtocolExtraPrivileges, LoadBrowserProcessSpecificV8Snapshot | default | default | out of scope (below) |

`electronFuses` goes into `commonConfig()` for each platform and kind. electron-builder flips the fuses before it signs, so the signature, notarization and Info.plist's asar hash all cover the final bytes. The DMG step packages the already-signed app (`prepackaged`), so it flips nothing.

**RunAsNode stays on, for the MCP connector.** What was tried:

- **A windowless Terno as the host** (`Terno --terno-mcp`: main hides itself, uses a scratch userData and forks the MCP bundle as a `utilityProcess`, relaying stdin over `parentPort`; stdout inherited). It works (probe on Electron 45: stdin relay and inherited stdout both fine, no Dock icon with `app.dock.hide()` or `setActivationPolicy("prohibited")`). But any Electron browser process registers with LaunchServices under Terno's bundle id. With the host running, `open -a` didn't start the app (tested with both activation policies). So while an agent session is open and Terno is closed, clicking Terno in the Dock or opening a `terno://` link would reach the windowless host, not the app. That breaks Terno for the user. It's also four processes (browser, network service, utility, GPU unless in-process: about 260 MB resident against the Node runtime's 96 MB) for every agent session.
- **The MCP server inside the running app**, with the agent's command a plain stdio-to-socket bridge (`nc -U` on macOS) and no Node at all. This is the clean end state, but it moves plan 183's server into the backend, changes what an agent sees when Terno is closed (today: a server that answers "Open Terno…"; then: a server that fails to start), and needs a bridge that every Linux desktop has. That's its own plan (proposed as a follow-up), not part of this fix.

What RunAsNode still allows once the other fuses are set: someone already running programs as the user can run JavaScript in a process signed as Terno. They can't change Terno's own code (the asar is integrity-checked and only it loads), can't inject into the real app (NODE_OPTIONS and `--inspect` are off, CDP is refused, DevTools are gone), and can't load native code into that process (hardened runtime, library validation on, no `disable-library-validation` or `allow-dyld-environment-variables` entitlement). So it can't call the Keychain to read the safeStorage key. The remaining risk is inherited TCC grants; Terno asks for none beyond notifications. The plan's report states this for the assessor.

### 3. The DevTools protocol (CDP) follows Node's inspector

At the top of `main.ts`, before any other mode: a **packaged** Terno given `--remote-debugging-port` or `--remote-debugging-pipe` while Node's inspector isn't running (`inspector.url()` is undefined) writes one line to stderr and exits with code 1. Playwright passes `--inspect=0` with it, so an inspectable package (inspect fuse on, inspector live) still allows it. A shipped package (inspect fuse off) can never have a live inspector, so it always refuses. One source of truth (the fuse wire), no build-time flag in the JavaScript, and a Linux CI copy with the inspect fuse flipped back behaves like an inspectable package (§6). Unpackaged runs (`dev.mjs`'s `TERNO_REMOTE_DEBUGGING_PORT`) are untouched.

The check runs before `app` is ready, which is before Electron starts the DevTools HTTP handler. It costs one `hasSwitch` pair and one `inspector.url()` per launch.

### 4. DevTools only in an unpackaged run; `TERNO_DEV_URL` only there too

- `debugging.ts` exports `devToolsAllowed(packaged)` (true only unpackaged). Every `BrowserWindow` sets `webPreferences.devTools` from it: the main window, the storage-migration window and the print window. A packaged window can't open DevTools, by menu, shortcut or `openDevTools()`.
- The View menu gets the `toggleDevTools` item only when `dev` (not a hidden item): no accelerator is registered in a packaged app.
- `isDev` becomes `devModeOf({ devUrl, packaged })`, the same rule as Dev mode: `TERNO_DEV_URL` does nothing in a packaged app (no foreign page in the window, no dev origin in the trust checks or the network fence).

### 5. `app://` containment

`registerAppProtocol` asks a pure helper, `rendererFile(root, pathname)` in `renderer-path.ts`, for the file. The helper resolves the path and returns it only when `relative(root, file)` is non-empty, isn't `..` or under it, and isn't absolute; otherwise null, which is a 403.

### 6. Release-time verification

- `fuses.mjs` reads the wire back as `@electron/fuses` (what `npx @electron/fuses read` uses) does: the sentinel, a version byte, a length byte, one byte per fuse, every copy in a universal binary. It does this itself, synchronously and with no dependency, and lists every fuse that differs from the table.
- **Every package build** (package.mjs, package-linux.mjs for each architecture's unpacked binary) reads its fuses back and fails on any difference from its kind's table, so electron-builder silently skipping `electronFuses` fails the build.
- **`release.mjs build-mac` and `build-linux`** check the shipped table again on the final app (`release/mac-arm64/Terno.app`) and each Linux binary, after codesign verification. A release can't ship an inspectable build.
- **Linux CI** (`release.yml`): the shipped deb is what's installed. A new step runs `debugging.smoke.ts` against it as installed (locked). Then `fuses.mjs inspectable /opt/Terno/terno` (sudo) flips the inspect fuse on that **installed test copy only**, so Playwright can attach for `linux.smoke.ts`. The uploaded packages in `apps/desktop/release/` are never touched; they were verified before.

## Tests

- **`apps/desktop/src/fuses.test.ts`** (unit): the table for each kind and platform, literally (RunAsNode on, NODE_OPTIONS off, inspect off only when shipped, asar integrity on macOS, only-from-asar on); `fuseProblems` names each wrong fuse and accepts the right wire; `package-stage`'s `shipped` refuses a test build; `commonConfig()` carries the table (a build-config pin); release.mjs's build steps set `TERNO_SHIPPED=1`.
- **`apps/desktop/src/debugging.test.ts`** (unit): the CDP rule (packaged with switch and no inspector refuses; with a live inspector allows; unpackaged allows; no switch allows); `DEVTOOLS` is false when packaged. A source scan: every `new BrowserWindow(` in `apps/desktop/src` sets `devTools: DEVTOOLS`.
- **`menu.test.ts`:** no DevTools item at all when not in dev.
- **`renderer-path.test.ts`:** a sibling folder with the same prefix, `..`, an absolute path and the root itself are refused; a nested file is accepted.
- **`e2e/debugging.smoke.ts`** (new, no Playwright attach, runs on either kind and reads which one from the app's fuses): `--remote-debugging-port` alone is refused with code 1 and no "DevTools listening"; NODE_OPTIONS `--require` runs nothing; on a shipped build `--inspect` opens no debugger and `--inspect --remote-debugging-port` is refused; Terno launched as a user starts it (demo mailbox, temp profile, in the background), and the bundled `terno-mcp` answers `list_accounts` against it, which proves launch, backend and the MCP connector on a locked build too. Linux runs it through `TERNO_LINUX_APP`.
- **`native-reload.smoke.ts`:** the DevTools-frontend reload test runs only in the source run (`TERNO_RELOAD_SMOKE_DEV=1`, where DevTools exist); the packaged run asserts that `openDevTools()` opens nothing and that the View menu has no DevTools item.
- Run: the unit files above, typecheck and lint; `pnpm dist:mac` then `packaged.smoke.ts`, `links.smoke.ts`, `native-reload.smoke.ts`, `migration.smoke.ts` (the keychain helper) and `debugging.smoke.ts`; then a shipped build (`TERNO_SHIPPED=1`) into its own output and `debugging.smoke.ts` against it.

## Performance and resources

One `hasSwitch` pair and one `inspector.url()` at launch; asar integrity hashes the asar header (not the whole file) once at startup, which is Electron's design. No new processes, no change to the agents' connector.

## Out of scope

- **The MCP server inside the app** (so RunAsNode can go off): a follow-up plan, above.
- **EnableCookieEncryption:** changes how existing cookies are stored and needs its own migration thought; Terno keeps no login in cookies.
- **GrantFileProtocolExtraPrivileges:** Terno loads no `file://` page, but main fetches renderer files through `net.fetch(file://…)`; worth its own check.
- Windows (not built).

## Revisions after the Codex review

Codex read the plan against the code and Electron 45's source. What changed:

1. **The release's draft job installs nothing.** `release.mjs` would have imported `@electron/fuses` through `fuses.mjs`. `fuses.mjs` now reads and checks the wire itself (and the DMG check, inside a synchronous mount, needs a synchronous read anyway), so no dependency is added.
2. **RunAsNode's Node mode takes `--inspect` whatever the inspect fuse says** (Electron's standalone `NodeMain` doesn't apply that fuse). So a shipped Terno run with `ELECTRON_RUN_AS_NODE=1 --inspect` is a Node runtime with a debugger. It runs only the code it's given, never Terno's app, but the assessment's first point stays open while RunAsNode is on. The report says so plainly, and the follow-up (the MCP server inside the app, or a connector with its own identity) is what closes it. Checked on the built app: see the test results.
3. **The keychain helper was a decryption oracle.** `Terno --terno-legacy-keychain --legacy-name=Terno` would open "Terno Safe Storage" and return the plaintext of any sealed blob on stdin, and the keychain trusts the signed binary, so no prompt. It now never opens Terno's own item, nor the one the process runs as (`legacyNameAllowed`, with a unit test). Única's item is still opened, which is the helper's purpose; the helper can go once no Única profile is left (there are no users yet).
4. **`inspector.url()` as the CDP gate** (Codex preferred a build-time flag). Kept, because it follows the fuse: a shipped build can't start an inspector, and the Linux CI copy with the fuse turned back on behaves as an inspectable package does. Nothing in main opens the inspector programmatically, and an inspectable build whose inspector fails to bind refuses CDP, which only fails a test run. Probed on Electron 45: CDP starts listening only after `ready`, and `app.exit(1)` at the top of main never reaches it.
5. **The NODE_OPTIONS probe needs a positive control.** A packaged browser process already filters `--require`. The smoke runs Terno as Node with `NODE_OPTIONS=--require <probe>` and checks the probe never runs, after checking it does run under Electron's own unfused binary. The same fuse also drops `NODE_EXTRA_CA_CERTS`: a private CA for a mail server can no longer come from the environment (nothing in Terno documents it; noted for support).
6. **Check what users download, not only the unpacked app.** `release.mjs build-mac` unpacks the update zip, verifies its signature and reads its fuses; `package.mjs` reads the fuses of the app inside the mounted DMG; `build-linux` unpacks each deb and rpm and reads the executable inside. `build-mac` also checks the hardened runtime flag and that there's no `get-task-allow` when signed with a Developer ID.
7. **The Mac release job runs the probe too**, after notarization and before the artifact is kept, with the kind given explicitly (`TERNO_SMOKE_SHIPPED=1` in `playwright.shipped.config.ts`, and the first test asserts the fuses are that kind's). It skips the one test that launches the app (`@launches`): a runner's login keychain isn't one Terno can use. A probe launch is stopped with its own cleanup (`stopSpawned`), since `closePackaged` needs Playwright.
8. **The Linux probe needs its own entry point**: `test:smoke:shipped` (`playwright.shipped.config.ts`), run under the same display, bus and keyring as the installed-app smoke, at the installed path (the AppArmor profile is path-based). The test copy isn't restored afterwards: it's the runner's install, and the uploaded packages were never touched.
9. **DevTools and the renderer's CDP are separate:** the packaged smoke shows `openDevTools()` does nothing while Playwright still drives the page over CDP (the rest of the suite). The source run keeps the detached-DevTools reload test.
10. **A connector with its own identity** (a separate helper bundle, or a standalone executable) would avoid the LaunchServices collision. Running Electron's own helper bundle as a browser process isn't documented behaviour, and a standalone Node is another 100 MB; both go to the follow-up plan.
11. **The assessor claim is scoped to debugging the app provides.** A native debugger is the OS's business: the release requires the hardened runtime without `get-task-allow` (point 6); Linux follows its ptrace policy.
12. **`app://` decoding:** a malformed escape (`%E0%A4%A`) used to throw inside the handler; it's a 400 now. `rendererFile` takes the decoded URL path, slash first, as the handler gives it.

## What the Codex code review changed

1. **A package renamed `electron` read as unpackaged** (Electron's `app.isPackaged` reads only the executable's name), which would have reopened DevTools, the DevTools protocol and `TERNO_DEV_URL`. `packagedApp(isPackaged, __dirname)` also counts code loaded from an asar; main, the windows and print use it.
2. **`pnpm release --local` with `TERNO_PACKAGE_OUT`** would have checked and drafted `apps/desktop/release` while packaging elsewhere: the release refuses the variable.
3. **The probe could reach the Terno you're running:** an inherited `TERNO_SOCKET` or `TERNO_TOKEN_FILE` outranks `TERNO_USER_DATA` in the connector. The probe sets both inside its own profile.
4. **The probe's processes:** every child is bounded, drained through `close`, and stopped with what it started before the scratch tree goes; MCP output is parsed only once complete. The launch test asks the connector until it answers, since the token is written a moment before the socket listens.
5. **A shipped run never passes by skipping:** a missing app or a missing Electron binary for the NODE_OPTIONS control fails it.
6. **Entitlements are parsed** (`codesign -d --entitlements <file> --xml`, then `plutil`), and a failed read fails the release; only `get-task-allow: true` is refused.
7. **Scratch extractions are removed before a failed check stops the release** (`verify` throws, cleans up, then fails).

Not taken: checking the draft phase's inputs again. The workflow feeds it only the gated build jobs' artifacts; the draft runner has no `ditto` or `rpm2cpio`, and it's a maintainer running `release.mjs draft` by hand with other files that it would catch.

Found while testing: `native-reload.smoke.ts` had been failing on main since plan 207. The seeded mailbox gets the first-screen question, and its tests clicked behind it. It now dismisses the question as `people` and `update` smoke do (its own commit).
