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
