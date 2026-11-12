# Plan 190: Settings → About

## Request (verbatim)

> add an 'About' section to the app on settings, so users can see their current version and things about the app, also there it should be a way to see if there is an update pending, and a button to 'check for updates', show me pictures of how this looks, must look nice and clean.

## What exists

- **Settings sections** are a closed list: `SettingsTab` (`apps/web/src/state/app.ts`), `SETTINGS_TABS` (`components/settings/tabs.ts`, sidebar order; the palette offers each as "Settings → …"), and one `TabsContent` per section in `settings-dialog.tsx`. Dev mode (plan 146) is appended last when present.
- **Updates in Settings** (plan 11): `UpdatesSection` (`components/settings/updates-section.tsx`) sits in General, desktop only (`useHasUpdates()`): the automatic switch (with "Updates come from GitHub…"), the channel, and a "Check for updates · Check Now" row whose hint is the status (last checked, available, downloading, ready, unsupported, error). Its footer carries the mark and "Terno 0.1.0". It shows that an update is pending as a sentence, but the action for it (Download, Restart to Update) lives only in the sidebar pill's popover (`update-pill.tsx`).
- **Update state** (`@terno/core/updates`): main owns it and pushes it; `lib/updates.ts` mirrors it (`useUpdates`), and has the pure `pillModel` (what the pill says) and `checkResult` (what a manual check found), plus `checkForUpdates`, `downloadUpdate`, `installUpdate`, `updateNow`, `openReleaseNotes`.
- **Build identity** (`lib/diag.ts` `BUILD`): version, commit sha and channel, on desktop from main's diag bridge, on the web from the Vite define.
- **Web** has no updater bridge; a newer deployment waiting in the service worker shows the pill's "New Version · Reload" (`useWeb((s) => s.update)`).
- **App menu**: "About Terno" is Electron's `role: "about"` (the native panel: icon, name, version), next to "Check for Updates…", which main sends to the renderer as the `updates.check` command.
- **Licence**: BSL 1.1, licensor Luisiacc LLC (`LICENSE`); the repo is public at github.com/luisiacc/terno, where releases are published.

## Design

A new last section, **About** (Info icon), after Storage and before Dev mode. It gathers what the app is and whether it is current; the update preferences move into it from General (General keeps the everyday settings; one place answers "which version, and is there a newer one").

```
About
┌────────────────────────────────────────────────────────────┐
│ [mark]  Terno                                              │
│         Version 0.1.0 (642c1b3)                            │
├────────────────────────────────────────────────────────────┤
│ ✓ Terno is up to date                 [ Check for Updates ]│
│   Last checked 5 minutes ago.                              │
└────────────────────────────────────────────────────────────┘
Updates
┌────────────────────────────────────────────────────────────┐
│ Download updates automatically                       (on)  │
│ Channel                                         [Stable ▾] │
└────────────────────────────────────────────────────────────┘
┌────────────────────────────────────────────────────────────┐
│ Release Notes                                           ↗  │
│ Source Code                                             ↗  │
│ License  Business Source License 1.1 …                  ↗  │
└────────────────────────────────────────────────────────────┘
© 2026 Luisiacc LLC
```

### The identity card

One card group, two rows, aligned to every other row's content line (`px-4`, the same text column):

1. **Identity**: the mark in a 40 px tile (primary ink on the primary wash, as the app icon reads), "Terno" in the body's semibold, and below it "Version 0.1.0 (642c1b3)" muted, tabular, selectable (people paste it into a report). The sha is shown only when it's a real one (not `dev`).
2. **Status** (desktop with the updater): a 16 px glyph, a title, a detail line, and the one action that state allows, on the right:

| State | Glyph | Title | Detail | Action |
| --- | --- | --- | --- | --- |
| idle / up to date | check (muted; success ink when up to date) | Terno is up to date / (idle) Check for updates | Last checked … / Not checked yet. | **Check for Updates** (outline) |
| checking | spinner | Checking for updates… | — | Check for Updates (loading) |
| available | arrow down (primary) | Terno 0.2.0 is available | 118.5 MB · Oct 24, 2026 · What's New | **Download** (primary) |
| downloading | — | Downloading Terno 0.2.0 | progress bar with the percent | — |
| verifying | spinner | Verifying Terno 0.2.0… | — | — |
| ready | restart glyph (primary) | Terno 0.2.0 is ready to install | It installs when Terno restarts. · What's New | **Restart to Update** (primary) |
| ready, deferred | spinner | Waiting for Send… | Terno restarts as soon as it finishes. | — |
| required (plan 95) | arrow down | Update Required | the pill's body | **Update Terno** |
| error | alert (destructive ink) | Couldn't check / download / install | the error in plain words | **Try Again** (outline) |
| unsupported | info | Updates aren't available for this copy | the reason ("Move Terno to Applications …") | Check for Updates (disabled) |

The table is a pure function, `aboutStatus(state)` in `lib/updates.ts`, beside `pillModel`, unit-tested over every row. "What's New" opens the release's page (`openReleaseNotes`), as the post-update snack does; the pill's popover keeps the inline notes. The actions are the same functions the pill's popover calls, so both places stay one flow. The state glyph is decorative; the title and detail are the status's text, in a `role="status"` region (polite), so a check's result is heard where it is shown.

