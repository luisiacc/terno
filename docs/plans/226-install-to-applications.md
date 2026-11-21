# Plan 226: installing Terno into Applications

## Request

> ok i just did and it worked, but i was expecting it to tell the user to install the app instead of just executing it [screenshot: the mounted DMG in Finder, Terno.app alone in a plain window] , can we make it so they have to install it instead of just executing it?

Asked what should happen when Terno is opened straight from the DMG, the owner chose **offer to move**: a native "Move Terno to Applications?" before any window, Move as the default, Not Now opens Terno as today and asks again next launch. (The other choice, Move or Quit, was not taken: a managed Mac without admin rights could never run Terno.)

## What exists

- **The DMG** (`apps/desktop/scripts/package.mjs`, plans 19 and 126): `hdiutil create -srcfolder Terno.app` into a writable image, `.VolumeIcon.icns` copied in and flagged with `SetFile`, converted to UDZO, re-attached to check, with our own three-try retry for hosted runners. The window has no Applications shortcut, no background and no layout: Finder shows a folder holding one app, and people double-click it. Plan 19 listed "a DMG window background or Applications shortcut" as out of scope.
- **Running from the DMG is already detected**, for updates only: `unsupportedReason` (`src/updates/policy.ts`) returns `dmg`, `translocated`, `read-only` or `not-writable`, and Settings says "Move Terno to Applications to get updates" (plan 11 §5). Nothing happens at launch.
- **electron-builder 26.15.3** already builds the app, zip and channel file. Its `dmg` target (dmg-builder, which runs a pinned, checksummed `dmgbuild` bundle) writes the window layout straight into `.DS_Store` without Finder or AppleScript, so it works on a headless runner; it adds the `/Applications` link, the volume icon and a background, and retries `hdiutil` on its transient codes.
- **Electron 45** documents `app.isInApplicationsFolder()` and `app.moveToApplicationsFolder({ conflictHandler })`: no dialog of its own; returns `false` when the user cancels the admin prompt; throws with a readable message when the copy fails; on success the app **quits and relaunches** from Applications. An existing app of the same name that isn't running is trashed and replaced; one that is running takes focus and this copy quits.
- Main's launch (`src/app.ts`, `whenReady`): menu language, `buildMenu`, `startBackend`, updates, then the first window. `t()` from `@terno/i18n` works in main (the menu uses it).

## Design

### 1. The DMG window: drag to Applications

