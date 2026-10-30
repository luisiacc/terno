# 72 · No setting change flashes the screen

## Request

> when clicking these [the "Photos from Google" switches] the list of threads shown on the background flashes, please fix that so it doesn't flash, also look for that pattern and what cused it, and fisx the root cause so not setting change causes a flash in the screen or in the thread list or anywhere really

## Causes found

A probe (Settings open over the inbox, a setting flipped, every list mutation, `<html>` attribute and animation behind the dialog recorded) showed the browser build's list untouched. The flashes come from four "drop everything, then redraw" paths:

1. **Sender icons reset** (this report). Any icon source change (photos on or off, listed, website icons, "Forget saved icons") sends `icons` with `reset`. The renderer cleared its whole cache and notified every avatar at once: every sender image in the list fell back to initials, then popped back as the new lookups and bytes arrived. And `dropPhotos` sent a reset even for an account that never had photos (switching off something never on).
2. **Motion coming back on** replayed every entrance animation (plan 70, fixed there).
3. **The open mail frame** was rebuilt (`srcDoc`) on any theme, mode or "HTML mail" change, because its colors were literals inside the document. A new `srcDoc` reloads the frame: blank, reloaded, re-measured.
4. **The desktop shell** was told the native appearance on every appearance save, and set the window's vibrancy and background again even when they hadn't changed. On macOS that can flash the window.

## Fixes

1. **Stale-while-revalidate icons** (`sender-icons.ts`). On a reset, what's on screen keeps drawing and is looked up again; off-screen entries are forgotten. An address changes only when its new answer can be drawn: a new icon is held back until its bytes are here, the same icon settles at once, and "none" (its source off) goes to initials. "Again" (a busy backend) keeps it drawn and asks again. Backend: `dropPhotos` resets only when the account had photos or a listing was running.
2. Plan 70.
3. **The mail document is built only when its content changes** (the mail, its remote-content consent). Colors, scheme and padding are CSS variables on its root, written in place on the loaded document when the theme or setting changes, and baked into its first paint.
4. **The shell hears only changes.** The renderer sends the native appearance only when it differs from the last sent. Main re-dresses a window only when its own last-applied appearance differs.

## Tests

- `sender-icons.test.ts`: through a reset and its lookup an on-screen icon stays drawn (never initials in between); a new icon replaces it only once its bytes are here; "none" goes to initials; off-screen entries are forgotten.
- `icons/google.test.ts`: switching photos off for an account that never had them sends no reset; turning off photos that were on still does.
- `mail-repaint.spec.ts`: switching to dark, then "Always paper", repaints the open mail with no frame load and the same document.
- `appearance.test.ts`: the shell hears an appearance once, and again only when it changes.

Each fails without its fix.