**Web**: no status row from the updater; when a new deployment is waiting, the same row says "A new version of Terno is ready" with **Reload** (the pill's `apply`). Otherwise the identity row stands alone.

### Updates (desktop)

The automatic switch and the channel select move here unchanged (same test ids, hints, rules: the channel waits while an update is staged; both are disabled for an unsupported copy). The old "Check for updates" row goes: its job is the status row's.

### Links

Three link buttons under the groups (BoardUI's link button, `link-secondary`: the accent fails AA on the tint), each with the external-link glyph, opening the system browser through `openLink`:

- **Release Notes**: this version's release (`…/releases/tag/v0.1.0`); a dev build (sha `dev`) opens the releases list.
- **Source Code**: `https://github.com/luisiacc/terno`.
- **License**: `…/blob/main/LICENSE`.

The URLs live in one module (`lib/terno-links.ts`, which the release-notes snack and the required-update cover now use too), with the version→URL rule unit-tested. These are links the user clicks (plan 97: an explicit action outside the app), not network traffic of the app's own.

Below them: "© 2026 Luisiacc LLC · Business Source License 1.1".

### General

`UpdatesSection` leaves General (the group, its footer with the version). Nothing else in General changes.

## Tests

- **Unit**: `aboutStatus` over every state in the table, including ready winning over a later failed check, deferred, required, unsupported; `releaseNotesUrl` (a version, a dev build); `tabs.test.ts` with About in the list (en, es).
- **e2e** (`updates.spec.ts`, the Settings scenario rewritten for About, sharing its page): the status row through up to date (Check for Updates → the answer in the row and the snack), available (Download calls main), downloading (the progress bar), ready (Restart to Update calls install), unsupported (disabled, the reason), an error (Try Again); the switch and channel still save; axe on the section in light and dark. The General tab no longer has `updates-section`.
- **Visual**: screenshots of About in light and dark, up to date, available, downloading, ready; in at least two designs.

## Perf and resources

No new work at idle: the section reads the state main already pushes; "Last checked" is formatted on render (no timer). Nothing is fetched until a button is pressed. Plain imports.

## Out of scope

- The App menu's "About Terno" stays Electron's native panel. Pointing it at this section needs a new path in main (a window created when none is open, the command delivered once the renderer listens): its own change.

- Acknowledgements / third-party licences page.
- Showing release notes inline in About (the pill's popover has them).
- Changing what the updater does.

## Revisions after the Codex review

The critique (12 points) is in the session scratchpad (`plan-critique.txt`). What changed:

1. **Errors live beside the offer.** A failed download or verification settles back on `available` with the error kept: the model reads `error` before `available`, and the unit tests drive the reducer (not hand-built states) through each failure.
2. **A refused Restart says why.** Ready still wins, but carries `refused` (an install error, e.g. unsaved drafts) and shows its words in place of "Restart now, or …"; Restart stays offered.
3. **Installing** is its own presentation ("Restarting to update…", a spinner, Restart disabled); every action also has a local busy guard while its call is in flight.
4. **The download is named by `target`**, not a newer `available` that arrived meanwhile (tested with two versions).
5. **Required on an unsupported copy** offers "Download Terno" (the releases page), as the required-update cover does, never the updater.
6. **The App menu stays as it is** (moved to out of scope): no window-creation path in main for this series.
7. **One action per state is kept** (not a second Check beside Download or Restart): the row stays calm, and ⌘K and the App menu still check in every state. Recorded as a decision.
8. **A check that never reaches main** (the bridge call rejects) marks the row "Couldn't check for updates" with Try Again (`checkFailed` in the store, cleared by main's next state), so it can't keep showing the stale answer.
9. **The web branch** is covered by a jsdom component test (no updater: no status row or preferences; a waiting deployment shows Reload, which calls its `apply`).
10. **Focus**: when the state takes away the focused action (Download → the bar), focus moves to the row's status text (`tabIndex=-1`); a disabled action stays focusable (`focusableWhenDisabled`). Tracked through `focusin`, since a removed element fires no reliable blur. Unit-tested, and the test fails without the handoff.
11. **One links module** (`terno-links.ts`) for every GitHub URL; the link test checks the opener (a new tab on the web, the shell on desktop).
12. **Settings primitives**: `SettingsGroup`'s own inset, the shared `Progress` and `Spinner`, `link-secondary` links; axe runs on the whole About pane in light and dark.

## What the Codex code review changed (865185a25..)

The review is in the session scratchpad (`code-review.txt`). Each fix has a regression test that fails without it.

1. **A check that never reached main outranks the state before it**, other than a staged update: after a failed download, Try Again no longer downloads again; a stale "checking" no longer keeps the button busy.
2. **A required update says why its install was refused** (unsaved drafts) instead of the generic consent line.
3. **Focus handoff covers the whole row**, not only the action: What's New taken away by a background check moves focus to the status text too.