`package.mjs` drops its hand-built DMG. After the zip build (signed, notarized, channel file stamped), a second electron-builder `build()` with `prepackaged: <Terno.app>` and only the `dmg` target makes the image: with `prepackaged` electron-builder skips packing and signing (`macPackager.js` `packMacTargets`), so the DMG step can be retried alone without re-signing or re-notarizing. Its own `dmg.artifactName` keeps the name `Terno-<v>-arm64.dmg` (the zip's `…-arm64-mac.${ext}` pattern would otherwise apply), so `release-assets.mjs`, the site's `/download/mac` and RELEASING.md keep working. `dmg.writeUpdateInfo: false` and `publish: "never"`: the DMG adds nothing to the update contract (no `.dmg.blockmap`, no channel entry), and the channel file must be byte-identical before and after the DMG step.

- **Layout:** a 600 × 380 window, Terno on the left (x 160), Applications on the right (x 440), both on one line (y 190), 112 px icons, no toolbar or sidebar (dmgbuild's default for a DMG window).
- **Background:** `apps/desktop/resources/dmg-background.png` and `dmg-background@2x.png` (electron-builder combines the pair into a Retina TIFF). A quiet arrow from Terno to Applications and one line under it, "Drag Terno to Applications to install it." Drawn as `brand/dmg-background.svg` (the repo root's `brand/`, where `gen-brand.ts` reads) and rendered by `pnpm brand` at 600 × 380 and 1200 × 760: the renderer learns rectangular sizes, and the source, its recipe and both outputs are registered in `generate.ts`'s drift checks like every other brand image. The line is English only: a DMG has one background, and the arrow carries the meaning on its own.
- **Legible in both Finder appearances:** Finder draws icon labels in the system's label colour, black in light mode and white in dark, over the picture. The background's colour under the labels is chosen so both reach 4.5:1, then checked in screenshots of the mounted DMG in light and dark.
- **Volume icon:** `dmg.icon` = `resources/icon.icns` (dmgbuild sets `.VolumeIcon.icns` and the custom-icon flag), replacing our `SetFile` step and its "SetFile not found" branch.
- **Kept checks:** after the build, the DMG is attached read-only (`withMounted`, unchanged) and must hold `Terno.app`, an `Applications` symlink to `/Applications`, `.VolumeIcon.icns` with the custom-icon flag, and a `.background` image. A missing piece fails the package step.
- Test builds still make no DMG; `TERNO_PACKAGE_DMG=0` still skips it.
- **Retries:** dmg-builder's own `hdiutil` retry doesn't wrap the bundled `dmgbuild` (and its exit-code lookup never matches), so the DMG-only build is wrapped in our bounded retry (3 tries, 5 s apart, the old helper's policy), removing a half-written DMG between tries. The retry is a small pure helper with a unit test that fails twice then succeeds.

### 2. At launch: "Move Terno to Applications?"

A new module, `apps/desktop/src/install-location.ts`, with a pure decision and a small driver whose Electron calls are injected:

- **`offerMoveReason(probe)`** returns why to offer (`dmg`, `elsewhere`) or `null`. It offers only when all hold: packaged, macOS, not a test build (`TEST_BUILD`, unless it bakes `offerInstall: true`, which only the real-run check below sets), not demo, not a launch that came with a `terno://` link (the move's relaunch doesn't carry it, and the link would be lost: `LinkReceiver` says whether it holds one), not a background launch (`TERNO_TEST_BACKGROUND=1`, which the packaged smoke sets on every launch: a launch that must never take focus can't ask), not `isInApplicationsFolder()` (Electron counts `/Applications`, `~/Applications` and any `…/Applications/…` path), and no newer Terno is already in `/Applications` (its `CFBundleShortVersionString` read from `Info.plist`; a newer one means this is an old download, and replacing it would downgrade the mailbox's app, plan 95). The same version installed is still offered (Move replaces it, and you end up running the installed copy).
- **The dialog** (`dialog.showMessageBox`, no parent window, before any window or the backend): Terno's icon, title "Move Terno to Applications?", detail "Terno is running from the disk image. In Applications it stays installed and keeps itself up to date." (from Downloads or elsewhere: "Terno is running from <folder name>. …"), buttons **Move to Applications** (default, Return) and **Not Now** (cancel, Esc). In the menu's language; `en` and `es` together.
- **Move:** main sets `quitState = "stopped"` (no backend or window exists, so there is nothing to flush, and `before-quit` lets the move's quit through) and calls `app.moveToApplicationsFolder({ conflictHandler })`. The handler re-reads the installed version at that moment: a newer one returns `false` (nothing is replaced); otherwise the documented default (an older copy not running is trashed and replaced; a running one takes focus and this copy quits). On success Electron quits and relaunches from Applications, and `whenReady` returns without starting anything. On `false`, or a throw, `quitState` goes back to `"running"` and Terno opens. A throw also shows a second dialog, worded so it fits every cause (Electron 45 throws even when the admin prompt is cancelled, though its typings say `false`): "Terno wasn't moved to Applications." / "You can still install it: open the Applications folder in Finder and drag Terno into it, then open it from there." The error's own text is not shown (it can hold a path).
- **Not Now:** Terno opens exactly as today. Nothing is stored: the next launch from outside Applications asks again (the owner's choice). Settings keeps its existing "Move Terno to Applications to get updates".
- **Hook:** in `app.ts`'s `whenReady`, after `switchLanguage` (so the dialog speaks the right language) and before `buildMenu()` / `startBackend()`. The decision's file reads are synchronous and tiny (one `Info.plist`, only when not in Applications), so an installed Terno pays one `isInApplicationsFolder()` call and nothing else.
- **Diagnostics:** one code, `install.offer`, registered in `packages/core/src/diag/codes.ts`, with a new closed field `installStep` (`offered` · `moved` · `declined` · `kept` (a newer copy is installed) · `failed`) and `installFrom` for where it ran from (`dmg` · `elsewhere`), both closed fields in `fields.ts` so the sanitizer keeps them. No path, folder name, username or error text is logged (plan 10). Tested through the real sanitizer.

### 3. Translocation

An app opened from a quarantined download can run from a randomized read-only path (App Translocation); an unsigned DMG's app is one. Electron's docs don't say whether `moveToApplicationsFolder` handles it, and we never build on undocumented behaviour. Its v45 source copies from the running bundle's path (a translocated path is a read-only view of the original, so the copy works), strips the copy's quarantine before relaunching, and ejects the DMG only when it recognises the bundle as on a disk image. The real run (§Tests) is what decides: if the move from a quarantined DMG doesn't land Terno in Applications and relaunch it, the offer is limited to the cases where it does, and the others get the failure dialog's instructions instead.

## Tests

- `install-location.test.ts` (unit): `offerMoveReason` over every condition (dev, Linux, test build, demo, in Applications, in `~/Applications`, newer installed, same installed, older installed, from `/Volumes/…`, from Downloads); the driver with fake `dialog`/`move`: Move calls `move` once and marks quitting; `false` from `move` opens Terno and unmarks; a throw shows the failure dialog and opens Terno; Not Now never calls `move`; the logs carry no path.
- `package.mjs`'s DMG check is a pure function over a mounted volume's listing (`checkDmgVolume` in `dmg-mount.ts`), unit-tested with a fake volume: missing app, missing or wrong Applications link, missing volume icon or flag, missing background.
- The brand drift test already covers every file `pnpm brand` writes; the DMG background joins `BINARY_OUTPUTS`.
- i18n: the type check covers `en`/`es`.
- **Real run (once, recorded here):** a test build (its profile and app name baked, so neither Finder's launch nor the move's relaunch can reach a real profile) with `offerInstall: true`, made into a DMG by the same DMG step, quarantined (`xattr -w com.apple.quarantine`), opened in Finder (screenshots of the window in light and dark), Terno double-clicked: the offer, Not Now, then Move, and Terno relaunching from `/Applications`. Only when no Terno is in `/Applications` beforehand; afterwards the copy is removed after checking its bundle id is the test build's (`dev.terno.updatetest`). A real release's DMG is checked the same way by the owner on the first release.
- **Packaging contract:** a test that runs the DMG step's config builder and checks the DMG's `artifactName`, `writeUpdateInfo: false` and that the zip's config is unchanged; the package step itself asserts the channel file didn't change across the DMG step.

## Perf

Launch from Applications: one `isInApplicationsFolder()` call, no file read. Launch from anywhere else: one small `Info.plist` read, then a dialog the user is meant to see. Nothing runs after launch. No timers, no network.

## Out of scope

- **Signing or notarizing the DMG itself.** The app inside is signed and notarized with its ticket stapled, which is what Gatekeeper checks when it runs. A signed, notarized DMG is a separate step.
- Requiring the move (the owner chose to offer it).
- A "Don't ask again" choice: the owner chose to ask on every launch from outside Applications.
- Linux (packages install into place) and the web build.
- Localising the DMG background.

## Revisions after the Codex review

The plan critique raised 10 points; all were taken:

1. **The DMG's name:** the zip's global `artifactName` would have renamed it `…-arm64-mac.dmg`, which `release-assets.mjs` doesn't list. The DMG build sets its own `artifactName`, and a test pins it.
2. **The real run could reach the real profile:** Finder's launch and the move's relaunch drop the shell's environment. It now uses a test build (profile baked) that opts into the offer, and runs only when `/Applications` holds no Terno.
3. **Quit state:** exactly `quitState = "stopped"` before the move, back to `"running"` on `false` or a throw, and `whenReady` returns on success; tested through the driver.
4. **Retries:** dmg-builder's retry doesn't wrap `dmgbuild`, and its code lookup never matches. The DMG is a separate `prepackaged` build inside our own bounded retry.
5. **Cancelling the admin prompt throws** in Electron 45 (the typings say `false`). The failure dialog's wording now fits a cancel too, without matching the error's text.
6. **The newer-installed check could go stale** while the dialog is open: the conflict handler re-reads it at the moment of the move.
7. **A `terno://` launch would lose its link** (the relaunch doesn't carry it): no offer on a launch that came with a link.
8. **The brand pipeline:** the source goes in the root `brand/`, the renderer learns rectangles, and the source, recipe and outputs join the drift checks.
9. **The update contract:** `dmg.writeUpdateInfo: false`, and the package step asserts the channel file is unchanged by the DMG step.
10. **Diagnostics:** the code and its closed fields are registered in `codes.ts` and `fields.ts`, tested through the real sanitizer.

## What building it changed

- **The background lives with the DMG, not in `pnpm brand`.** It draws nothing from the logo (Finder draws the icons), so `apps/desktop/src/dmg-layout.ts` holds the geometry, the art and the electron-builder config in one place, `gen:dmg-background` renders it (1x and 2x), and `dmg-layout.test.ts` fails when the art and the checked-in PNGs drift. No change to the brand pipeline was needed.
- **macOS 26's Finder shows its toolbar whatever the DMG asks**, and keeps a user's own path bar, status bar and filename-extension settings (dmgbuild's `show_toolbar` and `hide_extensions` were tried directly). The window is 600 × 400 and everything sits in the top 270 pt of the content, so the icons, labels and hint all show even with both bars on.
- **Over a picture, Finder keeps the labels dark in dark mode too** (screenshots of the mounted DMG in both appearances). So the field is a light neutral (#E9E9EE), with the hint at 5.5:1.
- **dmgbuild keeps the background as `.background.tiff` at the volume's root**, not in a `.background` folder; the DMG check accepts either.
- **No `~/Applications` check of our own:** Electron's `isInApplicationsFolder` already counts `/Applications`, `~/Applications` and any `…/Applications/…` path.
- **Another app under the name is never replaced:** the installed copy must have Terno's own bundle id (read from both Info.plists), else no offer and the conflict handler keeps it. This also keeps a test build from replacing a real Terno.

## The real run

A test build (`offerInstall: true`, profile baked into the scratch folder, signed with Apple Development) through the full `package.mjs`, `TERNO_PACKAGE_DMG=1`, with no Terno in `/Applications`:

- The DMG step built `Terno-0.1.0-arm64.dmg` (no blockmap, channel file unchanged) and its checks passed. Finder showed the window as designed, in light and dark.
- Opened from the mounted volume, Terno showed the offer before any window, in English, Move as the default.
- **Move:** `/Applications/Terno.app` appeared (the test build's bundle id, quarantine cleared) and Terno relaunched from there, its files open only in the scratch profile, with no second offer.
- **Not Now** (Esc): nothing moved; Terno opened from the disk image as before.
- The disk image stayed mounted after the move: Electron ejects it only when nothing has it open, and Finder's window had it open. Ejecting it is the user's, as with any DMG.
- Afterwards the copy in `/Applications` was removed (bundle id checked first) and the volume detached.

**Not covered here: a quarantined, translocated launch.** An app opened from a downloaded DMG runs translocated (the owner's own 0.1.0 was running from an `AppTranslocation` path during this run). That needs a notarized build, which only the release workflow makes. The next release's DMG is the check: download it, open Terno from it, Move; it should land in `/Applications` and relaunch from there. If it doesn't, the offer is limited to the cases where it does (§3).

## What the code review changed

Codex reviewed the series (4e1530b48..35e7e98d1) and found three problems, each fixed with a test that fails without the fix:

1. **The guard read the wrong destination.** Electron moves a bundle to `/Applications/<its own name>`, so a renamed copy (`Terno 2.app`) goes to `/Applications/Terno 2.app`, while the newer-or-foreign check always read `/Applications/Terno.app`. The probe and the re-check now read `moveDestination(bundle)`.
2. **The admin-password path skips the conflict handler.** When the destination needs authorization, Electron replaces it without asking the handler, so a newer Terno installed while the dialog was open could be downgraded. The destination is now re-read right before the move (the check that counts), and again in the handler when Electron asks.
3. **A link that arrived while the dialog was open was lost on Move.** The launch passed a snapshot of `links.holding`; it now passes the getter, and after the answer a waiting link wins: Terno opens with it (`installStep: "deferred"`) and asks again next launch.
