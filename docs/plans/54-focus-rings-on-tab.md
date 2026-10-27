# 54 · Focus rings only while Tabbing

## Request

> remove these stupid blue borders on focus, now it happens on buttons to, remove them everywhere

(A screenshot of the reader's "Reply to Mei…" bar with a blue ring.)

The user's choice when asked: show a ring **only while Tabbing**. No ring after clicks, shortcuts, or focus Terno moves itself; Tab navigation keeps a ring.

## What exists

- The global `:focus-visible { outline: 2px solid var(--ring) }` in `globals.css`, plus 85 `focus-visible:` utilities (rings and borders) on controls.
- Chromium matches `:focus-visible` whenever the last input was a key. After `r`, Esc, `#` or `j`, a focus the app moves (the reply bar, the collapsed draft, the list) lights up, even though the user never navigated with Tab.
- Plan 52 already removed rings around whole lists.

## Design

- `apps/web/src/lib/focus-ring.ts`, installed synchronously in `main.tsx`, keeps `<html data-focus-ring>`:
  - set by an unmodified Tab or Shift+Tab;
  - kept by navigating keys: arrows, Home/End, PageUp/PageDown, Enter, Space, Escape and modifiers;
  - cleared by any other key (shortcuts, typing) and by any pointer press.

  It listens on `window` in capture, so handlers that stop a key can't hide it. There are no timers, and nothing runs while idle.
- `globals.css`:
  - Tailwind's `focus-visible` variant is redefined as `&:focus-visible:where(:root[data-focus-ring] *, <text field>)`, so every existing `focus-visible:` utility (including `has-focus-visible:`) is gated with no per-component edits.
  - The global outline follows the same rule. A bare `:focus-visible { outline: none }` replaces the browser's own focus outline, which would otherwise show whenever the flag is off.
- Text fields (inputs other than checkbox, radio, range, buttons, file and color; textarea; select; contenteditable; `role=textbox`) keep their rings, as the user allowed in plan 52's request.
- `AGENTS.md` records the rule so new UI doesn't bring the rings back.

## Tests

- `lib/focus-ring.test.ts` (jsdom):
  - Tab and Shift+Tab set the flag, and navigating keys keep it;
  - shortcuts and typed characters clear it;
  - a pointer press clears it;
  - modified Tab (Cmd, Ctrl or Alt) doesn't set it;
  - a key stopped by another capture handler is still seen.
- `e2e/focus-ring.spec.ts` (`@design`):
  - `r` then Esc leaves the collapsed draft focused, `:focus-visible` but unringed, and it rings once the flag is set;
  - Tab brings the ring, a shortcut (`s`) removes it, Shift+Tab brings it back, and a click removes it;
  - a clicked text field keeps its ring.
- The first two fail without the fix (the browser's own `outline: auto` and the old 2 px ring).

## Perf

Two capture listeners. An attribute flip happens only when the state changes, so there's no style recalc on every key.

## Out of scope

Focus inside sandboxed HTML mail frames (their own documents).

## Revisions after the Codex review

Round 1 found one problem (medium): gating the whole `focus-visible` variant also gated *reveals*. New Category (`opacity-0 … focus-visible:opacity-100`) vanished while it still had focus once a non-navigating key cleared the flag. The fix:

- A new ungated `focus-reveal:` variant (`&:focus-visible`), used for New Category and for the reader's sender email (`group-focus-reveal/mh:`).
- `source-scan.test.ts` now requires every gated `focus-visible:`, `group-focus-visible:` and `peer-focus-visible:` utility to be focus paint (ring, outline, border, shadow, z). The pane handle's bar is allowlisted because the bar is its focus ring.
- An e2e Tabs onto New Category, presses F8, and requires opacity 1. The e2e and the scan both fail without the fix.

`first-run.png` was re-recorded:

- The selected Local card no longer carries the autofocus ring.
- The old baseline also showed a stale gap under More, a paint artifact of the below-More layer. The layout probe measured a 0 px group in both builds, and main's own screenshot of the sidebar shows no gap.
