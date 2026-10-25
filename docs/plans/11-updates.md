# Plan 11: in-app updates

- **Status:** shipped (see §9, as shipped).
- **Builds on:** plan 10 (the updater logs through its primitives).
- **Request:** "Work on properly being able to update the app, like T3 Code, where there's a button to update the app inside the app. It works in the background and then asks to reload to load the update. Let's have that nice flow as well."

## 1. What T3 Code does

- `electron-updater` against GitHub Releases, with stable and nightly channels (`latest-mac.yml` and `nightly-mac.yml` plus blockmaps).
- It checks on startup and every 4 minutes, and downloads in the background.
- A pure reducer state machine (`updateMachine.ts`): `disabled | checking | up-to-date | available | downloading (percent) | downloaded | error` (with check, download or install context and `canRetry`).
- A sidebar pill and a toast in the web app. Release notes come from the release body.
- "Restart to update" calls `quitAndInstall`.
- It records `{ fromVersion, targetVersion }` before installing so it can tell an update that didn't apply.
- Its macOS builds are Developer ID signed and notarized. That is what makes Squirrel.Mac (behind `electron-updater`'s `MacUpdater`) work.

## 2. The constraint that changes the design for Terno

Terno's builds are **ad-hoc signed**: `package.mjs` uses `codesign --sign -`, and this machine has only an "Apple Development" identity, no "Developer ID Application".

Squirrel.Mac refuses an update unless the new bundle satisfies the running app's designated requirement. For an ad-hoc signature that requirement is its own cdhash, so **every update would be rejected**. `electron-updater` on macOS is therefore not usable today.

**Decision:** a small Terno updater whose integrity comes from our own Ed25519 signature, as Sparkle does, rather than from Apple code signing. It works with today's ad-hoc builds and keeps working once a Developer ID exists. At that point the release step also signs and notarizes, and the updater additionally checks `codesign --verify` against the team id.

## 3. Release artifacts (`pnpm release:mac`, run by the maintainer, never by tests)

1. Run `pnpm dist:mac` as today. It produces `Terno.app` and the DMG.
2. Zip the app with `ditto -c -k --keepParent Terno.app Terno-<v>-arm64.zip`, which preserves the bundle's symlinks and xattrs.
3. Build the manifest `terno-update-<channel>.json`:

   ```json
   { "schema": 1, "version": "0.2.0", "channel": "stable", "pubDate": "...", "minOS": "13.0",
     "arch": "arm64", "url": "https://github.com/luisiacc/terno/releases/download/v0.2.0/Terno-0.2.0-arm64.zip",
     "size": 123, "sha512": "<base64>", "notes": "<markdown, from the release>" }
   ```

4. Sign the canonical manifest bytes with Ed25519: `terno-update-<channel>.json.sig`. The private key comes from `TERNO_UPDATE_KEY_FILE`, which lives outside the repo and is created once with `pnpm release:keygen`.
   - The public key is compiled into the app (`apps/desktop/src/update-key.ts`).
   - Key rotation: the manifest may carry `nextKeys` signed by the current key.
5. Publish with `gh release create v<v>` (stable) or as a prerelease (nightly), attaching the zip, the DMG, the manifest and the signature.
   - The stable feed URL is `https://github.com/luisiacc/terno/releases/latest/download/terno-update-stable.json`.
   - The nightly feed reads the newest prerelease's assets through the API.
   - The feed base is a build-time constant (`TERNO_UPDATE_FEED`), so a fork, a self-hosted server or a test points elsewhere.
   - **Note:** the repo must be public, or the feed hosted somewhere public, for users to reach it.

## 4. Updater (main, `apps/desktop/src/updates/`)

- **The state machine** is a pure reducer, ported from T3 Code's shape: `idle | checking | up-to-date | available | downloading(percent, bytes) | verifying | ready(version, notes) | error(context: check|download|verify|install, canRetry)`, plus `unsupported(reason)`. The reasons are:
  - a dev build
  - running from the DMG or a read-only volume
  - an app location that isn't writable
  - running translated (not arm64)
  - an MAS build later
- **Check:** at startup (after 30 s, so cold start isn't touched), then every 4 h, and on demand from the UI.
  - It fetches the manifest and its `.sig` over HTTPS through Electron `net` with a 15 s timeout.
  - It verifies the Ed25519 signature *before* parsing any field, compares semver, and checks `minOS` and `arch`.
  - **Local mode:** update checks are network traffic outside the mail servers. In local mode, automatic checks are off. A manual "Buscar actualizaciones" is allowed, because it's an explicit user action and only fetches Terno's own release feed. This is said plainly in the setting.
  - Setting `updates: "auto" | "manual"`, default `auto`, which means check, download and verify in the background.
- **Download:**
  - The zip goes to `userData/updates/<version>/`, resumable with an HTTP Range request after a failure, with progress events throttled to 4/s.
  - The final sha512 and size must match the signed manifest; on a mismatch the file is deleted and the state becomes `error(verify)`.
- **Prepare:**
  - Extract with `ditto -x -k` into `updates/<version>/staged/`.
  - Check that the bundle has `Contents/Info.plist`, that `CFBundleIdentifier` is `dev.terno.mail` and that `CFBundleShortVersionString` equals the manifest version.
  - Run `codesign --verify --deep --strict` (ad-hoc is accepted until a team id is configured, after which the team id is required).
  - Strip `com.apple.quarantine` if present.
  - Only then go to `ready`.
- **Install ("Reiniciar para actualizar"):**
  1. Write `updates/pending.json` with `{ fromVersion, toVersion, appPath, stagedPath }`.
  2. Spawn a detached helper, a small `/bin/sh` script shipped in `Resources/`. Its arguments are the current pid and the paths, and all paths are validated in main: they must be inside userData or be the current app's bundle path. The helper:
     1. waits for the pid to exit, up to 30 s
     2. renames `Terno.app` to `Terno.app.old-<ts>` in the same directory, which is atomic on the same volume
     3. moves the staged app into place
     4. on any failure, renames the old app back
     5. relaunches with `open -n`
     6. removes `.old` only after the new app writes its started marker; the next start of the new version does that removal
  3. Main then quits normally. The usual flushes run, so the database is closed cleanly and the WAL is checkpointed.
- **After restart:** main reads `pending.json`.
  - If the running version equals `toVersion`, it logs `update.applied`, removes the old bundle and shows a quiet "Terno se actualizó a 0.2.0 · Novedades" toast.
  - If it's still `fromVersion`, it logs `update.not_applied` (captured as an unexpected error), shows "No se pudo instalar la actualización" with Retry, and cleans up.
- **Never during a send:** "Reiniciar" waits for the outbox to settle (`ops` queue idle, no send in flight, a draft save flushed) for up to 10 s, then proceeds.
- **Concurrency:** one action at a time (check, download or install). A check while a download is in flight is a no-op.

## 5. UI (renderer)

- `window.ternoDesktop.updates`: `getState()`, `onState(cb)`, `check()`, `download()`, `install()`.
- **Sidebar footer pill** (like T3 Code's), next to Filtros and Local:
  - nothing while idle or up to date
  - "Actualización 0.2.0" while available (manual mode)
  - a thin progress ring with the percentage while downloading
  - "Reiniciar para actualizar" (accent) when ready
- **The pill opens a popover:** version, release notes (markdown rendered as safe text, collapsible), size, and the primary "Reiniciar ahora" button with a secondary "Más tarde". "Más tarde" hides the accent until the next launch, while the pill stays.
- **Ajustes → General → "Actualizaciones":**
  - automatic or manual
  - channel: Estable / Nightly
  - "Buscar actualizaciones" with the last checked time
  - the current version and build
  - unsupported reasons in plain words: "Mueve Terno a Aplicaciones para recibir actualizaciones"
- **⌘K:** "Buscar actualizaciones" and "Reiniciar para actualizar". **App menu:** "Buscar actualizaciones…".
- **Web build:** a new deployment means a new bundle. The web app polls `version.json` every 30 minutes and shows the same pill ("Nueva versión · Recargar"). Reloading is safe because drafts autosave.

## 6. Tests

- **Unit:**
  - the reducer: every transition, and the error/retry matrix
  - manifest verification: a good signature, one bad byte, the wrong key, a downgrade, the wrong arch, `minOS`
  - sha512 mismatch
  - path validation for the helper
  - the unsupported reasons
  - the pending-record outcomes
  - resume after a partial download
- **Helper script test (node + temp dirs):**
  - a happy swap
  - the new bundle missing
  - the destination not writable: rolls back and the old app stays runnable
  - the pid never exits: times out with no change
- **Packaged e2e (`test:smoke` grows an "update" project):**
  1. Build two packaged apps, 0.1.0 and 0.1.1-test, from the same tree with different versions; the second is zipped and signed with a *test* key, which is used for test builds only.
  2. Serve the feed from a local HTTP server.
  3. Copy 0.1.0 into a temp "Applications" dir, launch it with a temp profile and the feed and test key overridden by env, which is honoured only in test builds.
  4. Assert: the pill goes to "Reiniciar para actualizar", clicking it relaunches into 0.1.1-test (the window title or version IPC), the profile data survives, and the old bundle is gone.
  5. Also: a tampered zip is rejected with a visible error, and no swap happens.
- **e2e (web fixture):** the pill states driven by a stub updater in the renderer, axe on the popover, and the web `version.json` path.
- **Visual:** the pill in each state, light and dark.

## 7. Out of scope

- Delta updates (blockmaps).
- Windows and Linux.
- Forced or critical updates.
- Staged rollouts. The manifest could gain a `rolloutPercent` later.

## 8. Revisions after the Codex plan review

These revisions override §§2–6 where they conflict. The full critique is in `/tmp/unica-scratch/plan-11-codex.txt`.

1. **Use the standard path: `electron-updater` (Squirrel.Mac) with a stable signing identity. No custom installer.**
   - Squirrel rejects ad-hoc updates only because an ad-hoc designated requirement is the cdhash.
   - Signing every build with the same certificate gives a stable requirement: `identifier "dev.terno.mail" and anchor apple generic and certificate leaf[subject.CN] = …`. Squirrel then accepts updates, and Keychain/safeStorage stops re-prompting after each update.
   - `package.mjs` picks `TERNO_SIGN_IDENTITY`, otherwise auto-detects "Developer ID Application", then "Apple Development" (present on this machine), then falls back to ad-hoc. An ad-hoc build reports `unsupported("unsigned")` and offers a manual download instead.
   - Hardened runtime and notarization are added automatically when the identity is a Developer ID (with `APPLE_*` env for notarytool). Distribution without a Developer ID still needs the user to bypass Gatekeeper the first time; updates after that need nothing.
   - **Spike first:** sign 0.1.0 and 0.1.1 with the Apple Development identity, serve a generic feed locally, and prove that `electron-updater` downloads, Squirrel swaps and the app relaunches into 0.1.1 with the profile and Keychain intact. If codesign blocks on a keychain prompt in a non-interactive shell, stop and report.
   - The Ed25519 manifest, the shell helper and the bundle swap are dropped.
2. **Feed.**
   - `electron-updater`'s GitHub provider (`luisiacc/terno`) with stable/nightly channels, as in T3: `latest-mac.yml` / `nightly-mac.yml`, `allowPrerelease` for nightly.
   - It can be overridden at build time to a generic URL.
   - Test-only overrides are honoured only when `TERNO_TEST=1` *and* the build was made with a test flag; production ignores them, and a test proves it.
   - `pnpm release:mac` builds the zip, DMG, yml and blockmap and creates a **draft** GitHub release (`gh release create --draft`), which the maintainer publishes once every asset is present. Tests never run it.
3. **Coordinated shutdown before install. It is also used on every quit.**
   1. Main asks every window to flush its drafts and waits for acknowledgements (up to 5 s).
   2. The backend gets `shutdown`: it stops dispatching new ops, waits for an in-flight send to finish (up to 30 s), closes the database (with a checkpoint), and acks.
   3. Only then does main call `quitAndInstall`. If a send is still in flight at the deadline, the install is deferred, with "Se instalará al terminar el envío", and never forced.
4. **Local mode and network policy.**
   - The updater uses its own session (`persist:terno-updater`, no cookies), so the default-session backstop and renderer traffic are unaffected.
   - Automatic checks and downloads are off in local mode, and automatic work in flight is cancelled when local mode turns on.
   - A manual "Buscar actualizaciones" grants one check. If an update is found, "Descargar" is a second explicit grant.
   - The setting discloses that this traffic goes to GitHub.
   - Redirects go only to GitHub's release CDN hosts, with no credentials.
5. **Unsupported locations:** the app runs from the DMG, from an App Translocation path (`/private/var/folders/.../AppTranslocation/`), from a read-only volume, or from a parent directory that isn't writable. In each case the state is `unsupported`, with "Mueve Terno a Aplicaciones para recibir actualizaciones". Nothing tries to work around it.
6. **Health after an update.**
   - Before installing, main records `{ from, to, txId }`.
   - The new version acknowledges only after the backend is ready and migrations are done; then the toast "Terno se actualizó a X" appears.
   - If no acknowledgement arrives (the still-old version is running), the result is `update.not_applied`: captured, shown with a retry.
   - Squirrel relaunches the same bundle path, and the profile comes from the app's own `userData`. Dev-only env profile overrides are documented as not surviving.
   - Rolling back a binary across a migration is not supported. Squirrel keeps no backup, so this is noted as a limitation.
7. **Ready state is preserved.** A downloaded update survives later check failures (T3's reducer behaviour). Switching channel discards a staged update from the other channel. Switching from nightly to stable never offers a downgrade.
8. **Web build:** extend the existing service-worker flow in `connect.ts`. Periodic `registration.update()` every 30 min feeds the same pill: "Nueva versión · Recargar". Activation asks every tab to flush its drafts first, and replaces the immediate reload on `controllerchange` with a coordinated one. A separate `version.json` poll is dropped.
9. **Tests.**
   - Unit: the reducer, the policy matrix (local mode × auto/manual × grants), unsupported-location detection, the shutdown coordinator (a slow draft, a send past the deadline defers the install), and that production ignores test overrides.
   - Packaged spike turned into a test: two signed builds, a local generic feed, an update applied, a relaunch, the profile intact, the acknowledgement recorded, and a corrupted zip rejected by sha512.
   - If signing isn't available (CI), the test is skipped with a clear reason.
   - Web: two SW builds, with a dirty draft in a second tab.

## 9. As shipped

### What exists

- **Spike first** (branch `worktree-agent-a1438f42869e1ab2d`): signing 0.1.0 and 0.1.1 with "Apple Development: lccpacc@gmail.com (DA229N496G)" gives a stable designated requirement (`identifier "…" and anchor apple generic and certificate leaf[subject.CN] = …`); Squirrel accepted the update, relaunched the same path, `codesign --verify` passed, safeStorage decrypted with no prompt, the profile was intact. Ad-hoc builds are refused (`SQRLCodeSignatureErrorDomain`); a tampered zip is refused by sha512.
- **Backend quiesce** (`BackendCore.quiesce/resume/sendsIdle`, `ops.release` in both stores): once a quit or update begins no op starts; one claimed but not started goes back to the queue as it was (a send never turns "unknown" because the app quit); a send already at its server gets until the deadline.
- **Coordinated shutdown on every quit** (`apps/desktop/src/shutdown.ts`): each window flushes its drafts and acknowledges (5 s at most; a page registers its flusher once booted), then the backend gets `shutdown` (quiesce up to 30 s, stop, database closed: the WAL is checkpointed and emptied), then main quits. A plain quit hides the windows at once and is `force`d (a send still running at 30 s is recovered as "unknown" next start, as after a crash); "Restart now" isn't forced: a send past the deadline answers "sending", the backend keeps running, the pill says "Waiting for Send…", and the install happens on `sends-idle`. A backend that never answers is given up on after the deadline plus 5 s.
- **Updater** (`apps/desktop/src/updates/`): `@terno/core/updates` holds the pure reducer and the plain-text release notes; `policy.ts` the rules (policy matrix, grants, hosts, unsupported locations, feed, prefs, the install record, error kinds); `controller.ts` the flow with injected deps (unit-tested end to end with a fake engine and fake timers); `engine.ts` electron-updater's `MacUpdater` in its own bundle `dist/updater.cjs` (256 KB), required on the first check only; `main.ts` the Electron side (files under `userData/updates/`, the location probe, IPC trusted like printing).
  - Isolated session `persist:terno-updater` (cache off): cookies, `Authorization` and `Set-Cookie` stripped; every request and redirect must be https to GitHub's release hosts (or a test build's own feed origin) **and** happen while a grant is open.
  - Ready only on Squirrel's own `update-downloaded`; `autoInstallOnAppQuit` stays on (Squirrel validates right after the download), so a ready update installs at any quit: `quitting()` records it for the health check.
  - Startup: nothing for 30 s (no engine loaded, no request); then the location probe (codesign + the bundle folder, local) and, policy permitting, a check; then every 4 h, scheduled only while automatic checks are allowed.
  - Health: `updates/pending.json` `{ from, to, txId }` before an install; on the next run's first backend `ready`, `update.applied` (logged, a "Terno updated to X · What's New" snack) or `update.not_applied` (captured unexpected, the pill offers Try Again).
- **Renderer:** `window.ternoDesktop.updates` (state, check, download, install, setPrefs, seen, onState) and `onFlushDrafts`; the sidebar pill and popover (`update-pill.tsx`), Settings → General → Updates (`updates-section.tsx`), ⌘K "Check for Updates…" and "Restart to Update", Terno → "Check for Updates…" (answered with a snack in the window).
- **Web:** `registration.update()` every 30 min while the tab is visible (no timer while hidden); the same pill says "New Version · Reload" (the corner banner is gone); Reload flushes this tab's drafts, then activates; every tab flushes its own before reloading on `controllerchange`.
- **Packaging** (`scripts/package.mjs`): identity `TERNO_SIGN_IDENTITY` → Developer ID Application → Apple Development → ad-hoc; a 30 s probe signature fails fast on a keychain prompt; Developer ID adds the hardened runtime (`resources/entitlements.mac.plist`) and notarization when `APPLE_*` credentials are set; the zip target writes the zip, blockmap, `latest-mac.yml` (`nightly-mac.yml` for an `x.y.z-nightly.n` version) and `Resources/app-update.yml`; the designated requirement and `app-update.yml` are checked. `pnpm release:mac` (`scripts/release.mjs`) refuses test builds, ad-hoc builds, dirty trees and existing tags, then `gh release create --draft` with the zip, blockmap, channel file and DMG.
- **Test builds:** `TERNO_TEST_BUILD` (JSON: feed, profile, app data, app name, first-check delay) is baked by `build.mjs` (`__TERNO_TEST_BUILD__`) into `TERNO_BUILD_OUT` (never `dist/`), packaged as `dev.terno.updatetest` / `terno-updatetest`; `package.mjs` refuses to package a test build as a release or the other way round (`test-build.json` marker).

### Cutting a release

1. Bump `apps/desktop/package.json` (`0.2.0`, or `0.2.0-nightly.1` for nightly) and commit.
2. `pnpm release:mac` (gh signed in; the signing identity in the keychain; `APPLE_*` for notarization with a Developer ID).
3. Review the draft on GitHub (notes, assets) and publish it. Copies of Terno see it on their next check. The repository must be public for them to reach it.

### Deviations from §§2–8

- **Manual mode** still checks in the background (outside local mode) and only offers; automatic mode also downloads. §4 left "manual" undefined; this is T3 Code's.
- **Test overrides:** honoured only in builds made with `TERNO_TEST_BUILD` (baked), not "`TERNO_TEST=1` and a test flag": no environment survives Squirrel's relaunch, and a release never reads one for its feed (unit test plus a packaged check that the release's `main.cjs` was never given the define and its `app-update.yml` is GitHub's).
- **Channel switch with an update already staged:** Squirrel offers no way to unstage it, so the channel can't change until it's installed (Settings says so and the select waits); what the other channel offered or was downloading is dropped.
- **Squirrel keeps no backup** and a binary can't be rolled back across a migration: a bad release is fixed by a newer one.
- **Profile env overrides** (`TERNO_USER_DATA`) don't survive the relaunch; only test builds bake theirs.
- electron-updater's staged-rollout id (`.updaterId`, sent as `x-user-staging-id`) is never created, and the header is stripped anyway: no stable identifier reaches GitHub.
- **Copy** is English literals; the i18n catalog had not landed (strings and Spanish listed in the hand-off).
- The web test passes in Chromium even with an immediate reload, because Chromium's `pagehide` flush also reaches the worker; the coordinated reload is for engines where it doesn't.

### Verification

- Unit: reducer and error/retry matrix (20), policy, hosts, locations, feed, prefs, install record and the override proof (38), the controller flow (20), the shutdown coordinator (6), quiesce (4 backend, 1 conformance on both stores), pill model and check messages (11), menu (2).
- e2e (web fixture with a stand-in for main): every pill state light and dark with axe, the popover, Restart Now / Later, a deferred restart, a refused download, the post-update snack, Settings → Updates, an unsupported copy, ⌘K. Web: a deploy offered by the periodic check, a draft typed until another tab activates the new build survives, every tab ends on the new build.
- Packaged (`update.smoke.ts`, ~1.5 min, real Squirrel): a tampered zip is refused with an integrity error and the bundle stays 0.1.0; through the pill (local mode: check, Download, Restart Now) 0.1.0 updates to 0.1.1, relaunches, logs `update.applied` from the new version after `shutdown.done{closed, restart}`; a plain quit of 0.1.1 leaves an empty WAL and every thread. Squirrel's caches and launchd job for the test bundle id are cleaned before and after.

## 10. What the Codex code review changed (a36dbe0..)

The review is in `/tmp/unica-scratch/updates-11/codex-review.txt`. Each fix has a regression test that fails without it.

1. **A web reload never drops an unsaved draft.** `flushAllDrafts` gives up after its cap and swallows failures; activating or reloading into a new build now waits for `draftsSaved()` (every draft saved as written), and otherwise holds, with a snack offering Try Again or Reload Anyway (`web/reload.ts`).
2. **An update's restart is never forced.** A backend that doesn't answer the shutdown in time is no longer killed for an install: the install is put off like a send in flight ("Waiting for Send…"), and a late "closed" answer brings a fresh backend up.
3. **A send queued behind a slow op is never left "running".** Quiesce gives back every claimed op not yet at its provider before it answers, so a send behind a slow Gmail archive in the same batch can't be recovered as "unknown".
4. **Readiness belongs to the download Squirrel checked.** The state keeps the download's `target`; Squirrel's "ready" makes that version ready, not a newer offer that arrived meanwhile; no check or download starts while Squirrel is still verifying.
5. **No stable identifier goes to GitHub.** electron-updater's `x-user-staging-id` is stripped with cookies and credentials, and its `.updaterId` is never created (the packaged test checks both on the wire and on disk).
6. **A staged update holds the channel** (see the deviation above) instead of silently installing a nightly after choosing Stable.
7. **Local mode cuts an automatic check already in flight** (`session.closeAllConnections()`), not only a download.

